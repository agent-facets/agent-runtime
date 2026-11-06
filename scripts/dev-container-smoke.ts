// Isolated smoke test of the development deployment (compose.dev.yaml). It builds the development image and starts a
// uniquely named Compose project with fresh volumes, an inert Tailscale namespace holder and internal networks only,
// running from a disposable copy of the package sources — so it edits that copy, never the checkout. It never reads
// the owner's environment, joins a tailnet or contacts model providers.
//
// It shows, through the runtime's own listener: the console page and its live-update channel pass the request checks;
// a console edit reaches open pages without restarting the backend or disturbing recorded runs; a backend edit takes
// effect by a clean backend restart, without an image rebuild, with recorded runs reconciled as documented; a
// dependency change is refused until the image is rebuilt; and stopping the container stops the backend cleanly.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeLaunch, fixtureEnv, runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:dev-container', process.argv.slice(2), process.env);

const id = crypto.randomUUID().slice(0, 8);
const project = `agent-runtime-devsmoke-${id}`;
const image = `agent-runtime/runtime:devsmoke-${id}`;
const fixtureDir = mkdtempSync(join(tmpdir(), `${project}-`));
const sourceDir = join(fixtureDir, 'source');
const workspaceDir = join(fixtureDir, 'workspace');
const programsDir = join(fixtureDir, 'programs');
const envFile = join(fixtureDir, 'empty.env');
const configFile = join(fixtureDir, 'config.json');
const overlayFile = join(fixtureDir, 'compose.fixture.yaml');
const PUBLIC_HOST = 'agent-runtime.devsmoke.invalid';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const SOURCE_PACKAGES = ['runtime', 'contracts', 'anthropic-subscription', 'ui'];
const MANIFESTS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  ...['anthropic-subscription', 'contracts', 'facet-adapter', 'mcp-programs', 'runtime', 'ui'].map(
    (name) => `packages/${name}/package.json`,
  ),
];

// The disposable source copy the container runs, and the manifests it checks its dependencies against.
for (const name of SOURCE_PACKAGES) {
  cpSync(join(repoRoot, 'packages', name, 'src'), join(sourceDir, 'packages', name, 'src'), { recursive: true });
}
for (const path of MANIFESTS) cpSync(join(repoRoot, path), join(sourceDir, path));
mkdirSync(workspaceDir);
mkdirSync(programsDir);
writeFileSync(join(workspaceDir, 'README.md'), 'synthetic workspace fixture\n');
writeFileSync(envFile, '');
writeFileSync(
  configFile,
  JSON.stringify({
    version: 1,
    workspace: { id: 'smoke', label: 'Smoke workspace', root: '/workspace' },
    providers: { anthropic: { authMode: 'subscription', model: 'smoke-model', profileId: 'claude-cli-2.1.280' } },
    defaultProvider: 'anthropic',
  }),
);
// Same mount targets as compose.dev.yaml, so these binds replace its checkout binds; plus the fixture helpers.
const bind = (source: string, target: string) =>
  `      - { type: bind, source: ${JSON.stringify(source)}, target: ${JSON.stringify(target)}, read_only: true }`;
writeFileSync(
  overlayFile,
  [
    'services:',
    '  runtime:',
    '    volumes:',
    ...SOURCE_PACKAGES.map((name) => bind(join(sourceDir, 'packages', name, 'src'), `/repo/packages/${name}/src`)),
    ...MANIFESTS.map((path) => bind(join(sourceDir, path), `/repo/${path}`)),
    bind(join(repoRoot, 'tests'), '/repo/tests'),
    '',
  ].join('\n'),
);

const env = fixtureEnv(process.env, {
  AGENT_RUNTIME_WORKSPACE: workspaceDir,
  AGENT_RUNTIME_CONFIG: configFile,
  AGENT_RUNTIME_PUBLIC_HOST: PUBLIC_HOST,
  AGENT_RUNTIME_DEV_IMAGE: image,
  AGENT_RUNTIME_FIXTURE_PROGRAMS: programsDir,
  POSTGRES_PASSWORD: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
});
const compose = [
  'docker',
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '-f',
  'compose.yaml',
  '-f',
  'compose.dev.yaml',
  '-f',
  'tests/container/compose.smoke.yaml',
  '-f',
  overlayFile,
];
const run = (cmd: string[], allowFailure = false) => runCommand(cmd, { env, cwd: repoRoot, allowFailure });
const exec = (...cmd: string[]) => run([...compose, 'exec', '-T', 'runtime', ...cmd], true);

