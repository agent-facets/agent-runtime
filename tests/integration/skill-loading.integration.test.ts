// On-demand skills through the production controller and official saver (design Decisions 3 and 8; tasks 10.8–10.9):
// a successful load and its actor's membership commit together; a reference is readable only from a response issued
// after the load; and a pause, a fresh owner and its continuation neither repeat a completed load nor lose or invent a
// membership. Provider-free: the model is scripted and its physical requests are counted.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { CapabilityConfig } from '../../packages/runtime/src/config/capabilities.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { commandFixture, createWiring } from '../../packages/runtime/test-support/lifecycle/wiring.ts';
import { AIMessage, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
const workspace = createFixture();
workspace.write('notes/plan.md', 'alpha\n');
beforeAll(async () => {
  db = await createScratchDatabase();
});
afterAll(async () => {
  await db.drop();
  workspace.cleanup();
});
let opened: Persistence | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const origin = { facet: 'fixture-workflows', version: '0.0.1', source: 'local:fixture', integrity: 'sha256-x' };
const guide = new TextEncoder().encode('# Guide\nRead the diff first.\n');
const reviewSkill = {
  id: 'skill:review',
  name: 'review',
  description: 'Reviews changes.',
  origins: [origin],
  exportDigest: 'a'.repeat(64),
  requires: [],
  instructions: 'Review carefully.',
  resources: [
    {
      path: 'references/guide.md',
      byteLength: guide.byteLength,
      sha256: new Bun.CryptoHasher('sha256').update(guide).digest('hex'),
      content: Buffer.from(guide).toString('base64'),
    },
  ],
};
const grants: CapabilityConfig = {
  installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: 'a'.repeat(64) },
  allowSkills: ['skill:review', 'skill:notes'],
  allowAgents: ['agent:helper', 'agent:narrow'],
  maxDelegationsPerRun: 8,
  localPrograms: {},
  servers: [],
};
const notesSkill = { ...reviewSkill, id: 'skill:notes', name: 'notes', instructions: 'Take notes.', resources: [] };
function command() {
  const { snapshot, input } = commandFixture();
  return {
    snapshot: {
      ...snapshot,
      skills: [notesSkill, reviewSkill],
      authority: { ...snapshot.authority, skills: ['skill:notes', 'skill:review'] },
    },
    input,
  };
}

