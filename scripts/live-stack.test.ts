import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, parseArgs, type Service, UsageError } from './lib/live-stack/args.ts';
import { COMPOSE_FILE, childEnv, deployTag, type RunOptions, type RunResult } from './lib/live-stack/docker.ts';
import { acquireFileLock, LockBusyError } from './lib/live-stack/lock.ts';
import { configuredImage, type Deps, execute, OperationError } from './lib/live-stack/operations.ts';
import { type DeploymentState, StateError, VOLUMES } from './lib/live-stack/state.ts';
import { repoRoot } from './lib/workspace.ts';

const imageId = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const RUNTIME_OLD = imageId(1);
const RUNTIME_NEW = imageId(2);
const POSTGRES = imageId(3);
const TAILSCALE = imageId(4);
const SECRET = 'supersecretpassword123';
const COMPOSE_PREFIX = 10;

interface FakeContainer {
  id: string;
  service: Service;
  status: string;
  health?: string;
  imageId: string;
  networkMode: string;
  labels: Record<string, string>;
  mounts: { Type: string; Name?: string; Source: string; Destination: string }[];
}

interface FakeImage {
  id: string;
  cmd: string[];
  env: string[];
}

const production = (id: string): FakeImage => ({ id, cmd: ['bun', 'dist/main.js'], env: ['NODE_ENV=production'] });

/** A small simulation of the Docker CLI for one Compose project. */
class FakeDocker {
  containers = new Map<Service, FakeContainer>();
  images = new Map<string, FakeImage>();
  volumes = new Set<string>(Object.values(VOLUMES));
  calls: { argv: string[]; options: RunOptions }[] = [];
  backendState = 'Running';
  ready: () => boolean = () => true;
  next = 100;

  container(service: Service, imageIdValue: string, extra: Partial<FakeContainer> = {}): FakeContainer {
    const id = `${service}-${this.next++}`;
    const mounts: Record<Service, FakeContainer['mounts']> = {
      runtime: [
        { Type: 'volume', Name: VOLUMES.runtime, Source: '/var/lib/docker/x', Destination: '/var/lib/agent-runtime' },
        { Type: 'bind', Source: '/srv/workspace', Destination: '/workspace' },
        { Type: 'bind', Source: '/srv/config.json', Destination: '/etc/agent-runtime/config.json' },
      ],
      postgres: [{ Type: 'volume', Name: VOLUMES.postgres, Source: '/x', Destination: '/var/lib/postgresql/data' }],
      tailscale: [{ Type: 'volume', Name: VOLUMES.tailscale, Source: '/x', Destination: '/var/lib/tailscale' }],
    };
    const container: FakeContainer = {
      id,
      service,
      status: 'running',
      health: service === 'tailscale' ? undefined : 'healthy',
      imageId: imageIdValue,
      networkMode: service === 'runtime' ? `container:${this.containers.get('tailscale')?.id}` : 'bridge',
      labels: {
        'com.docker.compose.project': PROJECT,
        'com.docker.compose.service': service,
        'com.docker.compose.project.working_dir': repoRoot,
        'com.docker.compose.project.config_files': COMPOSE_FILE,
      },
      mounts: mounts[service],
      ...extra,
    };
    this.containers.set(service, container);
    return container;
  }

  async deploymentUp(runtime = RUNTIME_OLD) {
    this.images.set(await configuredImage('postgres'), { id: POSTGRES, cmd: ['postgres'], env: [] });
    this.images.set(await configuredImage('tailscale'), { id: TAILSCALE, cmd: [], env: [] });
    this.images.set(RUNTIME_OLD, production(RUNTIME_OLD));
    this.images.set('agent-runtime/runtime:old', production(RUNTIME_OLD));
    this.images.set(RUNTIME_NEW, production(RUNTIME_NEW));
    this.images.set('agent-runtime/runtime:new', production(RUNTIME_NEW));
    this.container('tailscale', TAILSCALE);
    this.container('postgres', POSTGRES);
    this.container('runtime', runtime);
  }

  /** Compose subcommands issued, without the fixed project prefix. */
  composeCalls(): string[][] {
    return this.calls.filter((call) => call.argv[1] === 'compose').map((call) => call.argv.slice(COMPOSE_PREFIX));
  }

