// Screening of whole workspace documents before any line is paginated, clipped or excerpted. The screen reports
// protected spans over the complete decoded text; each line is then rendered with those spans replaced, so a
// credential split across an excerpt boundary, or spanning lines, is never partly revealed. Line numbers are
// unchanged because rendering keeps every line break.
import { lineSpans } from './text.ts';

export type Span = readonly [start: number, end: number];

/** Locates protected material; the security content policy implements it. Spans are sorted and merged. */
export interface ContentScreen {
  spans(text: string): readonly Span[];
  /** The marker that replaces protected material. */
  readonly marker: string;
}

export interface ProjectedLine {
  number: number;
  /** The original line, for matching; never returned to a caller when it intersects a protected span. */
  original: string;
  /** The line with protected segments replaced by the marker. */
  text: string;
  /** Protected ranges within `original`, in line-relative offsets. */
  protectedRanges: Span[];
}

/** Yields every line of `text` with its projection. Spans must be sorted and merged. */
export function* projectLines(text: string, spans: readonly Span[], marker: string): Generator<ProjectedLine> {
  let spanIndex = 0;
  let number = 0;
  for (const [start, end] of lineSpans(text)) {
    number++;
    while (spanIndex < spans.length && (spans[spanIndex] as Span)[1] <= start) spanIndex++;
    const protectedRanges: Span[] = [];
    for (let index = spanIndex; index < spans.length; index++) {
      const [spanStart, spanEnd] = spans[index] as Span;
      if (spanStart >= end) break;
      const from = Math.max(spanStart, start) - start;
      const to = Math.min(spanEnd, end) - start;
      if (to > from) protectedRanges.push([from, to]);
    }
    const original = text.slice(start, end);
    yield { number, original, text: renderLine(original, protectedRanges, marker), protectedRanges };
  }
}

function renderLine(line: string, ranges: readonly Span[], marker: string): string {
  if (ranges.length === 0) return line;
  let result = '';
  let cursor = 0;
  for (const [from, to] of ranges) {
    result += line.slice(cursor, from) + marker;
    cursor = to;
  }
  return result + line.slice(cursor);
}

/** Where an original, unprotected offset lands in the rendered line. */
export function renderedOffset(offset: number, ranges: readonly Span[], marker: string): number {
  let shift = 0;
  for (const [from, to] of ranges) {
    if (to > offset) break;
    shift += marker.length - (to - from);
  }
  return offset + shift;
}

export const intersects = (from: number, to: number, ranges: readonly Span[]) =>
  ranges.some(([start, end]) => start < to && from < end);

/** The screen for contexts with nothing to protect (tests of the tools themselves). */
export const NO_SCREEN: ContentScreen = Object.freeze({ spans: () => [], marker: '' });
