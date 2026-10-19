// MCP server state for the container smoke suite (scripts/container-smoke.ts). The launcher bundles this file and runs
// it in a short-lived container of the image under test, with the runtime's own volumes, configuration and read-only
// facet bundle and program mounts. Through the runtime's own launch and call code — the configured approval, the
// mounted program checked against its digest, the private per-server directories — it starts the synthetic server
// twice, one connection at a time:
//
//   remember <value>  reports where the server runs and stores `value` in its private home directory
//   recall            reports where the server runs and reads the stored value back
//
// Each connection is closed and its process confirmed gone before the next step. Nothing here involves a model, a
// provider or a run; credential values never leave this process.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { planServerLaunch } from '../../packages/runtime/src/capabilities/server-access.ts';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { McpCredentialStore } from '../../packages/runtime/src/credentials/mcp-store.ts';
import { callTool } from '../../packages/runtime/src/mcp/call.ts';
import { deadline } from '../../packages/runtime/src/mcp/deadline.ts';
import { closeSession, openSession } from '../../packages/runtime/src/mcp/session.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';

const SERVER = 'synthetic';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const [mode, value] = process.argv.slice(2);
if (!(mode === 'remember' && value !== undefined) && mode !== 'recall') {
  throw new Error('usage: mcp-state.js remember <value> | recall');
}

const stateDir = required('RUNTIME_STATE_DIR');
const configFile = required('RUNTIME_CONFIG_FILE');
const operator = parseOperatorConfig(await Bun.file(configFile).text(), { stateDir, configFile });
const grants = operator.capabilities;
if (grants === undefined) throw new Error('capabilities are not configured');
const load = await readInstallation(grants.installation.path, grants.installation.sha256);
if (load.kind !== 'ready') throw new Error(`installation unavailable: ${load.reason}`);
const server = load.catalog.installation.servers.find((candidate) => candidate.serverId === SERVER);
if (server === undefined) throw new Error('the synthetic server is not installed');

const credentials = McpCredentialStore.forStateDir(stateDir);
const slot = await credentials.read('repo-token');
if (slot.kind !== 'present') throw new Error(`credential slot ${slot.kind}`);
const policy = createContentPolicy(exactSecretMatcher([slot.value]));
const deps = { stateDir, bunPath: process.execPath, readCredential: (id: string) => credentials.read(id) };

const witness = () => Bun.file(join(stateDir, 'mcp', SERVER, 'home', 'witness.log')).text();
const lastSpawn = async () => Number((await witness()).match(/spawn (\d+)\n(?![\s\S]*spawn )/)?.[1]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One connection: start, call each tool in turn, close and confirm the process has gone. */
async function connection(calls: [string, Record<string, unknown>][]) {
  const plan = await planServerLaunch(server as NonNullable<typeof server>, grants, deps, policy);
  if (!plan.ok) throw new Error(`launch refused: ${plan.reason}`);
  const opened = await openSession(plan.params, deadline(15_000));
  if (!opened.ok) throw new Error(`connection failed: ${opened.reason}`);
  const outcomes = [];
  let gone = false;
  try {
    for (const [toolName, args] of calls) {
      const { outcome } = await callTool({
        session: opened.session,
        toolName,
        args,
        validate: () => true,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        policy,
        operationId: `container-fixture-${toolName}`,
      });
      if (outcome.kind !== 'ok') throw new Error(`${toolName}: ${outcome.kind} ${outcome.reason}`);
      outcomes.push(outcome);
    }
  } finally {
    const pid = await lastSpawn();
    gone = (await closeSession(opened.session)) && !alive(pid);
  }
  if (!gone) throw new Error('the server process outlived its connection');
  return { launch: plan.params, outcomes };
}

const env = await connection([['env', {}]]);
const reported = env.outcomes[0]?.json as { names: string[]; home: string; tmpdir: string; cwd: string };
const stored = await connection(mode === 'remember' ? [['remember', { value: value as string }]] : [['recall', {}]]);
const mode700 = (path: string) => {
  const stat = lstatSync(path);
  return { mode: (stat.mode & 0o777).toString(8), uid: stat.uid };
};
const root = join(stateDir, 'mcp', SERVER);

console.log(
  JSON.stringify({
    launch: { command: env.launch.command, args: env.launch.args, cwd: env.launch.cwd },
    reported: { cwd: reported.cwd, home: reported.home, tmpdir: reported.tmpdir, names: reported.names },
    directories: Object.fromEntries(
      ['', 'home', 'tmp'].map((name) => [name === '' ? 'root' : name, mode700(join(root, name))]),
    ),
    uid: process.getuid?.(),
    ...(mode === 'recall' ? { recalled: stored.outcomes[0]?.text } : {}),
    spawns: (await witness()).split('\n').filter((line) => line.startsWith('spawn ')).length,
  }),
);
