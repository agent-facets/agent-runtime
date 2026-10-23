import { describe, expect, test } from 'bun:test';
import { RunStoreError, type StoredEvent } from '../records/run-store.ts';
import type { RunState } from '../records/schemas.ts';
import { handleApi } from './http.ts';
import type { RunService } from './runs.ts';
import {
  HEARTBEAT_MS,
  openEventStream,
  REAL_TIME,
  STREAM_PAGE_BYTES,
  STREAM_PAGE_EVENTS,
  type StreamTiming,
} from './stream.ts';

const RUN = '00000000-0000-4000-8000-000000000001';
const AT = '2026-09-30T12:00:00.000000Z';

function message(seq: number, text = `message ${seq}`): StoredEvent {
  return {
    runId: RUN,
    seq: String(seq),
    recordedAt: AT,
    sourceKey: `message:m${seq}`,
    event: { kind: 'assistant.message', payload: { messageId: `m${seq}`, text } },
  };
}

function status(seq: number, state: RunState): StoredEvent {
  return {
    runId: RUN,
    seq: String(seq),
    recordedAt: AT,
    sourceKey: `status:${seq}`,
    event: { kind: 'run.status', payload: { revision: String(seq), state } },
  };
}

const working: RunState = { kind: 'working', invocationId: RUN, ownerEpoch: '1' };
const succeeded: RunState = { kind: 'succeeded', finishedAt: AT, resultSeq: '2' };

/** Committed history and run state, with a witness of every read. */
function history(events: StoredEvent[], state: RunState = working) {
  const reads: string[] = [];
  let failing = false;
  const store = {
    events,
    state,
    reads,
    fail() {
      failing = true;
    },
    async snapshot(runId: string) {
      if (runId !== RUN) throw new RunStoreError('run_not_found', 'no such run');
      return { throughSeq: events.at(-1)?.seq ?? '0', state: store.state } as never;
    },
    async readEvents(_runId: string, options: { after: string; limit: number }) {
      if (failing) throw new Error('database unreachable');
      reads.push(options.after);
      return events.filter((event) => BigInt(event.seq) > BigInt(options.after)).slice(0, options.limit);
    },
  };
  return store;
}

/** A clock that advances only when the stream waits. */
function fakeTime(): StreamTiming & { waited: number[] } {
  let now = 0;
  const waited: number[] = [];
  return {
    waited,
    now: () => now,
    async wait(ms) {
      waited.push(ms);
      now += ms;
      await Bun.sleep(0);
    },
  };
}

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  retry?: string;
}

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else {
          const [field, ...rest] = line.split(': ');
          frame[field as keyof Frame] = rest.join(': ');
        }
      }
      return frame;
    });
}

async function open(store: ReturnType<typeof history>, cursor: string | null, timing = fakeTime()) {
  const response = await openEventStream(store, RUN, cursor, { timing });
  if (!(response instanceof Response)) throw new Error(`refused: ${JSON.stringify(response.body)}`);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    response,
    reader,
    timing,
    /** Reads until `count` complete frames have arrived (or the stream ends). */
    async frames(count: number): Promise<Frame[]> {
      const out: Frame[] = [];
      while (out.length < count) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          out.push(...parseFrames(buffer.slice(0, end + 2)));
          buffer = buffer.slice(end + 2);
          continue;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return out;
    },
  };
}

