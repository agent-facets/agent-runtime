// G1: Bun persistence and ownership with the official saver and a root createAgent. Children are real Bun
// processes; the parent's append-only log of their stdout lines is the independent witness.
import { afterEach, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { LOCK_NAMESPACE, OWNERSHIP_LOCK } from '../../packages/runtime/src/persistence/ownership.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

const CHILD = join(import.meta.dir, '..', '..', 'packages', 'runtime', 'test-support', 'g1', 'child.ts');

interface WitnessEvent {
  g1: string;
  pid: number;
  [key: string]: unknown;
}

interface Binding {
  tuple: boolean;
  checkpointNs: string | null;
  checkpointId: string | null;
  next: string[];
  tasks: {
    id: string;
    name: string;
    error: string | null;
    interrupts: { id: string; value: { questionId?: string } }[];
  }[];
  messageIds: (string | null)[];
}

class Child {
  readonly events: WitnessEvent[] = [];
  readonly proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  #stderr = '';

  constructor(phase: string, db: ScratchDatabase, threadId: string) {
    this.proc = Bun.spawn([process.execPath, '--no-env-file', CHILD], {
      env: {
        PATH: dirname(process.execPath),
        G1_PHASE: phase,
        G1_DATABASE_URL: db.url,
        G1_THREAD_ID: threadId,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void this.#collect();
    void new Response(this.proc.stderr).text().then((text) => {
      this.#stderr = text;
    });
  }

  async #collect() {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of this.proc.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) this.events.push(JSON.parse(line) as WitnessEvent);
        newline = buffer.indexOf('\n');
      }
    }
  }

  count(event: string): number {
    return this.events.filter((entry) => entry.g1 === event).length;
  }

  find(event: string): WitnessEvent {
    const found = this.events.find((entry) => entry.g1 === event);
    if (found === undefined) throw new Error(`missing ${event}; saw ${this.events.map((e) => e.g1).join(', ')}`);
    return found;
  }

  async waitFor(event: string, timeoutMs = 20_000): Promise<WitnessEvent> {
    await eventually(
      () => this.count(event) > 0 || this.count('child-error') > 0,
      timeoutMs,
      `${event} (stderr: ${this.#stderr.slice(0, 400)})`,
    );
    if (this.count('child-error') > 0 && this.count(event) === 0) {
      throw new Error(`child failed: ${JSON.stringify(this.find('child-error'))}`);
    }
    return this.find(event);
  }

  send(line: string) {
    this.proc.stdin.write(`${line}\n`);
    this.proc.stdin.flush();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(): Promise<ScratchDatabase> {
  const db = await createScratchDatabase();
  cleanups.push(() => db.drop());
  return db;
}

function spawn(phase: string, db: ScratchDatabase, threadId: string): Child {
  const child = new Child(phase, db, threadId);
  cleanups.push(async () => {
    child.proc.kill('SIGKILL');
    await child.proc.exited;
  });
  return child;
}

async function ownershipHolders(db: ScratchDatabase): Promise<number[]> {
  const rows = await db.admin`
    select pid from pg_locks where locktype = 'advisory' and granted
      and classid = ${LOCK_NAMESPACE}::oid and objid = ${OWNERSHIP_LOCK}::oid`;
  return rows.map((row: { pid: number }) => row.pid);
}

describe('G1: Bun persistence, ownership and fresh-process continuation', () => {
  test('a settled question survives SIGKILL and a fresh process delivers a negative answer exactly once', async () => {
    const db = await scratch();
    const threadId = crypto.randomUUID();

    // Child A: run until the question is persisted, settled and verified; then it is killed while still owning.
    const first = spawn('pause', db, threadId);
    const settled = await first.waitFor('pause-settled');
    const owned = first.find('owned');
    expect(owned.epoch).toBe('1');
    expect(first.find('invocation-config')).toMatchObject({ configurableKeys: ['thread_id'], durability: 'sync' });
    expect(first.find('stream-drained').candidateInterrupts).toBeGreaterThan(0);

    const pauseBinding = settled.binding as Binding;
    expect(pauseBinding.tuple).toBe(true);
    expect(pauseBinding.checkpointNs).toBe('');
    expect(pauseBinding.checkpointId).toEqual(expect.any(String));
    expect(pauseBinding.tasks).toHaveLength(1);
    expect(pauseBinding.tasks[0]?.error).toBeNull();
    expect(pauseBinding.tasks[0]?.interrupts).toHaveLength(1);
    expect(pauseBinding.tasks[0]?.interrupts[0]?.value.questionId).toBe(settled.expectedQuestionId as string);
    expect(pauseBinding.messageIds).toContain('g1-model-question');
    // Child A's real work before the kill: one model dispatch that asked, one tool entry, no delivered answer.
    expect([first.count('model.dispatch'), first.count('model.ask'), first.count('tool.enter')]).toEqual([1, 1, 1]);
    expect(first.count('tool.answer-delivered')).toBe(0);
    expect(await ownershipHolders(db)).toEqual([owned.ownerPid as number]);

    first.proc.kill('SIGKILL');
    expect(await first.proc.exited).not.toBe(0);
    expect(first.proc.signalCode).toBe('SIGKILL');
    expect(first.count('closed')).toBe(0);
    await eventually(async () => (await ownershipHolders(db)).length === 0, 10_000, 'ownership session end');

    // Child B: a fresh process, a new owner epoch, the same saved binding before anything is invoked.
    const second = spawn('resume', db, threadId);
    expect(await second.proc.exited).toBe(0);
    expect(second.find('owned').epoch).toBe('2');
    expect(second.find('pre-resume-binding').binding).toEqual(pauseBinding);

    // Post-interrupt work in child B happened exactly once, with the boolean false.
    const delivered = second.events.filter((entry) => entry.g1 === 'tool.answer-delivered');
    expect(delivered.map((entry) => entry.answer)).toEqual([false]);
    expect(second.count('model.validated-false')).toBe(1);
    expect(second.count('model.dispatch')).toBe(1);
    expect(second.count('model.ask')).toBe(0);
    // Replay re-enters the tool and calls interrupt again; that is not a second delivery.
    expect(second.count('tool.enter')).toBe(1);

    const final = second.find('final').binding as Binding;
    expect(final.tasks).toEqual([]);
    expect(final.next).toEqual([]);
    expect(final.messageIds.slice(-2)).toEqual([expect.any(String), 'g1-model-final']);
    expect(final.checkpointId).not.toBe(pauseBinding.checkpointId);

    // Across both processes: one question asked, one negative answer delivered, one completion.
    const all = [...first.events, ...second.events];
    expect(all.filter((entry) => entry.g1 === 'model.ask')).toHaveLength(1);
    expect(all.filter((entry) => entry.g1 === 'tool.answer-delivered')).toHaveLength(1);
    expect(all.filter((entry) => entry.g1 === 'model.validated-false')).toHaveLength(1);

    // Both drivers coexisted in each process against one database.
    const [counts] = await db.admin`
      select (select count(*) from checkpoints.checkpoints where thread_id = ${threadId})::int as checkpoints,
             (select epoch::text from runtime.runtime_owner) as epoch`;
    expect(counts.checkpoints).toBeGreaterThan(1);
    expect(counts.epoch).toBe('2');
  }, 60_000);

  for (const variant of ['before the loss is observed', 'after the loss is observed'] as const) {
    test(`lost ownership prevents model dispatch (${variant})`, async () => {
      const db = await scratch();
      const child = spawn('lost-ownership', db, crypto.randomUUID());
      await child.waitFor('ready');
      const ownerPid = child.find('owned').ownerPid as number;

      expect(await db.terminate({ pid: ownerPid })).toBe(1);
      if (variant === 'after the loss is observed') await child.waitFor('ownership-lost');
      child.send('go');

      const refused = await child.waitFor('refused');
      expect(refused.code).toBe('ownership_lost');
      expect(child.count('model.dispatch')).toBe(0);
      expect(child.count('tool.enter')).toBe(0);
      expect(child.count('dispatched')).toBe(0);
      expect(await child.proc.exited).toBe(0);
    }, 60_000);
  }
});
