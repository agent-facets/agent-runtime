// Isolated container smoke test. Builds the runtime image and starts a uniquely named Compose project
// with fresh volumes, a synthetic workspace, an inert Tailscale namespace holder and internal networks only.
// It never reads the owner's .env, joins a tailnet or contacts model providers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeLaunch, fixtureEnv, runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:container', process.argv.slice(2), process.env);

const id = crypto.randomUUID().slice(0, 8);
const project = `agent-runtime-smoke-${id}`;
const image = `agent-runtime/runtime:smoke-${id}`;
const fixtureDir = mkdtempSync(join(tmpdir(), `${project}-`));
const workspaceDir = join(fixtureDir, 'workspace');
const envFile = join(fixtureDir, 'empty.env');
await Bun.write(join(workspaceDir, 'README.md'), 'synthetic workspace fixture\n');
await Bun.write(envFile, '');

const env = fixtureEnv(process.env, {
  AGENT_RUNTIME_WORKSPACE: workspaceDir,
  AGENT_RUNTIME_IMAGE: image,
  POSTGRES_PASSWORD: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
});
const composeBase = ['docker', 'compose', '--project-name', project, '--env-file', envFile, '-f', 'compose.yaml'];
const composeSmoke = [...composeBase, '-f', 'tests/container/compose.smoke.yaml'];
const run = (cmd: string[], allowFailure = false) => runCommand(cmd, { env, cwd: repoRoot, allowFailure });

let failures = 0;
async function check(name: string, body: () => Promise<void>) {
  try {
    await body();
    console.log(`(pass) ${name}`);
  } catch (error) {
    failures++;
    console.error(`(fail) ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Inspection {
  Id: string;
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
const fetchScript = (url: string) =>
  `fetch(${JSON.stringify(url)}).then(async (r) => { console.log(r.status, await r.text()); }, () => process.exit(1))`;

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

  console.log(`building and starting isolated project ${project}`);
  await run([...composeSmoke, 'up', '--detach', '--build', '--wait', '--wait-timeout', '180']);

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
    assert(
      JSON.stringify(destinations) === JSON.stringify(['/tmp', '/var/lib/agent-runtime', '/workspace'].sort()) ||
        JSON.stringify(destinations) === JSON.stringify(['/var/lib/agent-runtime', '/workspace'].sort()),
      `unexpected runtime mounts: ${destinations.join(', ')}`,
    );
    assert(runtime.Mounts.find((m) => m.Destination === '/workspace')?.RW === false, 'workspace mount is writable');
  });

  await check('loopback health and foundation readiness respond inside the namespace', async () => {
    const health = await exec('runtime', 'bun', '-e', fetchScript('http://127.0.0.1:3000/healthz'));
    assert(health.stdout.startsWith('200 '), `healthz: ${health.stdout || health.stderr}`);
    const ready = await exec('runtime', 'bun', '-e', fetchScript('http://127.0.0.1:3000/readyz'));
    assert(ready.stdout.startsWith('503 '), `readyz status: ${ready.stdout}`);
    const body = JSON.parse(ready.stdout.slice(4)) as { checks: { database: string; agentExecution: string } };
    assert(body.checks.database === 'reachable', `database: ${body.checks.database}`);
    assert(body.checks.agentExecution === 'not_implemented', 'readiness overstates agent execution');
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
    await run([...composeSmoke, 'up', '--detach', '--wait', '--wait-timeout', '120']);
    const [holder, runtime] = await Promise.all([inspect('tailscale'), inspect('runtime')]);
    assert(holder.Id !== before.Id, 'namespace holder was not replaced');
    assert(runtime.HostConfig.NetworkMode === `container:${holder.Id}`, 'runtime still references the old holder');
    const health = await exec('runtime', 'bun', '-e', fetchScript('http://127.0.0.1:3000/healthz'));
    assert(health.stdout.startsWith('200 '), 'runtime unhealthy after reattachment');
  });
} catch (error) {
  failures++;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await run([...composeSmoke, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], true);
  await run(['docker', 'image', 'rm', '--force', image], true);
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} container smoke check(s) failed`);
  process.exit(1);
}
console.log('container smoke checks passed');
