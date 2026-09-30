// The workspace policy shared by file reads, directory listings and search. It comes only from operator
// configuration; tool arguments can never widen it. Everything the tools may reveal — content, names, sizes —
// passes the same exclusions first.
//
// Supported environment: owner-controlled volumes. The checks here detect escapes and observed changes; they do
// not make a tree safe against a hostile process mutating it concurrently.
import type { OperatorConfig } from '../config/operator.ts';
import { digestOf } from '../records/canonical.ts';

export const WORKSPACE_PROTOCOL_VERSION = 1;

export const WORKSPACE_LIMITS = Object.freeze({
  fileBytes: 1_048_576,
  readLinesDefault: 200,
  readLinesMax: 2_000,
  entriesDefault: 200,
  entriesMax: 2_000,
  /** Complete serialized tool result, in UTF-8 bytes. */
  resultBytes: 65_536,
  searchMatches: 100,
  searchFiles: 2_000,
  searchBytes: 16_777_216,
  searchQueryBytes: 1_024,
  /** Traversal work per call: raw directory entries examined, directories opened, and depth. */
  rawEntries: 20_000,
  directories: 2_000,
  depth: 64,
  pathBytes: 4_096,
});

/**
 * Names excluded wherever they appear (matched case-insensitively): version-control and dependency trees,
 * environment files (templates included), private keys and common credential stores.
 */
export const DEFAULT_EXCLUDED_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.venv',
  '.env',
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.credentials.json',
  'credentials.json',
  'auth.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

/** Name patterns excluded wherever they appear (case-insensitive). */
export const DEFAULT_EXCLUDED_PATTERNS: readonly RegExp[] = [
  /^\.env\..+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|tfstate)$/i,
  /\.tfstate\.backup$/i,
];

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface WorkspacePolicy {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly limits: typeof WORKSPACE_LIMITS;
  readonly excludedNames: ReadonlySet<string>;
  readonly excludedPatterns: readonly RegExp[];
  /** Relative path prefixes, as component arrays. */
  readonly excludedPaths: readonly (readonly string[])[];
  /** Identities of runtime-private files and directories (credentials, configuration, state). */
  readonly protectedIdentities: ReadonlySet<string>;
  /** SHA-256 of everything above except live identities; part of each run's workspace snapshot. */
  readonly digest: string;
}

export const identityKey = (identity: FileIdentity) => `${identity.dev}:${identity.ino}`;

export function createWorkspacePolicy(
  workspace: OperatorConfig['workspace'],
  protectedIdentities: Iterable<FileIdentity> = [],
): WorkspacePolicy {
  const excludedNames = new Set(
    [...DEFAULT_EXCLUDED_NAMES, ...workspace.excludeNames].map((name) => name.toLowerCase()),
  );
  const excludedPaths = workspace.excludePaths.map((path) => path.split('/'));
  const digest = digestOf({
    protocolVersion: WORKSPACE_PROTOCOL_VERSION,
    root: workspace.root,
    limits: WORKSPACE_LIMITS,
    excludedNames: [...excludedNames].sort(),
    excludedPatterns: DEFAULT_EXCLUDED_PATTERNS.map((pattern) => pattern.source),
    excludedPaths: [...workspace.excludePaths].sort(),
  });
  return Object.freeze({
    id: workspace.id,
    label: workspace.label,
    root: workspace.root,
    limits: WORKSPACE_LIMITS,
    excludedNames,
    excludedPatterns: DEFAULT_EXCLUDED_PATTERNS,
    excludedPaths,
    protectedIdentities: new Set([...protectedIdentities].map(identityKey)),
    digest,
  });
}

/** True when the relative path (as components) or any of its ancestors is excluded. */
export function isExcluded(policy: WorkspacePolicy, parts: readonly string[]): boolean {
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (policy.excludedNames.has(lower)) return true;
    if (policy.excludedPatterns.some((pattern) => pattern.test(part))) return true;
  }
  return policy.excludedPaths.some(
    (prefix) => prefix.length <= parts.length && prefix.every((part, index) => parts[index] === part),
  );
}
