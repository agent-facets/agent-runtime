// The console served over HTTP in front of the MCP command-run harness (./mcp-service.ts): the production routes,
// run service, either scripted provider and the bundled synthetic MCP server, for browser journeys. Synthetic only.
import { type ConsoleFiles, loadConsole } from '../../packages/runtime/src/console.ts';
import { startServer } from '../../packages/runtime/src/server.ts';
import { handleApi } from '../../packages/runtime/src/service/http.ts';
import { REAL_TIME } from '../../packages/runtime/src/service/stream.ts';
import { type HarnessOptions, mcpService } from './mcp-service.ts';

let files: Promise<ConsoleFiles> | undefined;

export async function mcpConsole(options: HarnessOptions) {
  const harness = await mcpService(options);
  files ??= loadConsole();
  const loaded = await files;
  const server = startServer({
    port: 0,
    persistenceStatus: () => 'ready',
    api: (request, srv) => handleApi(request, () => harness.service, srv, { ...REAL_TIME, pollMs: 50 }),
    console: () => loaded,
  });
  return {
    ...harness,
    url: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.stop(true);
      await harness.service.settled();
    },
  };
}
