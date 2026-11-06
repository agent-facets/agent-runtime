// The environment is checked before any framework or provider module loads, so a tracing or proxy setting can
// never take effect; the runtime itself is imported only afterwards. Shared by the production entry point and the
// development backend, which adds its own options once the checks have passed.
import { environmentProblems } from './config/environment.ts';
import { ConfigError } from './config/operator.ts';
import type { RuntimeConfig } from './config.ts';
import { loadConfig, withOperatorConfig } from './config.ts';
import type { RuntimeOptions } from './runtime.ts';

export type ExtraOptions = (config: RuntimeConfig) => Promise<Partial<Omit<RuntimeOptions, 'config'>>>;

export async function launch(extra?: ExtraOptions): Promise<never> {
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

  const additional = extra === undefined ? {} : await extra(config);
  const { startRuntime } = await import('./runtime.ts');
  const { LISTEN_HOSTNAME } = await import('./server.ts');

  const runtime = startRuntime({ ...additional, config });
  console.log(`agent-runtime listening on http://${LISTEN_HOSTNAME}:${runtime.port}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void runtime.stop(0);
    });
  }

  process.exit(await runtime.stopped);
}
