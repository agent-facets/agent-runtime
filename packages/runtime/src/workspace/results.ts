// Tool outcomes and exact result sizing. The 64-KiB bound applies to the complete serialized result — metadata,
// JSON escaping and all — measured in UTF-8 bytes. Results grow only by whole items through a budget, and are
// checked once more when finished; serialized JSON is never cut.
import { utf8Bytes } from '../domain/text.ts';
import { ToolProblem } from './filesystem.ts';

export type ToolOutcome<T> =
  | { outcome: 'ok'; result: T }
  | { outcome: 'refused' | 'error'; code: string; message: string };

/** Headroom reserved for a result's envelope fields (paths, counters, cursors, flags). */
export const ENVELOPE_RESERVE_BYTES = 8_192;

export class ResultBudget {
  #used = 0;
  constructor(readonly limit: number) {}

  /** Bytes a JSON value adds as an array element (including its separator). */
  static costOf(value: unknown): number {
    return utf8Bytes(JSON.stringify(value)) + 1;
  }

  get remaining(): number {
    return this.limit - this.#used;
  }

  tryAdd(value: unknown): boolean {
    const cost = ResultBudget.costOf(value);
    if (cost > this.remaining) return false;
    this.#used += cost;
    return true;
  }
}

/** Runs a tool body, turning refusals and errors into outcomes. Cancellation and other failures propagate. */
export async function toolOutcome<T>(limit: number, body: () => Promise<T>): Promise<ToolOutcome<T>> {
  try {
    const result = await body();
    if (utf8Bytes(JSON.stringify(result)) > limit) throw new Error('tool result exceeds its size bound');
    return { outcome: 'ok', result };
  } catch (error) {
    if (error instanceof ToolProblem) return { outcome: error.outcome, code: error.code, message: error.message };
    throw error;
  }
}