  image(reference: string): FakeImage | undefined {
    return this.images.get(reference) ?? [...this.images.values()].find((image) => image.id === reference);
  }

  runner = async (argv: string[], options: RunOptions = {}): Promise<RunResult> => {
    this.calls.push({ argv, options });
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    const fail: RunResult = { code: 1, stdout: '', stderr: 'error' };
    if (argv[0] === 'git') return ok(argv.includes('rev-parse') ? 'abc123def456' : '');
    if (argv[1] === 'ps') return ok([...this.containers.values()].map((c) => c.id).join('\n'));
    if (argv[1] === 'inspect') {
      const found = argv.slice(2).map((id) => [...this.containers.values()].find((c) => c.id === id));
      return ok(
        JSON.stringify(
          found.map((c) => ({
            Id: c?.id,
            Image: c?.imageId,
            State: { Status: c?.status, ...(c?.health === undefined ? {} : { Health: { Status: c.health } }) },
            HostConfig: { NetworkMode: c?.networkMode },
            Config: { Labels: c?.labels, Env: [`POSTGRES_PASSWORD=${SECRET}`] },
            Mounts: c?.mounts,
          })),
        ),
      );
    }
    if (argv[1] === 'image' && argv[2] === 'inspect') {
      const image = this.image(argv[3] as string);
      if (image === undefined) return fail;
      return ok(JSON.stringify([{ Id: image.id, Config: { Cmd: image.cmd, Env: image.env, WorkingDir: '/app' } }]));
    }
    if (argv[1] === 'volume') return this.volumes.has(argv[3] as string) ? ok('[]') : fail;
    if (argv[1] === 'tag') {
      const image = this.image(argv[2] as string);
      if (image === undefined) return fail;
      this.images.set(argv[3] as string, image);
      return ok();
    }
    if (argv[1] === 'build') {
      const tag = argv[argv.indexOf('--tag') + 1] as string;
      this.images.set(tag, production(imageId(99)));
      return ok();
    }
    if (argv[1] === 'exec') {
      if (argv.includes('tailscale') && argv.includes('--json')) {
        return ok(
          JSON.stringify({
            BackendState: this.backendState,
            AuthURL: this.backendState === 'NeedsLogin' ? 'https://login.tailscale.com/a/xyz' : '',
            Self: { DNSName: 'agent-runtime-live.example.ts.net.', Online: true },
          }),
        );
      }
      if (argv.includes('serve')) return ok('https://agent-runtime-live.example.ts.net (tailnet only)');
      if (argv.includes('-e')) {
        const ready = this.ready();
        return ok(JSON.stringify({ status: ready ? 200 : 503, body: { ready, checks: { persistence: 'ready' } } }));
      }
      return ok();
    }
    if (argv[1] === 'compose') return this.compose(argv.slice(COMPOSE_PREFIX), options);
    return fail;
  };

  async compose(sub: string[], options: RunOptions): Promise<RunResult> {
    const ok: RunResult = { code: 0, stdout: '', stderr: '' };
    const service = sub.at(-1) as Service;
    const all = [...this.containers.values()];
    switch (sub[0]) {
      case 'start': {
        const targets = sub.length > 1 ? [this.containers.get(service)] : all;
        if (targets.some((c) => c === undefined)) return { code: 1, stdout: '', stderr: 'no container' };
        for (const c of targets) if (c !== undefined) c.status = 'running';
        return ok;
      }
      case 'stop':
        for (const c of sub.includes('runtime') ? [this.containers.get('runtime')] : all) {
          if (c !== undefined) c.status = 'exited';
        }
        return ok;
      case 'restart':
        return ok;
      case 'down':
        this.containers.clear();
        return ok;
      case 'up': {
        const reference =
          service === 'runtime'
            ? (options.env?.AGENT_RUNTIME_IMAGE as string)
            : await configuredImage(service as 'postgres');
        const image = this.image(reference);
        if (image === undefined) return { code: 1, stdout: '', stderr: 'no image' };
        this.container(service, image.id);
        return ok;
      }
      default:
        return ok;
    }
  }
}

let dir: string;
let stateDir: string;
let docker: FakeDocker;
let output: string[];
let clock: number;
let locks: string[];

