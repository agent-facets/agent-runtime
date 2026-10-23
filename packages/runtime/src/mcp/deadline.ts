// One absolute deadline shared by every step of an MCP operation, combined with the caller's cancellation. Each SDK
// request gets only the time that remains, as both its timeout and its total timeout, so progress notifications can
// never extend it.

export interface Deadline {
  signal: AbortSignal;
  /** Milliseconds left, at least 1 while time remains. */
  remaining(): number;
  expired(): boolean;
  /** Request options for one SDK call within this deadline. */
  requestOptions(): { signal: AbortSignal; timeout: number; maxTotalTimeout: number; resetTimeoutOnProgress: false };
  dispose(): void;
}

export function deadline(ms: number, outer?: AbortSignal, now: () => number = Date.now): Deadline {
  const end = now() + ms;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('deadline')), ms);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener('abort', onOuter, { once: true });
  const remaining = () => Math.max(0, end - now());
  return {
    signal: controller.signal,
    remaining: () => Math.max(1, remaining()),
    expired: () => remaining() <= 0 || controller.signal.aborted,
    requestOptions() {
      const left = Math.max(1, remaining());
      return { signal: controller.signal, timeout: left, maxTotalTimeout: left, resetTimeoutOnProgress: false };
    },
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}
