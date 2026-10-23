// Credential files in the private runtime volume: <root>/<provider>/<slot>.json.
//
// Directories must be owned by this user with mode 0700 and records 0600, single-linked regular files; anything
// else (a symlink, a hard link, a FIFO, loose permissions) is refused rather than repaired, because it means
// something other than this runtime has touched the store. Replacement never truncates the live record:
//
//   open(temp, O_CREAT|O_EXCL|O_NOFOLLOW, 0600) in the same directory → write all bytes → fsync → close
//   → rename over the record → fsync the directory
//
// and is acknowledged only after the directory fsync. A crash at any point leaves either the old or the new
// complete record. This module does not serialize writers; callers hold the provider lock (coordination.ts).
// Descriptor-level control uses Bun's node:fs implementation; there is no Node runtime involved.
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provider } from '../records/schemas.ts';
import { CREDENTIAL_RECORD_MAX_BYTES, type CredentialRecord, decodeCredentialRecord, slotSchema } from './record.ts';

export type CredentialStoreErrorCode = 'unsafe_storage' | 'invalid_record' | 'stale_generation' | 'write_failed';

export class CredentialStoreError extends Error {
  override readonly name = 'CredentialStoreError';
  constructor(
    readonly code: CredentialStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'record'; record: CredentialRecord }
  /** Present but not a valid record (truncated, corrupt, wrong slot or version): fails closed. */
  | { kind: 'invalid' }
  /** Storage is not private (permissions, owner, links, file type): fails closed. */
  | { kind: 'unsafe' };

export const WRITE_POINTS = [
  'after-temp-create',
  'mid-write',
  'before-fsync',
  'after-fsync',
  'after-rename',
  'after-dir-fsync',
] as const;
export type WritePoint = (typeof WRITE_POINTS)[number];

/** Test instrumentation: pause or fail at named write boundaries, and force short writes. */
export interface WriteHooks {
  at?: (point: WritePoint) => void | Promise<void>;
  maxWriteBytes?: number;
}

const errno = (error: unknown) => (error as { code?: string } | null)?.code;
const uid = () => process.getuid?.() ?? -1;
const isPrivate = (mode: number | bigint) => (Number(mode) & 0o077) === 0;

export class CredentialStore {
  constructor(readonly root: string) {}

  directoryFor(provider: Provider): string {
    return join(this.root, provider);
  }

  pathFor(provider: Provider, slot: string): string {
    if (!slotSchema.safeParse(slot).success)
      throw new CredentialStoreError('invalid_record', 'invalid credential slot');
    return join(this.directoryFor(provider), `${slot}.json`);
  }

  /** Creates (0700) or verifies the private directories; refuses directories that are not private to this user. */
  async ensureDirectories(provider: Provider): Promise<void> {
    for (const directory of [this.root, this.directoryFor(provider)]) {
      const state = await privateDirectory(directory);
      if (state === 'missing') {
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if (errno(error) !== 'EEXIST')
            throw new CredentialStoreError('unsafe_storage', 'cannot create credential storage');
        }
        if ((await privateDirectory(directory)) !== 'private') {
          throw new CredentialStoreError('unsafe_storage', 'credential storage is not private');
        }
      } else if (state !== 'private') {
        throw new CredentialStoreError('unsafe_storage', 'credential storage is not private');
      }
    }
  }

  async read(provider: Provider, slot: string): Promise<ReadResult> {
    for (const directory of [this.root, this.directoryFor(provider)]) {
      const state = await privateDirectory(directory);
      if (state === 'missing') return { kind: 'missing' };
      if (state !== 'private') return { kind: 'unsafe' };
    }
    let handle: FileHandle;
    try {
      // O_NONBLOCK keeps a FIFO planted at the record path from blocking the open.
      handle = await open(
        this.pathFor(provider, slot),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errno(error) === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unsafe' };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid() || !isPrivate(stat.mode) || stat.nlink !== 1) return { kind: 'unsafe' };
      if (stat.size > CREDENTIAL_RECORD_MAX_BYTES) return { kind: 'invalid' };
      const bytes = await readAll(handle, CREDENTIAL_RECORD_MAX_BYTES + 1);
      if (bytes.byteLength > CREDENTIAL_RECORD_MAX_BYTES) return { kind: 'invalid' };
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return { kind: 'invalid' };
      }
      const record = decodeCredentialRecord(value, provider, slot);
      return record === undefined ? { kind: 'invalid' } : { kind: 'record', record };
    } finally {
      await handle.close();
    }
  }

