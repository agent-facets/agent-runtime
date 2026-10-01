// Keeps one run's timeline current: snapshot, then bounded history through the snapshot's cursor, then the
// replaying event stream after it. Whatever happens to the connection, the remedy is the same — read a fresh
// snapshot and resubscribe after the last event received — so nothing is lost, nothing is applied twice, and a
// closed socket never stands in for an outcome. Connection availability is reported separately from run state.
import { type RunEvent, runEventSchema, streamAvailabilitySchema } from '@agent-runtime/contracts';
import type { ApiClient } from '../api/client.ts';
import { RunTimeline } from './timeline.ts';

/** How the console is connected to a run's history, independent of what the run is doing. */
export type Connection =
  /** Loading the snapshot and history. */
  | 'loading'
  /** Receiving live events. */
  | 'live'
  /** Temporarily disconnected; reconnecting after the last event received. */
  | 'reconnecting'
  /** The run finished and all of its history is here; no connection is needed. */
  | 'complete'
  /** The run does not exist. */
  | 'not_found';

/** The parts of EventSource the console uses, so tests can supply their own. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: 'availability', listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface RunSyncOptions {
  client: ApiClient;
  runId: string;
  onChange: (timeline: RunTimeline | undefined, connection: Connection) => void;
  openEventSource?: (url: string) => EventSourceLike;
  /** Delay before a reconnect attempt; grows with consecutive failures. */
  retryDelayMs?: (attempt: number) => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  historyPage?: number;
}

const CLOSED = 2;

export class RunSync {
  #timeline: RunTimeline | undefined;
  #connection: Connection = 'loading';
  #source: EventSourceLike | undefined;
  #timer: unknown;
  #failures = 0;
  #stopped = false;
  #generation = 0;
  readonly #options: Required<Omit<RunSyncOptions, 'client' | 'runId' | 'onChange'>> & RunSyncOptions;

  constructor(options: RunSyncOptions) {
    this.#options = {
      openEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
      retryDelayMs: (attempt) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)),
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      historyPage: 500,
      ...options,
    };
  }

  get timeline(): RunTimeline | undefined {
    return this.#timeline;
  }

  get connection(): Connection {
    return this.#connection;
  }

  start(): void {
    void this.#sync();
  }

  stop(): void {
    this.#stopped = true;
    this.#generation++;
    this.#source?.close();
    this.#source = undefined;
    if (this.#timer !== undefined) this.#options.clearTimeout(this.#timer);
  }

  /** Re-reads the snapshot now (for example, after this console answered or cancelled). */
  refresh(): void {
    if (!this.#stopped) void this.#sync();
  }

  #emit(): void {
    this.#options.onChange(this.#timeline, this.#connection);
  }

  #set(connection: Connection): void {
    this.#connection = connection;
    this.#emit();
  }

  /** Snapshot, history through it, then the stream after the last event received. */
  async #sync(): Promise<void> {
    const generation = ++this.#generation;
    this.#source?.close();
    this.#source = undefined;
    const { client, runId } = this.#options;
    const current = () => generation === this.#generation && !this.#stopped;

    const snapshot = await client.run(runId);
    if (!current()) return;
    if (!snapshot.ok) {
      if (snapshot.kind === 'refused' && snapshot.status === 404) {
        this.#connection = 'not_found';
        this.#options.onChange(this.#timeline, 'not_found');
        return;
      }
      return this.#retry(generation);
    }
    if (this.#timeline === undefined) this.#timeline = new RunTimeline(snapshot.value);
    else this.#timeline.applySnapshot(snapshot.value);
    const timeline = this.#timeline;
    const through = snapshot.value.throughSeq;
    this.#emit();

    // History up to the snapshot's bound, from the first event not yet held.
    let after = timeline.cursor;
    while (BigInt(after) < BigInt(through)) {
      const page = await client.events(runId, { after, through, limit: this.#options.historyPage });
      if (!current()) return;
      if (!page.ok) return this.#retry(generation);
      timeline.applyEvents(page.value.events);
      this.#emit();
      if (page.value.events.length === 0) break;
      after = page.value.nextAfter;
    }
    this.#failures = 0;

    if (timeline.complete) return this.#set('complete');
    this.#subscribe(generation, timeline);
  }

  #subscribe(generation: number, timeline: RunTimeline): void {
    const source = this.#options.openEventSource(this.#options.client.streamUrl(timeline.runId, timeline.cursor));
    this.#source = source;
    const current = () => generation === this.#generation && !this.#stopped && this.#source === source;
    source.onopen = () => {
      if (current()) this.#set('live');
    };
    source.onmessage = (message) => {
      if (!current()) return;
      let event: RunEvent;
      try {
        event = runEventSchema.parse(JSON.parse(message.data));
      } catch {
        // An event the console cannot read is not skipped silently: resynchronize from the last good one.
        return this.#retry(generation);
      }
      timeline.applyEvents([event]);
      this.#failures = 0;
      if (timeline.complete) {
        source.close();
        this.#source = undefined;
        return this.#set('complete');
      }
      this.#set('live');
    };
    source.addEventListener('availability', (message) => {
      if (!current()) return;
      // Unsequenced and unstored: storage is unavailable; nothing about the run changed.
      if (streamAvailabilitySchema.safeParse(safeJson(message.data)).success) this.#retry(generation);
    });
    source.onerror = () => {
      if (!current()) return;
      // A refused or failed stream (closed) is resynchronized through a fresh snapshot; a dropped one that the
      // browser is retrying by itself resumes after its last ID.
      if (source.readyState === CLOSED) return this.#retry(generation);
      this.#set('reconnecting');
    };
  }

  #retry(generation: number): void {
    if (generation !== this.#generation || this.#stopped) return;
    this.#source?.close();
    this.#source = undefined;
    if (this.#timeline !== undefined) this.#set('reconnecting');
    const delay = this.#options.retryDelayMs(this.#failures++);
    this.#timer = this.#options.setTimeout(() => {
      this.#timer = undefined;
      if (generation === this.#generation && !this.#stopped) void this.#sync();
    }, delay);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
