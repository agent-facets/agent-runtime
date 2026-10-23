import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { compareProvenance, type ObservedUpstream, type RecordedProvenance } from './lib/provenance.ts';
import { repoRoot } from './lib/workspace.ts';

const recorded = (await Bun.file(
  join(repoRoot, 'packages', 'anthropic-subscription', 'provenance.json'),
).json()) as RecordedProvenance;

function baselineObservation(): ObservedUpstream {
  const files: Record<string, string> = { [recorded.upstream.licenseFile]: recorded.upstream.licenseSha256 };
  for (const source of recorded.sources) files[source.path] = source.sha256;
  return {
    version: recorded.upstream.version,
    gitHead: recorded.upstream.revision,
    registryIntegrity: recorded.upstream.tarballIntegrity,
    tarballIntegrity: recorded.upstream.tarballIntegrity,
    revision: recorded.upstream.revision,
    files,
    sourceFiles: recorded.sources.map((source) => source.path),
  };
}

describe('upstream provenance comparison', () => {
  test('the recorded baseline is consistent with itself', () => {
    expect(compareProvenance(recorded, baselineObservation())).toEqual({ problems: [], changed: [], unrecorded: [] });
  });

  test('a tampered tarball, changed source or unrecorded file contradicts the baseline', () => {
    const observed = baselineObservation();
    observed.tarballIntegrity = 'sha512-different';
    observed.files['src/auth.ts'] = '0'.repeat(64);
    observed.sourceFiles.push('src/new-feature.ts');
    const report = compareProvenance(recorded, observed);
    expect(report.problems).toEqual([
      'downloaded tarball does not match the registry integrity',
      'src/auth.ts differs from the recorded baseline',
      'unrecorded upstream sources: src/new-feature.ts',
    ]);
  });

  test('a candidate update reports its differences without calling them baseline problems', () => {
    const observed = {
      ...baselineObservation(),
      version: '2.0.0-next.6',
      revision: 'f'.repeat(40),
      gitHead: 'f'.repeat(40),
    };
    observed.files = { ...observed.files, 'src/cch.ts': '1'.repeat(64), 'src/pkce.ts': undefined };
    observed.sourceFiles = [...observed.sourceFiles, 'src/extra.ts'];
    expect(compareProvenance(recorded, observed)).toEqual({
      problems: [],
      changed: ['src/pkce.ts (removed)', 'src/cch.ts'],
      unrecorded: ['src/extra.ts'],
    });
  });

  test('a registry revision that disagrees with the requested one is a problem', () => {
    const observed = { ...baselineObservation(), gitHead: 'e'.repeat(40) };
    expect(compareProvenance(recorded, observed).problems).toEqual([
      `registry gitHead ${'e'.repeat(40)} differs from revision ${recorded.upstream.revision}`,
    ]);
  });
});
