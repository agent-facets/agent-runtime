// A server connection as the owner approved it (design Decision 4): its approval digest, and the launch plan for a
// retained declaration under the owner's current program, environment and credential-slot bindings. Shared by
// command-start preflight and per-call dispatch so that what is approved, what is inspected and what is called can
// never be computed differently. Nothing here starts a process.
import type { CapabilityConfig, ServerAccess } from '../config/capabilities.ts';
import type { McpSlotRead } from '../credentials/mcp-store.ts';
import {
  declarationLaunchInputs,
  type LaunchRefusal,
  planLaunch,
  type StdioServerParameters,
} from '../mcp/transport.ts';
import { digestOf } from '../records/canonical.ts';
import type { ContentPolicy } from '../security/content-policy.ts';

/**
 * The approval digest of a server connection: its portable declaration and everything the runtime adds to run it —
 * the program bundle, the argument vector, the logical working directory and the environment and credential-slot
 * bindings. Credential values are never part of it. Any change requires the owner to approve the new digest.
 */
export function serverDigest(
  server: { serverId: string; declaration: Record<string, unknown> },
  access: ServerAccess,
  program: { sha256: string },
): string {
  return digestOf({
    version: 1,
    declaration: server.declaration,
    program: { id: access.programId, sha256: program.sha256 },
    workingDirectory: `mcp/${server.serverId}`,
    literalEnv: access.literalEnv,
    credentialEnv: access.credentialEnv,
  });
}

export interface LaunchDeps {
  stateDir: string;
  /** The runtime's own pinned Bun. */
  bunPath: string;
  readCredential(slot: string): Promise<McpSlotRead>;
}

export type ServerLaunch =
  | { ok: true; digest: string; params: StdioServerParameters }
  | {
      ok: false;
      reason:
        | 'server_not_approved'
        | 'server_denied'
        | 'program_unavailable'
        | 'server_reapproval_required'
        | 'transport_unsupported'
        | 'declaration_invalid'
        | 'credential_unavailable'
        | LaunchRefusal;
    };

export type ApprovedConnection =
  | {
      ok: true;
      digest: string;
      access: ServerAccess & { approval: { kind: 'approved' } };
      program: CapabilityConfig['localPrograms'][string];
    }
  | {
      ok: false;
      reason: 'server_not_approved' | 'server_denied' | 'program_unavailable' | 'server_reapproval_required';
    };

/**
 * The owner's current approval of a connection for exactly this declaration and binding. `expectedDigest`, when
 * given, must also match: an accepted run uses only the connection its definitions were retained under.
 */
export function approvedConnection(
  server: { serverId: string; declaration: Record<string, unknown> },
  grants: CapabilityConfig | undefined,
  expectedDigest?: string,
): ApprovedConnection {
  const access = grants?.servers.find((candidate) => candidate.serverId === server.serverId);
  if (access === undefined) return { ok: false, reason: 'server_not_approved' };
  if (access.approval.kind === 'denied') return { ok: false, reason: 'server_denied' };
  const program = grants?.localPrograms[access.programId];
  if (program === undefined) return { ok: false, reason: 'program_unavailable' };
  const digest = serverDigest(server, access, program);
  if (access.approval.serverDigest !== digest || (expectedDigest !== undefined && expectedDigest !== digest)) {
    return { ok: false, reason: 'server_reapproval_required' };
  }
  return { ok: true, digest, access: access as ServerAccess & { approval: { kind: 'approved' } }, program };
}

/**
 * How to start a server for a declaration under the owner's current configuration, if its connection is approved
 * (see `approvedConnection`). Credential values are read last, only when everything else is in order.
 */
export async function planServerLaunch(
  server: { serverId: string; declaration: Record<string, unknown> },
  grants: CapabilityConfig | undefined,
  deps: LaunchDeps,
  policy: ContentPolicy,
  expectedDigest?: string,
): Promise<ServerLaunch> {
  const approved = approvedConnection(server, grants, expectedDigest);
  if (!approved.ok) return approved;
  const { access, program, digest } = approved;
  const declaration = declarationLaunchInputs(server.declaration);
  if (!declaration.ok) return declaration;
  const credentialEnv: Record<string, string> = {};
  for (const [name, slot] of Object.entries(access.credentialEnv)) {
    const read = await deps.readCredential(slot);
    if (read.kind !== 'present') return { ok: false, reason: 'credential_unavailable' };
    credentialEnv[name] = read.value;
  }
  const plan = await planLaunch(
    {
      serverId: server.serverId,
      program,
      args: declaration.args,
      declarationEnv: declaration.env,
      literalEnv: access.literalEnv,
      credentialEnv,
    },
    { stateDir: deps.stateDir, bunPath: deps.bunPath, policy },
  );
  return plan.ok ? { ok: true, digest, params: plan.params } : plan;
}
