// The environment is checked before any framework or provider module loads, so a tracing or proxy setting can
// never take effect; the runtime itself is imported only afterwards.
import { environmentProblems } from './config/environment.ts';
import { ConfigError } from './config/operator.ts';
import { loadConfig, withOperatorConfig } from './config.ts';

const problems = environmentProblems(process.env);
if (problems.length > 0) {
  for (const problem of problems) console.error(`refusing to start: ${problem.variable} (${problem.reason})`);
  process.exit(1);
}

let config: Awaited<ReturnType<typeof withOperatorConfig>>;
try {
  config = await withOperatorConfig(loadConfig(process.env));
} catch (error) {
  console.error(`refusing to start: ${error instanceof ConfigError ? error.message : 'invalid configuration'}`);
  process.exit(1);
}

const { startRuntime } = await import('./runtime.ts');
const { LISTEN_HOSTNAME } = await import('./server.ts');

const runtime = startRuntime({ config });
console.log(`agent-runtime listening on http://${LISTEN_HOSTNAME}:${runtime.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runtime.stop(0);
  });
}

process.exit(await runtime.stopped);
