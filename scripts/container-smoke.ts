// Isolated container smoke test. Builds the runtime image and starts a uniquely named Compose project
// with fresh volumes, a synthetic workspace, an inert Tailscale namespace holder and internal networks only.
// It never reads the owner's .env, joins a tailnet or contacts model providers.
//
// Runtime facets are exercised with synthetic inputs only: a sealed installation through the optional
// compose.facets.yaml overlay and a test-built MCP program, both mounted read-only, a credential provisioned while the
// runtime is stopped, and explicit inspection of the approved server. No tool is granted and no model is involved.
//
// It ends with an image-rollback rehearsal: a second image built from the same source snapshot, differing only in
// the console page's title, replaces the first over the same database and private-state volumes, and the first is
// then restored. Recorded runs, retained capabilities, credentials and activity must be unchanged throughout. This
// shows a compatible image can be rolled back on preserved storage; it is not a rollback of a live deployment. A
// configuration-only rollback then turns capabilities off over the same storage.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPrograms } from '../packages/mcp-programs/src/builder.ts';
import { PROGRAMS } from '../packages/mcp-programs/src/programs.ts';
import { SYNTHETIC_PROGRAMS } from '../packages/mcp-programs/test-support/programs.ts';
import {
  CREDENTIAL_SLOT,
  connectionDigest,
  INSTALLATION_BYTES,
  INSTALLATION_SHA256,
  SERVER,
  SLOT_VALUE,
} from '../tests/support/synthetic-installation.ts';
import { assertSafeLaunch, fixtureEnv, runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:container', process.argv.slice(2), process.env);

const id = crypto.randomUUID().slice(0, 8);
const project = `agent-runtime-smoke-${id}`;
const image = `agent-runtime/runtime:smoke-${id}`;
const nextImage = `agent-runtime/runtime:smoke-${id}-ui-next`;
const fixtureDir = mkdtempSync(join(tmpdir(), `${project}-`));
const workspaceDir = join(fixtureDir, 'workspace');
const buildContext = join(fixtureDir, 'build-context');
const helperDir = join(fixtureDir, 'helper');
const envFile = join(fixtureDir, 'empty.env');
const configFile = join(fixtureDir, 'config.json');
const programsDir = join(fixtureDir, 'programs');
const installationFile = join(fixtureDir, 'installation.json');
const PUBLIC_HOST = 'agent-runtime.smoke.invalid';
const TITLE = '<title>Agent runtime</title>';
const NEXT_TITLE = '<title>Agent runtime (rollback fixture)</title>';
const BUNDLE_PATH = '/etc/agent-runtime/facets/installation.json';
const FIXTURE_PROGRAMS = '/opt/agent-runtime/mcp-fixture';
const SERVER_DIR = `/var/lib/agent-runtime/mcp/${SERVER}`;
await Bun.write(join(workspaceDir, 'README.md'), 'synthetic workspace fixture\n');
await Bun.write(envFile, '');

// Synthetic capability inputs: the test-only server program and the sealed installation declaring it.
const built = await buildPrograms({
  programs: SYNTHETIC_PROGRAMS,
  packageRoot: join(repoRoot, 'packages', 'mcp-programs'),
  outDir: programsDir,
  lockfile: join(repoRoot, 'bun.lock'),
});
const program = built.programs.find((entry) => entry.id === SERVER);
if (program === undefined) throw new Error('the synthetic MCP program was not built');
const programFile = join(programsDir, program.path);
chmodSync(programsDir, 0o755);
chmodSync(dirname(programFile), 0o755);
writeFileSync(installationFile, INSTALLATION_BYTES, { mode: 0o644 });

const nativeConfig = {
  version: 1,
  workspace: { id: 'smoke', label: 'Smoke workspace', root: '/workspace' },
  providers: {
    anthropic: { authMode: 'subscription', model: 'smoke-model', profileId: 'claude-cli-2.1.280' },
    openai: { authMode: 'subscription', model: 'smoke-model', profileId: 'codex-responses-v1' },
  },
  defaultProvider: 'anthropic',
};
// The synthetic server's connection is approved for discovery only: no tool is granted.
const capabilityConfig = {
  ...nativeConfig,
  capabilities: {
    installation: { path: BUNDLE_PATH, sha256: INSTALLATION_SHA256 },
    localPrograms: { [SERVER]: { bundlePath: `${FIXTURE_PROGRAMS}/${program.path}`, sha256: program.sha256 } },
    servers: [
      {
        serverId: SERVER,
        programId: SERVER,
        credentialEnv: { REPO_TOKEN: CREDENTIAL_SLOT },
        approval: { kind: 'approved', serverDigest: connectionDigest(program), tools: [] },
      },
    ],
  },
};
/** Rewrites the mounted configuration in place (a bind-mounted file keeps its inode); read at the next start. */
const writeConfig = (config: object) => writeFileSync(configFile, JSON.stringify(config));
writeConfig(capabilityConfig);

/** Copies what the Docker build context admits (see .dockerignore) into a disposable snapshot. */
function snapshotBuildContext() {
  const patterns = [
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'tsconfig.base.json',
    'Dockerfile',
    '.dockerignore',
    'packages/*/package.json',
    'packages/*/tsconfig.json',
    'packages/*/src/**',
    'packages/anthropic-subscription/THIRD_PARTY_NOTICES.md',
    'packages/anthropic-subscription/licenses/**',
  ];
  for (const pattern of patterns) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true, dot: true })) {
      if (/(^|\/)(node_modules|dist|\.turbo)\//.test(path)) continue;
      mkdirSync(dirname(join(buildContext, path)), { recursive: true });
      copyFileSync(join(repoRoot, path), join(buildContext, path));
    }
  }
}

