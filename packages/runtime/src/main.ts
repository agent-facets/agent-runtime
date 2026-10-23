import { loadConfig } from './config.ts';
import { createDatabaseProbe } from './database-probe.ts';
import { LISTEN_HOSTNAME, startServer } from './server.ts';

const config = loadConfig(process.env);
const server = startServer({ port: config.port, probeDatabase: createDatabaseProbe(config.databaseUrl) });

console.log(`agent-runtime listening on http://${LISTEN_HOSTNAME}:${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
