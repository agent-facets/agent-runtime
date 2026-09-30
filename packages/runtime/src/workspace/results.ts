// Tool outcomes and exact result sizing. The 64-KiB bound applies to the complete serialized outcome — its
// envelope, metadata, JSON escaping and all — measured in UTF-8 bytes. Results grow only by whole items through a
// budget; the finished outcome is measured again, and an outcome that still exceeds the bound is replaced by a
// small refusal. Serialized JSON is never cut.
import { utf8Bytes } from '../domain/text.ts';
import { ToolProblem } from './filesystem.ts';

export type ToolOutcome<T> =
  | { outcome: 'ok'; result: T }
  | { outcome: 'refused' | 'error'; code: string; message: string };

/** Headroom reserved for a result's envelope fields (paths, counters, cursors, flags). */
export const ENVELOPE_RESERVE_BYTES = 8_192;

export const RESULT_TOO_LARGE: ToolOutcome<never> = Object.freeze({
  outcome: 'refused',
  code: 'result_too_large',
  message: 'The result would exceed the tool result size limit and was withheld.',
});

export const outcomeBytes = (outcome: ToolOutcome<unknown>) => utf8Bytes(JSON.stringify(outcome));

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

/**
 * The longest prefix of `text`, ending on a code-point boundary, that `fits` accepts. `fits` must be monotonic
 * (a shorter prefix never costs more), which holds for serialized size.
 */
export function largestFitting(text: string, fits: (prefix: string) => boolean): string {
  const boundaries = [0];
  for (let index = 0; index < text.length; ) {
    index += (text.codePointAt(index) as number) > 0xffff ? 2 : 1;
    boundaries.push(index);
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, boundaries[middle]))) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, boundaries[low]);
}

/** Runs a tool body, turning refusals and errors into outcomes. Cancellation and other failures propagate. */
export async function toolOutcome<T>(limit: number, body: () => Promise<T>): Promise<ToolOutcome<T>> {
  let outcome: ToolOutcome<T>;
  try {
    outcome = { outcome: 'ok', result: await body() };
  } catch (error) {
    if (!(error instanceof ToolProblem)) throw error;
    outcome = { outcome: error.outcome, code: error.code, message: error.message };
  }
  return boundOutcome(limit, outcome);
}

/** The outcome itself if its serialized form is within `limit` bytes, otherwise the fixed size refusal. */
export function boundOutcome<T>(limit: number, outcome: ToolOutcome<T>): ToolOutcome<T> {
  return outcomeBytes(outcome) <= limit ? outcome : RESULT_TOO_LARGE;
}
