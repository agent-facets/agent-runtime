import { loadConfig } from './config.ts';
import { startRuntime } from './runtime.ts';
import { LISTEN_HOSTNAME } from './server.ts';

const runtime = startRuntime({ config: loadConfig(process.env) });
console.log(`agent-runtime listening on http://${LISTEN_HOSTNAME}:${runtime.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runtime.stop(0);
  });
}

process.exit(await runtime.stopped);
