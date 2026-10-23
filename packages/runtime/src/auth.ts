// Operator authorization entry point (see operator/auth-command.ts). Like the server, it refuses an environment
// that could redirect or trace provider traffic before loading anything that talks to a provider.
import { environmentProblems } from './config/environment.ts';

const problems = environmentProblems(process.env);
if (problems.length > 0) {
  for (const problem of problems) console.error(`refusing to run: ${problem.variable} (${problem.reason})`);
  process.exit(1);
}

const { runAuthCommand } = await import('./operator/auth-command.ts');

async function readLine(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const lines = console[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const next = await Promise.race([lines.next(), aborted]);
  return next.done ? '' : next.value;
}

/** All of standard input, bounded: reading stops as soon as more than `maxBytes` (plus a line break) arrive. */
async function readSecret(maxBytes: number, signal: AbortSignal): Promise<string | undefined> {
  const limit = maxBytes + 2;
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
      if (length > limit) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return text.replace(/\r?\n$/, '');
}

const interrupted = new AbortController();
process.on('SIGINT', () => interrupted.abort(new Error('interrupted')));

process.exit(
  await runAuthCommand(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readLine,
    readSecret,
    signal: interrupted.signal,
  }),
);
