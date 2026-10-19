// The capability routes and HTTP command starts (design Decision 9; tasks 14.1–14.2) through the production API
// routes, run service and the bundled synthetic MCP server. Reading the catalog or a run's capabilities starts
// nothing; only an explicit inspection of an approved server starts one short-lived process, which lists tools and
// closes. The server's own witness log counts processes, listings and calls independently of the runtime.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type SentInference, sse, textTurn, toolTurn } from '../support/anthropic-network.ts';
import { catalogLoad, connectionDigest, mcpService, program, SLOT_VALUE, wire } from '../support/mcp-service.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

// Cases start and close real server processes.
setDefaultTimeout(30_000);

let db: ScratchDatabase;
let persistence: Persistence;
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-capability-api-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  rmSync(scratch, { recursive: true, force: true });
});

if (catalogLoad.kind !== 'ready') throw new Error('fixture catalog');
const REVISION = catalogLoad.catalog.installationSha256;
const SYNC = selectionRevision(REVISION, 'command:sync');
const done = () => sse(textTurn(`msg_${crypto.randomUUID()}`, 'Done.'));

/** Text that must never appear in anything the API returns. */
const PRIVATE = () => [SLOT_VALUE, 'repo-token', 'REPO_TOKEN', 'REPO_MODE', program.bundlePath, scratch];
const expectPrivate = (body: unknown) => {
  const text = JSON.stringify(body);
  for (const hidden of PRIVATE()) expect(text).not.toContain(hidden);
};

describe('the installed catalog', () => {
  test('lists contributions, configured grants and connection approval without starting anything', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items', argumentEquals: { repository: 'owner/repo-a' } }],
      allowSkills: ['skill:review'],
      replies: [],
    });
    const { status, body } = await h.api('GET', '/capabilities');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'ready', catalogRevision: REVISION });
    const byId = new Map(body.contributions.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get('command:sync')).toMatchObject({
      kind: 'command',
      name: 'sync',
      description: 'About sync',
      origins: [{ facet: 'workflows', version: '1.0.0' }],
      availability: { kind: 'ready', selectionRevision: SYNC },
      arguments: { required: true },
    });
    expect(byId.get('skill:review')).toMatchObject({ availability: { kind: 'ready' }, allowed: true });
    expect(byId.get('agent:worker')).toMatchObject({ availability: { kind: 'ready' }, allowed: false });
    expect(body.servers).toEqual([
      {
        serverId: 'synthetic',
        origins: [{ facet: 'workflows', version: '1.0.0', integrity: expect.any(String) }],
        transport: 'stdio',
        connection: { kind: 'approved', currentDigest: connectionDigest },
        grants: [
          {
            tool: 'list_items',
            definitionDigest: h.digests.get('list_items'),
            argumentEquals: { repository: { kind: 'value', value: 'owner/repo-a' } },
          },
        ],
      },
    ]);
    expectPrivate(body);
    expect(h.witness()).toEqual({ spawns: 0, lists: 0, calls: [] });
  });

  test('a denied connection is shown, with the digest to review, and cannot be inspected', async () => {
    const h = await mcpService({ scratch, persistence, approval: 'denied', grants: [], replies: [] });
    const { body } = await h.api('GET', '/capabilities');
    expect(body.servers[0].connection).toEqual({ kind: 'denied', currentDigest: connectionDigest });
    const refused = await h.api('POST', '/capabilities/servers/synthetic/discover', { catalogRevision: REVISION });
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: 'capability_unavailable', subject: 'mcp:synthetic', acceptance: 'not_accepted' } },
    });
    expect(h.witness().spawns).toBe(0);
  });

  test('an unconfigured or unreadable catalog is reported as such', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [],
      replies: [],
      catalog: async () => ({ kind: 'unavailable', reason: 'installation_missing' }),
    });
    expect((await h.api('GET', '/capabilities')).body).toEqual({ kind: 'unavailable', reason: 'installation_missing' });
    expect(
      await h.api('POST', '/capabilities/servers/synthetic/discover', { catalogRevision: REVISION }),
    ).toMatchObject({ status: 503, body: { error: { code: 'capabilities_unavailable' } } });
  });
});

