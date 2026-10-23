import { describe, expect, test } from 'bun:test';
import { NotSentError } from '../src/contracts.ts';
import { SyntheticTransport } from './synthetic-transport.ts';

const post = (signal = new AbortController().signal) =>
  new Request('https://issuer.invalid/token', { method: 'POST', body: '{"a":1}', signal });

describe('synthetic transport', () => {
  test('records each request before replying', async () => {
    const synthetic = new SyntheticTransport([{ kind: 'json', status: 201, body: { ok: true } }, { kind: 'lost' }]);
    const response = await synthetic.transport(post());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    await expect(synthetic.transport(post())).rejects.toBeInstanceOf(TypeError);
    expect(synthetic.count).toBe(2);
    expect(synthetic.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://issuer.invalid/token',
      body: '{"a":1}',
    });
  });

  test('distinguishes a request that never left from a lost one', async () => {
    const synthetic = new SyntheticTransport([{ kind: 'not_sent' }]);
    await expect(synthetic.transport(post())).rejects.toBeInstanceOf(NotSentError);
  });

  test('a hanging reply and a stalled body end when the request signal aborts', async () => {
    const synthetic = new SyntheticTransport([{ kind: 'hang' }, { kind: 'chunks', chunks: ['{"par'], stall: true }]);
    const first = new AbortController();
    const pending = synthetic.transport(post(first.signal));
    first.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');

    const second = new AbortController();
    const response = await synthetic.transport(post(second.signal));
    const body = response.text();
    second.abort(new Error('deadline'));
    await expect(body).rejects.toThrow('deadline');
  });

  test('refuses unscripted requests rather than inventing replies', async () => {
    await expect(new SyntheticTransport().transport(post())).rejects.toThrow('unscripted');
  });
});
