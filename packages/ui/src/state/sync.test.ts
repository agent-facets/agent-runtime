import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '@agent-runtime/contracts';
import { ApiClient } from '../api/client.ts';
import { json, message, RUN, refusal, snapshot, status, succeeded } from '../test-support/fixtures.ts';
import { type Connection, type EventSourceLike, RunSync } from './sync.ts';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly availability: ((event: { data: string }) => void)[] = [];
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(_type: 'availability', listener: (event: { data: string }) => void) {
    this.availability.push(listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(event: RunEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  /** The browser gave up (a non-200 answer, such as 409 or 503). */
  fail() {
    this.readyState = 2;
    this.onerror?.({});
  }
}

/** An API that answers from a script keyed by path prefix; every request is recorded. */
function api(routes: Record<string, (url: URL) => Response>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string) => {
    requests.push(input);
    const url = new URL(input, 'http://console.test');
    const route = Object.keys(routes)
      .filter((prefix) => url.pathname.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (route === undefined) throw new Error(`unscripted ${input}`);
    return (routes[route] as (url: URL) => Response)(url);
  }) as unknown as typeof fetch;
  return { requests, client: new ApiClient({ fetch: fetchImpl }) };
}

function harness(routes: Record<string, (url: URL) => Response>) {
  const { requests, client } = api(routes);
  const sources: FakeSource[] = [];
  const timers: (() => void)[] = [];
  const connections: Connection[] = [];
  const sync = new RunSync({
    client,
    runId: RUN,
    onChange: (_timeline, connection) => connections.push(connection),
    openEventSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  return { sync, requests, sources, timers, connections };
}

const settle = () => Bun.sleep(1);
const runPath = `/api/v1/runs/${RUN}`;

describe('run synchronization', () => {
  test('snapshot, history through its bound, then the stream after it; events are applied once', async () => {
    const h = harness({
      [runPath]: () => json(snapshot('3')),
      [`${runPath}/events`]: (url) => {
        expect(url.searchParams.get('through')).toBe('3');
        const after = Number(url.searchParams.get('after'));
        const events = [message(1), message(2), message(3)].filter((event) => Number(event.seq) > after).slice(0, 2);
        return json({ events, nextAfter: events.at(-1)?.seq ?? String(after) });
      },
    });
    h.sync.start();
    await settle();
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.url).toBe(`${runPath}/stream?after=3`);
    h.sources[0]?.open();
    h.sources[0]?.send(message(3));
    h.sources[0]?.send(message(4));
    expect(h.sync.timeline?.events.map((event) => event.seq)).toEqual(['1', '2', '3', '4']);
    expect(h.sync.connection).toBe('live');
  });

  test('a refused or failed stream is never taken for an outcome: resync from a fresh snapshot after the last event', async () => {
    let snapshots = 0;
    const h = harness({
      [runPath]: () => json(snapshot(++snapshots === 1 ? '1' : '3')),
      [`${runPath}/events`]: (url) => {
        const after = Number(url.searchParams.get('after'));
        const events = [message(1), message(2), message(3)].filter(
          (event) => Number(event.seq) > after && Number(event.seq) <= Number(url.searchParams.get('through')),
        );
        return json({ events, nextAfter: events.at(-1)?.seq ?? String(after) });
      },
    });
    h.sync.start();
    await settle();
    h.sources[0]?.open();
    h.sources[0]?.send(message(2));
    h.sources[0]?.fail();
    expect(h.sync.connection).toBe('reconnecting');
    expect(h.sync.timeline?.state.kind).toBe('working');
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.();
    await settle();
    // History filled to the new bound from the last event held, then a stream after it.
    expect(h.requests.filter((request) => request.includes('/events')).at(-1)).toContain('after=2');
    expect(h.sources[1]?.url).toBe(`${runPath}/stream?after=3`);
    expect(h.sync.timeline?.events.map((event) => event.seq)).toEqual(['1', '2', '3']);
  });

  test('an availability notice from the stream resynchronizes without changing the run', async () => {
    const h = harness({
      [runPath]: () => json(snapshot('0')),
      [`${runPath}/events`]: () => json({ events: [], nextAfter: '0' }),
    });
    h.sync.start();
    await settle();
    h.sources[0]?.open();
    h.sources[0]?.availability[0]?.({ data: JSON.stringify({ available: false, code: 'storage_unavailable' }) });
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.sync.connection).toBe('reconnecting');
    expect(h.sync.timeline?.state.kind).toBe('working');
    expect(h.timers).toHaveLength(1);
  });

  test('an unavailable snapshot keeps retrying with backoff, and recovers', async () => {
    let calls = 0;
    const h = harness({
      [runPath]: () => (++calls < 3 ? refusal('storage_unavailable', 503) : json(snapshot('0'))),
      [`${runPath}/events`]: () => json({ events: [], nextAfter: '0' }),
    });
    h.sync.start();
    await settle();
    h.timers.shift()?.();
    await settle();
    h.timers.shift()?.();
    await settle();
    expect(calls).toBe(3);
    expect(h.sources).toHaveLength(1);
  });

  test('once the run has finished and all history is here, the stream is closed', async () => {
    const h = harness({
      [runPath]: () => json(snapshot('1')),
      [`${runPath}/events`]: () => json({ events: [message(1)], nextAfter: '1' }),
    });
    h.sync.start();
    await settle();
    h.sources[0]?.open();
    h.sources[0]?.send(message(2));
    h.sources[0]?.send(status(3, succeeded));
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.sync.connection).toBe('complete');

    const finished = harness({
      [runPath]: () => json(snapshot('1', succeeded)),
      [`${runPath}/events`]: () => json({ events: [message(1)], nextAfter: '1' }),
    });
    finished.sync.start();
    await settle();
    expect(finished.sources).toHaveLength(0);
    expect(finished.sync.connection).toBe('complete');
  });

  test('an unknown run is reported as such and not retried', async () => {
    const h = harness({ [runPath]: () => refusal('not_found', 404) });
    h.sync.start();
    await settle();
    expect(h.sync.connection).toBe('not_found');
    expect(h.timers).toHaveLength(0);
  });

  test('an unreadable event is not skipped: the console resynchronizes from the last good one', async () => {
    const h = harness({
      [runPath]: () => json(snapshot('0')),
      [`${runPath}/events`]: () => json({ events: [], nextAfter: '0' }),
    });
    h.sync.start();
    await settle();
    h.sources[0]?.open();
    h.sources[0]?.send(message(1));
    h.sources[0]?.onmessage?.({ data: '{"kind":"made.up"}' });
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.sync.timeline?.cursor).toBe('1');
    expect(h.timers).toHaveLength(1);
  });
});