const env = fixtureEnv(process.env, {
  AGENT_RUNTIME_WORKSPACE: workspaceDir,
  AGENT_RUNTIME_CONFIG: configFile,
  AGENT_RUNTIME_PUBLIC_HOST: PUBLIC_HOST,
  AGENT_RUNTIME_IMAGE: image,
  AGENT_RUNTIME_FACETS: installationFile,
  AGENT_RUNTIME_FIXTURE_PROGRAMS: programsDir,
  POSTGRES_PASSWORD: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
});
const composeBase = ['docker', 'compose', '--project-name', project, '--env-file', envFile, '-f', 'compose.yaml'];
const composeSmoke = [...composeBase, '-f', 'compose.facets.yaml', '-f', 'tests/container/compose.smoke.yaml'];
const run = (cmd: string[], allowFailure = false, stdin?: string) =>
  runCommand(cmd, { env, cwd: repoRoot, allowFailure, ...(stdin === undefined ? {} : { stdin }) });
/** The same, with Compose selecting `runtimeImage` for the runtime service. */
const runWith = (runtimeImage: string, cmd: string[]) =>
  runCommand(cmd, { env: { ...env, AGENT_RUNTIME_IMAGE: runtimeImage }, cwd: repoRoot });

/** A failed check stops the suite: later checks build on the state earlier ones established. */
class CheckFailed extends Error {}
let failures = 0;
async function check(name: string, body: () => Promise<void>) {
  try {
    await body();
    console.log(`(pass) ${name}`);
  } catch (error) {
    failures++;
    console.error(`(fail) ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    throw new CheckFailed();
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Inspection {
  Id: string;
  Image: string;
  Config: { User: string };
  HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; PortBindings: Record<string, unknown> | null };
  NetworkSettings: { Ports: Record<string, unknown> | null; Networks: Record<string, { IPAddress: string }> };
  Mounts: { Destination: string; Source: string; Name?: string; RW: boolean }[];
}

const containerId = async (serviceName: string) =>
  (await run([...composeSmoke, 'ps', '-q', serviceName])).stdout.trim();
const inspect = async (serviceName: string) =>
  (
    JSON.parse((await run(['docker', 'inspect', await containerId(serviceName)])).stdout) as Inspection[]
  )[0] as Inspection;
const exec = (serviceName: string, ...cmd: string[]) => run([...composeSmoke, 'exec', '-T', serviceName, ...cmd], true);
const netNamespace = async (serviceName: string) =>
  (await exec(serviceName, 'readlink', '/proc/self/ns/net')).stdout.trim();
const fetchScript = (url: string, init: RequestInit = {}) =>
  `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async (r) => { console.log(r.status, await r.text()); }, () => process.exit(1))`;

interface ReadinessBody {
  ready: boolean;
  checks: { persistence: string; agentExecution: string; console: string };
}

/** Polls readiness until persistence is ready, tolerating restarts; persistence starts after the listener. */
async function awaitPersistenceReady(timeoutMs: number): Promise<ReadinessBody> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    const ready = await exec('runtime', 'bun', '-e', fetchScript('http://127.0.0.1:3000/readyz'));
    if (ready.stdout.startsWith('503 ') || ready.stdout.startsWith('200 ')) {
      const body = JSON.parse(ready.stdout.slice(4)) as ReadinessBody;
      if (body.checks.persistence === 'ready') return body;
      last = body.checks.persistence;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`persistence did not become ready (last: ${last})`);
}

/** One request from inside the runtime's namespace, as Serve would forward it: status and body. */
async function request(path: string, init: RequestInit = {}) {
  const result = await exec('runtime', 'bun', '-e', fetchScript(`http://127.0.0.1:3000${path}`, init));
  const status = Number(result.stdout.slice(0, 3));
  return { status, body: result.stdout.slice(4) };
}

const ownerEpoch = async () =>
  (
    await exec(
      'postgres',
      'psql',
      '-U',
      'agent_runtime',
      '-d',
      'agent_runtime',
      '-tAc',
      'select epoch from runtime.runtime_owner',
    )
  ).stdout.trim();

try {
  await check('rendered operational configuration publishes no ports', async () => {
    const rendered = JSON.parse((await run([...composeBase, 'config', '--format', 'json'])).stdout) as {
      services: Record<string, { ports?: unknown[]; network_mode?: string }>;
    };
    for (const [name, svc] of Object.entries(rendered.services)) {
      assert((svc.ports ?? []).length === 0, `${name} publishes ports`);
    }
    assert(rendered.services.runtime?.network_mode === 'service:tailscale', 'runtime does not share the namespace');
  });

  await check(
    'the base deployment needs no facet bundle; the facet overlay requires one and mounts it read-only',
    async () => {
      const { AGENT_RUNTIME_FACETS: _bundle, ...withoutBundle } = env;
      const render = (files: string[], renderEnv: Record<string, string>) =>
        runCommand([...files, 'config', '--format', 'json'], { env: renderEnv, cwd: repoRoot, allowFailure: true });
      type Rendered = {
        services: {
          runtime: {
            volumes: { target: string; source: string; read_only?: boolean; bind?: Record<string, unknown> }[];
          };
        };
      };
      const base = await render(composeBase, withoutBundle);
      assert(base.code === 0, `the base deployment did not render without a bundle: ${base.stderr.trim()}`);
      const baseVolumes = (JSON.parse(base.stdout) as Rendered).services.runtime.volumes;
      assert(!baseVolumes.some((volume) => volume.target === BUNDLE_PATH), 'the base deployment mounts a facet bundle');
      const overlay = [...composeBase, '-f', 'compose.facets.yaml'];
      const unset = await render(overlay, withoutBundle);
      assert(
        unset.code !== 0 && unset.stderr.includes('AGENT_RUNTIME_FACETS'),
        'the overlay rendered without a bundle',
      );
      const selected = await render(overlay, env);
      const mount = (JSON.parse(selected.stdout) as Rendered).services.runtime.volumes.find(
        (volume) => volume.target === BUNDLE_PATH,
      );
      assert(
        mount?.source === installationFile && mount.read_only === true && mount.bind?.create_host_path === false,
        `unexpected facet bundle mount: ${JSON.stringify(mount)}`,
      );
    },
  );

  console.log(`building images ${image} and ${nextImage} from one source snapshot`);
  snapshotBuildContext();
  await run(['docker', 'build', '--tag', image, buildContext]);
  const page = join(buildContext, 'packages', 'ui', 'src', 'index.html');
  const html = await Bun.file(page).text();
  if (!html.includes(TITLE)) throw new Error('the console page title was not found in the build snapshot');
  await Bun.write(page, html.replace(TITLE, NEXT_TITLE));
  await run(['docker', 'build', '--tag', nextImage, buildContext]);
  const imageId = async (tag: string) =>
    (await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag])).stdout.trim();
  const [firstId, nextId] = [await imageId(image), await imageId(nextImage)];

  await check('the rollback images are distinct but ship identical execution manifests', async () => {
    assert(firstId.startsWith('sha256:') && nextId.startsWith('sha256:'), 'image IDs were not captured');
    assert(firstId !== nextId, 'the two images are the same image');
    const manifests = await Promise.all(
      [firstId, nextId].map(
        async (imageRef) =>
          (
            await run([
              'docker',
              'run',
              '--rm',
              '--network',
              'none',
              '--entrypoint',
              'cat',
              imageRef,
              '/app/dist/execution-manifest.json',
            ])
          ).stdout,
      ),
    );
    const [first, next] = manifests.map((text) => JSON.parse(text) as { providers: Record<string, unknown> });
    assert(
      JSON.stringify(Object.keys(first?.providers ?? {}).sort()) === JSON.stringify(['anthropic', 'openai']),
      'the first image does not ship both provider manifests',
    );
    for (const provider of ['anthropic', 'openai']) {
      assert(
        JSON.stringify(first?.providers[provider]) === JSON.stringify(next?.providers[provider]),
        `the ${provider} execution manifest differs between the images`,
      );
    }
  });

  await check('the image ships only its selected MCP programs, digest-named, and no test server', async () => {
    const script = `const root = '/opt/agent-runtime/mcp';
      const manifest = await Bun.file(root + '/manifest.json').json();
      const files = [...new Bun.Glob('**/*').scanSync({ cwd: root, onlyFiles: true, dot: true })].sort();
      const problems = [];
      for (const entry of manifest.programs) {
        const bytes = await Bun.file(root + '/' + entry.path).bytes();
        const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
        if (digest !== entry.sha256 || entry.path !== entry.id + '/' + entry.sha256 + '.js') problems.push(entry.id);
      }
      console.log(JSON.stringify({ ids: manifest.programs.map((p) => p.id).sort(),
        paths: manifest.programs.map((p) => p.path), files, problems }));`;
    const shipped = JSON.parse(
      (await run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'bun', firstId, '-e', script])).stdout,
    ) as { ids: string[]; paths: string[]; files: string[]; problems: string[] };
    const selected = PROGRAMS.map((entry) => entry.id).sort();
    assert(JSON.stringify(shipped.ids) === JSON.stringify(selected), `shipped programs: ${shipped.ids.join(', ')}`);
    assert(!shipped.ids.includes(SERVER), 'the synthetic test server shipped in the image');
    assert(shipped.problems.length === 0, `programs with a wrong digest or path: ${shipped.problems.join(', ')}`);
    assert(
      JSON.stringify(shipped.files) === JSON.stringify(['manifest.json', ...shipped.paths].sort()),
      `unexpected files beside the programs: ${shipped.files.join(', ')}`,
    );
  });

  console.log(`starting isolated project ${project}`);
  await run([...composeSmoke, 'up', '--detach', '--wait', '--wait-timeout', '180']);

  await check('runtime shares the Tailscale network namespace', async () => {
    const [runtime, holder] = await Promise.all([inspect('runtime'), inspect('tailscale')]);
    assert(runtime.HostConfig.NetworkMode === `container:${holder.Id}`, 'unexpected runtime network mode');
    const [a, b] = await Promise.all([netNamespace('runtime'), netNamespace('tailscale')]);
    assert(a !== '' && a === b, `namespace mismatch: ${a} vs ${b}`);
  });

  await check('no container publishes ports', async () => {
    for (const name of ['runtime', 'tailscale', 'postgres']) {
      const info = await inspect(name);
      assert(Object.keys(info.HostConfig.PortBindings ?? {}).length === 0, `${name} has port bindings`);
      const published = Object.values(info.NetworkSettings.Ports ?? {}).filter((binding) => binding !== null);
      assert(published.length === 0, `${name} publishes ports`);
    }
  });

  await check('runtime is non-root with a read-only root filesystem', async () => {
    const info = await inspect('runtime');
    assert(info.HostConfig.ReadonlyRootfs, 'root filesystem is writable');
    const uid = (await exec('runtime', 'id', '-u')).stdout.trim();
    assert(uid !== '' && uid !== '0', `runtime runs as uid ${uid}`);
  });

  await check('writes are limited to private state and scratch space', async () => {
    assert((await exec('runtime', 'touch', '/app/probe')).code !== 0, 'application directory is writable');
    assert((await exec('runtime', 'touch', '/workspace/probe')).code !== 0, 'workspace is writable');
    for (const path of ['/opt/agent-runtime/mcp/probe', `${FIXTURE_PROGRAMS}/probe`, BUNDLE_PATH]) {
      assert((await exec('runtime', 'touch', path)).code !== 0, `${path} is writable`);
    }
    assert((await exec('runtime', 'cat', '/workspace/README.md')).stdout.includes('synthetic'), 'workspace unreadable');
    for (const path of ['/var/lib/agent-runtime/probe', '/tmp/probe']) {
      const result = await exec('runtime', 'sh', '-c', `touch ${path} && rm ${path}`);
      assert(result.code === 0, `${path} is not writable`);
    }
    const mode = (await exec('runtime', 'stat', '-c', '%a %U', '/var/lib/agent-runtime')).stdout.trim();
    assert(mode === '700 bun', `unexpected state directory mode/owner: ${mode}`);
  });

  await check('service state is not cross-mounted', async () => {
    const runtime = await inspect('runtime');
    const destinations = runtime.Mounts.map((mount) => mount.Destination).sort();
    const expected = [
      '/etc/agent-runtime/config.json',
      BUNDLE_PATH,
      FIXTURE_PROGRAMS,
      '/var/lib/agent-runtime',
      '/workspace',
    ];
    assert(
      JSON.stringify(destinations) === JSON.stringify([...expected, '/tmp'].sort()) ||
        JSON.stringify(destinations) === JSON.stringify(expected.sort()),
      `unexpected runtime mounts: ${destinations.join(', ')}`,
    );
    assert(runtime.Mounts.find((m) => m.Destination === '/workspace')?.RW === false, 'workspace mount is writable');
    const config = runtime.Mounts.find((m) => m.Destination === '/etc/agent-runtime/config.json');
    assert(config?.RW === false, 'configuration mount is writable');
    for (const destination of [BUNDLE_PATH, FIXTURE_PROGRAMS]) {
      assert(runtime.Mounts.find((m) => m.Destination === destination)?.RW === false, `${destination} is writable`);
    }
  });

  await check('loopback health and readiness respond inside the namespace', async () => {
    const health = await exec('runtime', 'bun', '-e', fetchScript('http://127.0.0.1:3000/healthz'));
    assert(health.stdout.startsWith('200 '), `healthz: ${health.stdout || health.stderr}`);
    const body = await awaitPersistenceReady(60_000);
    assert(body.checks.agentExecution === 'ready' && body.checks.console === 'ready', 'execution or console not ready');
    assert(body.ready, 'readiness does not report ready');
    assert((await ownerEpoch()) === '1', 'unexpected initial owner epoch');
  });

  await check('the console and API answer only the configured address and same-origin changes', async () => {
    const publicHost = { host: PUBLIC_HOST };
    const origin = `https://${PUBLIC_HOST}`;
    const page = await request('/', { headers: publicHost });
    assert(page.status === 200 && page.body.includes('<div id="root"></div>'), `console page: ${page.status}`);
    assert((await request('/', { headers: { host: 'evil.example' } })).status === 403, 'forged Host accepted');
    assert((await request('/api/v1/options', { headers: publicHost })).status === 200, 'options unavailable');
    const start = (headers: Record<string, string>) =>
      request('/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ requestId: crypto.randomUUID(), goal: 'Smoke.', provider: 'anthropic' }),
      });
    for (const headers of [
      publicHost,
      { ...publicHost, origin: 'null' },
      { ...publicHost, origin: 'https://evil.example' },
    ]) {
      assert((await start(headers)).status === 403, `a change was accepted from ${JSON.stringify(headers)}`);
    }
    // Same-origin and well-formed, but the provider has no authorization here: refused before any work.
    const refused = await start({ ...publicHost, origin });
    assert(refused.status === 409 && refused.body.includes('provider_unavailable'), `start: ${refused.status}`);
  });

  await check('only the console’s own files are served, never workspace, state or application files', async () => {
    for (const path of [
      '/README.md',
      '/workspace/README.md',
      '/var/lib/agent-runtime/credentials',
      '/main.js',
      '/execution-manifest.json',
      '/../etc/passwd',
    ]) {
      const response = await request(path, { headers: { host: PUBLIC_HOST } });
      assert(response.status === 404, `${path} answered ${response.status}`);
      assert(!response.body.includes('synthetic workspace fixture'), `${path} exposed workspace content`);
    }
  });

  await check('the image ships the OpenAI adapter, without the retired Codex request wrapper', async () => {
    // Present: the device login and the subscription endpoint. Absent: what only the retired wrapper sent or logged
    // (a Codex client identity, its routing header, its byte-stream diagnostic).
    const present = ['/api/accounts/deviceauth/usercode', 'chatgpt.com/backend-api/codex'];
    const retired = ['codex_exec', 'x-codex-routing-hint', 'model_stream_incomplete'];
    const scan = await exec(
      'runtime',
      'bun',
      '-e',
      `const present = ${JSON.stringify(present)}; const retired = ${JSON.stringify(retired)};
       const hits = []; const found = new Set(); const manifests = []; let files = 0;
       for (const path of new Bun.Glob('**/*').scanSync({ cwd: '/app', onlyFiles: true })) {
         files++;
         const text = await Bun.file('/app/' + path).text();
         for (const marker of retired) if (text.includes(marker)) hits.push(path + ': ' + marker);
         for (const marker of present) if (text.includes(marker)) found.add(marker);
         if (path.endsWith('execution-manifest.json')) manifests.push(Object.keys(JSON.parse(text).providers).sort());
       }
       console.log(JSON.stringify({ files, hits, found: [...found].sort(), manifests }));`,
    );
    const result = JSON.parse(scan.stdout) as { files: number; hits: string[]; found: string[]; manifests: string[][] };
    assert(result.files > 0, 'no application files were scanned');
    assert(result.hits.length === 0, `retired OpenAI wrapper code shipped: ${result.hits.join(', ')}`);
    assert(result.found.length === present.length, `the OpenAI adapter is missing: ${result.found.join(', ')}`);
    assert(
      JSON.stringify(result.manifests) === JSON.stringify([['anthropic', 'openai']]),
      `unexpected execution manifests: ${JSON.stringify(result.manifests)}`,
    );
  });

  const helper = await Bun.build({
    entrypoints: ['rollback-state.ts', 'mcp-state.ts'].map((file) => join(repoRoot, 'tests', 'container', file)),
    target: 'bun',
    outdir: helperDir,
    naming: '[name].[ext]',
  });
  if (!helper.success) throw new Error(`the fixture helpers did not build: ${helper.logs.join('\n')}`);
  chmodSync(helperDir, 0o755);
  for (const file of ['rollback-state.js', 'mcp-state.js']) chmodSync(join(helperDir, file), 0o644);
  /** Runs a helper in a one-off container of `runtimeImage`, on the runtime's own volumes, mounts and namespace. */
  const runHelper = async (runtimeImage: string, file: string, args: string[]) => {
    const result = await runWith(runtimeImage, [
      ...composeSmoke,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--volume',
      `${helperDir}:/fixture:ro`,
      '--entrypoint',
      'bun',
      'runtime',
      `/fixture/${file}`,
      ...args,
    ]);
    assert(!result.stdout.includes(SLOT_VALUE) && !result.stderr.includes(SLOT_VALUE), `${file} printed a credential`);
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as unknown;
  };
  const fixtureState = (runtimeImage: string, mode: 'seed' | 'inspect') =>
    runHelper(runtimeImage, 'rollback-state.js', [mode]);

  // --- Runtime facets: a sealed bundle and a test-built program, read-only -------------------------------------

  const publicHost = { host: PUBLIC_HOST };
  const sameOrigin = { ...publicHost, origin: `https://${PUBLIC_HOST}`, 'content-type': 'application/json' };
  const capabilities = async () =>
    JSON.parse((await request('/api/v1/capabilities', { headers: publicHost })).body) as {
      kind: string;
      catalogRevision?: string;
    };
  const discover = () =>
    request(`/api/v1/capabilities/servers/${SERVER}/discover`, {
      method: 'POST',
      headers: sameOrigin,
      body: JSON.stringify({ catalogRevision: INSTALLATION_SHA256 }),
    });
  /** What the synthetic server itself recorded in its private home directory. */
  const witness = async () => {
    const log = await exec('runtime', 'cat', `${SERVER_DIR}/home/witness.log`);
    const lines = log.code === 0 ? log.stdout.trim().split('\n') : [];
    return {
      spawns: lines.filter((line) => line.startsWith('spawn ')).map((line) => line.slice('spawn '.length)),
      lists: lines.filter((line) => line === 'list').length,
      calls: lines.filter((line) => line.startsWith('call ')).length,
    };
  };
  /** The operator's `auth mcp` command in a one-off runtime container. */
  const mcpAuth = (args: string[], stdin?: string) =>
    run(
      [...composeSmoke, 'run', '--rm', '--no-deps', '-T', 'runtime', 'bun', 'dist/auth.js', 'mcp', ...args],
      true,
      stdin,
    );
  const slotDigest = async () =>
    (await exec('runtime', 'sha256sum', `/var/lib/agent-runtime/mcp-credentials/${CREDENTIAL_SLOT}.json`)).stdout.split(
      ' ',
    )[0];
  const startRuntime = async () => {
    await run([...composeSmoke, 'up', '--detach', '--wait', '--wait-timeout', '120', '--no-deps', 'runtime']);
    await awaitPersistenceReady(120_000);
  };
  interface ServerState {
    launch: { command: string; args: string[]; cwd: string };
    reported: { cwd: string; home: string; tmpdir: string; names: string[] };
    directories: Record<'root' | 'home' | 'tmp', { mode: string; uid: number }>;
    uid: number;
    recalled?: string;
    spawns: number;
  }
  /** Where the server ran and with what environment; the same for every connection. */
  function assertPlacement(state: ServerState) {
    const programPath = `${FIXTURE_PROGRAMS}/${program?.path}`;
    assert(
      state.launch.command.endsWith('/bun') &&
        JSON.stringify(state.launch.args) ===
          JSON.stringify(['--config=/dev/null', '--no-install', '--no-env-file', programPath]),
      `unexpected launch: ${JSON.stringify(state.launch)}`,
    );
    assert(state.launch.cwd === SERVER_DIR && state.reported.cwd === SERVER_DIR, `cwd: ${state.reported.cwd}`);
    assert(state.reported.home === `${SERVER_DIR}/home`, `HOME: ${state.reported.home}`);
    assert(state.reported.tmpdir === `${SERVER_DIR}/tmp`, `TMPDIR: ${state.reported.tmpdir}`);
    for (const [name, directory] of Object.entries(state.directories)) {
      assert(directory.mode === '700' && directory.uid === state.uid, `${name}: ${JSON.stringify(directory)}`);
    }
    const names = state.reported.names;
    for (const name of ['HOME', 'TMPDIR', 'REPO_MODE', 'REPO_TOKEN']) assert(names.includes(name), `${name} missing`);
    const leaked = names.filter((name) => /^(DATABASE_URL|RUNTIME_|POSTGRES_|ANTHROPIC_|OPENAI_|BUN_)/.test(name));
    assert(leaked.length === 0, `runtime settings reached the server: ${leaked.join(', ')}`);
  }

  await check(
    'the sealed facet bundle is offered from its read-only mount, and reading it starts nothing',
    async () => {
      const catalog = await capabilities();
      assert(catalog.kind === 'ready' && catalog.catalogRevision === INSTALLATION_SHA256, JSON.stringify(catalog));
      assert((await exec('runtime', 'test', '-e', '/var/lib/agent-runtime/mcp')).code !== 0, 'a server was started');
    },
  );

  await check('an MCP credential is stored from standard input only while the runtime is stopped', async () => {
    const whileRunning = await mcpAuth(['set', CREDENTIAL_SLOT], SLOT_VALUE);
    assert(
      whileRunning.code !== 0 && whileRunning.stderr.includes('Stop the runtime first'),
      `set while running: ${whileRunning.code} ${whileRunning.stderr.trim()}`,
    );
    const unchanged = await mcpAuth(['status', CREDENTIAL_SLOT]);
    assert(unchanged.stdout.trim() === `mcp/${CREDENTIAL_SLOT}: missing`, `status: ${unchanged.stdout.trim()}`);
    await run([...composeSmoke, 'stop', '--timeout', '10', 'runtime']);
    const stored = await mcpAuth(['set', CREDENTIAL_SLOT], SLOT_VALUE);
    assert(stored.code === 0, `set while stopped: ${stored.stderr.trim()}`);
    const present = await mcpAuth(['status', CREDENTIAL_SLOT]);
    assert(present.stdout.trim() === `mcp/${CREDENTIAL_SLOT}: present`, `status: ${present.stdout.trim()}`);
    for (const output of [whileRunning, unchanged, stored, present]) {
      assert(!`${output.stdout}${output.stderr}`.includes(SLOT_VALUE), 'the credential was echoed');
    }
    await startRuntime();
    const before = await slotDigest();
    const replaced = await mcpAuth(['set', CREDENTIAL_SLOT], `${SLOT_VALUE}-replacement`);
    assert(replaced.code !== 0 && (await slotDigest()) === before, 'a running runtime’s credential was replaced');
  });

  await check('explicit inspection starts the approved server once, and it is gone afterwards', async () => {
    const inspected = await discover();
    assert(inspected.status === 200 && inspected.body.includes('list_items'), `discover: ${inspected.status}`);
    const seen = await witness();
    assert(seen.spawns.length === 1 && seen.lists === 1 && seen.calls === 0, JSON.stringify(seen));
    assert((await exec('runtime', 'test', '-e', `/proc/${seen.spawns[0]}`)).code !== 0, 'the server is still running');
  });

  await check('a tampered or missing program is refused before anything starts', async () => {
    const original = readFileSync(programFile);
    writeFileSync(programFile, Buffer.concat([original, Buffer.from('\n// tampered\n')]));
    const tampered = await discover();
    writeFileSync(programFile, original);
    renameSync(programFile, `${programFile}.moved`);
    const missing = await discover();
    renameSync(`${programFile}.moved`, programFile);
    for (const [name, response] of [
      ['tampered', tampered],
      ['missing', missing],
    ] as const) {
      assert(
        response.status !== 200 && response.body.includes(`"subject":"mcp:${SERVER}"`),
        `${name} program: ${response.status} ${response.body}`,
      );
    }
    assert((await witness()).spawns.length === 1, 'a refused program was started');
    const restored = await discover();
    assert(restored.status === 200 && (await witness()).spawns.length === 2, 'the restored program was not inspected');
  });

  await check('a tampered facet bundle makes only the catalog unavailable', async () => {
    writeFileSync(installationFile, Buffer.concat([Buffer.from(INSTALLATION_BYTES), Buffer.from(' ')]));
    const tampered = await capabilities();
    const readiness = await request('/readyz');
    writeFileSync(installationFile, INSTALLATION_BYTES);
    assert(tampered.kind === 'unavailable', `catalog: ${JSON.stringify(tampered)}`);
    assert(readiness.status === 200, `the runtime became unready: ${readiness.body}`);
    assert((await capabilities()).kind === 'ready', 'the restored bundle is not offered');
  });

  await check('a missing facet bundle stops the runtime starting instead of mounting an empty path', async () => {
    const attempt = (bundle: string) =>
      runCommand([...composeSmoke, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'true', 'runtime'], {
        env: { ...env, AGENT_RUNTIME_FACETS: bundle },
        cwd: repoRoot,
        allowFailure: true,
      });
    const absent = join(fixtureDir, 'absent.json');
    const refused = await attempt(absent);
    assert(refused.code !== 0, 'a runtime container started without its facet bundle');
    assert(!existsSync(absent), 'the missing bundle path was created');
    const control = await attempt(installationFile);
    assert(control.code === 0, `the control container did not start: ${control.stderr.trim()}`);
  });

  const marker = `retained-${id}`;
  let firstState: ServerState | undefined;
  await check('the server runs from its private directories with only its own environment', async () => {
    firstState = (await runHelper(image, 'mcp-state.js', ['remember', marker])) as ServerState;
    assertPlacement(firstState);
  });

  await check('ordinary network peers cannot reach the runtime listener', async () => {
    const [holder, database] = await Promise.all([inspect('tailscale'), inspect('postgres')]);
    const network = `${project}_backend`;
    const holderIp = holder.NetworkSettings.Networks[network]?.IPAddress;
    const databaseIp = database.NetworkSettings.Networks[network]?.IPAddress;
    assert(holderIp && databaseIp, 'missing backend addresses');
    const probe = (script: string) =>
      run(['docker', 'run', '--rm', '--network', network, '--entrypoint', 'bun', image, '-e', script], true);
    const control = await probe(
      `Bun.connect({ hostname: ${JSON.stringify(databaseIp)}, port: 5432, socket: { open(s) { s.end(); process.exit(0); }, data() {}, error() { process.exit(1); } } }).catch(() => process.exit(1)); setTimeout(() => process.exit(1), 5000);`,
    );
    assert(control.code === 0, 'probe could not reach PostgreSQL, so the negative check is inconclusive');
    const blocked = await probe(
      `fetch("http://${holderIp}:3000/healthz", { signal: AbortSignal.timeout(3000) }).then(() => process.exit(1), () => process.exit(0));`,
    );
    assert(blocked.code === 0, 'runtime listener is reachable from the backend network');
  });

  await check('runtime reattaches after the namespace holder is replaced', async () => {
    const before = await inspect('tailscale');
    await run([...composeSmoke, 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '120', 'tailscale']);
    // The replaced runtime may restart a few times until PostgreSQL ends the orphaned ownership session, so
    // readiness (not a single health probe) decides the outcome.
    await run([...composeSmoke, 'up', '--detach'], true);
    const [holder, runtime] = await Promise.all([inspect('tailscale'), inspect('runtime')]);
    assert(holder.Id !== before.Id, 'namespace holder was not replaced');
    assert(runtime.HostConfig.NetworkMode === `container:${holder.Id}`, 'runtime still references the old holder');
    await awaitPersistenceReady(120_000);
    const epoch = Number(await ownerEpoch());
    assert(epoch >= 2, `ownership did not move to the replacement runtime (epoch ${epoch})`);
  });

  // --- Image rollback over preserved storage -----------------------------------------------------------------

  await check('every network of the fixture is internal, so nothing can reach a provider', async () => {
    const networks = (
      await run(['docker', 'network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`])
    ).stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '');
    assert(networks.length > 0, 'no fixture networks found');
    const inspected = JSON.parse((await run(['docker', 'network', 'inspect', ...networks])).stdout) as {
      Name: string;
      Internal: boolean;
    }[];
    for (const network of inspected) assert(network.Internal, `${network.Name} is not internal`);
  });

  interface State {
    fingerprint: string;
    counts: Record<string, number>;
    runs: { runId: string; provider: string; state: string; consumed: number; unconfirmed: number }[];
    credentials: { provider: string; kind: string; generation?: number; lifecycle?: string; sha256: string }[];
    mcpCredentials: { file: string; sha256: string }[];
  }
  let seeded: Record<string, string> = {};
  let baseline: State | undefined;
  let storage: { runtimeState?: string; postgres: string; postgresData?: string } | undefined;
  const volumeOf = (info: Inspection, destination: string) =>
    info.Mounts.find((mount) => mount.Destination === destination)?.Name;

  /** Everything the rehearsal requires of the running runtime, whichever image it runs. */
  async function verifyRunning(expectedId: string, title: string) {
    const [runtime, database] = await Promise.all([inspect('runtime'), inspect('postgres')]);
    assert(runtime.Image === expectedId, `runtime runs ${runtime.Image}, not ${expectedId}`);
    await awaitPersistenceReady(120_000);
    const page = await request('/', { headers: { host: PUBLIC_HOST } });
    assert(page.status === 200 && page.body.includes(title), `console page does not show ${title}`);

    const now = { runtimeState: volumeOf(runtime, '/var/lib/agent-runtime'), postgres: database.Id };
    assert(storage !== undefined, 'storage identities were not recorded');
    assert(now.runtimeState === storage.runtimeState, 'the private-state volume changed');
    assert(now.postgres === storage.postgres, 'the database container was replaced');
    assert(volumeOf(database, '/var/lib/postgresql/data') === storage.postgresData, 'the database volume changed');

    const state = (await fixtureState(expectedId === firstId ? image : nextImage, 'inspect')) as State;
    assert(baseline !== undefined, 'no baseline state');
    assert(
      state.fingerprint === baseline.fingerprint,
      `recorded state changed: ${JSON.stringify(state.counts)} vs ${JSON.stringify(baseline.counts)}`,
    );
    assert(state.counts.model_attempts === 0, 'a model attempt was recorded');

    const options = await request('/api/v1/options', { headers: { host: PUBLIC_HOST } });
    const readiness = (JSON.parse(options.body) as { providers: { provider: string; readiness: string }[] }).providers;
    assert(
      JSON.stringify(readiness.map((p) => [p.provider, p.readiness])) ===
        JSON.stringify([
          ['anthropic', 'ready'],
          ['openai', 'ready'],
        ]),
      `provider readiness: ${JSON.stringify(readiness)}`,
    );
    for (const [key, runId] of Object.entries(seeded)) {
      const provider = key === 'command' ? 'anthropic' : key;
      const detail = await request(`/api/v1/runs/${runId}`, { headers: { host: PUBLIC_HOST } });
      const run = (JSON.parse(detail.body) as { run: { provider: string; state: { kind: string } } }).run;
      assert(detail.status === 200, `run ${runId} is not readable (${detail.status})`);
      assert(run.provider === provider && run.state.kind === 'cancelled', `run ${runId}: ${JSON.stringify(run)}`);
    }
    await assertRetainedCommand();
  }

  /** The seeded command run's retained capabilities, read from application storage alone. */
  async function assertRetainedCommand() {
    const retained = await request(`/api/v1/runs/${seeded.command}/capabilities`, { headers: { host: PUBLIC_HOST } });
    const view = JSON.parse(retained.body) as { kind: string; command?: { id: string } };
    assert(
      retained.status === 200 && view.kind === 'command' && view.command?.id === 'command:triage',
      `retained capabilities: ${retained.status} ${retained.body}`,
    );
  }

  await check('recorded runs and credentials are prepared on the first image, with nothing dispatched', async () => {
    await run([...composeSmoke, 'stop', '--timeout', '10', 'runtime']);
    seeded = ((await fixtureState(image, 'seed')) as { runs: Record<string, string> }).runs;
    assert(Object.keys(seeded).sort().join() === 'anthropic,command,openai', `seeded: ${JSON.stringify(seeded)}`);
    await run([...composeSmoke, 'up', '--detach', '--wait', '--wait-timeout', '120', '--no-deps', 'runtime']);
    const [runtime, database] = await Promise.all([inspect('runtime'), inspect('postgres')]);
    storage = {
      runtimeState: volumeOf(runtime, '/var/lib/agent-runtime'),
      postgres: database.Id,
      postgresData: volumeOf(database, '/var/lib/postgresql/data'),
    };
    assert(storage.runtimeState !== undefined && storage.postgresData !== undefined, 'named volumes not found');
    await awaitPersistenceReady(120_000);
    baseline = (await fixtureState(image, 'inspect')) as State;
    assert(baseline.counts.runs === 3 && baseline.counts.model_attempts === 0, JSON.stringify(baseline.counts));
    assert(
      baseline.counts.capability_snapshots === 1 && baseline.counts.run_capabilities === 1,
      JSON.stringify(baseline.counts),
    );
    assert(
      baseline.mcpCredentials.length === 1 && baseline.mcpCredentials[0]?.file === `${CREDENTIAL_SLOT}.json`,
      JSON.stringify(baseline.mcpCredentials),
    );
    assert(baseline.counts.tool_operations === 0 && baseline.counts.questions === 0, JSON.stringify(baseline.counts));
    assert(
      baseline.runs.every((r) => r.state === 'cancelled' && r.consumed === 0 && r.unconfirmed === 0),
      JSON.stringify(baseline.runs),
    );
    assert(
      baseline.credentials.every((c) => c.kind === 'record' && c.generation === 1 && c.lifecycle === 'usable'),
      JSON.stringify(baseline.credentials),
    );
    await verifyRunning(firstId, TITLE);
  });

  const switchTo = async (tag: string) => {
    const before = Number(await ownerEpoch());
    await runWith(tag, [...composeSmoke, 'up', '--detach', '--wait', '--wait-timeout', '120', '--no-deps', 'runtime']);
    await awaitPersistenceReady(120_000);
    const after = Number(await ownerEpoch());
    assert(after > before, `the runtime did not restart on ${tag} (epoch ${before} → ${after})`);
  };

  await check('a newer compatible image takes over the same storage without changing it', async () => {
    await switchTo(nextImage);
    await verifyRunning(nextId, NEXT_TITLE);
  });

  await check('rolling back to the earlier image keeps every recorded run, credential and outcome', async () => {
    await switchTo(image);
    await verifyRunning(firstId, TITLE);
  });

  await check('the server’s private data survives runtime restarts and image replacement', async () => {
    const state = (await runHelper(image, 'mcp-state.js', ['recall'])) as ServerState;
    assertPlacement(state);
    assert(state.recalled === marker, 'the server’s stored data was lost');
    assert(firstState !== undefined && state.spawns === firstState.spawns + 2, `spawns: ${state.spawns}`);
  });

  await check(
    'turning capabilities off in configuration refuses new command runs and keeps retained ones',
    async () => {
      writeConfig(nativeConfig);
      const before = Number(await ownerEpoch());
      await run([...composeSmoke, 'restart', '--timeout', '10', 'runtime']);
      await awaitPersistenceReady(120_000);
      assert(Number(await ownerEpoch()) > before, 'the runtime did not restart');
      assert((await capabilities()).kind === 'unconfigured', 'capabilities are still offered');
      const started = await request('/api/v1/runs', {
        method: 'POST',
        headers: sameOrigin,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          provider: 'anthropic',
          command: { id: 'command:sync', selectionRevision: 'a'.repeat(64), arguments: 'owner/repo-a' },
        }),
      });
      assert(
        started.status === 409 && started.body.includes('capability_unavailable'),
        `command start: ${started.status}`,
      );
      const spawns = (await witness()).spawns.length;
      assert((await discover()).status === 409 && (await witness()).spawns.length === spawns, 'a server was inspected');
      await assertRetainedCommand();
      const state = (await fixtureState(image, 'inspect')) as State;
      assert(state.fingerprint === baseline?.fingerprint, `recorded state changed: ${JSON.stringify(state.counts)}`);
    },
  );

  await check('no output of any service contains the synthetic credential', async () => {
    const logs = await run([...composeSmoke, 'logs', '--no-color']);
    assert(!`${logs.stdout}${logs.stderr}`.includes(SLOT_VALUE), 'a service logged the credential');
  });
  console.log(
    `rollback rehearsal: ${firstId} → ${nextId} → ${firstId}; state ${baseline?.fingerprint}; ${JSON.stringify(baseline?.counts)}`,
  );
} catch (error) {
  if (!(error instanceof CheckFailed)) {
    failures++;
    console.error(error instanceof Error ? error.message : String(error));
  }
} finally {
  await run([...composeSmoke, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], true);
  await run(['docker', 'image', 'rm', '--force', image, nextImage], true);
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} container smoke check(s) failed`);
  process.exit(1);
}
console.log('container smoke checks passed');