let requests = 0;
async function owner(current: CapabilityConfig | undefined = grants) {
  await opened?.close();
  opened = await openPersistence({ url: db.url, onFault: () => {} });
  return createWiring(opened, {
    root: workspace.root,
    scripts: [],
    transport: (async () => {
      requests++;
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch,
    skills: { current },
  });
}

const turn =
  (...calls: [string, Record<string, unknown>][]): ScriptStep =>
  () =>
    new AIMessage({
      id: `m-${crypto.randomUUID()}`,
      content: '',
      tool_calls: calls.map(([name, args]) => ({
        id: `c-${crypto.randomUUID()}`,
        name,
        args,
        type: 'tool_call' as const,
      })),
    });
const read = ['mcp_ReadSkillReference', { skill: 'skill:review', path: 'references/guide.md' }] as [
  string,
  Record<string, unknown>,
];
const ask = [
  'mcp_AskUser',
  { prompt: 'Continue?', input: { kind: 'choice', multiple: false, options: [{ label: 'No', value: false }] } },
] as [string, Record<string, unknown>];

async function operations(runId: string) {
  return (await db.admin`select tool_name, disposition ->> 'outcome' as outcome,
      disposition #>> '{result,code}' as code from runtime.tool_operations where run_id = ${runId}
      and tool_name in ('mcp_LoadSkill', 'mcp_ReadSkillReference') order by created_at, operation_id`) as {
    tool_name: string;
    outcome: string;
    code: string | null;
  }[];
}
const membership = async (runId: string) =>
  (await db.admin`select actor_key, skill_id, operation_id from runtime.loaded_skills where run_id = ${runId}`) as {
    actor_key: string;
    skill_id: string;
    operation_id: string;
  }[];

describe('skill loading across a pause and a fresh owner', () => {
  test('membership commits with the load, gates later references only, and survives continuation unchanged', async () => {
    let wiring = await owner();
    const run = await wiring.createRun(10, command());
    wiring.script([turn(['mcp_LoadSkill', { skill: 'skill:review' }], read), turn(read), turn(ask)]);
    expect((await wiring.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'waiting',
    );
    expect(await operations(run.runId)).toEqual([
      { tool_name: 'mcp_LoadSkill', outcome: 'ok', code: null },
      { tool_name: 'mcp_ReadSkillReference', outcome: 'refused', code: 'skill_not_loaded' },
      { tool_name: 'mcp_ReadSkillReference', outcome: 'ok', code: null },
    ]);
    const loaded = await membership(run.runId);
    const [loadOperation] = (await db.admin`select operation_id from runtime.tool_operations
      where run_id = ${run.runId} and tool_name = 'mcp_LoadSkill'`) as { operation_id: string }[];
    expect(loaded).toEqual([
      { actor_key: 'root', skill_id: 'skill:review', operation_id: loadOperation?.operation_id as string },
    ]);

    // A fresh owner verifies and answers; the continuation reads the reference again and loads the skill again.
    wiring = await owner();
    const question = (await wiring.store.snapshot(run.runId)).pendingQuestion;
    const answered = await wiring.answer(run.runId, question?.questionId as string, { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    wiring.script([
      turn(read, ['mcp_LoadSkill', { skill: 'skill:review' }]),
      () => new AIMessage({ id: 'm-end', content: 'Done.' }),
    ]);
    const before = requests;
    const state = await wiring.controller.run(run.runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
    expect(requests - before).toBe(2);
    expect((await operations(run.runId)).map((row) => [row.tool_name, row.outcome])).toEqual([
      ['mcp_LoadSkill', 'ok'],
      ['mcp_ReadSkillReference', 'refused'],
      ['mcp_ReadSkillReference', 'ok'],
      ['mcp_ReadSkillReference', 'ok'],
      ['mcp_LoadSkill', 'ok'],
    ]);
    // The second load is a new operation; membership keeps its first successful load.
    expect(await membership(run.runId)).toEqual(loaded);
  });

  test('a refused or unrecorded load leaves no membership', async () => {
    const wiring = await owner();
    const run = await wiring.createRun(10, command());
    wiring.script([
      turn(['mcp_LoadSkill', { skill: 'skill:absent' }]),
      turn(read),
      () => new AIMessage({ id: `m-${crypto.randomUUID()}`, content: 'Done.' }),
    ]);
    expect((await wiring.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    expect((await operations(run.runId)).map((row) => row.code)).toEqual(['skill_unavailable', 'skill_not_loaded']);
    expect(await membership(run.runId)).toEqual([]);
  });
});

describe('continuing command runs from retained definitions', () => {
  async function paused() {
    const wiring = await owner();
    const run = await wiring.createRun(10, command());
    wiring.script([turn(ask)]);
    expect((await wiring.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'waiting',
    );
    const question = (await wiring.store.snapshot(run.runId)).pendingQuestion;
    return { run, questionId: question?.questionId as string };
  }

  test('a skill first used after a pause comes from the retained definitions; bound and used stay distinct', async () => {
    const { run, questionId } = await paused();
    const wiring = await owner();
    const answered = await wiring.answer(run.runId, questionId, { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    wiring.script([
      turn(['mcp_LoadSkill', { skill: 'skill:review' }]),
      turn(read),
      () => new AIMessage({ id: `m-${crypto.randomUUID()}`, content: 'Done.' }),
    ]);
    const state = await wiring.controller.run(run.runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
    const [loadResult] = (await db.admin`select disposition #>> '{result,result,text}' as text
      from runtime.tool_operations where run_id = ${run.runId} and tool_name = 'mcp_LoadSkill'`) as { text: string }[];
    expect(loadResult?.text).toBe('Review carefully.');
    const retained = await wiring.store.readCapabilities(run.runId);
    // Bound: every retained skill. Used: only the one this run actually loaded.
    expect(retained?.snapshot.skills.map((skill) => skill.id)).toEqual(['skill:notes', 'skill:review']);
    expect((await membership(run.runId)).map((row) => row.skill_id)).toEqual(['skill:review']);
    // The retained ceiling records what was allowed at acceptance, never the configuration object itself.
    expect(JSON.stringify(retained?.snapshot)).not.toContain('/etc/agent-runtime');
  });

  test('changed or revoked grants alone keep a waiting run continuable; revocation refuses only new loads', async () => {
    const { run, questionId } = await paused();
    const wiring = await owner({ ...grants, allowSkills: [] });
    const answered = await wiring.answer(run.runId, questionId, { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    wiring.script([
      turn(['mcp_LoadSkill', { skill: 'skill:review' }]),
      () => new AIMessage({ id: 'm-x', content: 'Done.' }),
    ]);
    const state = await wiring.controller.run(run.runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
    expect((await operations(run.runId)).map((row) => row.code)).toEqual(['skill_not_permitted']);
    expect(await membership(run.runId)).toEqual([]);
  });

  test('confirmed loss of the retained definitions refuses continuation without accepting the answer', async () => {
    const { run, questionId } = await paused();
    const digest = (await (await owner()).store.snapshot(run.runId)).command?.snapshotDigest as string;
    await db.admin.unsafe('alter table runtime.capability_snapshots disable trigger capability_snapshots_immutable');
    try {
      await db.admin`update runtime.capability_snapshots
        set payload = jsonb_set(payload, '{skills,0,instructions}', '"Altered."') where digest = ${digest}`;
    } finally {
      await db.admin.unsafe('alter table runtime.capability_snapshots enable trigger capability_snapshots_immutable');
    }
    const wiring = await owner();
    const refused = await wiring.answer(run.runId, questionId, { answer: false });
    expect(refused).toEqual({ kind: 'continuation_unavailable', problem: 'definition_changed' });
    const [question] = await db.admin`select disposition ->> 'kind' as kind from runtime.questions
      where run_id = ${run.runId}`;
    expect(question?.kind).not.toBe('answered');
  });
});
