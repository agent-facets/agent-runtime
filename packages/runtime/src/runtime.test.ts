import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOperatorConfig } from './config/operator.ts';
import { CredentialStore } from './credentials/store.ts';
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

  test('reports each configured provider’s readiness at startup from stored credentials alone', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-runtime-readiness-'));
    const workspace = mkdtempSync(join(tmpdir(), 'agent-runtime-readiness-ws-'));
    try {
      const operator = parseOperatorConfig(
        JSON.stringify({
          version: 1,
          workspace: { id: 'main', label: 'Main', root: workspace },
          providers: {
            anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' },
            openai: { authMode: 'subscription', model: 'gpt-5.6-sol', profileId: 'codex-0.151.0' },
          },
          defaultProvider: 'anthropic',
        }),
        { stateDir, configFile: join(stateDir, 'config.json') },
      );
      const readiness = async () => {
        const lines: string[] = [];
        const runtime = startRuntime({
          config: { port: 0, databaseUrl: undefined, stateDir, configFile: undefined, operator },
          log: (line) => lines.push(line),
        });
        await runtime.started;
        await runtime.stop(0);
        return lines;
      };
      expect(await readiness()).toEqual([
        JSON.stringify({
          event: 'provider_readiness',
          reason: 'reauthorization_required',
          provider: 'anthropic',
          operation: 'startup',
        }),
        JSON.stringify({
          event: 'provider_readiness',
          reason: 'integration_unavailable',
          provider: 'openai',
          operation: 'startup',
        }),
      ]);
      await CredentialStore.forStateDir(stateDir).replace({
        version: 1,
        provider: 'anthropic',
        authMode: 'subscription',
        slot: 'default',
        generation: 1,
        updatedAtMs: Date.now(),
        lifecycle: 'usable',
        accessToken: 'sk-ant-synthetic-readiness-access',
        refreshToken: 'sk-ant-synthetic-readiness-refresh',
        expiresAtMs: Date.now() - 1,
        account: {},
      });
      const lines = await readiness();
      // Expired access is still ready: renewal happens on use, never at startup.
      expect(lines[0]).toBe(
        JSON.stringify({ event: 'provider_readiness', reason: 'ready', provider: 'anthropic', operation: 'startup' }),
      );
      expect(lines.join('\n')).not.toContain('synthetic');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
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