describe('explicit server inspection', () => {
  test('one approved inspection lists tools in one short-lived process and calls nothing', async () => {
    const h = await mcpService({ scratch, persistence, grants: [{ name: 'list_items' }], replies: [] });
    for (const [body, status, code] of [
      [{ catalogRevision: 'f'.repeat(64) }, 409, 'capability_selection_changed'],
      [{ catalogRevision: REVISION, extra: true }, 400, 'invalid_request'],
      [{}, 400, 'invalid_request'],
    ] as const) {
      expect(await h.api('POST', '/capabilities/servers/synthetic/discover', body)).toMatchObject({
        status,
        body: { error: { code } },
      });
    }
    expect((await h.api('POST', '/capabilities/servers/missing/discover', { catalogRevision: REVISION })).status).toBe(
      404,
    );
    expect((await h.api('GET', '/capabilities/servers/synthetic/discover')).status).toBe(405);
    expect(h.witness().spawns).toBe(0);

    // Two concurrent requests for one binding share one inspection.
    const [first, second] = await Promise.all([
      h.api('POST', '/capabilities/servers/synthetic/discover', { catalogRevision: REVISION }),
      h.api('POST', '/capabilities/servers/synthetic/discover', { catalogRevision: REVISION }),
    ]);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(h.witness()).toEqual({ spawns: 1, lists: 1, calls: [] });
    const tools = first.body.server.observation.tools;
    expect(tools.find((tool: { name: string }) => tool.name === 'list_items')).toMatchObject({
      status: 'supported',
      definitionDigest: h.digests.get('list_items'),
      grant: 'granted',
      definition: { name: 'list_items', inputSchema: { type: 'object' } },
    });
    expect(tools.find((tool: { name: string }) => tool.name === 'slow')).toMatchObject({ grant: 'not_granted' });
    expectPrivate(first.body);

    // The observation is remembered for display; reading it starts nothing.
    const catalog = await h.api('GET', '/capabilities');
    expect(catalog.body.servers[0].observation).toEqual(first.body.server.observation);
    expect(h.witness()).toEqual({ spawns: 1, lists: 1, calls: [] });
  });
});

describe('command starts over HTTP', () => {
  const start = (requestId: string, args: string, revision = SYNC, id = 'command:sync') => ({
    requestId,
    provider: 'anthropic',
    command: { id, selectionRevision: revision, arguments: args },
  });

  test('a command start is accepted once; retries and conflicts follow the request identity', async () => {
    const h = await mcpService({ scratch, persistence, grants: [{ name: 'list_items' }], replies: [done] });
    const requestId = crypto.randomUUID();
    const first = await h.api('POST', '/runs', start(requestId, 'owner/repo-a'));
    expect(first.status).toBe(202);
    expect(first.body.run.goal).toBe('Sync owner/repo-a.');
    await h.service.settled();
    const spawned = h.witness().spawns;
    const again = await h.api('POST', '/runs', start(requestId, 'owner/repo-a'));
    expect([again.status, again.body.run.runId]).toEqual([200, first.body.run.runId]);
    // The retry is resolved before anything current: no new preflight process, no model request.
    expect(h.witness().spawns).toBe(spawned);
    expect(h.net.sent).toHaveLength(1);
    expect(await h.api('POST', '/runs', start(requestId, 'owner/repo-b'))).toMatchObject({
      status: 409,
      body: { error: { code: 'request_conflict' } },
    });
    // Both forms at once are invalid; the goal form is unchanged.
    expect(
      (await h.api('POST', '/runs', { ...start(crypto.randomUUID(), 'x'), goal: 'Also this.' })).body.error.code,
    ).toBe('invalid_request');
  });

  test('refused selections start nothing and never become a goal run', async () => {
    const h = await mcpService({ scratch, persistence, grants: [{ name: 'list_items' }], replies: [] });
    const runs = async () => ((await db.admin`select count(*)::int as n from runtime.runs`)[0] as { n: number }).n;
    const before = await runs();
    for (const [body, status, code] of [
      [start(crypto.randomUUID(), 'owner/repo-a', 'e'.repeat(64)), 409, 'capability_selection_changed'],
      [
        start(crypto.randomUUID(), 'x', selectionRevision(REVISION, 'command:missing'), 'command:missing'),
        409,
        'capability_unavailable',
      ],
      [start(crypto.randomUUID(), '   '), 400, 'command_arguments_invalid'],
      [start(crypto.randomUUID(), `use ${SLOT_VALUE}`), 400, 'credential_in_input'],
    ] as const) {
      expect(await h.api('POST', '/runs', body)).toMatchObject({
        status,
        body: { error: { code, acceptance: 'not_accepted' } },
      });
    }
    await h.service.settled();
    expect(h.net.sent).toHaveLength(0);
    expect(h.witness().spawns).toBe(0);
    expect(await runs()).toBe(before);
  });
});

