// Durable replay over server-sent events (design Decision 13). The stream is a view of committed history: it
// replays every event strictly after the client's cursor — the `after` of its initial snapshot, or the
// `Last-Event-ID` the browser sends when it reconnects — and then tails the run by querying the database again.
// Nothing here depends on an in-memory event bus, so a reconnect, a race between a snapshot and its subscription,
// or a missed wakeup can never skip or duplicate an event: each event is sent with its sequence as its ID, and
// the browser keeps the last one it saw.
//
// The stream only produces when the client reads (pull-based), and reads at most a bounded page, so a slow reader
// holds at most one page in memory. A comment heartbeat every 15 seconds keeps idle connections alive. If storage
// fails mid-stream, an unsequenced availability notice is sent and the stream closes without advancing the
// client's cursor. Closing the stream — or the browser — never touches the run.
import { type StreamAvailability, TERMINAL_STATE_KINDS } from '@agent-runtime/contracts';
import { parseSequence } from '../records/canonical.ts';
import { type RunStore, RunStoreError } from '../records/run-store.ts';
import { eventView } from './projection.ts';
import { type ApiResult, refusal } from './runs.ts';

export const HEARTBEAT_MS = 15_000;
export const POLL_MS = 500;
/** Events read per database query, and the serialized bytes sent per read of the stream. */
export const STREAM_PAGE_EVENTS = 100;
export const STREAM_PAGE_BYTES = 256 * 1024;

export interface StreamTiming {
  now(): number;
  /** Resolves after `ms`, or as soon as the signal aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  heartbeatMs?: number;
  pollMs?: number;
}

export const REAL_TIME: StreamTiming = {
  now: () => Date.now(),
  wait: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

const encoder = new TextEncoder();

function availability(code: StreamAvailability['code']): Uint8Array {
  const notice: StreamAvailability = { available: false, code };
  return encoder.encode(`event: availability\ndata: ${JSON.stringify(notice)}\n\n`);
}

/**
 * Opens the event stream of a run after a cursor. Validation happens before any stream bytes: an unknown run,
 * a malformed cursor and a cursor beyond committed history get ordinary JSON errors.
 */
export async function openEventStream(
  store: Pick<RunStore, 'snapshot' | 'readEvents'>,
  runId: string,
  cursor: string | null,
  options: { timing?: StreamTiming; signal?: AbortSignal } = {},
): Promise<ApiResult | Response> {
  const timing = options.timing ?? REAL_TIME;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
    return refusal('not_found', 'No such run.');
  }
  let after: bigint;
  try {
    after = parseSequence(cursor ?? '0');
  } catch {
    return refusal('invalid_cursor', 'The event cursor is not valid.', { runId });
  }
  let terminal: boolean;
  try {
    const snapshot = await store.snapshot(runId);
    if (after > BigInt(snapshot.throughSeq)) {
      return refusal('cursor_ahead', 'The cursor is beyond this run’s recorded history.', { runId });
    }
    // A finished run gains no events; once caught up, the stream only keeps the connection alive.
    terminal = TERMINAL_STATE_KINDS.has(snapshot.state.kind) && after === BigInt(snapshot.throughSeq);
  } catch (error) {
    if (error instanceof RunStoreError && error.code === 'run_not_found')
      return refusal('not_found', 'No such run.', { runId });
    return refusal('storage_unavailable', 'Run storage is unavailable right now.', { runId });
  }

  const heartbeatMs = timing.heartbeatMs ?? HEARTBEAT_MS;
  const pollMs = timing.pollMs ?? POLL_MS;
  const stop = new AbortController();
  options.signal?.addEventListener('abort', () => stop.abort(), { once: true });
  let lastWrite = timing.now();
  let opened = false;

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!opened) {
          opened = true;
          // Reconnect after three seconds; the browser sends the last ID it received.
          controller.enqueue(encoder.encode('retry: 3000\n\n'));
          lastWrite = timing.now();
          return;
        }
        while (!stop.signal.aborted) {
          if (!terminal) {
            let stored: Awaited<ReturnType<RunStore['readEvents']>>;
            try {
              stored = await store.readEvents(runId, { after: after.toString(), limit: STREAM_PAGE_EVENTS });
            } catch {
              controller.enqueue(availability('storage_unavailable'));
              controller.close();
              stop.abort();
              return;
            }
            if (stored.length > 0) {
              let bytes = 0;
              for (const event of stored) {
                const view = eventView(event);
                const frame = encoder.encode(`id: ${view.seq}\ndata: ${JSON.stringify(view)}\n\n`);
                controller.enqueue(frame);
                bytes += frame.byteLength;
                after = BigInt(view.seq);
                if (view.kind === 'run.status' && TERMINAL_STATE_KINDS.has(view.payload.state.kind)) terminal = true;
                if (bytes >= STREAM_PAGE_BYTES) break;
              }
              lastWrite = timing.now();
              return;
            }
          }
          const sinceWrite = timing.now() - lastWrite;
          if (sinceWrite >= heartbeatMs) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
            lastWrite = timing.now();
            return;
          }
          await timing.wait(
            terminal ? heartbeatMs - sinceWrite : Math.min(pollMs, heartbeatMs - sinceWrite),
            stop.signal,
          );
        }
      },
      cancel() {
        stop.abort();
      },
    },
    // One page is produced per read; nothing more is held for a reader that is not reading.
    { highWaterMark: 0 },
  );

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Ask intermediaries not to buffer the stream.
      'x-accel-buffering': 'no',
    },
  });
}
