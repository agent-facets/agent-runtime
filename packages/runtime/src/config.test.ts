import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './config/operator.ts';
import { loadConfig, parsePort, withOperatorConfig } from './config.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-config-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('runtime configuration', () => {
  test('defaults to port 3000, the standard state directory and no database or operator configuration', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      databaseUrl: undefined,
      stateDir: '/var/lib/agent-runtime',
      configFile: undefined,
    });
  });

  test('treats an empty database URL as unconfigured', () => {
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBeUndefined();
  });

  test('rejects malformed or out-of-range ports', () => {
    for (const value of ['0', '65536', '3000abc', '-1', '1e3']) {
      expect(() => parsePort(value)).toThrow(ConfigError);
    }
  });

  test('requires absolute state and configuration paths', () => {
    expect(() => loadConfig({ RUNTIME_STATE_DIR: 'state' })).toThrow(ConfigError);
    expect(() => loadConfig({ RUNTIME_CONFIG_FILE: 'config.json' })).toThrow(ConfigError);
    expect(loadConfig({ RUNTIME_STATE_DIR: '/srv/state/' }).stateDir).toBe('/srv/state');
  });

  test('reads the operator configuration file when one is named', async () => {
    const file = join(scratch, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        workspace: { id: 'main', label: 'Main', root: '/workspace' },
        providers: { anthropic: { authMode: 'subscription', model: 'owner-model', profileId: 'anthropic-sub' } },
        defaultProvider: 'anthropic',
      }),
    );
    const config = await withOperatorConfig(loadConfig({ RUNTIME_CONFIG_FILE: file }));
    expect(config.operator?.workspace.root).toBe('/workspace');
    expect(config.operator?.stepBudget).toBe(50);
    await expect(withOperatorConfig(loadConfig({ RUNTIME_CONFIG_FILE: join(scratch, 'absent.json') }))).rejects.toThrow(
      'RUNTIME_CONFIG_FILE could not be read',
    );
  });
});
