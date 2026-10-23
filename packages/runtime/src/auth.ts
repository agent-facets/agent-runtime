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

const interrupted = new AbortController();
process.on('SIGINT', () => interrupted.abort(new Error('interrupted')));

process.exit(
  await runAuthCommand(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readLine,
    signal: interrupted.signal,
  }),
);
