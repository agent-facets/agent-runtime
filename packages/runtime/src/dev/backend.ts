// Development backend, started (and restarted) by the supervisor. It is the production runtime with two
// development options, added only after the same environment checks (launch.ts):
//
// - the live-reloading console, relayed from the supervisor's private console server;
// - the execution-code manifest computed once, before any run is admitted, so this process never records
//   source edited after it loaded as the code it is running.
import { launch } from '../launch.ts';

await launch(async () => {
  const socket = process.env.AGENT_RUNTIME_DEV_CONSOLE_SOCKET;
  if (socket === undefined || socket === '' || !socket.startsWith('/')) {
    console.error('refusing to start: the development backend is started by `bun run dev`');
    process.exit(1);
  }
  const { createDevelopmentConsole } = await import('./console-proxy.ts');
  const { frozenCodeManifests } = await import('./frozen-manifests.ts');
  return { developmentConsole: createDevelopmentConsole({ socket }), code: await frozenCodeManifests() };
});