describe("a run's capabilities", () => {
  test('retained definitions, recorded use and captured/current permissions; reading starts nothing', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items', argumentEquals: { repository: 'owner/repo-a' } }],
      replies: [
        (request: SentInference) =>
          sse(toolTurn('msg_1', 'toolu_1', wire(request, 'list_items'), { repository: 'owner/repo-a' })),
        (request: SentInference) =>
          sse(toolTurn('msg_2', 'toolu_2', wire(request, 'list_items'), { repository: 'owner/repo-b' })),
        done,
      ],
    });
    const started = await h.api('POST', '/runs', {
      requestId: crypto.randomUUID(),
      provider: 'anthropic',
      command: { id: 'command:sync', selectionRevision: SYNC, arguments: 'owner/repo-a' },
    });
    const runId = started.body.run.runId as string;
    await h.service.settled();
    const before = h.witness();
    const { status, body } = await h.api('GET', `/runs/${runId}/capabilities`);
    expect(status).toBe(200);
    const snapshot = await h.service.store.snapshot(runId);
    expect(body).toMatchObject({
      kind: 'command',
      throughSeq: snapshot.throughSeq,
      command: {
        id: 'command:sync',
        origins: [{ facet: 'workflows', version: '1.0.0' }],
        selectionRevision: SYNC,
        arguments: 'owner/repo-a',
        renderedGoal: 'Sync owner/repo-a.',
      },
      limits: { maxDelegations: 8, delegationDepth: 1 },
    });
    expect(body.bound.tools).toEqual([
      expect.objectContaining({
        serverId: 'synthetic',
        toolName: 'list_items',
        definitionDigest: h.digests.get('list_items'),
      }),
    ]);
    expect(body.used.operations).toEqual([
      {
        kind: 'mcp',
        subject: 'synthetic/list_items',
        ok: 1,
        refused: 1,
        error: 0,
        uncertain: 0,
        pending: 0,
        codes: ['argument_out_of_scope'],
      },
    ]);
    expect(body.permissions.captured.servers).toEqual([
      expect.objectContaining({
        serverId: 'synthetic',
        serverDigest: connectionDigest,
        grants: [expect.objectContaining({ argumentEquals: { repository: { kind: 'value', value: 'owner/repo-a' } } })],
      }),
    ]);
    expect(body.permissions.current).toMatchObject({
      kind: 'configured',
      servers: [{ serverId: 'synthetic', connection: 'approved_as_retained' }],
    });
    expectPrivate(body);
    expect(h.witness()).toEqual(before);

    // After the installation is gone, the run's view is unchanged: it never reads the installation.
    const gone = await mcpService({
      scratch,
      persistence,
      grants: [],
      replies: [],
      catalog: async () => ({ kind: 'unavailable', reason: 'installation_missing' }),
    });
    const later = await gone.api('GET', `/runs/${runId}/capabilities`);
    expect(later.body.command).toEqual(body.command);
    expect(later.body.used).toEqual(body.used);
    expect(later.body.permissions.current.servers[0].connection).toBe('approved_as_retained');
    expect(gone.witness().spawns).toBe(0);

    expect((await h.api('GET', `/runs/${crypto.randomUUID()}/capabilities`)).status).toBe(404);
    expect((await h.api('GET', '/runs/not-a-run/capabilities')).status).toBe(404);
  });

  test('a goal run is native', async () => {
    const h = await mcpService({ scratch, persistence, grants: [], replies: [done] });
    const started = await h.api('POST', '/runs', {
      requestId: crypto.randomUUID(),
      provider: 'anthropic',
      goal: 'Read the notes.',
    });
    await h.service.settled();
    const { body } = await h.api('GET', `/runs/${started.body.run.runId}/capabilities`);
    expect(body).toEqual({ kind: 'native', throughSeq: expect.any(String) });
  });
});
