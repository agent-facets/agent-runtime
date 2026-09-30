import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileIdentity } from './policy.ts';

export const MAX_PROTECTED_ENTRIES = 10_000;

/** Protection could not be established completely; workspace access must stay unavailable. */
export class ProtectionIncomplete extends Error {
  override readonly name = 'ProtectionIncomplete';
}

const errnoOf = (error: unknown) => (error as { code?: string } | null)?.code;

/**
 * Identities of runtime-private locations (the state directory tree, including credentials, and the operator
 * configuration), collected from metadata only, without following links or reading contents. The workspace tools
 * refuse these inodes wherever they appear, for example through a bind mount inside the workspace.
 *
 * The result is complete or the call fails: a missing root, an unreadable directory, an unexpected metadata
 * error or more than `maxEntries` examined paths throws ProtectionIncomplete. Only an entry that disappears
 * between listing and inspection (a credential slot removed meanwhile) is skipped.
 */
export async function collectProtectedIdentities(
  roots: readonly string[],
  options: { maxEntries?: number } = {},
): Promise<FileIdentity[]> {
  const maxEntries = options.maxEntries ?? MAX_PROTECTED_ENTRIES;
  const identities: FileIdentity[] = [];
  const pending = roots.map((path) => ({ path, root: true }));
  let examined = 0;
  while (pending.length > 0) {
    const { path, root } = pending.pop() as { path: string; root: boolean };
    if (++examined > maxEntries) throw new ProtectionIncomplete('too many private entries to protect');
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (error) {
      if (!root && errnoOf(error) === 'ENOENT') continue;
      throw new ProtectionIncomplete('a private location could not be inspected');
    }
    identities.push({ dev: BigInt(stat.dev), ino: BigInt(stat.ino) });
    if (!stat.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if (!root && errnoOf(error) === 'ENOENT') continue;
      throw new ProtectionIncomplete('a private directory could not be listed');
    }
    if (examined + pending.length + names.length > maxEntries) {
      throw new ProtectionIncomplete('too many private entries to protect');
    }
    for (const name of names) pending.push({ path: join(path, name), root: false });
  }
  return identities;
}