class CheckFailed extends Error {}
let failures = 0;
async function check(name: string, body: () => Promise<void>) {
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw new CheckFailed();
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One request from inside the runtime's namespace, as Serve would forward it. */
async function request(path: string, headers: Record<string, string> = { host: PUBLIC_HOST }) {
  const script = `const r = await fetch(${JSON.stringify(`http://127.0.0.1:3000${path}`)}, { headers: ${JSON.stringify(headers)} });
    console.log(JSON.stringify({ status: r.status, csp: r.headers.get('content-security-policy'), body: await r.text() }));`;
  const result = await exec('bun', '-e', script);
  if (result.code !== 0) throw new Error(`request ${path} failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { status: number; csp: string; body: string };
}

/** Opens the live-update channel from inside the namespace with the given Origin; reports what happened. */
const channelScript = (origin: string, waitForUpdate: boolean) => `
  const page = await (await fetch('http://127.0.0.1:3000/', { headers: { host: ${JSON.stringify(PUBLIC_HOST)} } })).text();
  const src = page.match(/src="([^"]+)"/)?.[1] ?? '';
  const ws = new WebSocket('ws://127.0.0.1:3000/_bun/hmr', { headers: { host: ${JSON.stringify(PUBLIC_HOST)}, origin: ${JSON.stringify(origin)} } });
  ws.binaryType = 'arraybuffer';
  const timer = setTimeout(() => { console.log('timeout'); process.exit(0); }, 30000);
  ws.onerror = () => { clearTimeout(timer); console.log('refused'); process.exit(0); };
  ws.onmessage = (event) => {
    const kind = String.fromCharCode(new Uint8Array(event.data)[0]);
    if (kind === 'V') {
      // As Bun's development client does: subscribe, name the page, report its bundle generation.
      ws.send('she'); ws.send('n/'); ws.send('i' + src.slice(-11, -3));
      console.log('connected');
      if (!${waitForUpdate}) { clearTimeout(timer); process.exit(0); }
    } else if (kind === 'u') { clearTimeout(timer); console.log('update'); process.exit(0); }
  };`;

/** How many backends the supervisor has started, from its log. */
const backendStarts = async () =>
  ((await run([...compose, 'logs', '--no-color', 'runtime'])).stdout.match(/dev: backend started/g) ?? []).length;

const fixtureState = async (mode: 'seed' | 'inspect', ...args: string[]) => {
  const result = await exec('bun', '/repo/tests/dev-container/state.ts', mode, ...args);
  if (result.code !== 0) throw new Error(`fixture state ${mode} failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as unknown;
};

const manifestDigest = async () => {
  const script = `const { currentCodeManifest } = await import('/repo/packages/runtime/src/execution/code-manifest.ts');
    const manifests = [await currentCodeManifest('anthropic'), await currentCodeManifest('openai')];
    console.log(new Bun.CryptoHasher('sha256').update(JSON.stringify(manifests)).digest('hex'));`;
  return (await exec('bun', '-e', script)).stdout.trim();
};

interface ReadinessBody {
  checks: { persistence: string; agentExecution: string; console: string };
}
const persistenceReady = (timeoutMs: number) =>
  eventually(
    async () => {
      const ready = await request('/readyz');
      const body = JSON.parse(ready.body) as ReadinessBody;
      return body.checks.persistence === 'ready' ? body : undefined;
    },
    timeoutMs,
    'persistence readiness',
  );

interface Inspection {
  Image: string;
  Config: { Image: string };
  HostConfig: { ReadonlyRootfs: boolean; PortBindings: Record<string, unknown> | null; Init: boolean | null };
  Mounts: { Type: string; Destination: string; Source: string; Name?: string; RW: boolean }[];
  State: { ExitCode: number; Status: string };
}
const inspect = async (service: string) => {
  const ids = (await run([...compose, 'ps', '-a', '-q', service])).stdout.trim();
  return (JSON.parse((await run(['docker', 'inspect', ids])).stdout) as Inspection[])[0] as Inspection;
};

try {
  await check('the development overlay publishes no ports and mounts sources read-only', async () => {
    const rendered = JSON.parse((await run([...compose, 'config', '--format', 'json'])).stdout) as {
      services: Record<
        string,
        {
          ports?: unknown[];
          network_mode?: string;
          build?: { target?: string };
          volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
        }
      >;
    };
    for (const [name, svc] of Object.entries(rendered.services)) {
      assert((svc.ports ?? []).length === 0, `${name} publishes ports`);
    }
    const runtime = rendered.services.runtime;
    assert(runtime?.network_mode === 'service:tailscale', 'the runtime does not share the namespace');
    assert(runtime.build?.target === 'dev', 'the runtime is not built from the development target');
    for (const volume of runtime.volumes ?? []) {
      if (volume.type === 'bind') assert(volume.read_only === true, `${volume.target} is writable`);
    }
    const targets = (runtime.volumes ?? []).map((volume) => volume.target);
    assert(!targets.includes('/repo'), 'the whole checkout is mounted');
    assert(
      !targets.some((target) => /^\/repo\/packages\/[^/]+$/.test(target) || target.includes('node_modules')),
      'a package directory or dependencies are mounted over the image’s own',
    );
  });

  console.log(`building development image ${image}`);
  await run([...compose, 'build', 'runtime']);
  console.log(`starting isolated project ${project}`);
  await run([...compose, 'up', '--detach', '--wait', '--wait-timeout', '180']);

  await check('the runtime is isolated: its own volumes, no ports, read-only root, non-root', async () => {
    const runtime = await inspect('runtime');
    assert(runtime.HostConfig.ReadonlyRootfs, 'the root filesystem is writable');
    assert(runtime.HostConfig.Init === true, 'no init process reaps the backend’s children');
    assert(Object.keys(runtime.HostConfig.PortBindings ?? {}).length === 0, 'the runtime has port bindings');
    const uid = (await exec('id', '-u')).stdout.trim();
    assert(uid !== '' && uid !== '0', `the runtime runs as uid ${uid}`);
    for (const service of ['runtime', 'tailscale', 'postgres']) {
      for (const mount of (await inspect(service)).Mounts) {
        if (mount.Type === 'volume') {
          assert(mount.Name?.startsWith(`${project}_`), `${service} uses volume ${mount.Name} of another project`);
        } else if (mount.Type === 'bind') {
          assert(
            mount.Source.startsWith(fixtureDir) || mount.Source.startsWith(repoRoot),
            `${service} mounts ${mount.Source}`,
          );
          assert(!mount.RW || mount.Destination === '/tmp', `${service} mounts ${mount.Destination} writable`);
        }
      }
    }
  });

  await check('persistence and agent execution become ready behind the development console', async () => {
    const ready = await persistenceReady(60_000);
    assert(ready.checks.agentExecution === 'ready' && ready.checks.console === 'ready', JSON.stringify(ready.checks));
  });

  await check('the development console passes the request checks and allows only its own paths', async () => {
    const page = await request('/');
    assert(page.status === 200 && page.body.includes('data-bun-dev-server-script'), `page: ${page.status}`);
    assert(page.csp.includes(`connect-src 'self' wss://${PUBLIC_HOST}`), `page CSP: ${page.csp}`);
    assert(/script-src 'self' blob: 'sha256-[A-Za-z0-9+/=]+'/.test(page.csp), `page CSP: ${page.csp}`);
    assert((await request('/', { host: 'forged.invalid' })).status === 403, 'a forged Host was served');
    const script = page.body.match(/src="([^"]+)"/)?.[1] ?? '';
    assert((await request(script, { host: 'forged.invalid' })).status === 403, 'an asset was served to a forged Host');
    assert((await request(script)).status === 200, 'the page script was not served');
    for (const path of ['/packages/runtime/src/config.ts', '/.well-known/appspecific/com.chrome.devtools.json']) {
      assert((await request(path)).status === 404, `${path} was served`);
    }
    for (const origin of ['https://foreign.invalid', 'null']) {
      const opened = (await exec('bun', '-e', channelScript(origin, false))).stdout.trim();
      assert(opened === 'refused', `the live-update channel opened for Origin ${origin}: ${opened}`);
    }
    assert(
      (await exec('bun', '-e', channelScript(PUBLIC_ORIGIN, false))).stdout.trim() === 'connected',
      'the live-update channel did not open for the console’s own origin',
    );
  });

  let seeded = { working: '', waiting: '' };
  let epoch = '';
  let manifest = '';
  await check('recorded runs are prepared: one working, one waiting on a question', async () => {
    seeded = (await fixtureState('seed')) as typeof seeded;
    const state = (await fixtureState('inspect', seeded.working, seeded.waiting)) as {
      epoch: string;
      states: Record<string, string>;
    };
    epoch = state.epoch;
    assert(state.states[seeded.working] === 'working' && state.states[seeded.waiting] === 'waiting', 'seeding failed');
    manifest = await manifestDigest();
    assert(/^[0-9a-f]{64}$/.test(manifest), 'no execution-code manifest');
    assert((await backendStarts()) === 1, 'the backend restarted before any edit');
  });

  await check('a console edit reaches open pages without restarting the backend or touching runs', async () => {
    const marker = `devsmoke-${id}`;
    const watcher = Bun.spawn([...compose, 'exec', '-T', 'runtime', 'bun', '-e', channelScript(PUBLIC_ORIGIN, true)], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const chunk of watcher.stdout) lines.push(...new TextDecoder().decode(chunk).split('\n'));
    })();
    await eventually(async () => (lines.includes('connected') ? true : undefined), 20_000, 'the channel to open');
    const styles = join(sourceDir, 'packages', 'ui', 'src', 'styles.css');
    await Bun.write(styles, `${await Bun.file(styles).text()}\n.${marker} { color: green; }\n`);
    await watcher.exited;
    await reading;
    assert(lines.includes('update'), `no live update reached the page: ${lines.join(' ').trim()}`);
    const page = await request('/');
    const stylesheet = page.body.match(/href="(\/_bun\/asset\/[^"]+\.css)"/)?.[1] ?? '';
    assert((await request(stylesheet)).body.includes(marker), 'the served stylesheet lacks the edit');
    assert((await backendStarts()) === 1, 'the console edit restarted the backend');
    const state = (await fixtureState('inspect', seeded.working, seeded.waiting)) as {
      epoch: string;
      states: Record<string, string>;
    };
    assert(state.epoch === epoch, 'runtime ownership changed');
    assert(state.states[seeded.working] === 'working' && state.states[seeded.waiting] === 'waiting', 'runs changed');
    assert((await manifestDigest()) === manifest, 'the console edit changed the execution-code manifest');
  });

  await check('a backend edit takes effect by a clean backend restart, reconciling runs as documented', async () => {
    const marker = `devsmoke-${id}`;
    const server = join(sourceDir, 'packages', 'runtime', 'src', 'server.ts');
    const source = await Bun.file(server).text();
    const original = "GET: guarded(() => json({ status: 'ok' }, 200)),";
    assert(source.includes(original), 'the liveness handler was not found in the source copy');
    await Bun.write(
      server,
      source.replace(original, `GET: guarded(() => json({ status: 'ok', fixture: '${marker}' }, 200)),`),
    );
    await eventually(
      async () => ((await request('/healthz')).body.includes(marker) ? true : undefined),
      60_000,
      'the edited liveness handler',
    );
    await persistenceReady(60_000);
    assert((await backendStarts()) === 2, `backend starts: ${await backendStarts()}`);
    const state = (await fixtureState('inspect', seeded.working, seeded.waiting)) as {
      epoch: string;
      states: Record<string, string>;
    };
    assert(BigInt(state.epoch) > BigInt(epoch), 'the new backend did not take ownership under a later epoch');
    assert(state.states[seeded.working] === 'interrupted', `working run became ${state.states[seeded.working]}`);
    assert(state.states[seeded.waiting] === 'waiting', `waiting run became ${state.states[seeded.waiting]}`);
    const runtime = await inspect('runtime');
    assert(runtime.Config.Image === image, `the runtime now runs ${runtime.Config.Image}`);
  });

  await check('a dependency change stops the backend until the image is rebuilt', async () => {
    const manifestFile = join(sourceDir, 'packages', 'ui', 'package.json');
    const original = await Bun.file(manifestFile).text();
    const changed = JSON.parse(original) as { description?: string };
    changed.description = `devsmoke ${id}`;
    await Bun.write(manifestFile, `${JSON.stringify(changed, null, 2)}\n`);
    await eventually(
      async () => {
        const logs = (await run([...compose, 'logs', '--no-color', 'runtime'])).stdout;
        return logs.includes('dependencies changed since this development image was built') ? true : undefined;
      },
      30_000,
      'the stale-dependency refusal',
    );
    await Bun.write(manifestFile, original);
    await eventually(
      async () => ((await inspect('runtime')).State.Status === 'running' ? await persistenceReady(5_000) : undefined),
      90_000,
      'the runtime to recover once dependencies match again',
    );
  });

  await check('stopping the container stops the backend cleanly', async () => {
    const started = Date.now();
    await run([...compose, 'stop', 'runtime']);
    const runtime = await inspect('runtime');
    assert(runtime.State.ExitCode === 0, `the runtime exited with ${runtime.State.ExitCode}`);
    assert(Date.now() - started < 25_000, 'stopping waited for the kill timeout');
    const logs = (await run([...compose, 'logs', '--no-color', 'runtime'])).stdout;
    assert(logs.includes('dev: stopping') && !logs.includes('unclean stop'), 'the backend did not stop cleanly');
  });
} catch (error) {
  if (!(error instanceof CheckFailed)) {
    failures++;
    console.error(error instanceof Error ? error.message : String(error));
  }
} finally {
  await run([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], true);
  await run(['docker', 'image', 'rm', '--force', image], true);
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} development container smoke check(s) failed`);
  process.exit(1);
}
console.log('development container smoke checks passed');
