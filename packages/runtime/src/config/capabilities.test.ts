import { describe, expect, test } from 'bun:test';
import { argumentsMatch, isProtectedEnvironmentName } from './capabilities.ts';
import { ConfigError, parseOperatorConfig } from './operator.ts';

const context = { stateDir: '/var/lib/agent-runtime', configFile: '/etc/agent-runtime/config.json' };
const D = 'd'.repeat(64);
const P = 'a'.repeat(64);

const base = {
  version: 1,
  workspace: { id: 'main', label: 'Main repository', root: '/workspace' },
  providers: { anthropic: { authMode: 'subscription', model: 'model', profileId: 'anthropic-subscription' } },
  defaultProvider: 'anthropic',
};
const server = (extra: Record<string, unknown> = {}) => ({
  serverId: 'repo-tools',
  programId: 'repo-tools',
  approval: {
    kind: 'approved',
    serverDigest: D,
    tools: [{ name: 'list_prs', definitionDigest: D, argumentEquals: { repository: 'owner/repo-a' } }],
  },
  ...extra,
});
const capabilities = (extra: Record<string, unknown> = {}) => ({
  installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
  localPrograms: { 'repo-tools': { bundlePath: `/opt/agent-runtime/mcp/repo-tools/${P}.js`, sha256: P } },
  servers: [server()],
  ...extra,
});
const parse = (caps: unknown) => parseOperatorConfig(JSON.stringify({ ...base, capabilities: caps }), context);
const refusal = (caps: unknown) => {
  try {
    parse(caps);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('configuration was accepted');
};

describe('capability configuration', () => {
  test('a configuration without capabilities stays goal-only and valid', () => {
    expect(parseOperatorConfig(JSON.stringify(base), context).capabilities).toBeUndefined();
  });

  test('applies documented defaults and keeps the parsed grants immutable', () => {
    const config = parse({ installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D } });
    expect(config.capabilities).toEqual({
      installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
      allowSkills: [],
      allowAgents: [],
      maxDelegationsPerRun: 8,
      localPrograms: {},
      servers: [],
    });
    const full = parse(capabilities());
    expect(full.capabilities?.servers[0]).toMatchObject({ literalEnv: {}, credentialEnv: {}, toolTimeoutSeconds: 60 });
    expect(Object.isFrozen(full.capabilities?.servers[0]?.approval)).toBe(true);
  });

  test('delegation and timeout limits are bounded integers', () => {
    for (const [value, ok] of [
      [1, true],
      [32, true],
      [0, false],
      [33, false],
      [2.5, false],
    ] as const) {
      if (ok)
        expect(parse(capabilities({ maxDelegationsPerRun: value })).capabilities?.maxDelegationsPerRun).toBe(value);
      else expect(() => parse(capabilities({ maxDelegationsPerRun: value }))).toThrow(ConfigError);
    }
    for (const toolTimeoutSeconds of [0, 301, 1.5]) {
      expect(() => parse(capabilities({ servers: [server({ toolTimeoutSeconds })] }))).toThrow(ConfigError);
    }
    expect(parse(capabilities({ servers: [server({ toolTimeoutSeconds: 300 })] }))).toBeDefined();
  });

  test('refuses malformed digests, identifiers and program paths', () => {
    for (const caps of [
      capabilities({ installation: { path: 'relative.json', sha256: D } }),
      capabilities({ installation: { path: '/x.json', sha256: D.toUpperCase() } }),
      capabilities({ allowSkills: ['review'] }),
      capabilities({ allowAgents: ['skill:review'] }),
      capabilities({ servers: [server({ serverId: 'Repo Tools' })] }),
      capabilities({ servers: [server({ approval: { kind: 'approved', serverDigest: 'abc', tools: [] } })] }),
      capabilities({
        localPrograms: { 'repo-tools': { bundlePath: '/opt/agent-runtime/mcp/repo-tools/other.js', sha256: P } },
      }),
      capabilities({ servers: [server({ programId: 'missing' })] }),
    ]) {
      expect(() => parse(caps)).toThrow(ConfigError);
    }
  });

  test('refuses duplicate servers, tool grants and allowlist entries', () => {
    const tool = { name: 'list_prs', definitionDigest: D };
    for (const caps of [
      capabilities({ servers: [server(), server()] }),
      capabilities({
        servers: [server({ approval: { kind: 'approved', serverDigest: D, tools: [tool, tool] } })],
      }),
      capabilities({ allowSkills: ['skill:review', 'skill:review'] }),
    ]) {
      expect(() => parse(caps)).toThrow(ConfigError);
    }
  });

  test('a denied server carries no grants, and an empty approval permits discovery only', () => {
    expect(
      refusal(capabilities({ servers: [server({ approval: { kind: 'denied', serverDigest: D, tools: [] } })] })),
    ).toStartWith('operator configuration: unsupported setting');
    expect(parse(capabilities({ servers: [server({ approval: { kind: 'denied' } })] }))).toBeDefined();
    const empty = parse(
      capabilities({ servers: [server({ approval: { kind: 'approved', serverDigest: D, tools: [] } })] }),
    );
    expect(empty.capabilities?.servers[0]?.approval).toEqual({ kind: 'approved', serverDigest: D, tools: [] });
  });

  test('refuses protected, overlapping and malformed environment targets without echoing values', () => {
    const secret = 'synthetic-literal-value-0000';
    for (const env of [
      { literalEnv: { PATH: '/tmp' } },
      { literalEnv: { NODE_OPTIONS: '--require x' } },
      { literalEnv: { LD_PRELOAD: '/x.so' } },
      { literalEnv: { HTTPS_PROXY: 'http://proxy' } },
      { literalEnv: { DEBUG: '*' } },
      { literalEnv: { ANTHROPIC_API_KEY: secret } },
      { credentialEnv: { HOME: 'slot' } },
      { literalEnv: { lower_case: secret } },
      { literalEnv: { TOKEN: secret }, credentialEnv: { TOKEN: 'repo-token' } },
      { credentialEnv: { TOKEN: 'Bad Slot' } },
      { literalEnv: { MODE: 'a\u0000b' } },
    ]) {
      const message = refusal(capabilities({ servers: [server(env)] }));
      expect(message).not.toContain(secret);
    }
    const token = `ghp_${'A'.repeat(36)}`;
    expect(refusal(capabilities({ servers: [server({ literalEnv: { REPO_AUTH: token } })] }))).not.toContain(token);
    const accepted = parse(
      capabilities({
        servers: [server({ literalEnv: { REPO_MODE: 'read' }, credentialEnv: { REPO_TOKEN: 'repo-token' } })],
      }),
    );
    expect(accepted.capabilities?.servers[0]?.credentialEnv).toEqual({ REPO_TOKEN: 'repo-token' });
    expect(isProtectedEnvironmentName('PGPASSWORD')).toBe(true);
    expect(isProtectedEnvironmentName('REPO_TOKEN')).toBe(false);
  });

  test('refuses an arbitrary working directory, command or unsupported predicate', () => {
    for (const extra of [{ cwd: '/workspace' }, { command: 'npx' }, { args: ['--x'] }]) {
      expect(refusal(capabilities({ servers: [server(extra)] }))).toStartWith(
        'operator configuration: unsupported setting',
      );
    }
    for (const argumentEquals of [
      { repository: { regex: 'owner/.*' } },
      { repository: ['owner/repo-a'] },
      { 'nested/field': 'x' },
    ]) {
      const approval = {
        kind: 'approved',
        serverDigest: D,
        tools: [{ name: 'list_prs', definitionDigest: D, argumentEquals }],
      };
      expect(() => parse(capabilities({ servers: [server({ approval })] }))).toThrow(ConfigError);
    }
  });
});

describe('argument restrictions', () => {
  const grant = { argumentEquals: { repository: 'owner/repo-a', limit: 10, draft: false, label: null } };

  test('every restricted top-level argument must be present and exactly equal', () => {
    expect(argumentsMatch(grant, { repository: 'owner/repo-a', limit: 10, draft: false, label: null, other: 1 })).toBe(
      true,
    );
    expect(argumentsMatch(grant, { repository: 'owner/repo-b', limit: 10, draft: false, label: null })).toBe(false);
    expect(argumentsMatch(grant, { limit: 10, draft: false, label: null })).toBe(false);
  });

  test('values are never coerced', () => {
    const full = { repository: 'owner/repo-a', limit: 10, draft: false, label: null };
    for (const changed of [{ limit: '10' }, { draft: 0 }, { draft: 'false' }, { label: undefined }, { label: '' }]) {
      expect(argumentsMatch(grant, { ...full, ...changed })).toBe(false);
    }
    expect(argumentsMatch({ argumentEquals: { repository: 'Owner/Repo-A' } }, { repository: 'owner/repo-a' })).toBe(
      false,
    );
  });

  test('a grant without restrictions matches any arguments', () => {
    expect(argumentsMatch({ argumentEquals: {} }, {})).toBe(true);
  });
});
