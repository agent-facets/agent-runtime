// Development only. Bun's live-reloading console server: it bundles the console from source, rebuilds it as its
// files change and pushes updates to open pages. It listens on a Unix socket in a private directory, never on a
// network port, because Bun's development routes do not pass the runtime's request checks; browsers reach it only
// through the runtime's own listener (console-proxy.ts). It runs in the supervisor, so a console edit never
// restarts the backend.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import consoleEntry from '@agent-runtime/ui';
import type { HTMLBundle } from 'bun';

export interface ConsoleServer {
  readonly socket: string;
  stop(): Promise<void>;
}

export async function startConsoleServer(bundle: HTMLBundle = consoleEntry): Promise<ConsoleServer> {
  // mkdtemp creates the directory private to this user (0700).
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-console-'));
  const socket = join(directory, 'console.sock');
  const server = Bun.serve({
    unix: socket,
    development: {
      hmr: true,
      // Browser console output stays in the browser; nothing here offers the checkout to browser tooling.
      console: false,
      chromeDevToolsAutomaticWorkspaceFolders: false,
    },
    routes: { '/': bundle },
    fetch: () => new Response(null, { status: 404 }),
  });
  return {
    socket,
    async stop() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
