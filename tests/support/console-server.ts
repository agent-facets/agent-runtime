// The runtime's HTTP server as the application composes it — console files, `/api/v1` and the run service on the
// official saver — with scripted provider networks in place of Anthropic. Used by the browser journeys.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { type ConsoleFiles, loadConsole } from '../../packages/runtime/src/console.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import type { Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { startServer } from '../../packages/runtime/src/server.ts';
import { handleApi } from '../../packages/runtime/src/service/http.ts';
import { RunService } from '../../packages/runtime/src/service/runs.ts';
import { REAL_TIME } from '../../packages/runtime/src/service/stream.ts';
import { inferenceNetwork, tokenNetwork } from './anthropic-network.ts';

export const SYNTHETIC_ACCESS = 'sk-ant-oat01-console-suite-access-token';
export const SYNTHETIC_REFRESH = 'sk-ant-ort01-console-suite-refresh-token';

let files: Promise<ConsoleFiles> | undefined;
let counter = 0;

export async function consoleServer(options: {
  persistence: Persistence;
  scratch: string;
  workspaceRoot: string;
  replies: Parameters<typeof inferenceNetwork>[0];
  /** Operator settings merged over the defaults (for example a trial's budget and ceiling). */
  operator?: Record<string, unknown>;
}) {
  const base = join(options.scratch, `server-${++counter}`);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configFile = join(base, 'config.json');
  const source = JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main workspace', root: options.workspaceRoot },
    providers: { anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' } },
    defaultProvider: 'anthropic',
    ...options.operator,
  });
  writeFileSync(configFile, source);
  const operator = parseOperatorConfig(source, { stateDir, configFile });
  await CredentialStore.forStateDir(stateDir).replace({
    version: 1,
    provider: 'anthropic',
    authMode: 'subscription',
    slot: 'default',
    generation: 1,
    updatedAtMs: Date.now(),
    lifecycle: 'usable',
    accessToken: SYNTHETIC_ACCESS,
    refreshToken: SYNTHETIC_REFRESH,
    expiresAtMs: Date.now() + 3_600_000,
    account: {},
  });
  const net = inferenceNetwork(options.replies);
  const assembly = createProviderAssembly({
    config: operator,
    stateDir,
    inferenceTransport: net.fetchImpl,
    authTransport: tokenNetwork().fetchImpl,
  });
  const logs: string[] = [];
  const service = new RunService({
    operator,
    locations: { stateDir, configFile },
    persistence: options.persistence,
    assembly,
    failStop: () => {
      throw new Error('fail stop');
    },
    log: (line) => logs.push(line),
  });
  files ??= loadConsole();
  const loaded = await files;
  const timing = { ...REAL_TIME, pollMs: 50 };
  const listen = (port: number) =>
    startServer({
      port,
      persistenceStatus: () => 'ready',
      api: (request, srv) => handleApi(request, () => service, srv, timing),
      console: () => loaded,
    });
  let server = listen(0);
  const port = server.port as number;
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    net,
    /** Every diagnostic line the service wrote. */
    logs,
    /** Closes every connection (as a proxy or network failure would) and listens again shortly after. */
    async dropConnections() {
      await server.stop(true);
      await Bun.sleep(1_000);
      server = listen(port);
    },
    async stop() {
      await server.stop(true);
      await service.settled();
    },
  };
}
