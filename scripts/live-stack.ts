// The live deployment's commands (`bun run live:stack <command>`): the base Compose file only, always under the
// `agent-runtime-live` project, with its environment file and management state in ~/.local/state/agent-runtime-live.
// Ordinary commands never build, pull or change the selected image; `build` and `deploy` are separate and explicit.
// Nothing here deletes a volume, an image or a Tailscale identity. Run `bun run live:stack help` for the commands.
import { createInterface } from 'node:readline/promises';
import { parseArgs, UsageError } from './lib/live-stack/args.ts';
import { DockerError, processRunner } from './lib/live-stack/docker.ts';
import { acquireFileLock, LockBusyError } from './lib/live-stack/lock.ts';
import { execute, OperationError } from './lib/live-stack/operations.ts';
import { StateError } from './lib/live-stack/state.ts';

async function prompt(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(`${question} Type yes to continue: `)).trim() === 'yes';
  } finally {
    readline.close();
  }
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2), process.env);
    process.exitCode = await execute(parsed, {
      runner: processRunner(process.env),
      ambient: process.env,
      acquireLock: acquireFileLock,
      out: (line) => console.log(line),
      interactive: process.stdin.isTTY === true,
      prompt,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
    });
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`live:stack: ${error.message}`);
      process.exitCode = 2;
    } else if (
      error instanceof OperationError ||
      error instanceof StateError ||
      error instanceof LockBusyError ||
      error instanceof DockerError
    ) {
      console.error(`live:stack: ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
