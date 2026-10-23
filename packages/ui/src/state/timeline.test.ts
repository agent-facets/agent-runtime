import { describe, expect, test } from 'bun:test';
import { answered, asked, attempt, message, QUESTION, snapshot, status, succeeded } from '../test-support/fixtures.ts';
import { RunTimeline } from './timeline.ts';

describe('run timeline', () => {
  test('history, replay and live events overlap; each sequence is kept once, in order', () => {
    const timeline = new RunTimeline(snapshot('3'));
    expect(timeline.applyEvents([message(2), message(1)])).toBe(2);
    expect(timeline.cursor).toBe('2');
    // A replayed event and a live one arriving out of order.
    expect(timeline.applyEvents([message(4), message(3), message(2)])).toBe(2);
    expect(timeline.events.map((event) => event.seq)).toEqual(['1', '2', '3', '4']);
    expect(timeline.cursor).toBe('4');
    // Another run's event is not this run's history.
    expect(timeline.applyEvents([{ ...message(5), runId: '00000000-0000-4000-8000-000000000002' }])).toBe(0);
  });

  test('the cursor stops at a gap, so a resubscription fills it', () => {
    const timeline = new RunTimeline(snapshot('0'));
    timeline.applyEvents([message(1), message(3)]);
    expect(timeline.cursor).toBe('1');
    timeline.applyEvents([message(2)]);
    expect(timeline.cursor).toBe('3');
  });

  test('state, question and budget follow events newer than the snapshot, never older ones', () => {
    const timeline = new RunTimeline(snapshot('2'));
    // Older than the snapshot: history only.
    timeline.applyEvents([status(1, { kind: 'working' }), attempt(2, 1)]);
    expect(timeline.run.budget.consumed).toBe(0);
    timeline.applyEvents([attempt(3, 1), status(4, { kind: 'waiting', questionId: QUESTION }), asked(5)]);
    expect(timeline.state).toEqual({ kind: 'waiting', questionId: QUESTION });
    expect(timeline.run.pendingQuestion?.questionId).toBe(QUESTION);
    expect(timeline.run.budget.consumed).toBe(1);
    timeline.applyEvents([answered(6, false), status(7, { kind: 'working' })]);
    expect(timeline.run.pendingQuestion).toBeUndefined();
    expect(timeline.state.kind).toBe('working');
    // A stale snapshot does not roll the view back.
    timeline.applySnapshot(snapshot('3', { kind: 'waiting', questionId: QUESTION }));
    expect(timeline.state.kind).toBe('working');
  });

  test('a run is complete only when finished and every event up to its bound has arrived', () => {
    const timeline = new RunTimeline(snapshot('3', succeeded));
    expect(timeline.complete).toBe(false);
    timeline.applyEvents([message(1), message(3)]);
    expect(timeline.complete).toBe(false);
    timeline.applyEvents([message(2)]);
    expect(timeline.complete).toBe(true);
  });
});
