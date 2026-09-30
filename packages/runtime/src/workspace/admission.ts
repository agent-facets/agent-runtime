// Establishes the workspace policy used by the tools. The configured root must be its own canonical path (no
// symlink anywhere along it), must be a directory, and must be separate from private runtime state and the
// operator configuration by canonical path as well as by spelling. Protection of the private locations must be
// collected completely. Any failure leaves workspace access unavailable; nothing is repaired or created.
//
// This is admission of an owner-controlled volume, not isolation from a hostile process that changes it later.
import { lstat, realpath } from 'node:fs/promises';
import type { OperatorConfig } from '../config/operator.ts';
import { createWorkspacePolicy, type WorkspacePolicy } from './policy.ts';
import { collectProtectedIdentities, ProtectionIncomplete } from './protected.ts';

export type AdmissionFailure =
  | 'workspace_unavailable'
  | 'workspace_alias'
  | 'private_location_overlap'
  | 'protection_incomplete';

export type WorkspaceAdmission = { ok: true; policy: WorkspacePolicy } | { ok: false; code: AdmissionFailure };

export interface PrivateLocations {
  /** Private runtime state; required to exist. */
  stateDir: string;
  /** The operator configuration file that was read. */
  configFile: string;
}

const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const canonical = (path: string) => realpath(path).catch(() => undefined);

export async function admitWorkspace(
  workspace: OperatorConfig['workspace'],
  locations: PrivateLocations,
  options: { maxProtectedEntries?: number } = {},
): Promise<WorkspaceAdmission> {
  const root = workspace.root;
  const realRoot = await canonical(root);
  if (realRoot === undefined) return { ok: false, code: 'workspace_unavailable' };
  if (realRoot !== root) return { ok: false, code: 'workspace_alias' };
  const stat = await lstat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) return { ok: false, code: 'workspace_unavailable' };

  const realState = await canonical(locations.stateDir);
  const realConfig = await canonical(locations.configFile);
  if (realState === undefined || realConfig === undefined) return { ok: false, code: 'protection_incomplete' };
  for (const [spelled, real] of [
    [locations.stateDir, realState],
    [locations.configFile, realConfig],
  ] as const) {
    for (const candidate of [spelled, real]) {
      if (within(root, candidate) || within(candidate, root)) return { ok: false, code: 'private_location_overlap' };
    }
  }

  try {
    const identities = await collectProtectedIdentities([realState, realConfig], {
      maxEntries: options.maxProtectedEntries,
    });
    return { ok: true, policy: createWorkspacePolicy(workspace, identities) };
  } catch (error) {
    if (error instanceof ProtectionIncomplete) return { ok: false, code: 'protection_incomplete' };
    throw error;
  }
}
