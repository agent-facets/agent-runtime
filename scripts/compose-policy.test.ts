import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { repoRoot } from './lib/workspace.ts';

interface ComposeService {
  image?: string;
  command?: string[];
  build?: unknown;
  network_mode?: string;
  networks?: string[];
  ports?: unknown;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean } | null>;
  volumes: Record<string, unknown>;
}

const compose = Bun.YAML.parse(await Bun.file(join(repoRoot, 'compose.yaml')).text()) as ComposeFile;
const facets = Bun.YAML.parse(await Bun.file(join(repoRoot, 'compose.facets.yaml')).text()) as {
  services: Record<string, { volumes?: unknown[] } & Record<string, unknown>>;
};
const dockerfile = await Bun.file(join(repoRoot, 'Dockerfile')).text();
const dockerignore = await Bun.file(join(repoRoot, '.dockerignore')).text();
const serve = await Bun.file(join(repoRoot, 'deploy', 'tailscale', 'serve.json')).json();
const envExample = await Bun.file(join(repoRoot, '.env.example')).text();

const service = (name: string): ComposeService => {
  const found = compose.services[name];
  if (found === undefined) throw new Error(`missing service ${name}`);
  return found;
};
const runtime = service('runtime');
const tailscale = service('tailscale');
const postgres = service('postgres');
const sources = (svc: ComposeService) => (svc.volumes ?? []).map((volume) => volume.split(':')[0]);

describe('deployment topology', () => {
  test('defines exactly the runtime, Tailscale and PostgreSQL services', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['postgres', 'runtime', 'tailscale']);
  });

  test('publishes no application or database ports', () => {
    for (const svc of Object.values(compose.services)) expect(svc.ports).toBeUndefined();
  });

  test('runs the runtime inside the Tailscale network namespace', () => {
    expect(runtime.network_mode).toBe('service:tailscale');
    expect(runtime.networks).toBeUndefined();
    expect(runtime.depends_on?.postgres?.condition).toBe('service_healthy');
  });

  test('keeps PostgreSQL on an internal backend network', () => {
    expect(postgres.networks).toEqual(['backend']);
    expect(compose.networks.backend?.internal).toBe(true);
    expect(tailscale.networks).toEqual(['backend', 'egress']);
  });

  test('PostgreSQL ends orphaned runtime sessions so ownership can move to a replacement', () => {
    const settings = (postgres.command ?? []).filter((arg) => arg !== '-c' && arg !== 'postgres');
    expect(settings).toEqual(['tcp_keepalives_idle=10', 'tcp_keepalives_interval=5', 'tcp_keepalives_count=3']);
  });

  test('serves only the loopback runtime over Serve with Funnel disabled', () => {
    expect(Object.values(serve.AllowFunnel)).toEqual([false]);
    const handlers = Object.values(serve.Web as Record<string, { Handlers: Record<string, { Proxy: string }> }>);
    expect(handlers.flatMap((web) => Object.values(web.Handlers).map((handler) => handler.Proxy))).toEqual([
      'http://127.0.0.1:3000',
    ]);
    expect(tailscale.environment?.TS_USERSPACE).toBe('true');
    expect(Object.keys(tailscale.environment ?? {})).not.toContain('TS_AUTHKEY');
  });
});

describe('private browser access', () => {
  test('the runtime accepts only the Serve address, configured from the same tailnet name', () => {
    expect(runtime.environment?.RUNTIME_PUBLIC_ORIGIN).toBe(
      ['https://', '$', '{AGENT_RUNTIME_PUBLIC_HOST:?set AGENT_RUNTIME_PUBLIC_HOST}'].join(''),
    );
    expect(runtime.environment?.RUNTIME_CONFIG_FILE).toBe('/etc/agent-runtime/config.json');
  });

  test('the example operator configuration is valid for the container paths', async () => {
    const { parseOperatorConfig } = await import('../packages/runtime/src/config/operator.ts');
    const source = await Bun.file(join(repoRoot, 'deploy', 'runtime', 'config.example.json')).text();
    const config = parseOperatorConfig(source, {
      stateDir: '/var/lib/agent-runtime',
      configFile: '/etc/agent-runtime/config.json',
    });
    expect(config.workspace.root).toBe('/workspace');
    expect(config.capabilities).toBeUndefined();
  });

  test('the example capability configuration is valid and holds no credential value', async () => {
    const { parseOperatorConfig } = await import('../packages/runtime/src/config/operator.ts');
    const source = await Bun.file(join(repoRoot, 'deploy', 'runtime', 'config.capabilities.example.json')).text();
    const config = parseOperatorConfig(source, {
      stateDir: '/var/lib/agent-runtime',
      configFile: '/etc/agent-runtime/config.json',
    });
    expect(config.capabilities?.servers[0]?.credentialEnv).toEqual({ REPO_TOKEN: 'repo-token' });
    expect(config.capabilities?.servers[0]?.approval.kind).toBe('approved');
  });
});

