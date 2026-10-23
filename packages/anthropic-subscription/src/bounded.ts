// Derived from @ex-machina/opencode-anthropic-auth src/bounded.ts (revision 156cb66); see PROVENANCE.md.
// Difference: reading also stops when the caller's signal aborts, whether or not the transport ties the body to it.

export class BodyLimitError extends Error {
  override readonly name = 'BodyLimitError';
  constructor(label: string, limit: number) {
    super(`${label} exceeds ${limit} byte limit`);
  }
}

export class InvalidUtf8Error extends Error {
  override readonly name = 'InvalidUtf8Error';
  constructor(label: string) {
    super(`${label} is not valid UTF-8`);
  }
}

/** The declared Content-Length, when it is a plain non-negative safe integer. */
export function contentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Reads a body as strict UTF-8, refusing more than `limit` bytes. Rejects with the signal's reason on abort. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
  signal: AbortSignal,
): Promise<string> {
  if (!body) return '';
  signal.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let total = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new BodyLimitError(label, limit);
      try {
        parts.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new InvalidUtf8Error(label);
      }
    }
    try {
      parts.push(decoder.decode());
    } catch {
      throw new InvalidUtf8Error(label);
    }
    return parts.join('');
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
