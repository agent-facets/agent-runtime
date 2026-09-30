import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitWorkspace } from './admission.ts';
import { identityKey } from './policy.ts';
import { collectProtectedIdentities, ProtectionIncomplete } from './protected.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-admission-'));
afterAll(() => {
  // Restore permissions changed by tests so cleanup can remove everything.
  Bun.spawnSync(['chmod', '-R', 'u+rwx', scratch]);
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;

/** A layout like the container: a workspace, private state with a credential record, and a configuration file. */
function layout() {
  const base = join(scratch, `case-${++counter}`);
  const root = join(base, 'workspace');
  const stateDir = join(base, 'state');
  const configFile = join(base, 'config.json');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(stateDir, 'credentials', 'openai'), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'credentials', 'openai', 'default.json'), '{}', { mode: 0o600 });
  writeFileSync(configFile, '{}');
  const workspace = (at = root) => ({ id: 'w', label: 'W', root: at, excludeNames: [], excludePaths: [] });
  return { base, root, stateDir, configFile, workspace };
}

describe('workspace admission', () => {
  test('admits a canonical root and protects every private file and directory', async () => {
    const { root, stateDir, configFile, workspace } = layout();
    const admission = await admitWorkspace(workspace(), { stateDir, configFile });
    if (!admission.ok) throw new Error(admission.code);
    const record = lstatSync(join(stateDir, 'credentials', 'openai', 'default.json'), { bigint: true });
    for (const stat of [record, lstatSync(stateDir, { bigint: true }), lstatSync(configFile, { bigint: true })]) {
      expect(admission.policy.protectedIdentities.has(identityKey(stat))).toBe(true);
    }
    expect(admission.policy.root).toBe(root);
  });

  test('a missing optional credential slot is not a failure', async () => {
    const { stateDir, configFile, workspace } = layout();
    rmSync(join(stateDir, 'credentials'), { recursive: true });
    expect((await admitWorkspace(workspace(), { stateDir, configFile })).ok).toBe(true);
  });

  test('refuses a root reached through a symlink, including through an ancestor', async () => {
    const { base, root, stateDir, configFile, workspace } = layout();
    symlinkSync(root, join(base, 'root-link'));
    symlinkSync(base, join(scratch, `ancestor-link-${counter}`));
    for (const alias of [join(base, 'root-link'), join(scratch, `ancestor-link-${counter}`, 'workspace')]) {
      expect(await admitWorkspace(workspace(alias), { stateDir, configFile })).toEqual({
        ok: false,
        code: 'workspace_alias',
      });
    }
  });

  test('refuses a missing root or one that is not a directory', async () => {
    const { base, stateDir, configFile, workspace } = layout();
    expect(await admitWorkspace(workspace(join(base, 'absent')), { stateDir, configFile })).toEqual({
      ok: false,
      code: 'workspace_unavailable',
    });
    writeFileSync(join(base, 'file'), 'x');
    expect((await admitWorkspace(workspace(join(base, 'file')), { stateDir, configFile })).ok).toBe(false);
  });

  test('refuses private state or configuration that resolves into the workspace', async () => {
    const { base, root, workspace } = layout();
    mkdirSync(join(root, 'hidden-state'), { mode: 0o700 });
    symlinkSync(join(root, 'hidden-state'), join(base, 'state-alias'));
    writeFileSync(join(root, 'config.json'), '{}');
    symlinkSync(join(root, 'config.json'), join(base, 'config-alias.json'));
    expect(
      await admitWorkspace(workspace(), { stateDir: join(base, 'state-alias'), configFile: join(base, 'config.json') }),
    ).toEqual({ ok: false, code: 'private_location_overlap' });
    expect(
      await admitWorkspace(workspace(), { stateDir: join(base, 'state'), configFile: join(base, 'config-alias.json') }),
    ).toEqual({ ok: false, code: 'private_location_overlap' });
    // The workspace may not lie inside private state either.
    expect(await admitWorkspace(workspace(), { stateDir: base, configFile: join(base, 'config.json') })).toEqual({
      ok: false,
      code: 'private_location_overlap',
    });
  });

  test('a missing state directory or configuration file leaves the workspace unavailable', async () => {
    const { base, stateDir, configFile, workspace } = layout();
    expect(await admitWorkspace(workspace(), { stateDir: join(base, 'no-state'), configFile })).toEqual({
      ok: false,
      code: 'protection_incomplete',
    });
    expect(await admitWorkspace(workspace(), { stateDir, configFile: join(base, 'no-config.json') })).toEqual({
      ok: false,
      code: 'protection_incomplete',
    });
  });

  test('an unreadable private directory makes protection incomplete rather than partial', async () => {
    if (process.getuid?.() === 0) return;
    const { stateDir, configFile, workspace } = layout();
    chmodSync(join(stateDir, 'credentials'), 0o000);
    try {
      expect(await admitWorkspace(workspace(), { stateDir, configFile })).toEqual({
        ok: false,
        code: 'protection_incomplete',
      });
    } finally {
      chmodSync(join(stateDir, 'credentials'), 0o700);
    }
  });

  test('more private entries than the bound makes protection incomplete rather than truncated', async () => {
    const { stateDir, configFile, workspace } = layout();
    for (let index = 0; index < 20; index++) writeFileSync(join(stateDir, `extra-${index}`), '');
    expect(await admitWorkspace(workspace(), { stateDir, configFile }, { maxProtectedEntries: 10 })).toEqual({
      ok: false,
      code: 'protection_incomplete',
    });
    await expect(collectProtectedIdentities([stateDir], { maxEntries: 10 })).rejects.toBeInstanceOf(
      ProtectionIncomplete,
    );
    expect((await collectProtectedIdentities([stateDir], { maxEntries: 100 })).length).toBeGreaterThan(20);
  });
});