describe('runtime container restrictions', () => {
  test('runs non-root with a read-only root filesystem and no added privileges', () => {
    expect(dockerfile).toMatch(/^USER bun$/m);
    expect(runtime.read_only).toBe(true);
    expect(runtime.cap_drop).toEqual(['ALL']);
    expect(runtime.security_opt).toEqual(['no-new-privileges:true']);
  });

  test('writes only to private state and bounded scratch space', () => {
    const workspaceMount = ['$', '{AGENT_RUNTIME_WORKSPACE:?set AGENT_RUNTIME_WORKSPACE}:/workspace:ro'].join('');
    const configMount = [
      '$',
      '{AGENT_RUNTIME_CONFIG:?set AGENT_RUNTIME_CONFIG}:/etc/agent-runtime/config.json:ro',
    ].join('');
    expect(runtime.volumes).toEqual(['runtime-state:/var/lib/agent-runtime', workspaceMount, configMount]);
    expect(runtime.tmpfs).toEqual(['/tmp:rw,noexec,nosuid,size=64m']);
  });

  test('never mounts the Docker socket, home directories or another service state', () => {
    const all = Object.values(compose.services).flatMap(sources);
    expect(all.some((source) => source?.includes('docker.sock') || source?.startsWith('~'))).toBe(false);
    expect(sources(runtime)).not.toContain('tailscale-state');
    expect(sources(runtime)).not.toContain('postgres-data');
    expect(sources(tailscale)).not.toContain('runtime-state');
    expect(sources(postgres)).not.toContain('runtime-state');
  });
});

describe('runtime facets', () => {
  const bundle = '/etc/agent-runtime/facets/installation.json';

  test('the base deployment needs no facet bundle', () => {
    expect(JSON.stringify(compose)).not.toContain('AGENT_RUNTIME_FACETS');
    expect(JSON.stringify(compose)).not.toContain(bundle);
  });

  test('the overlay adds only a read-only bind of an existing bundle at the fixed path', () => {
    expect(Object.keys(facets.services)).toEqual(['runtime']);
    expect(facets.services.runtime).toEqual({
      volumes: [
        {
          type: 'bind',
          source: ['$', '{AGENT_RUNTIME_FACETS:?set AGENT_RUNTIME_FACETS}'].join(''),
          target: bundle,
          read_only: true,
          bind: { create_host_path: false },
        },
      ],
    });
  });

  test('the image builds the selected MCP programs into a read-only directory, never test servers', () => {
    expect(dockerfile).toContain('RUN bun run --cwd packages/mcp-programs build');
    expect(dockerfile).toContain('COPY --from=build /repo/packages/mcp-programs/dist/programs /opt/agent-runtime/mcp');
    // Only package sources enter the build context, so the synthetic servers under test-support cannot.
    expect(dockerignore).not.toMatch(/test-support/);
    expect(dockerignore).toContain('!packages/*/src/**');
  });
});

describe('environment example', () => {
  test('lists every required variable with placeholders only', () => {
    const entries = Object.fromEntries(
      envExample
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => line.split('=', 2) as [string, string]),
    );
    const composeText = JSON.stringify(compose);
    const required = [...composeText.matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1]);
    for (const name of new Set(required)) expect(Object.keys(entries)).toContain(name as string);
    expect(entries).toEqual({
      AGENT_RUNTIME_WORKSPACE: '/absolute/path/to/workspace',
      AGENT_RUNTIME_CONFIG: '/absolute/path/to/config.json',
      AGENT_RUNTIME_PUBLIC_HOST: 'agent-runtime.your-tailnet.ts.net',
      POSTGRES_PASSWORD: 'replace-with-generated-password',
      TS_HOSTNAME: 'agent-runtime',
    });
  });

  test('documents the optional facet bundle as a commented placeholder', () => {
    expect(envExample).toContain('\n# AGENT_RUNTIME_FACETS=/absolute/path/to/installation.json\n');
  });
});
