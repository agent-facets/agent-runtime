// Configured MCP credentials join the shared credential screen: they are refused in owner input and tool calls and
// redacted from results like provider credentials, and an unusable configured slot makes screening fail closed.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredCredentialSlots } from '../config/capabilities.ts';
import { parseOperatorConfig } from '../config/operator.ts';
import { loadConfiguredMcpCredentials, McpCredentialStore } from '../credentials/mcp-store.ts';
import { screenOwnerInput } from '../security/content-policy.ts';
import { CompleteMessageAssembler, sanitizeToolOutcome } from '../security/pre-graph.ts';
import { createProviderAssembly } from './assembly.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-screen-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const D = 'd'.repeat(64);
const P = 'a'.repeat(64);
const SECRET = 'synthetic-mcp-screened-secret-0001';

function setup(slots: Record<string, string> = { REPO_TOKEN: 'repo-token', OTHER_TOKEN: 'other-token' }) {
  const stateDir = join(scratch, `state-${++counter}`);
  mkdirSync(stateDir, { mode: 0o700 });
  const config = parseOperatorConfig(
    JSON.stringify({
      version: 1,
      workspace: { id: 'main', label: 'Main', root: '/workspace' },
      providers: { anthropic: { authMode: 'subscription', model: 'model', profileId: 'claude-cli-2.1.280' } },
      defaultProvider: 'anthropic',
      capabilities: {
        installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
        localPrograms: { repo: { bundlePath: `/opt/agent-runtime/mcp/repo/${P}.js`, sha256: P } },
        servers: [{ serverId: 'repo', programId: 'repo', credentialEnv: slots, approval: { kind: 'denied' } }],
      },
    }),
    { stateDir, configFile: '/etc/agent-runtime/config.json' },
  );
  const store = McpCredentialStore.forStateDir(stateDir);
  return { config, store, assembly: createProviderAssembly({ config, stateDir }) };
}

describe('configured MCP credential screening', () => {
  test('the configured slots are read once; missing slots hold nothing and unusable ones are reported', async () => {
    const { config, store } = setup();
    expect(configuredCredentialSlots(config)).toEqual(['other-token', 'repo-token']);
    expect(await loadConfiguredMcpCredentials(store, configuredCredentialSlots(config))).toEqual({
      values: [],
      unusable: [],
    });
    await store.replace('repo-token', SECRET);
    await store.replace('other-token', 'synthetic-mcp-other-secret-0002');
    chmodSync(store.pathFor('other-token'), 0o644);
    expect(await loadConfiguredMcpCredentials(store, configuredCredentialSlots(config))).toEqual({
      values: [SECRET],
      unusable: ['other-token'],
    });
  });

  test('admitted values are refused in owner input and tool calls and withheld from results', async () => {
    const { config, store, assembly } = setup();
    await store.replace('repo-token', SECRET);
    // Before admission, configured slots make owner input unscreenable.
    expect(await assembly.ownerInputPolicy()).toBeUndefined();
    assembly.admitMcpCredentials(await loadConfiguredMcpCredentials(store, configuredCredentialSlots(config)));

    const owner = await assembly.ownerInputPolicy();
    if (owner === undefined) throw new Error('screening should be complete');
    expect(screenOwnerInput(owner, `use ${SECRET} please`)).toEqual({ ok: false, code: 'credential_in_input' });
    expect(screenOwnerInput(owner, 'an ordinary goal')).toEqual({ ok: true });

    const policy = assembly.contentPolicy();
    const assembler = new CompleteMessageAssembler(policy);
    assembler.push({
      kind: 'tool_call',
      index: 0,
      id: 'call-1',
      name: 'mcp_repo_list',
      argumentsDelta: `{"token":"${SECRET}"}`,
    });
    assembler.push({ kind: 'terminal' });
    expect(assembler.finish()).toEqual({ kind: 'rejected', reason: 'credential_in_tool_call' });

    const text = sanitizeToolOutcome(policy, { outcome: 'ok', result: { text: `echo ${SECRET}` } });
    expect(JSON.stringify(text)).not.toContain(SECRET);
    const structured = sanitizeToolOutcome(policy, { outcome: 'ok', result: { json: { token: SECRET } } });
    expect(structured).toMatchObject({ outcome: 'refused', code: 'credential_in_result' });
    const failure = sanitizeToolOutcome(policy, { outcome: 'error', code: 'failed', message: `bad ${SECRET}` });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  test('an unusable configured slot makes owner-input screening fail closed', async () => {
    const { config, store, assembly } = setup();
    await store.replace('repo-token', SECRET);
    await store.replace('other-token', 'synthetic-mcp-other-secret-0002');
    chmodSync(store.pathFor('other-token'), 0o644);
    assembly.admitMcpCredentials(await loadConfiguredMcpCredentials(store, configuredCredentialSlots(config)));
    expect(await assembly.ownerInputPolicy()).toBeUndefined();
    // The usable value is still screened everywhere else.
    expect(assembly.contentPolicy().detect(SECRET)).toBe('known_credential');
  });

  test('without configured slots screening is complete from the start', async () => {
    const { assembly } = setup({});
    expect(await assembly.ownerInputPolicy()).toBeDefined();
  });
});
