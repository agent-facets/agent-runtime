import { describe, expect, test } from 'bun:test';
import { loadConfig, parsePort } from './config.ts';
import { createDatabaseProbe } from './database-probe.ts';

describe('runtime configuration', () => {
  test('defaults to port 3000 without a database', () => {
    expect(loadConfig({})).toEqual({ port: 3000, databaseUrl: undefined });
  });

  test('rejects malformed or out-of-range ports', () => {
    for (const value of ['0', '65536', '3000abc', '-1', '1e3']) {
      expect(() => parsePort(value)).toThrow();
    }
  });
});

describe('database probe', () => {
  test('reports an unconfigured database without connecting', async () => {
    expect(await createDatabaseProbe(undefined)()).toBe('unconfigured');
  });

  test('reports an unreachable database without exposing connection details', async () => {
    const probe = createDatabaseProbe('postgres://fixture:synthetic-secret@127.0.0.1:1/fixture');
    expect(await probe()).toBe('unreachable');
  });
});