const envText = [
  'AGENT_RUNTIME_WORKSPACE=/srv/workspace',
  'AGENT_RUNTIME_CONFIG=/srv/config.json',
  'AGENT_RUNTIME_PUBLIC_HOST=agent-runtime-live.example.ts.net',
  `POSTGRES_PASSWORD=${SECRET}`,
  'TS_HOSTNAME=agent-runtime-live',
  '',
].join('\n');

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    runner: docker.runner,
    ambient: { PATH: '/usr/bin', HOME: '/home/owner', COMPOSE_PROJECT_NAME: 'other', AGENT_RUNTIME_IMAGE: 'evil' },
    acquireLock: async (path) => {
      locks.push(path);
      return { release: async () => {} };
    },
    out: (line) => output.push(line),
    interactive: false,
    prompt: async () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeouts: { readinessMs: 10_000, postgresMs: 10_000, tailscaleMs: 10_000, pollMs: 1_000 },
    ...overrides,
  };
}

const run = (argv: string[], overrides: Partial<Deps> = {}) =>
  execute(parseArgs(['--state-dir', stateDir, ...argv], { HOME: '/home/owner' }), deps(overrides));

const readState = (): DeploymentState => JSON.parse(readFileSync(join(stateDir, 'deployment.json'), 'utf8'));

/** The live state directory as it exists for the adopted deployment. */
function adopt() {
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(stateDir, 'compose.env'), envText, { mode: 0o600 });
  const state: DeploymentState = {
    version: 1,
    project: PROJECT,
    images: { runtime: RUNTIME_OLD, postgres: POSTGRES, tailscale: TAILSCALE },
    volumes: VOLUMES,
    updatedAt: new Date(0).toISOString(),
  };
  writeFileSync(join(stateDir, 'deployment.json'), JSON.stringify(state), { mode: 0o600 });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'live-stack-'));
  stateDir = join(dir, 'live');
  docker = new FakeDocker();
  await docker.deploymentUp();
  output = [];
  clock = 0;
  locks = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('live:stack arguments', () => {
  const env = { HOME: '/home/owner' };

  test('defaults to the live state directory and a fixed project', () => {
    expect(parseArgs(['status'], env)).toEqual({
      invocation: { command: 'status' },
      stateDir: '/home/owner/.local/state/agent-runtime-live',
    });
    expect(() => parseArgs(['--project', 'other', 'status'], env)).toThrow(UsageError);
    expect(() => parseArgs(['--state-dir', 'relative', 'status'], env)).toThrow('absolute');
  });

  test('accepts only validated arguments', () => {
    expect(parseArgs(['up'], env).invocation).toEqual({ command: 'start' });
    expect(parseArgs(['reload'], env).invocation).toEqual({ command: 'recreate' });
    expect(parseArgs(['logs', 'tailscale', '--tail=50', '--no-follow'], env).invocation).toEqual({
      command: 'logs',
      services: ['tailscale'],
      follow: false,
      options: ['--tail', '50'],
    });
    expect(parseArgs(['deploy', '--image', 'agent-runtime/runtime:x', '--yes'], env).invocation).toEqual({
      command: 'deploy',
      image: 'agent-runtime/runtime:x',
      yes: true,
    });
    expect(parseArgs(['auth', '--offline', 'mcp', 'set', 'repo-token'], env).invocation).toEqual({
      command: 'auth',
      offline: true,
      args: ['mcp', 'set', 'repo-token'],
    });
    for (const argv of [
      ['logs', '--volumes'],
      ['logs', 'web'],
      ['down', '-v'],
      ['down', '--rmi', 'all'],
      ['stop', 'postgres'],
      ['deploy'],
      ['deploy', '--image', 'x;rm'],
      ['recreate', '--force'],
      ['tailscale', 'logout'],
      ['migrate-config'],
      ['compose', 'down', '-v'],
    ]) {
      expect(() => parseArgs(argv, env)).toThrow(UsageError);
    }
  });

  test('passes no ambient Compose or deployment variables to Docker', () => {
    expect(
      childEnv({ PATH: '/bin', DOCKER_HOST: 'unix:///x', COMPOSE_FILE: 'x', AGENT_RUNTIME_IMAGE: 'y', SECRET: 'z' }),
    ).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///x' });
  });
});

