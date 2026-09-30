import { describe, expect, test } from 'bun:test';
import { KeyedSerializer } from './keyed-serializer.ts';

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('per-run serialization', () => {
  test('runs work for one key strictly in submission order', async () => {
    const serializer = new KeyedSerializer();
    const order: string[] = [];
    const gate = deferred();
    const first = serializer.run('run-a', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = serializer.run('run-a', async () => {
      order.push('second');
    });
    await Bun.sleep(5);
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  test('different runs proceed independently', async () => {
    const serializer = new KeyedSerializer();
    const gate = deferred();
    const blocked = serializer.run('run-a', () => gate.promise);
    await expect(serializer.run('run-b', async () => 'done')).resolves.toBe('done');
    gate.resolve();
    await blocked;
  });

  test('a failure is returned to its caller without blocking later work', async () => {
    const serializer = new KeyedSerializer();
    const failed = serializer.run('run-a', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(serializer.run('run-a', async () => 42)).resolves.toBe(42);
  });

  test('releases idle keys, so no per-run resource is retained', async () => {
    const serializer = new KeyedSerializer();
    await Promise.all(Array.from({ length: 50 }, (_, index) => serializer.run(`run-${index}`, async () => index)));
    await Bun.sleep(0);
    expect(serializer.activeKeys).toBe(0);
  });

  test('the dispatch gate is independent of the lifetime executor', async () => {
    const executors = new KeyedSerializer();
    const gates = new KeyedSerializer();
    const invocation = deferred();
    const running = executors.run('run-a', () => invocation.promise);
    // A cancellation-style gate operation for the same run completes while the invocation is still running.
    await expect(gates.run('run-a', async () => 'cancel accepted')).resolves.toBe('cancel accepted');
    invocation.resolve();
    await running;
  });
});
