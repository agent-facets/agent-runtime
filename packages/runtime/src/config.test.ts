import { describe, expect, test } from 'bun:test';
import { loadConfig, parsePort } from './config.ts';

describe('runtime configuration', () => {
  test('defaults to port 3000 without a database', () => {
    expect(loadConfig({})).toEqual({ port: 3000, databaseUrl: undefined });
  });

  test('treats an empty database URL as unconfigured', () => {
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBeUndefined();
  });

  test('rejects malformed or out-of-range ports', () => {
    for (const value of ['0', '65536', '3000abc', '-1', '1e3']) {
      expect(() => parsePort(value)).toThrow();
    }
  });
});