describe('event stream', () => {
  test('replays everything after the cursor in order, then tails new events once each', async () => {
    const store = history([message(1), message(2), message(3)]);
    const stream = await open(store, '1');
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const [retry, two, three] = await stream.frames(3);
    expect(retry).toEqual({ retry: '3000' });
    expect([two?.id, three?.id]).toEqual(['2', '3']);
    expect(JSON.parse(two?.data ?? '')).toEqual({
      runId: RUN,
      seq: '2',
      recordedAt: AT,
      kind: 'assistant.message',
      payload: { messageId: 'm2', text: 'message 2' },
    });
    // Recorded after the client's snapshot and after the stream opened: it is still delivered, exactly once.
    store.events.push(message(4));
    const [four] = await stream.frames(1);
    expect(four?.id).toBe('4');
    // Each read continues from the last event delivered, so nothing is sent twice.
    expect(store.reads.slice(0, 2)).toEqual(['1', '3']);
    await stream.reader.cancel();
  });

  test('a quiet stream sends a comment heartbeat every 15 seconds and polls in between', async () => {
    const stream = await open(history([message(1)]), '1');
    await stream.frames(1);
    const [heartbeat] = await stream.frames(1);
    expect(heartbeat).toEqual({ comment: 'heartbeat' });
    expect(stream.timing.waited.reduce((sum, ms) => sum + ms, 0)).toBe(HEARTBEAT_MS);
    expect(Math.max(...stream.timing.waited)).toBeLessThan(HEARTBEAT_MS);
    const [next] = await stream.frames(1);
    expect(next).toEqual({ comment: 'heartbeat' });
    expect(stream.timing.waited.reduce((sum, ms) => sum + ms, 0)).toBe(2 * HEARTBEAT_MS);
    await stream.reader.cancel();
  });

  test('once a finished run is caught up, the database is no longer queried', async () => {
    const store = history([message(1), status(2, succeeded)], succeeded);
    const stream = await open(store, '0');
    const frames = await stream.frames(3);
    expect(frames.map((frame) => frame.id)).toEqual([undefined, '1', '2']);
    const reads = store.reads.length;
    expect(await stream.frames(2)).toEqual([{ comment: 'heartbeat' }, { comment: 'heartbeat' }]);
    expect(store.reads.length).toBe(reads);
    // Waits are whole heartbeat intervals, not polls.
    expect(stream.timing.waited.slice(-2)).toEqual([HEARTBEAT_MS, HEARTBEAT_MS]);
    await stream.reader.cancel();
  });

  test('a storage failure sends an unsequenced availability notice and ends without advancing the cursor', async () => {
    const store = history([message(1)]);
    const stream = await open(store, '0');
    await stream.frames(2);
    store.fail();
    const rest = await stream.frames(5);
    expect(rest).toEqual([
      { event: 'availability', data: JSON.stringify({ available: false, code: 'storage_unavailable' }) },
    ]);
    expect((await stream.reader.read()).done).toBe(true);
  });

  test('a reader that does not read holds at most one page; pages are bounded by bytes', async () => {
    const store = history(Array.from({ length: 1000 }, (_, index) => message(index + 1)));
    const stream = await open(store, '0');
    await stream.frames(1);
    await Bun.sleep(20);
    expect(store.reads).toEqual([]);
    await stream.frames(1);
    await Bun.sleep(20);
    expect(store.reads).toEqual(['0']);
    const big = history(Array.from({ length: 10 }, (_, index) => message(index + 1, 'x'.repeat(100_000))));
    const large = await open(big, '0');
    await large.frames(2);
    expect(big.reads).toEqual(['0']);
    const firstPage = Math.ceil(STREAM_PAGE_BYTES / 100_100);
    const delivered = await large.frames(firstPage - 1);
    expect(delivered.map((frame) => frame.id).at(-1)).toBe(String(firstPage));
    await large.frames(1);
    expect(big.reads).toEqual(['0', String(firstPage)]);
    expect(STREAM_PAGE_EVENTS).toBeGreaterThan(firstPage);
    await stream.reader.cancel();
    await large.reader.cancel();
  });

  test('cancelling the stream stops it, and nothing else', async () => {
    const store = history([message(1)]);
    const stream = await open(store, '1');
    await stream.frames(1);
    const pending = stream.frames(1);
    await Bun.sleep(5);
    await stream.reader.cancel();
    await pending;
    const reads = store.reads.length;
    await Bun.sleep(20);
    expect(store.reads.length).toBe(reads);
  });

  test('over a real server, a stream quieter than the idle timeout stays open and keeps tailing', async () => {
    const store = history([message(1)]);
    const service = { store } as unknown as RunService;
    const timing = { ...REAL_TIME, heartbeatMs: 1_500, pollMs: 100 };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 1,
      routes: { '/api/v1/*': (request, srv) => handleApi(request, () => service, srv, timing) },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/runs/${RUN}/stream?after=0`, {
        headers: { 'last-event-id': '1' },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const started = Date.now();
      while (Date.now() - started < 2_500) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      // Last-Event-ID superseded the URL cursor: event 1 is not replayed; heartbeats kept the stream alive.
      expect(text).not.toContain('id: 1');
      expect(text.split(': heartbeat').length - 1).toBeGreaterThanOrEqual(1);
      store.events.push(message(2));
      let tail = '';
      while (!tail.includes('id: 2')) tail += decoder.decode((await reader.read()).value, { stream: true });
      await reader.cancel();
    } finally {
      server.stop(true);
    }
  });

  test('refuses unknown runs, malformed cursors and cursors beyond committed history before streaming', async () => {
    const store = history([message(1), message(2)]);
    const refused = async (runId: string, cursor: string | null) => {
      const result = await openEventStream(store, runId, cursor, { timing: fakeTime() });
      if (result instanceof Response) throw new Error('expected a refusal');
      return [result.status, (result.body as { error: { code: string } }).error.code];
    };
    expect(await refused(RUN, '3')).toEqual([409, 'cursor_ahead']);
    for (const cursor of ['-1', '01', 'abc', '1.0', '99999999999999999999']) {
      expect(await refused(RUN, cursor)).toEqual([400, 'invalid_cursor']);
    }
    expect(await refused('00000000-0000-4000-8000-000000000002', '0')).toEqual([404, 'not_found']);
    expect(await refused('not-a-run', '0')).toEqual([404, 'not_found']);
    store.fail();
    const unavailable = history([]);
    unavailable.snapshot = async () => {
      throw new Error('database unreachable');
    };
    expect(
      await (async () => {
        const result = await openEventStream(unavailable, RUN, '0', { timing: fakeTime() });
        return result instanceof Response ? 'stream' : result.status;
      })(),
    ).toBe(503);
  });
});
