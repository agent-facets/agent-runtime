import { describe, expect, test } from 'bun:test';
import { startRuntime, statusForStartupFailure } from './runtime.ts';

describe('runtime lifecycle', () => {
  test('maps startup failures to operator-visible readiness states', () => {
    expect(statusForStartupFailure('owned_elsewhere')).toBe('owned_elsewhere');
    expect(statusForStartupFailure('schema_incompatible')).toBe('schema_incompatible');
    for (const code of ['database_unavailable', 'migration_failed', 'ownership_lost'] as const) {
      expect(statusForStartupFailure(code)).toBe('unavailable');
    }
  });

  test('runs without persistence when no database is configured and stops cleanly', async () => {
    const runtime = startRuntime({
      config: { port: 0, databaseUrl: undefined, stateDir: '/tmp/state', configFile: undefined },
      log: () => {},
    });
    await runtime.started;
    expect(runtime.status()).toBe('unconfigured');
    expect(await runtime.stop(0)).toBe(0);
    expect(await runtime.stopped).toBe(0);
  });

  test('exits for restart when the database is unreachable at startup, without logging connection details', async () => {
    const lines: string[] = [];
    const runtime = startRuntime({
      config: {
        port: 0,
        databaseUrl: 'postgres://fixture:synthetic-secret@127.0.0.1:1/fixture',
        stateDir: '/tmp/state',
        configFile: undefined,
      },
      log: (line) => lines.push(line),
    });
    await runtime.started;
    expect(runtime.status()).toBe('unavailable');
    expect(await runtime.stopped).toBe(1);
    expect(lines.join('\n')).not.toContain('synthetic-secret');
    expect(lines).toEqual([
      JSON.stringify({ event: 'persistence_startup_failed', reason: 'database_unavailable', operation: 'startup' }),
    ]);
    // Bun SQL retries a refused connection until its five-second connection timeout.
  }, 15_000);
});
