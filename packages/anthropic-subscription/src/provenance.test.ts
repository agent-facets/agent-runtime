import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');

interface SourceEntry {
  path: string;
  sha256: string;
  use: 'adapted' | 'planned' | 'excluded';
  into: string[];
  note: string;
}

interface Provenance {
  upstream: Record<string, string>;
  licenseCopy: string;
  sources: SourceEntry[];
}

const provenance = (await Bun.file(join(packageRoot, 'provenance.json')).json()) as Provenance;
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

describe('upstream provenance record', () => {
  test('pins an exact upstream version, revision and tarball integrity', () => {
    expect(provenance.upstream).toMatchObject({
      package: '@ex-machina/opencode-anthropic-auth',
      version: '2.0.0-next.5',
      revision: '156cb66c6889e1be3ad2b839345ea409942ab40f',
      license: 'MIT',
      copyright: 'Copyright (c) 2026 Ex Machina',
    });
    expect(provenance.upstream.tarballIntegrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  test('keeps the upstream license verbatim and reproduces it in the notices', async () => {
    const license = await Bun.file(join(packageRoot, provenance.licenseCopy)).text();
    expect(sha256(license)).toBe(provenance.upstream.licenseSha256 as string);
    const notices = await Bun.file(join(packageRoot, 'THIRD_PARTY_NOTICES.md')).text();
    expect(notices).toContain(license.trim());
    expect(notices).toContain(provenance.upstream.revision as string);
  });

  test('records every source with a content hash, a disposition and a reason', () => {
    const paths = provenance.sources.map((source) => source.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const source of provenance.sources) {
      expect(source.path).toMatch(/^src\/[a-z-]+\.ts$/);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(['adapted', 'planned', 'excluded']).toContain(source.use);
      expect(source.note.length).toBeGreaterThan(0);
      if (source.use !== 'adapted') expect(source.into).toEqual([]);
    }
  });

  test('every adapted source names existing files that cite it', async () => {
    for (const source of provenance.sources.filter((entry) => entry.use === 'adapted')) {
      expect(source.into.length).toBeGreaterThan(0);
      for (const file of source.into) {
        const path = join(packageRoot, file);
        expect(existsSync(path)).toBe(true);
        expect(await Bun.file(path).text()).toContain(`opencode-anthropic-auth ${source.path}`);
      }
    }
  });

  test('every upstream source has been either extracted or excluded', () => {
    expect(provenance.sources.filter((source) => source.use === 'planned').map((source) => source.path)).toEqual([]);
  });

  test('the plugin entry and response rewriting are excluded', () => {
    const excluded = provenance.sources.filter((source) => source.use === 'excluded').map((source) => source.path);
    expect(excluded).toEqual(
      expect.arrayContaining(['src/index.ts', 'src/json-response-stream.ts', 'src/rate-limit.ts', 'src/config.ts']),
    );
  });
});
