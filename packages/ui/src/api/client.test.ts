import { describe, expect, test } from 'bun:test';
import { json, message, RUN, refusal, snapshot } from '../test-support/fixtures.ts';
import { ApiClient } from './client.ts';
import { RequestIdentity, settlementOf } from './requests.ts';

function scripted(replies: (Response | Error)[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const reply = replies.shift();
    if (reply === undefined || reply instanceof Error) throw reply ?? new Error('unscripted');
    return reply;
  }) as unknown as typeof fetch;
  return { sent, client: new ApiClient({ fetch: fetchImpl }) };
}

describe('API client', () => {
  test('validates successful bodies against the contracts and sends JSON commands', async () => {
    const { sent, client } = scripted([json(snapshot('2'), 202)]);
    const outcome = await client.startRun({ requestId: RUN, goal: 'Go.', provider: 'anthropic' });
    expect(outcome).toEqual({ ok: true, status: 202, value: snapshot('2') });
    expect(sent[0]?.url).toBe('/api/v1/runs');
    expect(sent[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(sent[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ requestId: RUN, goal: 'Go.', provider: 'anthropic' });
  });

  test('a false or null answer is sent as itself', async () => {
    for (const answer of [false, null, 0, '']) {
      const { sent, client } = scripted([refusal('not_answerable', 409)]);
      await client.answer(RUN, 'q'.repeat(64), answer);
      expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ answer });
    }
  });

  test('refusals, unreadable bodies and unreachable servers are told apart', async () => {
    const { client } = scripted([
      refusal('answer_conflict', 409),
      json({ unexpected: true }),
      new Response('<html>', { status: 502 }),
      new TypeError('network down'),
      json({ error: { code: 'made_up', message: 'x', retryable: false, acceptance: 'not_accepted' } }, 409),
    ]);
    expect(await client.run(RUN)).toMatchObject({
      ok: false,
      kind: 'refused',
      status: 409,
      error: { code: 'answer_conflict' },
    });
    expect(await client.run(RUN)).toEqual({ ok: false, kind: 'invalid_response', status: 200 });
    expect(await client.run(RUN)).toEqual({ ok: false, kind: 'invalid_response', status: 502 });
    expect(await client.run(RUN)).toEqual({ ok: false, kind: 'unreachable' });
    expect(await client.run(RUN)).toEqual({ ok: false, kind: 'invalid_response', status: 409 });
  });

  test('history pages and stream URLs carry decimal cursors unchanged', async () => {
    const { sent, client } = scripted([json({ events: [message('9007199254740993')], nextAfter: '9007199254740993' })]);
    const page = await client.events(RUN, { after: '9007199254740992', through: '9007199254740993', limit: 50 });
    expect(page.ok && page.value.nextAfter).toBe('9007199254740993');
    expect(sent[0]?.url).toBe(`/api/v1/runs/${RUN}/events?after=9007199254740992&through=9007199254740993&limit=50`);
    expect(client.streamUrl(RUN, '12')).toBe(`/api/v1/runs/${RUN}/stream?after=12`);
  });
});

describe('request identity', () => {
  test('a command keeps its ID until the server gives a definite answer', () => {
    let next = 0;
    const identity = new RequestIdentity<{ goal: string }>(() => `id-${++next}`);
    const first = identity.idFor({ goal: 'a' });
    expect(identity.settle({ ok: false, kind: 'unreachable' })).toBe('unknown');
    expect(identity.idFor({ goal: 'a' })).toBe(first);
    expect(
      identity.settle({
        ok: false,
        kind: 'refused',
        status: 503,
        error: { code: 'acceptance_unknown', message: 'x', retryable: true, acceptance: 'unknown' },
      }),
    ).toBe('unknown');
    expect(identity.idFor({ goal: 'a' })).toBe(first);
    // Different content is a different request.
    expect(identity.idFor({ goal: 'b' })).not.toBe(first);
    const second = identity.idFor({ goal: 'b' });
    expect(identity.settle({ ok: true, status: 202, value: {} })).toBe('definite');
    expect(identity.pending).toBe(false);
    expect(identity.idFor({ goal: 'b' })).not.toBe(second);
  });

  test('definite refusals settle the request; only unknown acceptance keeps it', () => {
    const refusedWith = (acceptance: 'not_accepted' | 'unknown' | 'already_accepted') =>
      settlementOf({
        ok: false,
        kind: 'refused',
        status: 409,
        error: { code: 'request_conflict', message: 'x', retryable: false, acceptance },
      });
    expect([refusedWith('not_accepted'), refusedWith('already_accepted'), refusedWith('unknown')]).toEqual([
      'definite',
      'definite',
      'unknown',
    ]);
    expect(settlementOf({ ok: false, kind: 'invalid_response', status: 200 })).toBe('unknown');
  });
});