describe('live:stack lifecycle', () => {
  test('refuses every operation without deployment state, and does not create the state directory', async () => {
    for (const argv of [['start'], ['stop'], ['deploy', '--image', 'agent-runtime/runtime:new', '--yes']]) {
      await expect(run(argv)).rejects.toThrow('no deployment state');
    }
    expect(existsSync(stateDir)).toBe(false);
    expect(docker.composeCalls()).toEqual([]);
  });

  test('refuses an environment file other users can read', async () => {
    adopt();
    chmodSync(join(stateDir, 'compose.env'), 0o644);
    await expect(run(['stop'])).rejects.toThrow(StateError);
    expect(docker.composeCalls()).toEqual([]);
  });

  test('targets only the live project, the base Compose file and the selected image', async () => {
    adopt();
    await run(['stop']);
    const [call] = docker.calls.filter((item) => item.argv[1] === 'compose');
    expect(call?.argv.slice(0, COMPOSE_PREFIX)).toEqual([
      'docker',
      'compose',
      '-p',
      PROJECT,
      '--project-directory',
      repoRoot,
      '--env-file',
      join(stateDir, 'compose.env'),
      '-f',
      COMPOSE_FILE,
    ]);
    expect(call?.options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/owner',
      AGENT_RUNTIME_IMAGE: deployTag(RUNTIME_OLD),
    });
    expect(locks).toEqual([join(stateDir, 'management.lock')]);
  });

  test('stop, start, restart and recreate never build, pull or change the selected image', async () => {
    adopt();
    expect(await run(['stop'])).toBe(0);
    expect(await run(['start'])).toBe(0);
    expect(await run(['stop', 'runtime'])).toBe(0);
    expect(await run(['start'])).toBe(0);
    expect(await run(['restart'])).toBe(0);
    expect(await run(['recreate'])).toBe(0);
    expect(docker.composeCalls()).toEqual([
      ['stop', '-t', '30'],
      ['start'],
      ['stop', '-t', '30', 'runtime'],
      ['start'],
      ['restart', '-t', '30', 'runtime'],
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'runtime'],
    ]);
    expect(docker.calls.some((call) => call.argv[1] === 'build' || call.argv[1] === 'pull')).toBe(false);
    expect(docker.containers.get('runtime')?.imageId).toBe(RUNTIME_OLD);
    expect(readState().images.runtime).toBe(RUNTIME_OLD);
  });

  test('start does not create missing containers', async () => {
    adopt();
    docker.containers.delete('runtime');
    await expect(run(['start'])).rejects.toThrow(`deploy --image ${RUNTIME_OLD}`);
    expect(docker.composeCalls()).toEqual([]);
  });

  test('start stops a runtime left in a stopped Tailscale container’s namespace first', async () => {
    adopt();
    (docker.containers.get('tailscale') as FakeContainer).status = 'exited';
    expect(await run(['start'])).toBe(0);
    expect(docker.composeCalls()).toEqual([['stop', '-t', '30', 'runtime'], ['start']]);
  });

  test('start reports a runtime that does not become ready', async () => {
    adopt();
    docker.ready = () => false;
    await expect(run(['start'])).rejects.toThrow('runtime readiness did not happen within 10 seconds');
  });

  test('down needs confirmation and keeps every volume', async () => {
    adopt();
    await expect(run(['down'])).rejects.toThrow('--yes');
    await expect(run(['down'], { interactive: true, prompt: async () => false })).rejects.toThrow('cancelled');
    expect(docker.composeCalls()).toEqual([]);
    expect(await run(['down', '--yes'])).toBe(0);
    expect(docker.composeCalls()).toEqual([['down', '-t', '30']]);
    expect(readState().images.runtime).toBe(RUNTIME_OLD);
  });

  test('status reports the selected image, readiness and the node without secrets', async () => {
    adopt();
    expect(await run(['status'])).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('url        https://agent-runtime-live.example.ts.net');
    expect(text).toContain(`selected   ${RUNTIME_OLD}`);
    expect(text).toContain('readiness  ready');
    expect(text).toContain('tailscale  Running as agent-runtime-live.example.ts.net');
    expect(text).not.toContain(SECRET);
    expect(locks).toEqual([]);
  });
});

