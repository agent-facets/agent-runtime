import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileIdentity } from './policy.ts';

const MAX_ENTRIES = 10_000;

/**
 * Identities of runtime-private locations (the state directory tree, including credentials, and the operator
 * configuration), collected from metadata only, without following links or reading contents. The workspace tools
 * refuse these inodes wherever they appear, for example through a bind mount inside the workspace.
 */
export async function collectProtectedIdentities(paths: readonly string[]): Promise<FileIdentity[]> {
  const identities: FileIdentity[] = [];
  const pending = [...paths];
  while (pending.length > 0 && identities.length < MAX_ENTRIES) {
    const path = pending.pop() as string;
    const stat = await lstat(path, { bigint: true }).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink()) continue;
    identities.push({ dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) {
      const names = await readdir(path).catch(() => [] as string[]);
      for (const name of names) pending.push(join(path, name));
    }
  }
  return identities;
}
