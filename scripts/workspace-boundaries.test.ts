import { describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import {
  dependencyFields,
  importSpecifiers,
  isWithin,
  listSourceFiles,
  listWorkspacePackages,
  repoRoot,
  resolveRelative,
} from './lib/workspace.ts';

const packages = await listWorkspacePackages();
const spikesDir = join(repoRoot, 'spikes');
const runtimeDir = join(repoRoot, 'packages', 'runtime');
const uiDir = join(repoRoot, 'packages', 'ui');
const subscriptionDir = join(repoRoot, 'packages', 'anthropic-subscription');
const subscriptionPackage = '@agent-runtime/anthropic-subscription';
// The subscription package reaches the network only through its injected transport and has no ambient configuration.
const ambientIo: [string, RegExp][] = [
  ['global fetch', /(?<![.\w])fetch\s*\(|globalThis\s*\.\s*fetch/],
  ['environment', /\bprocess\s*\.\s*env\b|\bBun\s*\.\s*env\b|import\.meta\.env/],
  ['console output', /\bconsole\s*\./],
];
// The official PostgreSQL checkpointer is the only approved user of node-postgres.
const saverAdapterDir = join(runtimeDir, 'src', 'persistence', 'saver');
const saverOnlyModules = [/^pg(?:\/|$)/, /^pg-/, /^@langchain\/langgraph-checkpoint-postgres(?:\/|$)/];

interface ImportRecord {
  file: string;
  specifier: string;
  resolved: string | undefined;
}

async function importsOf(dir: string): Promise<ImportRecord[]> {
  const records: ImportRecord[] = [];
  for (const file of listSourceFiles(dir)) {
    for (const specifier of importSpecifiers(await Bun.file(file).text())) {
      records.push({ file, specifier, resolved: resolveRelative(file, specifier) });
    }
  }
  return records;
}

const describeImport = (record: ImportRecord) => `${relative(repoRoot, record.file)} -> ${record.specifier}`;

describe('workspace import boundaries', () => {
  test('import scanning detects static, dynamic, type and re-export specifiers', () => {
    const source = `
      import { a } from '../../spikes/anthropic-parity/src/a.ts';
      import type { B } from '@agent-runtime/runtime';
      export * from 'pg';
      const c = await import('@langchain/langgraph-checkpoint-postgres');
    `;
    const file = join(uiDir, 'src', 'synthetic.ts');
    const specifiers = importSpecifiers(source);
    expect(specifiers).toEqual(
      expect.arrayContaining([
        '../../spikes/anthropic-parity/src/a.ts',
        'pg',
        '@langchain/langgraph-checkpoint-postgres',
      ]),
    );
    expect(isWithin(spikesDir, resolveRelative(file, '../../spikes/anthropic-parity/src/a.ts') ?? '')).toBe(false);
    expect(isWithin(spikesDir, resolveRelative(file, '../../../spikes/anthropic-parity/src/a.ts') ?? '')).toBe(true);
    expect(isWithin(uiDir, resolveRelative(file, '../../runtime/src/server.ts') ?? '')).toBe(false);
  });

  test('the expected runtime, UI and subscription packages exist', () => {
    expect(packages.map((pkg) => pkg.manifest.name)).toEqual([
      subscriptionPackage,
      '@agent-runtime/runtime',
      '@agent-runtime/ui',
    ]);
    expect(packages.every((pkg) => pkg.manifest.private === true)).toBe(true);
  });

  test('no package imports the upstream plugin, an OpenCode host or its private files', async () => {
    const violations = (await importsOf(join(repoRoot, 'packages'))).filter((record) =>
      /^@(?:ex-machina|opencode|opencode-ai)\/|(^|\/)opencode-anthropic-auth(\/|$)/.test(record.specifier),
    );
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('the subscription package imports only its own modules and platform built-ins', async () => {
    const violations = (await importsOf(subscriptionDir)).filter((record) => {
      if (record.specifier.startsWith('.')) return false;
      if (/^node:(?:crypto|buffer)$/.test(record.specifier)) return false;
      const isTest = /\.test\.ts$/.test(record.file) || isWithin(join(subscriptionDir, 'test-support'), record.file);
      return !(isTest && /^(?:bun:test|node:[a-z_]+)$/.test(record.specifier));
    });
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('the ambient-I/O detector recognizes each forbidden access', () => {
    const samples = ['await fetch(url)', 'globalThis.fetch', 'process.env.X', 'Bun.env.X', "console.warn('x')"];
    for (const sample of samples) {
      expect(ambientIo.some(([, pattern]) => pattern.test(sample))).toBe(true);
    }
    expect(ambientIo.some(([, pattern]) => pattern.test('await context.transport(request)'))).toBe(false);
  });

  test('the subscription package performs no I/O of its own and reads no environment', async () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(join(subscriptionDir, 'src'))) {
      if (/\.test\.ts$/.test(file)) continue;
      const source = await Bun.file(file).text();
      for (const [label, pattern] of ambientIo) {
        if (pattern.test(source)) violations.push(`${relative(repoRoot, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('only the runtime imports the subscription package, through its public entry', async () => {
    const violations = (await importsOf(join(repoRoot, 'packages'))).filter(
      (record) =>
        record.specifier.startsWith(subscriptionPackage) &&
        (!isWithin(runtimeDir, record.file) || record.specifier !== subscriptionPackage),
    );
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('no package imports historical spike code', async () => {
    const violations = (await importsOf(join(repoRoot, 'packages'))).filter(
      (record) =>
        /(^|\/)spikes(\/|$)/.test(record.specifier) ||
        (record.resolved !== undefined && isWithin(spikesDir, record.resolved)),
    );
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('relative imports stay inside their own package', async () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const record of await importsOf(pkg.dir)) {
        if (record.resolved !== undefined && !isWithin(pkg.dir, record.resolved))
          violations.push(describeImport(record));
      }
    }
    expect(violations).toEqual([]);
  });

  test('the UI never imports runtime internals or server-only modules', async () => {
    const violations = (await importsOf(join(uiDir, 'src'))).filter((record) => {
      const isTest = /\.test\.[jt]sx?$/.test(record.file);
      return (
        record.specifier.startsWith('@agent-runtime/runtime') ||
        record.specifier === 'pg' ||
        (!isTest && (record.specifier === 'bun' || /^(?:bun|node):/.test(record.specifier)))
      );
    });
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('the runtime uses only the public UI entry', async () => {
    const violations = (await importsOf(runtimeDir)).filter((record) =>
      record.specifier.startsWith('@agent-runtime/ui/'),
    );
    expect(violations.map(describeImport)).toEqual([]);
  });

  test('node-postgres is imported only by the approved saver adapter', async () => {
    const violations = (await importsOf(join(repoRoot, 'packages'))).filter(
      (record) =>
        saverOnlyModules.some((pattern) => pattern.test(record.specifier)) && !isWithin(saverAdapterDir, record.file),
    );
    expect(violations.map(describeImport)).toEqual([]);
  });
});

// On Bun 1.3.14 a plain pool query can run inside another caller's transaction, so runtime code reaches PostgreSQL
// only through the application database adapter, which exposes transactions and reserved sessions but no pool.
const appDatabaseAdapter = join(runtimeDir, 'src', 'persistence', 'app-database.ts');

function bunPoolAccess(source: string): string[] {
  const found: string[] = [];
  if (/\bnew\s+SQL\s*\(/.test(source)) found.push('new SQL(');
  if (/\bBun\s*\.\s*(?:sql|SQL)\b/.test(source)) found.push('Bun.sql/Bun.SQL');
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]bun['"]/g)) {
    if (match[1] !== undefined) continue;
    const values = (match[2] ?? '')
      .split(',')
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== '' && !specifier.startsWith('type '));
    for (const specifier of values) {
      if (/^(?:SQL|sql)(?:\s+as\s+\w+)?$/.test(specifier)) found.push(`import { ${specifier} } from 'bun'`);
    }
  }
  if (/import\s+\w+\s+from\s*['"]bun['"]/.test(source)) found.push("default import from 'bun'");
  return found;
}

describe('application database access', () => {
  test('the detector recognizes every way to open a Bun SQL pool', () => {
    expect(bunPoolAccess("import { SQL } from 'bun';\nconst db = new SQL(url);")).toEqual([
      'new SQL(',
      "import { SQL } from 'bun'",
    ]);
    expect(bunPoolAccess("import { sql } from 'bun';")).toEqual(["import { sql } from 'bun'"]);
    expect(bunPoolAccess('await Bun.sql`select 1`;')).toEqual(['Bun.sql/Bun.SQL']);
    expect(bunPoolAccess("import bun from 'bun';")).toEqual(["default import from 'bun'"]);
    expect(bunPoolAccess("import type { SQL, TransactionSQL } from 'bun';")).toEqual([]);
    expect(bunPoolAccess("import { type ReservedSQL, type TransactionSQL } from 'bun';")).toEqual([]);
  });

  test('only the application database adapter starts transactions with begin()', async () => {
    // A failed ReservedSQL.begin() raises an extra unhandled rejection on Bun 1.3.14; everything else goes through
    // AppDatabase.transaction/readOnly (pool) or sessionTransaction (reserved sessions).
    const violations: string[] = [];
    for (const file of listSourceFiles(runtimeDir)) {
      if (file === appDatabaseAdapter || /\.test\.ts$/.test(file)) continue;
      if (/\.begin\s*\(/.test(await Bun.file(file).text())) violations.push(relative(repoRoot, file));
    }
    expect(violations).toEqual([]);
  });

  test('only the application database adapter opens Bun SQL connections', async () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(runtimeDir)) {
      if (file === appDatabaseAdapter) continue;
      for (const access of bunPoolAccess(await Bun.file(file).text())) {
        violations.push(`${relative(repoRoot, file)}: ${access}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// The agent's workspace tools only read, and the execution layer that runs the agent dispatches nothing but its
// three tools and guarded model requests. Neither may reach process execution, dynamic evaluation or any
// filesystem mutation; the tool and execution tests separately prove behavior with independent witnesses.
const workspaceToolsDir = join(runtimeDir, 'src', 'workspace');
const executionDir = join(runtimeDir, 'src', 'execution');
const forbiddenInWorkspaceTools: [string, RegExp][] = [
  ['process execution', /\bBun\s*\.\s*(?:spawn|spawnSync|\$)\b|child_process|\bexecSync\b|\bexecFile\b|\bspawn\s*\(/],
  ['dynamic evaluation', /\beval\s*\(|\bnew\s+Function\s*\(/],
  [
    'filesystem mutation',
    /\b(?:writeFile|appendFile|unlink|rename|mkdir|mkdtemp|rmdir|rm|chmod|chown|lchown|symlink|link|truncate|utimes|copyFile|cp)(?:Sync)?\s*\(|\bBun\s*\.\s*write\b|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/,
  ],
];

describe('workspace tools cannot execute or mutate', () => {
  test('the detector recognizes each forbidden capability', () => {
    const samples = [
      "Bun.spawn(['sh'])",
      "import { exec } from 'node:child_process'",
      'eval(code)',
      'await writeFile(path, data)',
      'unlinkSync(path)',
      'open(path, constants.O_WRONLY)',
      'await Bun.write(path, data)',
    ];
    for (const sample of samples) {
      expect(forbiddenInWorkspaceTools.some(([, pattern]) => pattern.test(sample))).toBe(true);
    }
    expect(
      forbiddenInWorkspaceTools.some(([, pattern]) => pattern.test('await lstat(path); symlinks are refused')),
    ).toBe(false);
  });

  test('workspace tool, execution and subscription-package source contains none of them', async () => {
    const violations: string[] = [];
    for (const file of [
      ...listSourceFiles(workspaceToolsDir),
      ...listSourceFiles(executionDir),
      ...listSourceFiles(join(subscriptionDir, 'src')),
    ]) {
      if (/\.test\.ts$/.test(file)) continue;
      const source = await Bun.file(file).text();
      for (const [label, pattern] of forbiddenInWorkspaceTools) {
        if (pattern.test(source)) violations.push(`${relative(repoRoot, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('workspace dependency boundaries', () => {
  test('internal dependencies use workspace links and the UI never depends on the runtime', () => {
    const internal = new Set(packages.map((pkg) => pkg.manifest.name));
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const field of dependencyFields) {
        for (const [name, version] of Object.entries(pkg.manifest[field] ?? {})) {
          if (internal.has(name) && version !== 'workspace:*')
            violations.push(`${pkg.manifest.name}: ${name}@${version}`);
          if (/^(?:file|link):/.test(version)) violations.push(`${pkg.manifest.name}: ${name}@${version}`);
          if (pkg.manifest.name === '@agent-runtime/ui' && name === '@agent-runtime/runtime') {
            violations.push(`${pkg.manifest.name} depends on the runtime`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('the subscription package declares no dependencies and only the runtime depends on it', () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const field of dependencyFields) {
        const declared = Object.keys(pkg.manifest[field] ?? {});
        if (pkg.manifest.name === subscriptionPackage && declared.length > 0)
          violations.push(`${subscriptionPackage} ${field}: ${declared.join(', ')}`);
        if (pkg.manifest.name !== '@agent-runtime/runtime' && declared.includes(subscriptionPackage))
          violations.push(`${pkg.manifest.name} depends on ${subscriptionPackage}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('only the runtime declares node-postgres', () => {
    const declaring = packages
      .filter((pkg) => dependencyFields.some((field) => pkg.manifest[field]?.pg !== undefined))
      .map((pkg) => pkg.manifest.name);
    expect(declaring).toEqual(['@agent-runtime/runtime']);
  });
});
