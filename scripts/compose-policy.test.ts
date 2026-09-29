import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { repoRoot } from './lib/workspace.ts';

interface ComposeService {
  image?: string;
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
const dockerfile = await Bun.file(join(repoRoot, 'Dockerfile')).text();
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
const digestPinned = /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/;

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

  test('pins third-party images by digest', () => {
    expect(tailscale.image).toMatch(digestPinned);
    expect(postgres.image).toMatch(digestPinned);
    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
    expect(bases.length).toBe(2);
    for (const base of bases) expect(base).toMatch(digestPinned);
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

describe('runtime container restrictions', () => {
  test('runs non-root with a read-only root filesystem and no added privileges', () => {
    expect(dockerfile).toMatch(/^USER bun$/m);
    expect(runtime.read_only).toBe(true);
    expect(runtime.cap_drop).toEqual(['ALL']);
    expect(runtime.security_opt).toEqual(['no-new-privileges:true']);
  });

  test('writes only to private state and bounded scratch space', () => {
    const workspaceMount = ['$', '{AGENT_RUNTIME_WORKSPACE:?set AGENT_RUNTIME_WORKSPACE}:/workspace:ro'].join('');
    expect(runtime.volumes).toEqual(['runtime-state:/var/lib/agent-runtime', workspaceMount]);
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
      POSTGRES_PASSWORD: 'replace-with-generated-password',
      TS_HOSTNAME: 'agent-runtime',
    });
  });
});
