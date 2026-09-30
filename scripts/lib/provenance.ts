// Comparison of the recorded upstream provenance of packages/anthropic-subscription with freshly observed upstream
// facts. Pure: the networked command (scripts/verify-anthropic-provenance.ts) gathers the observations.

export interface RecordedProvenance {
  upstream: {
    package: string;
    version: string;
    revision: string;
    tarballIntegrity: string;
    licenseFile: string;
    licenseSha256: string;
  };
  sources: { path: string; sha256: string; use: string }[];
}

export interface ObservedUpstream {
  version: string;
  /** The registry's recorded source revision (gitHead) for that version, if any. */
  gitHead: string | undefined;
  registryIntegrity: string;
  /** SHA-512 of the downloaded tarball bytes, in SRI form. */
  tarballIntegrity: string;
  revision: string;
  /** SHA-256 of each file at the observed revision; a missing file is undefined. */
  files: Record<string, string | undefined>;
  /** Every `src/*.ts` source (tests excluded) present at the observed revision. */
  sourceFiles: string[];
}

export interface ProvenanceReport {
  /** Problems that make the observation untrustworthy or contradict the recorded baseline. */
  problems: string[];
  /** Recorded sources whose content differs at the observed revision (expected when reviewing an update). */
  changed: string[];
  /** Upstream sources the record does not mention. */
  unrecorded: string[];
}

export function compareProvenance(recorded: RecordedProvenance, observed: ObservedUpstream): ProvenanceReport {
  const problems: string[] = [];
  if (observed.tarballIntegrity !== observed.registryIntegrity)
    problems.push('downloaded tarball does not match the registry integrity');
  if (observed.gitHead !== undefined && observed.gitHead !== observed.revision)
    problems.push(`registry gitHead ${observed.gitHead} differs from revision ${observed.revision}`);

  const baseline = observed.version === recorded.upstream.version && observed.revision === recorded.upstream.revision;
  if (baseline && observed.registryIntegrity !== recorded.upstream.tarballIntegrity)
    problems.push('registry integrity differs from the recorded baseline');

  const changed: string[] = [];
  const expected = [
    { path: recorded.upstream.licenseFile, sha256: recorded.upstream.licenseSha256 },
    ...recorded.sources.map(({ path, sha256 }) => ({ path, sha256 })),
  ];
  for (const { path, sha256 } of expected) {
    const actual = observed.files[path];
    if (actual === sha256) continue;
    if (baseline) problems.push(`${path} differs from the recorded baseline`);
    else changed.push(actual === undefined ? `${path} (removed)` : path);
  }

  const known = new Set(recorded.sources.map((source) => source.path));
  const unrecorded = observed.sourceFiles.filter((path) => !known.has(path)).sort();
  if (baseline && unrecorded.length > 0) problems.push(`unrecorded upstream sources: ${unrecorded.join(', ')}`);
  return { problems, changed, unrecorded };
}
