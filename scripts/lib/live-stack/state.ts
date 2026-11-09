// The live deployment's private management state: its environment file, the selected image and any operation that
// has not finished. Nothing here prints file contents; the environment file holds secrets.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT } from './args.ts';

export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export const VOLUMES = {
  postgres: `${PROJECT}_postgres-data`,
  runtime: `${PROJECT}_runtime-state`,
  tailscale: `${PROJECT}_tailscale-state`,
} as const;

export type PendingOperation =
  | { kind: 'deploy'; from: string; to: string; phase: 'started' | 'runtime-recreated'; startedAt: string }
  | { kind: 'tailscale-recover'; phase: 'started' | 'tailscale-recreated'; startedAt: string };

export interface DeploymentState {
  version: 1;
  project: typeof PROJECT;
  /** Image IDs: the runtime's is the selected release; the others are what the dependencies were adopted with. */
  images: { runtime: string; postgres: string; tailscale: string };
  volumes: typeof VOLUMES;
  pending?: PendingOperation;
  updatedAt: string;
}

export interface Paths {
  stateDir: string;
  envFile: string;
  stateFile: string;
  lockFile: string;
}

export function pathsFor(stateDir: string): Paths {
  return {
    stateDir,
    envFile: join(stateDir, 'compose.env'),
    stateFile: join(stateDir, 'deployment.json'),
    lockFile: join(stateDir, 'management.lock'),
  };
}

export class StateError extends Error {
  override readonly name = 'StateError';
}

const uid = () => process.getuid?.() ?? -1;

/** A private directory owned by this user, created when absent. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory()) throw new StateError(`${dir} is not a directory`);
  if (stat.uid !== uid()) throw new StateError(`${dir} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) throw new StateError(`${dir} is accessible to other users; restrict it to mode 0700`);
}

/** A regular file (not a link) owned by this user and readable by no one else. */
export async function checkPrivateFile(path: string): Promise<'present' | 'absent'> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat === undefined) return 'absent';
  if (!stat.isFile()) throw new StateError(`${path} is not a regular file`);
  if (stat.uid !== uid()) throw new StateError(`${path} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) throw new StateError(`${path} is readable by other users; restrict it to mode 0600`);
  return 'present';
}

/** Reads KEY=VALUE lines the way Compose's environment file does for the values used here. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2] as string;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values.set(match[1] as string, value);
  }
  return values;
}

export async function readEnvFile(path: string): Promise<Map<string, string>> {
  if ((await checkPrivateFile(path)) === 'absent') {
    throw new StateError(`the environment file ${path} does not exist`);
  }
  return parseEnvFile(await readFile(path, 'utf8'));
}

function validPending(value: unknown): value is PendingOperation {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Record<string, unknown>;
  if (typeof pending.startedAt !== 'string') return false;
  if (pending.kind === 'deploy') {
    return (
      IMAGE_ID.test(String(pending.from)) &&
      IMAGE_ID.test(String(pending.to)) &&
      (pending.phase === 'started' || pending.phase === 'runtime-recreated')
    );
  }
  return (
    pending.kind === 'tailscale-recover' && (pending.phase === 'started' || pending.phase === 'tailscale-recreated')
  );
}

export function validateState(value: unknown): DeploymentState {
  const state = value as Partial<DeploymentState> | null;
  const images = state?.images;
  const valid =
    state !== null &&
    typeof state === 'object' &&
    state.version === 1 &&
    state.project === PROJECT &&
    images !== undefined &&
    IMAGE_ID.test(String(images.runtime)) &&
    IMAGE_ID.test(String(images.postgres)) &&
    IMAGE_ID.test(String(images.tailscale)) &&
    JSON.stringify(state.volumes) === JSON.stringify(VOLUMES) &&
    (state.pending === undefined || validPending(state.pending)) &&
    typeof state.updatedAt === 'string';
  if (!valid) throw new StateError('the deployment state file is not valid; it was not changed');
  return state as DeploymentState;
}

export async function readState(paths: Paths): Promise<DeploymentState | undefined> {
  if ((await checkPrivateFile(paths.stateFile)) === 'absent') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.stateFile, 'utf8'));
  } catch {
    throw new StateError('the deployment state file is not valid JSON; it was not changed');
  }
  return validateState(parsed);
}

export async function requireState(paths: Paths): Promise<DeploymentState> {
  const state = await readState(paths);
  if (state === undefined) {
    throw new StateError(`no deployment state: ${paths.stateFile} does not exist`);
  }
  return state;
}

async function writeTemp(dir: string, name: string, data: string | Uint8Array): Promise<string> {
  const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/** Atomically replaces the state file. */
export async function writeState(paths: Paths, state: DeploymentState): Promise<void> {
  validateState(state);
  const temp = await writeTemp(paths.stateDir, 'deployment.json', `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, paths.stateFile);
}
