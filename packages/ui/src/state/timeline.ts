// One run as the console knows it: a consistent snapshot plus the committed history events, merged by sequence.
// History pages, replayed events and live events overlap freely — each `(runId, seq)` is kept once, in order — and
// the current state is taken from the latest committed status event or snapshot, never inferred from a connection
// closing.
import type { RunEvent, RunSnapshot, RunState, RunView } from '@agent-runtime/contracts';
import { TERMINAL_STATE_KINDS } from '@agent-runtime/contracts';

type Seq = bigint;

export interface TimelineView {
  run: RunView;
  /** Events in sequence order, each once. */
  events: readonly RunEvent[];
  /** The highest sequence known to be included: the replay cursor. */
  cursor: string;
  terminal: boolean;
}

export class RunTimeline {
  readonly runId: string;
  #run: RunView;
  /** The sequence the current run view reflects. */
  #runSeq: Seq;
  readonly #events = new Map<string, RunEvent>();
  #cursor: Seq;
  #ordered: RunEvent[] | undefined;

  constructor(snapshot: RunSnapshot) {
    this.runId = snapshot.run.runId;
    this.#run = snapshot.run;
    this.#runSeq = BigInt(snapshot.throughSeq);
    this.#cursor = 0n;
  }

  /** A newer snapshot replaces the run view; an older one (a slow response) is ignored. */
  applySnapshot(snapshot: RunSnapshot): void {
    if (snapshot.run.runId !== this.runId) return;
    const seq = BigInt(snapshot.throughSeq);
    if (seq < this.#runSeq) return;
    this.#run = snapshot.run;
    this.#runSeq = seq;
  }

  /** Adds committed events; duplicates and other runs' events are ignored. Returns how many were new. */
  applyEvents(events: readonly RunEvent[]): number {
    let added = 0;
    for (const event of events) {
      if (event.runId !== this.runId || this.#events.has(event.seq)) continue;
      this.#events.set(event.seq, event);
      added++;
      this.#ordered = undefined;
      const seq = BigInt(event.seq);
      if (seq > this.#runSeq) this.#advance(event, seq);
    }
    // The cursor is the end of the contiguous prefix: replay resumes after it and fills any gap.
    while (this.#events.has((this.#cursor + 1n).toString())) this.#cursor++;
    return added;
  }

  /** Applies an event newer than the current run view to it. */
  #advance(event: RunEvent, seq: Seq): void {
    const run = { ...this.#run, lastActivityAt: event.recordedAt };
    switch (event.kind) {
      case 'run.status':
        run.state = event.payload.state;
        if (event.payload.state.kind !== 'waiting') delete run.pendingQuestion;
        break;
      case 'model.attempt':
        run.budget = event.payload.budget;
        break;
      case 'question.asked':
        run.pendingQuestion = {
          questionId: event.payload.questionId,
          prompt: event.payload.prompt,
          input: event.payload.input,
        };
        break;
      case 'question.answered':
      case 'question.closed':
        if (run.pendingQuestion?.questionId === event.payload.questionId) delete run.pendingQuestion;
        break;
      default:
        break;
    }
    this.#run = run;
    this.#runSeq = seq;
  }

  get run(): RunView {
    return this.#run;
  }

  get state(): RunState {
    return this.#run.state;
  }

  /** Every event through this sequence has been received. */
  get cursor(): string {
    return this.#cursor.toString();
  }

  get events(): readonly RunEvent[] {
    this.#ordered ??= [...this.#events.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    return this.#ordered;
  }

  /** Finished, and every event up to the snapshot's bound has arrived: nothing more can be recorded. */
  get complete(): boolean {
    return TERMINAL_STATE_KINDS.has(this.#run.state.kind) && this.#cursor >= this.#runSeq;
  }

  view(): TimelineView {
    return {
      run: this.#run,
      events: this.events,
      cursor: this.cursor,
      terminal: TERMINAL_STATE_KINDS.has(this.state.kind),
    };
  }
}
