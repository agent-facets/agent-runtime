import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityConfig, ServerAccess } from '../config/capabilities.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import type { inspectServer } from '../mcp/discovery.ts';
import { canonicalJson, digestOf } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { type Catalog, loadInstallation } from './installation.ts';
import { createMcpPreflight, serverDigest } from './preflight.ts';
import type { CapabilitySnapshot } from './records.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-preflight-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const D = 'd'.repeat(64);
const SECRET = 'synthetic-preflight-credential-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };
const declaration = { type: 'stdio' as const, command: './repo', args: ['--read'], env: { MODE: 'synthetic' } };
const listTool = {
  name: 'list_prs',
  description: 'Lists pull requests.',
  inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'] },
};
const commentTool = { name: 'comment', description: 'Comments.', inputSchema: { type: 'object' } };
const deleteTool = { name: 'delete_repo', description: 'Deletes.', inputSchema: { type: 'object' } };

function catalogWith(servers: unknown[]): Catalog {
  const bytes = new TextEncoder().encode(
    `${canonicalJson({
      format: 2,
      profile: 1,
      toolchain: {
        cli: { version: '0.36.0', platform: 'linux-x64', sha256: 'c'.repeat(64) },
        adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
      },
      inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
      facets: [
        { facet: 'workflows', version: '1.0.0', source: { kind: 'local', path: './facets/workflows' }, integrity },
      ],
      items: [],
      servers,
      omittedServers: [],
    })}\n`,
  );
  const load = loadInstallation(bytes, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  if (load.kind !== 'ready') throw new Error(load.reason);
  return load.catalog;
}
const installed = (serverId = 'repo', decl: unknown = declaration) => ({
  serverId,
  fingerprint: `sha256:${'9'.repeat(64)}`,
  declaration: decl,
  origins: [{ ...origin, authoredName: serverId }],
});

function setup(
  options: {
    access?: Partial<ServerAccess>;
    decl?: unknown;
    approve?: (access: ServerAccess) => ServerAccess['approval'];
  } = {},
) {
  const stateDir = join(scratch, `state-${++counter}`);
  mkdirSync(stateDir, { mode: 0o700 });
  const programDir = join(scratch, `programs-${counter}`, 'repo');
  mkdirSync(programDir, { recursive: true });
  const bytes = 'console.log("repo");\n';
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  writeFileSync(join(programDir, `${sha256}.js`), bytes);
  const program = { bundlePath: join(programDir, `${sha256}.js`), sha256 };
  const catalog = catalogWith([installed('repo', options.decl ?? declaration)]);
  const base: ServerAccess = {
    serverId: 'repo',
    programId: 'repo',
    literalEnv: {},
    credentialEnv: { REPO_TOKEN: 'repo-token' },
    toolTimeoutSeconds: 60,
    approval: { kind: 'denied' },
    ...options.access,
  };
  const digest = serverDigest(catalog.installation.servers[0] as never, base, program);
  const access: ServerAccess = {
    ...base,
    approval: options.approve?.(base) ?? {
      kind: 'approved',
      serverDigest: digest,
      tools: [
        { name: 'list_prs', definitionDigest: digestOf(listTool), argumentEquals: { repository: 'owner/repo-a' } },
        { name: 'comment', definitionDigest: digestOf(commentTool), argumentEquals: {} },
      ],
    },
  };
  const grants: CapabilityConfig = {
    installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
    allowSkills: [],
    allowAgents: [],
    maxDelegationsPerRun: 8,
    localPrograms: { repo: program },
    servers: [access],
  };
  const inspected: unknown[] = [];
  let advertised: unknown[] = [listTool, commentTool, deleteTool];
  let unavailable: string | undefined;
  const inspect = (async (input: Parameters<typeof inspectServer>[0]) => {
    inspected.push(input.params);
    if (unavailable !== undefined) return { ok: false, reason: unavailable };
    const { judgeTool } = await import('../mcp/discovery.ts');
    return { ok: true, tools: advertised.map((raw) => judgeTool(raw as Record<string, unknown>, policy)) };
  }) as typeof inspectServer;
  const credentials = new Map<string, string>([['repo-token', SECRET]]);
  const preflight = createMcpPreflight({
    stateDir,
    bunPath: '/usr/local/bin/bun',
    readCredential: async (slot) => {
      const value = credentials.get(slot);
      return value === undefined ? { kind: 'missing' } : { kind: 'present', value };
    },
    inspect,
  });
  const run = (requires: CapabilitySnapshot['command']['requires']) =>
    preflight({ command: { requires } as CapabilitySnapshot['command'], grants, catalog, policy });
  return {
    run,
    inspected,
    credentials,
    digest,
    program,
    access,
    advertise: (tools: unknown[]) => {
      advertised = tools;
    },
    fail: (reason: string) => {
      unavailable = reason;
    },
  };
}

const needs = (toolName: string, serverId = 'repo') => [{ kind: 'mcp' as const, serverId, toolName }];

describe('required-tool preflight', () => {
  test('a command needing no MCP tool launches nothing', async () => {
    const s = setup();
    expect(await s.run([{ kind: 'native', name: 'mcp_Read' }])).toEqual({
      ok: true,
      bound: { servers: [], tools: [], authority: [] },
    });
    expect(s.inspected).toEqual([]);
  });

  test('binds the approved definitions of the required server, granted tools only', async () => {
    const s = setup();
    const result = await s.run(needs('list_prs'));
    if (!result.ok) throw new Error(result.reason);
    expect(s.inspected).toHaveLength(1);
    expect(result.bound.servers).toEqual([
      {
        serverId: 'repo',
        origins: [origin],
        declaration,
        programId: 'repo',
        serverDigest: s.digest,
      },
    ]);
    // The other granted tool is bound too; an advertised tool without a grant is not.
    expect(result.bound.tools.map((tool) => [tool.toolName, tool.definitionDigest, tool.adapted.name])).toEqual([
      ['list_prs', digestOf(listTool), 'mcp_repo_list_prs'],
      ['comment', digestOf(commentTool), 'mcp_repo_comment'],
    ]);
    expect(result.bound.tools[0]?.raw).toEqual(listTool);
    expect(result.bound.authority).toEqual([
      {
        serverId: 'repo',
        serverDigest: s.digest,
        tools: [
          { name: 'list_prs', definitionDigest: digestOf(listTool), argumentEquals: { repository: 'owner/repo-a' } },
          { name: 'comment', definitionDigest: digestOf(commentTool), argumentEquals: {} },
        ],
      },
    ]);
    // The credential reaches only the launch environment, never what the run retains.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(s.inspected)).toContain(SECRET);
  });

  test('refuses without launching when the connection or tool is not approved for what is installed now', async () => {
    const cases: [ReturnType<typeof setup>, string, string][] = [
      [setup({ approve: () => ({ kind: 'denied' }) }), 'server_denied', 'mcp:repo/list_prs'],
      [
        setup({ approve: () => ({ kind: 'approved', serverDigest: D, tools: [] }) }),
        'server_reapproval_required',
        'mcp:repo/list_prs',
      ],
      [
        setup({ decl: { type: 'http', url: 'https://mcp.example.test/' } }),
        'transport_unsupported',
        'mcp:repo/list_prs',
      ],
    ];
    for (const [s, reason, subject] of cases) {
      expect(await s.run(needs('list_prs'))).toEqual({ ok: false, code: 'capability_unavailable', reason, subject });
      expect(s.inspected).toEqual([]);
    }
    const s = setup();
    expect(await s.run(needs('delete_repo'))).toMatchObject({
      ok: false,
      reason: 'tool_not_granted',
      subject: 'mcp:repo/delete_repo',
    });
    expect(await s.run(needs('list_prs', 'other'))).toMatchObject({ ok: false, reason: 'prerequisite_missing' });
    s.credentials.clear();
    expect(await s.run(needs('list_prs'))).toMatchObject({
      ok: false,
      code: 'mcp_server_unavailable',
      reason: 'credential_unavailable',
    });
    expect(s.inspected).toEqual([]);
  });

  test('a changed definition needs reapproval; a missing tool or an unreachable server is attributed', async () => {
    const s = setup();
    s.advertise([{ ...listTool, description: 'Lists pull requests, now differently.' }, commentTool]);
    expect(await s.run(needs('list_prs'))).toEqual({
      ok: false,
      code: 'capability_unavailable',
      reason: 'tool_reapproval_required',
      subject: 'mcp:repo/list_prs',
    });
    s.advertise([commentTool]);
    expect(await s.run(needs('list_prs'))).toMatchObject({ reason: 'tool_unavailable' });
    s.fail('connection_timeout');
    expect(await s.run(needs('list_prs'))).toEqual({
      ok: false,
      code: 'mcp_server_unavailable',
      reason: 'connection_timeout',
      subject: 'mcp:repo/list_prs',
    });
    // A changed definition of a tool the command does not require only leaves that tool unbound.
    const optional = setup();
    optional.advertise([listTool, { ...commentTool, description: 'Changed.' }]);
    const result = await optional.run(needs('list_prs'));
    expect(result.ok && result.bound.tools.map((tool) => tool.toolName)).toEqual(['list_prs']);
  });

  test('tools of different servers with one canonical name are never bound; requiring one refuses the start', async () => {
    // `a_b`/`c_d` and `a`/`b_c_d` are both `mcp_a_b_c_d`; `a_b`/`ping` and `a`/`zed` are unrelated.
    const advertised: Record<string, unknown[]> = {
      a_b: [
        { ...commentTool, name: 'c_d' },
        { ...commentTool, name: 'ping' },
      ],
      a: [
        { ...commentTool, name: 'b_c_d' },
        { ...commentTool, name: 'zed' },
      ],
    };
    const stateDir = join(scratch, `state-${++counter}`);
    mkdirSync(stateDir, { mode: 0o700 });
    const programDir = join(scratch, `programs-${counter}`);
    mkdirSync(programDir, { recursive: true });
    const bytes = 'console.log("collide");\n';
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    writeFileSync(join(programDir, `${sha256}.js`), bytes);
    const program = { bundlePath: join(programDir, `${sha256}.js`), sha256 };
    const catalog = catalogWith([installed('a'), installed('a_b')]);
    const servers = catalog.installation.servers.map((server) => {
      const base: ServerAccess = {
        serverId: server.serverId,
        programId: server.serverId,
        literalEnv: {},
        credentialEnv: {},
        toolTimeoutSeconds: 60,
        approval: { kind: 'denied' },
      };
      return {
        ...base,
        approval: {
          kind: 'approved' as const,
          serverDigest: serverDigest(server, base, program),
          tools: (advertised[server.serverId] ?? []).map((raw) => ({
            name: (raw as { name: string }).name,
            definitionDigest: digestOf(raw),
            argumentEquals: {},
          })),
        },
      };
    });
    const grants: CapabilityConfig = {
      installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
      allowSkills: [],
      allowAgents: [],
      maxDelegationsPerRun: 8,
      localPrograms: { a: program, a_b: program },
      servers,
    };
    const { judgeTool } = await import('../mcp/discovery.ts');
    const preflight = createMcpPreflight({
      stateDir,
      bunPath: '/usr/local/bin/bun',
      readCredential: async () => ({ kind: 'missing' }),
      inspect: (async (input: Parameters<typeof inspectServer>[0]) => {
        const serverId = (input.params as { cwd: string }).cwd.split('/').at(-1) as string;
        return {
          ok: true,
          tools: (advertised[serverId] ?? []).map((raw) => judgeTool(raw as Record<string, unknown>, policy)),
        };
      }) as typeof inspectServer,
    });
    const run = (requires: CapabilitySnapshot['command']['requires']) =>
      preflight({ command: { requires } as CapabilitySnapshot['command'], grants, catalog, policy });

    // Only `a_b` is needed, so `a` is never inspected and nothing collides.
    const one = await run(needs('ping', 'a_b'));
    expect(one.ok && one.bound.tools.map((tool) => tool.adapted.name)).toEqual(['mcp_a_b_c_d', 'mcp_a_b_ping']);
    // Both servers needed: neither colliding tool is bound (nor renamed, nor chosen by order); the rest are.
    const both = await run([...needs('zed', 'a'), ...needs('ping', 'a_b')]);
    if (!both.ok) throw new Error(both.reason);
    expect(both.bound.tools.map((tool) => `${tool.serverId}/${tool.toolName}`)).toEqual(['a/zed', 'a_b/ping']);
    expect(both.bound.authority.map((server) => server.tools.map((grant) => grant.name))).toEqual([['zed'], ['ping']]);
    // A command that requires a colliding tool is refused, naming it.
    expect(await run([...needs('b_c_d', 'a'), ...needs('ping', 'a_b')])).toEqual({
      ok: false,
      code: 'capability_unavailable',
      reason: 'name_collision',
      subject: 'mcp:a/b_c_d',
    });
  });

  test('the server digest binds program, arguments and bindings, never credential values', () => {
    const s = setup();
    const server = { serverId: 'repo', declaration };
    const base = serverDigest(server, s.access, s.program);
    expect(serverDigest(server, s.access, { sha256: D })).not.toBe(base);
    expect(
      serverDigest({ ...server, declaration: { ...declaration, args: ['--write'] } }, s.access, s.program),
    ).not.toBe(base);
    expect(serverDigest(server, { ...s.access, literalEnv: { MODE: 'x' } }, s.program)).not.toBe(base);
    expect(serverDigest(server, { ...s.access, credentialEnv: { REPO_TOKEN: 'other-slot' } }, s.program)).not.toBe(
      base,
    );
    expect(serverDigest({ serverId: 'other', declaration }, s.access, s.program)).not.toBe(base);
    expect(serverDigest(server, { ...s.access, toolTimeoutSeconds: 5 }, s.program)).toBe(base);
  });
});
