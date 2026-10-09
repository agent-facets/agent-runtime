// Stopped-runtime MCP credential provisioning against a real PostgreSQL fixture: the maintenance command takes the
// runtime's singleton ownership without migrating or claiming an epoch, and refuses (changing nothing) while a
// runtime owns the database. Values are synthetic; no provider or MCP request is made.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpCredentialStore } from '../../packages/runtime/src/credentials/mcp-store.ts';
import { type AuthCommandIo, runAuthCommand } from '../../packages/runtime/src/operator/auth-command.ts';
import { withMaintenanceOwnership } from '../../packages/runtime/src/persistence/maintenance.ts';
import { LOCK_NAMESPACE, OWNERSHIP_LOCK } from '../../packages/runtime/src/persistence/ownership.ts';
import { openPersistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

const scratchDir = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-provision-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
let counter = 0;

const VALUE = 'synthetic-mcp-provisioned-0001';
const NEXT = 'synthetic-mcp-provisioned-0002';

async function scratch(): Promise<ScratchDatabase> {
  const db = await createScratchDatabase();
  cleanups.push(() => db.drop());
  return db;
}
function stateDir(): string {
  const dir = join(scratchDir, `state-${++counter}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
async function lockHolders(db: ScratchDatabase): Promise<number> {
  const rows = await db.admin`
    select pid from pg_locks where locktype = 'advisory' and granted
      and classid = ${LOCK_NAMESPACE}::oid and objid = ${OWNERSHIP_LOCK}::oid`;
  return rows.length;
}
async function ownerState(db: ScratchDatabase) {
  const [owner] = await db.admin`select owner_id::text as owner, epoch::text as epoch from runtime.runtime_owner`;
  const [migrations] = await db.admin`select count(*)::int as count from runtime.schema_migrations`;
  return { owner, migrations: migrations?.count };
}

function setCommand(env: Record<string, string>, stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AuthCommandIo = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: (async () => {
      throw new Error('no request is expected');
    }) as unknown as typeof fetch,
    readLine: async () => '',
    readSecret: async () => stdin,
  };
  return { io, out, err };
}

describe('stopped-runtime MCP credential provisioning', () => {
  test('refuses while a runtime owns the database, leaving the slot, schema and epoch unchanged', async () => {
    const db = await scratch();
    const state = stateDir();
    const store = McpCredentialStore.forStateDir(state);
    await store.replace('repo-token', VALUE);

    const runtime = await openPersistence({ url: db.url, onFault: () => {} });
    cleanups.push(() => runtime.close());
    const before = await ownerState(db);

    let reached = false;
    await expect(
      withMaintenanceOwnership(db.url, async () => {
        reached = true;
      }),
    ).rejects.toMatchObject({ reason: 'runtime_running' });
    expect(reached).toBe(false);

    const command = setCommand({ RUNTIME_STATE_DIR: state, DATABASE_URL: db.url }, NEXT);
    expect(await runAuthCommand(['mcp', 'set', 'repo-token'], command.io)).toBe(1);
    expect(command.err.join('\n')).toContain('Stop the runtime first');
    expect(await store.read('repo-token')).toEqual({ kind: 'present', value: VALUE });
    expect(await ownerState(db)).toEqual(before);
    expect(await lockHolders(db)).toBe(1);
  });

  test('with the runtime stopped it stores the value without migrating or claiming an epoch, then releases', async () => {
    const db = await scratch();
    const state = stateDir();
    const runtime = await openPersistence({ url: db.url, onFault: () => {} });
    await runtime.close();
    const before = await ownerState(db);

    const command = setCommand({ RUNTIME_STATE_DIR: state, DATABASE_URL: db.url }, VALUE);
    expect(await runAuthCommand(['mcp', 'set', 'repo-token'], command.io)).toBe(0);
    expect(command.out).toEqual(['mcp/repo-token: present (takes effect when the runtime next starts)']);
    expect([...command.out, ...command.err].join('\n')).not.toContain(VALUE);
    expect(await McpCredentialStore.forStateDir(state).read('repo-token')).toEqual({ kind: 'present', value: VALUE });
    expect(await ownerState(db)).toEqual(before);
    expect(await lockHolders(db)).toBe(0);

    // A failing write still releases ownership, so a later runtime can start.
    await expect(
      withMaintenanceOwnership(db.url, async () => {
        throw new Error('injected');
      }),
    ).rejects.toThrow('injected');
    expect(await lockHolders(db)).toBe(0);
    const restarted = await openPersistence({ url: db.url, onFault: () => {} });
    cleanups.push(() => restarted.close());
  });

  test('a fresh database is not migrated by maintenance', async () => {
    const db = await scratch();
    await withMaintenanceOwnership(db.url, async () => {});
    const [schema] =
      await db.admin`select count(*)::int as count from information_schema.schemata where schema_name = 'runtime'`;
    expect(schema?.count).toBe(0);
  });

  test('concurrent maintenance commands do not both proceed', async () => {
    const db = await scratch();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withMaintenanceOwnership(db.url, async () => {
      entered();
      await held;
    });
    await inside;
    await expect(withMaintenanceOwnership(db.url, async () => {})).rejects.toMatchObject({ reason: 'runtime_running' });
    release();
    await first;
    expect(await lockHolders(db)).toBe(0);
  });
});
