import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDependencies,
  dependencyFingerprint,
  dependencyInputs,
  isDependencyInput,
  REPOSITORY_ROOT,
} from './dependencies.ts';
import { isBackendSource } from './watch.ts';

describe('backend restart scope', () => {
  test('backend and shared backend source restarts the backend', () => {
    for (const path of [
      'packages/runtime/src/server.ts',
      'packages/runtime/src/execution/agent.ts',
      'packages/runtime/src/config/operator.json',
      'packages/contracts/src/index.ts',
      'packages/anthropic-subscription/src/transport.ts',
    ]) {
      expect(isBackendSource(path)).toBe(true);
    }
  });

  test('console source, tests, generated output, dependencies, state and editor files never do', () => {
    for (const path of [
      'packages/ui/src/app/App.tsx',
      'packages/ui/src/styles.css',
      'packages/ui/src/index.html',
      'packages/runtime/src/server.test.ts',
      'packages/ui/src/app/App.test.tsx',
      'packages/runtime/test-support/scripted-model.ts',
      'packages/runtime/dist/main.js',
      'packages/runtime/src/node_modules/x/index.js',
      'packages/runtime/src/.server.ts.swp',
      'packages/runtime/src/server.ts~',
      'packages/runtime/src/4913',
      'packages/runtime/src/.#server.ts',
      'packages/runtime/src/notes.md',
      'packages/mcp-programs/src/programs.ts',
      'packages/facet-adapter/src/index.ts',
      'packages/runtime/package.json',
      'state/runs.db',
      'tmp/scratch.ts',
    ]) {
      expect(isBackendSource(path)).toBe(false);
    }
  });
});

describe('dependency fingerprint', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-deps-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  for (const path of dependencyInputs(REPOSITORY_ROOT)) {
    cpSync(join(REPOSITORY_ROOT, path), join(scratch, path), { recursive: true });
  }

  test('covers the lockfile, Bun configuration and every workspace manifest', () => {
    const inputs = dependencyInputs(REPOSITORY_ROOT);
    expect(inputs.slice(0, 3)).toEqual(['package.json', 'bun.lock', 'bunfig.toml']);
    expect(inputs).toContain('packages/runtime/package.json');
    expect(inputs).toContain('packages/ui/package.json');
    expect(inputs.every(isDependencyInput)).toBe(true);
    expect(isDependencyInput('packages/runtime/src/package.json')).toBe(false);
    expect(isDependencyInput('README.md')).toBe(false);
  });

  test('a matching record passes; any manifest change, or a missing record, is refused with the rebuild step', async () => {
    const record = join(scratch, 'record');
    writeFileSync(record, `${await dependencyFingerprint(scratch)}\n`);
    expect(await checkDependencies(scratch, record)).toEqual({ ok: true });
    expect(await checkDependencies(scratch, undefined)).toEqual({ ok: true });

    const manifest = join(scratch, 'packages', 'ui', 'package.json');
    const original = await Bun.file(manifest).text();
    writeFileSync(manifest, original.replace('"private": true', '"private": false'));
    const stale = await checkDependencies(scratch, record);
    expect(stale.ok).toBe(false);
    expect(stale.ok ? '' : stale.message).toContain('bun run dev:stack rebuild');
    writeFileSync(manifest, original);
    expect(await checkDependencies(scratch, record)).toEqual({ ok: true });

    expect((await checkDependencies(scratch, join(scratch, 'absent'))).ok).toBe(false);
  });
});