  /**
   * Durably replaces a slot's record. The new record must be valid and newer than any valid record on disk;
   * an invalid existing record may be replaced (that is how reauthorization repairs it), an unsafe one may not.
   */
  async replace(record: CredentialRecord, hooks: WriteHooks = {}): Promise<void> {
    const { provider, slot } = record;
    if (decodeCredentialRecord(structuredClone(record), provider, slot) === undefined) {
      throw new CredentialStoreError('invalid_record', 'refusing to store an invalid credential record');
    }
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
    if (bytes.byteLength > CREDENTIAL_RECORD_MAX_BYTES) {
      throw new CredentialStoreError('invalid_record', 'credential record is too large');
    }
    await this.ensureDirectories(provider);
    const current = await this.read(provider, slot);
    if (current.kind === 'unsafe') throw new CredentialStoreError('unsafe_storage', 'credential record is not private');
    if (current.kind === 'record' && current.record.generation >= record.generation) {
      throw new CredentialStoreError('stale_generation', 'a newer credential generation is already stored');
    }

    const directory = this.directoryFor(provider);
    const target = this.pathFor(provider, slot);
    const temp = join(directory, `${slot}.json.${crypto.randomUUID()}.tmp`);
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
      await unlink(temp).catch(() => {});
      throw error instanceof CredentialStoreError
        ? error
        : new CredentialStoreError('write_failed', 'credential record could not be written');
    }
    try {
      await hooks.at?.('after-rename');
      await syncDirectory(directory);
      await hooks.at?.('after-dir-fsync');
    } catch {
      // The rename happened, but its durability is not established; the write is not acknowledged.
      throw new CredentialStoreError('write_failed', 'credential record replacement could not be made durable');
    }
  }

  /**
   * Removes this slot's temporary files abandoned by a crash. Only regular files owned by this user whose names
   * match this slot's temp pattern are touched. Call only while holding the provider lock.
   */
  async removeAbandonedTemps(provider: Provider, slot: string): Promise<number> {
    this.pathFor(provider, slot);
    const directory = this.directoryFor(provider);
    if ((await privateDirectory(directory)) !== 'private') return 0;
    const pattern = new RegExp(`^${slot.replaceAll('-', '\\-')}\\.json\\.[0-9a-f]{8}-[0-9a-f-]{27}\\.tmp$`);
    let removed = 0;
    for (const name of await readdir(directory)) {
      if (!pattern.test(name)) continue;
      const path = join(directory, name);
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined || !stat.isFile() || stat.uid !== uid()) continue;
      await unlink(path).then(
        () => removed++,
        () => {},
      );
    }
    return removed;
  }
}

async function privateDirectory(path: string): Promise<'missing' | 'private' | 'unsafe'> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && stat.uid === uid() && isPrivate(stat.mode) ? 'private' : 'unsafe';
  } catch (error) {
    return errno(error) === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

async function readAll(handle: FileHandle, limit: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await handle.read(buffer, length, limit - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, hooks: WriteHooks): Promise<void> {
  const chunk = hooks.maxWriteBytes ?? bytes.byteLength;
  let offset = 0;
  let first = true;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, Math.min(chunk, bytes.byteLength - offset), offset);
    if (bytesWritten <= 0) throw new CredentialStoreError('write_failed', 'credential record write made no progress');
    offset += bytesWritten;
    if (first) {
      first = false;
      if (offset < bytes.byteLength) await hooks.at?.('mid-write');
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