describe('live:stack build and deploy', () => {
  test('build makes a uniquely tagged production image and deploys nothing', async () => {
    clock = Date.UTC(2026, 10, 9, 12, 30, 0);
    expect(await run(['build'])).toBe(0);
    const build = docker.calls.find((call) => call.argv[1] === 'build');
    expect(build?.argv).toEqual([
      'docker',
      'build',
      '--target',
      'runtime',
      '--file',
      join(repoRoot, 'Dockerfile'),
      '--tag',
      'agent-runtime/runtime:release-20261109T123000-abc123def456',
      repoRoot,
    ]);
    expect(docker.composeCalls()).toEqual([]);
  });

  test('deploy refuses absent and non-production images, and missing volumes, before changing anything', async () => {
    adopt();
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:absent', '--yes'])).rejects.toThrow('not present');
    docker.images.set('agent-runtime/runtime:dev', { id: imageId(7), cmd: ['bun', 'x.ts'], env: [] });
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:dev', '--yes'])).rejects.toThrow('not a production');
    docker.volumes.delete(VOLUMES.postgres);
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:new', '--yes'])).rejects.toThrow('create it empty');
    expect(docker.composeCalls()).toEqual([]);
    expect(readState().pending).toBeUndefined();
  });

  test('deploy needs confirmation, recreates only the runtime and commits after readiness', async () => {
    adopt();
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:new'])).rejects.toThrow('--yes');
    expect(
      await run(['deploy', '--image', 'agent-runtime/runtime:new'], { interactive: true, prompt: async () => true }),
    ).toBe(0);
    expect(docker.composeCalls()).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'runtime'],
    ]);
    const up = docker.calls.find((call) => call.argv[1] === 'compose');
    expect(up?.options.env?.AGENT_RUNTIME_IMAGE).toBe(deployTag(RUNTIME_NEW));
    expect(docker.containers.get('runtime')?.imageId).toBe(RUNTIME_NEW);
    expect(readState().images.runtime).toBe(RUNTIME_NEW);
    expect(readState().pending).toBeUndefined();
    output = [];
    expect(await run(['deploy', '--image', 'agent-runtime/runtime:new'])).toBe(0);
    expect(output.join('\n')).toContain('already deployed');
  });

  test('a failed deployment stays recorded, blocks other changes and can be finished or reversed', async () => {
    adopt();
    docker.ready = () => false;
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:new', '--yes'])).rejects.toThrow(
      `To try again: \`bun run live:stack deploy --image ${RUNTIME_NEW}\``,
    );
    expect(readState().images.runtime).toBe(RUNTIME_OLD);
    expect(readState().pending).toMatchObject({
      kind: 'deploy',
      from: RUNTIME_OLD,
      to: RUNTIME_NEW,
      phase: 'runtime-recreated',
    });

    docker.images.set('agent-runtime/runtime:third', production(imageId(9)));
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:third', '--yes'])).rejects.toThrow('did not finish');
    await expect(run(['recreate'])).rejects.toThrow('did not finish');
    await expect(run(['tailscale', 'recover', '--yes'])).rejects.toThrow('did not finish');

    docker.ready = () => true;
    expect(await run(['deploy', '--image', RUNTIME_NEW, '--yes'])).toBe(0);
    expect(readState().images.runtime).toBe(RUNTIME_NEW);
    expect(readState().pending).toBeUndefined();
  });

  test('deploy recreates removed dependencies on their existing volumes from the adopted images', async () => {
    adopt();
    expect(await run(['down', '--yes'])).toBe(0);
    await expect(run(['start'])).rejects.toThrow('does not create containers');
    expect(await run(['deploy', '--image', RUNTIME_OLD, '--yes'])).toBe(0);
    expect(docker.composeCalls().slice(1)).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'tailscale'],
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'postgres'],
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'runtime'],
    ]);
    expect(docker.containers.get('runtime')?.networkMode).toBe(`container:${docker.containers.get('tailscale')?.id}`);
  });

  test('deploy refuses to create a dependency whose pinned image changed', async () => {
    adopt();
    await run(['down', '--yes']);
    docker.images.set(await configuredImage('postgres'), { id: imageId(42), cmd: [], env: [] });
    await expect(run(['deploy', '--image', RUNTIME_OLD, '--yes'])).rejects.toThrow('different postgres image');
  });
});

