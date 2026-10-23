/**
 * Serializes asynchronous work per key within this process, without holding a database connection. The runtime
 * uses two independent instances per run: a lifetime executor lock and a short dispatch gate, so cancellation
 * never waits for a whole invocation to finish.
 */
export class KeyedSerializer {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(body);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** Number of keys with queued or running work; used to verify that idle keys are released. */
  get activeKeys(): number {
    return this.#tails.size;
  }
}
