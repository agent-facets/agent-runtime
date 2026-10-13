// Command-run snapshot retention against a real PostgreSQL fixture (design Decision 6): a snapshot assembled from a
// sealed installation is retained atomically with its run, and the run keeps its full definitions — unloaded skill
// resources included — after the installation file is removed. Inputs are synthetic; no model or server is used.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCommandStart, selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { readInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { assembleSnapshot } from '../../packages/runtime/src/capabilities/snapshot.ts';
import type { CapabilityConfig } from '../../packages/runtime/src/config/capabilities.ts';
import { NO_KNOWN_CREDENTIALS } from '../../packages/runtime/src/credentials/matcher.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { canonicalJson } from '../../packages/runtime/src/records/canonical.ts';
import { type CreateRunInput, RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { binding, DIGEST, workspace } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let store: RunStore;
const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-command-snapshot-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  store = new RunStore(persistence.app, persistence.ownership);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };
const guide = new TextEncoder().encode('# Guide\nRead the diff first.\n');
const definition = (kind: string, name: string, extra: Record<string, unknown>) => ({
  kind,
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: [{ path: kind === 'skill' ? `skills/${name}/SKILL.md` : `${kind}s/${name}.md`, integrity }],
  state: {
    kind: 'ready',
    definition: {
      id: `${kind}:${name}`,
      name,
      description: `About ${name}`,
      origins: [origin],
      exportDigest: DIGEST,
      requires: [],
      ...extra,
    },
  },
});
const bundle = canonicalJson({
  format: 2,
  profile: 1,
  toolchain: {
    cli: { version: '0.36.0', platform: 'linux-x64', sha256: 'c'.repeat(64) },
    adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
  },
  inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: DIGEST, lockSha256: DIGEST },
  facets: [{ facet: 'workflows', version: '1.0.0', source: { kind: 'local', path: './facets/workflows' }, integrity }],
  items: [
    definition('command', 'triage', { body: 'Triage $ARGUMENTS.', arguments: { required: true } }),
    definition('skill', 'review', {
      instructions: 'Review carefully.',
      resources: [
        {
          path: 'references/guide.md',
          byteLength: guide.byteLength,
          sha256: new Bun.CryptoHasher('sha256').update(guide).digest('hex'),
          content: Buffer.from(guide).toString('base64'),
        },
      ],
    }),
    definition('agent', 'scout', { instructions: 'Investigate one question.' }),
  ],
  servers: [],
  omittedServers: [],
});
const grants: CapabilityConfig = {
  installation: { path: join(dir, 'installation.json'), sha256: DIGEST },
  allowSkills: ['skill:review'],
  allowAgents: ['agent:scout'],
  maxDelegationsPerRun: 8,
  localPrograms: {},
  servers: [],
};

describe('retained command snapshots', () => {
  test('an assembled snapshot is retained with its run and survives removal of the installation', async () => {
    const path = join(dir, 'installation.json');
    const bytes = new TextEncoder().encode(`${bundle}\n`);
    writeFileSync(path, bytes);
    const load = await readInstallation(path, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
    if (load.kind !== 'ready') throw new Error(load.reason);
    const submission = {
      kind: 'command' as const,
      commandId: 'command:triage',
      selectionRevision: selectionRevision(load.catalog.installationSha256, 'command:triage'),
      arguments: 'owner/repo-a',
      provider: 'anthropic' as const,
    };
    const policy = createContentPolicy(NO_KNOWN_CREDENTIALS);
    const start = prepareCommandStart(load.catalog, submission, policy);
    if (!start.ok) throw new Error(start.reason);
    const assembled = assembleSnapshot({
      catalog: load.catalog,
      command: start.command,
      submission,
      renderedGoal: start.goal,
      grants,
      policy,
    });
    if (!assembled.ok) throw new Error(assembled.reason);

    const request: CreateRunInput = {
      requestId: crypto.randomUUID(),
      goal: start.goal,
      provider: 'anthropic',
      workspace,
      binding: binding as CreateRunInput['binding'],
      definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
      budgetMax: 50,
      capability: { input: submission, snapshot: assembled.snapshot },
    };
    const created = await store.createRun(request);
    expect(created.created).toBe(true);
    expect(created.snapshot.goal).toBe('Triage owner/repo-a.');
    expect(created.snapshot.command?.snapshotDigest).toBe(assembled.digest);

    rmSync(path);
    expect((await readInstallation(path, DIGEST)).kind).toBe('unavailable');
    const retained = await store.readCapabilities(created.snapshot.runId);
    expect(retained?.snapshotDigest).toBe(assembled.digest);
    expect(retained?.snapshot).toEqual(assembled.snapshot);
    const resource = retained?.snapshot.skills[0]?.resources[0];
    expect(Buffer.from(resource?.content ?? '', 'base64').toString()).toBe('# Guide\nRead the diff first.\n');
    expect(retained?.snapshot.agents.map((agent) => agent.instructions)).toEqual(['Investigate one question.']);

    // The same submission returns the original run without needing the removed installation.
    const retry = await store.createRun(request);
    expect(retry).toMatchObject({ created: false, snapshot: { runId: created.snapshot.runId } });
  });
});