describe('live:stack Tailscale', () => {
  test('recover stops the runtime, recreates Tailscale, then reattaches the runtime', async () => {
    adopt();
    const before = docker.containers.get('tailscale')?.id;
    expect(await run(['tailscale', 'recover', '--yes'])).toBe(0);
    expect(docker.composeCalls()).toEqual([
      ['stop', '-t', '30', 'runtime'],
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'tailscale'],
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'runtime'],
    ]);
    const after = docker.containers.get('tailscale')?.id;
    expect(after).not.toBe(before);
    expect(docker.containers.get('runtime')?.networkMode).toBe(`container:${after}`);
    expect(docker.volumes.has(VOLUMES.tailscale)).toBe(true);
    expect(readState().pending).toBeUndefined();
  });

  test('an unenrolled node stops recovery; running it again continues without recreating Tailscale again', async () => {
    adopt();
    docker.backendState = 'NeedsLogin';
    await expect(run(['tailscale', 'recover', '--yes'])).rejects.toThrow('tailscale enroll');
    expect(readState().pending).toMatchObject({ kind: 'tailscale-recover', phase: 'tailscale-recreated' });
    await expect(run(['deploy', '--image', 'agent-runtime/runtime:new', '--yes'])).rejects.toThrow('recovery');

    output = [];
    expect(await run(['tailscale', 'enroll'])).toBe(0);
    expect(output.join('\n')).toContain('https://login.tailscale.com/a/xyz');

    docker.backendState = 'Running';
    docker.calls = [];
    expect(await run(['tailscale', 'recover', '--yes'])).toBe(0);
    expect(docker.composeCalls()).toEqual([
      ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'runtime'],
    ]);
    expect(readState().pending).toBeUndefined();
  });

  test('status reports the node, Serve and the runtime attachment', async () => {
    adopt();
    expect(await run(['tailscale', 'status'])).toBe(0);
    expect(output).toContain('runtime    attached to this container');
    expect(output).toContain('https://agent-runtime-live.example.ts.net (tailnet only)');
  });
});

describe('live:stack auth', () => {
  test('runs the bundled command in the running runtime', async () => {
    adopt();
    expect(await run(['auth', 'anthropic', 'status'])).toBe(0);
    const call = docker.calls.find((item) => item.argv[1] === 'exec' && item.argv.includes('dist/auth.js'));
    expect(call?.argv).toEqual([
      'docker',
      'exec',
      '-i',
      docker.containers.get('runtime')?.id as string,
      'bun',
      'dist/auth.js',
      'anthropic',
      'status',
    ]);
    expect(call?.options.stdin).toBe(true);
  });

  test('offline runs a one-off container only while the runtime is stopped', async () => {
    adopt();
    await expect(run(['auth', '--offline', 'mcp', 'set', 'repo-token'])).rejects.toThrow('stop it first');
    await run(['stop', 'runtime']);
    await expect(run(['auth', 'anthropic', 'status'])).rejects.toThrow('auth --offline');
    expect(await run(['auth', '--offline', 'mcp', 'set', 'repo-token'])).toBe(0);
    expect(docker.composeCalls().at(-1)).toEqual([
      'run',
      '--rm',
      '--no-deps',
      '--pull',
      'never',
      '-T',
      'runtime',
      'bun',
      'dist/auth.js',
      'mcp',
      'set',
      'repo-token',
    ]);
  });
});

describe('live:stack management lock', () => {
  test('admits one holder at a time and frees on release', async () => {
    const path = join(dir, 'management.lock');
    const first = await acquireFileLock(path);
    await expect(acquireFileLock(path)).rejects.toThrow(LockBusyError);
    await first.release();
    const second = await acquireFileLock(path);
    await second.release();
    expect(existsSync(path)).toBe(true);
  });
});

test('operation errors are distinct from usage errors', () => {
  expect(new OperationError('x')).not.toBeInstanceOf(UsageError);
});
