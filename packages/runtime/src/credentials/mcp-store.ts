// Private MCP credential slots: <state>/mcp-credentials/<slot>.json holding `{ version: 1, value }`. The owner
// provisions them through stdin while the runtime is stopped (operator/auth-command.ts); the runtime only reads them
// at startup. They follow the provider store's hygiene: owner-only directory and single-linked regular files,
// refused (never repaired) when anything else has touched them, and replaced atomically with a durable rename.
// Nothing here deletes a slot.
import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CREDENTIAL_TOKEN_MAX_LENGTH,
  CREDENTIAL_TOKEN_MIN_LENGTH,
  CREDENTIAL_TOKEN_PATTERN,
  slotSchema,
} from './record.ts';
import {
  CredentialStoreError,
  errno,
  isPrivate,
  privateDirectory,
  readAll,
  syncDirectory,
  uid,
  type WriteHooks,
  writeAll,
} from './store.ts';

export const MCP_CREDENTIALS_DIRECTORY = 'mcp-credentials';
const RECORD_MAX_BYTES = CREDENTIAL_TOKEN_MAX_LENGTH + 64;

/** The same floor and grammar as provider tokens, so exact-match screening can always recognize the value. */
export const mcpSecretSchema = z
  .string()
  .min(CREDENTIAL_TOKEN_MIN_LENGTH)
  .max(CREDENTIAL_TOKEN_MAX_LENGTH)
  .regex(CREDENTIAL_TOKEN_PATTERN);

const recordSchema = z.strictObject({ version: z.literal(1), value: mcpSecretSchema });

export type McpSlotRead =
  | { kind: 'missing' }
  | { kind: 'present'; value: string }
  /** Present but unusable: not private, not a regular single-linked file, unreadable or not a valid record. */
  | { kind: 'unusable' };

export interface ConfiguredMcpCredentials {
  /** Values of the configured slots that hold one, for screening only. */
  values: string[];
  /** Configured slots whose storage cannot be read safely: screening is incomplete while any exist. */
  unusable: string[];
}

/**
 * Reads every slot the configuration binds, once, at startup. A missing slot holds no value to screen (its server
 * cannot start); an unusable one leaves screening incomplete, so callers fail closed.
 */
export async function loadConfiguredMcpCredentials(
  store: McpCredentialStore,
  slots: Iterable<string>,
): Promise<ConfiguredMcpCredentials> {
  const values: string[] = [];
  const unusable: string[] = [];
  for (const slot of [...new Set(slots)].sort()) {
    let read: McpSlotRead;
    try {
      read = await store.read(slot);
    } catch {
      read = { kind: 'unusable' };
    }
    if (read.kind === 'present') values.push(read.value);
    else if (read.kind === 'unusable') unusable.push(slot);
  }
  return { values, unusable };
}

export class McpCredentialStore {
  constructor(readonly directory: string) {}

  static forStateDir(stateDir: string): McpCredentialStore {
    return new McpCredentialStore(join(stateDir, MCP_CREDENTIALS_DIRECTORY));
  }

  pathFor(slot: string): string {
    if (!slotSchema.safeParse(slot).success)
      throw new CredentialStoreError('invalid_record', 'invalid credential slot');
    return join(this.directory, `${slot}.json`);
  }

  async read(slot: string): Promise<McpSlotRead> {
    const path = this.pathFor(slot);
    const state = await privateDirectory(this.directory);
    if (state === 'missing') return { kind: 'missing' };
    if (state !== 'private') return { kind: 'unusable' };
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      return errno(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unusable' };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid() || !isPrivate(stat.mode) || stat.nlink !== 1)
        return { kind: 'unusable' };
      if (stat.size > RECORD_MAX_BYTES) return { kind: 'unusable' };
      const bytes = await readAll(handle, RECORD_MAX_BYTES + 1);
      if (bytes.byteLength > RECORD_MAX_BYTES) return { kind: 'unusable' };
      const parsed = recordSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      return parsed.success ? { kind: 'present', value: parsed.data.value } : { kind: 'unusable' };
    } catch {
      return { kind: 'unusable' };
    } finally {
      await handle.close();
    }
  }

  /**
   * Durably replaces a slot's value. An unreadable or malformed existing record may be replaced; storage that is not
   * private (loose permissions, another owner, a link or a special file) is refused, never repaired.
   */
  async replace(slot: string, value: string, hooks: WriteHooks = {}): Promise<void> {
    const target = this.pathFor(slot);
    if (!mcpSecretSchema.safeParse(value).success) {
      throw new CredentialStoreError('invalid_record', 'the credential value is not acceptable');
    }
    const state = await privateDirectory(this.directory);
    if (state === 'missing') {
      try {
        await mkdir(this.directory, { mode: 0o700 });
      } catch (error) {
        if (errno(error) !== 'EEXIST')
          throw new CredentialStoreError('unsafe_storage', 'cannot create credential storage');
      }
      if ((await privateDirectory(this.directory)) !== 'private') {
        throw new CredentialStoreError('unsafe_storage', 'credential storage is not private');
      }
    } else if (state !== 'private') {
      throw new CredentialStoreError('unsafe_storage', 'credential storage is not private');
    }
    await this.#requireReplaceable(target);

    const bytes = new TextEncoder().encode(`${JSON.stringify({ version: 1, value })}\n`);
    const temp = join(this.directory, `${slot}.json.${crypto.randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await hooks.at?.('after-temp-create');
      await writeAll(handle, bytes, hooks);
      await hooks.at?.('before-fsync');
      await handle.sync();
      await hooks.at?.('after-fsync');
      await handle.close();
      handle = undefined;
      await rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      // Only this write's own temporary file is removed; the slot itself is never deleted.
      await unlink(temp).catch(() => {});
      throw error instanceof CredentialStoreError
        ? error
        : new CredentialStoreError('write_failed', 'credential record could not be written');
    }
    try {
      await hooks.at?.('after-rename');
      await syncDirectory(this.directory);
      await hooks.at?.('after-dir-fsync');
    } catch {
      throw new CredentialStoreError('write_failed', 'credential record replacement could not be made durable');
    }
  }

  /** The existing record path holds nothing or a private, single-linked regular file of this user. */
  async #requireReplaceable(path: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errno(error) === 'ENOENT') return;
      throw new CredentialStoreError('unsafe_storage', 'credential record is not private');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid() || !isPrivate(stat.mode) || stat.nlink !== 1) {
        throw new CredentialStoreError('unsafe_storage', 'credential record is not private');
      }
    } finally {
      await handle.close();
    }
  }
}
