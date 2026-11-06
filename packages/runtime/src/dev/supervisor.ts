// Development entry point (`bun run dev`). Serves the live-reloading console and supervises the backend:
//
// - console source changes update open pages in place; the backend keeps running;
// - backend source changes restart the backend process cleanly (see supervisor-core.ts);
// - dependency changes need the development image rebuilt (or `bun install` outside a container).
//
// Never used in production, whose image contains only the built server and its static console.
import { type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { startConsoleServer } from './console-server.ts';
import { checkDependencies, dependencyInputs, REPOSITORY_ROOT } from './dependencies.ts';
import { BackendSupervisor } from './supervisor-core.ts';
import { BACKEND_SOURCE_DIRS, isBackendSource } from './watch.ts';

/** Exit status for a development image that no longer matches the checkout's dependencies. */
const EXIT_STALE_DEPENDENCIES = 78;

const root = REPOSITORY_ROOT;
const dependencyRecord = process.env.AGENT_RUNTIME_DEPENDENCY_RECORD;
const log = (line: string) => console.error(line);

const initial = await checkDependencies(root, dependencyRecord);
if (!initial.ok) {
  log(`dev: refusing to start: ${initial.message}`);
  process.exit(EXIT_STALE_DEPENDENCIES);
}

const consoleServer = await startConsoleServer();
const backendEntry = join(import.meta.dir, 'backend.ts');

const supervisor = new BackendSupervisor({
  spawn: () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', backendEntry], {
      cwd: join(root, 'packages', 'runtime'),
      env: { ...process.env, AGENT_RUNTIME_DEV_CONSOLE_SOCKET: consoleServer.socket },
      stdio: ['ignore', 'inherit', 'inherit'],
      // Its own process group, so MCP servers it starts can be stopped with it.
      detached: true,
    });
    return {
      pid: child.pid,
      exited: child.exited.then(() => child.exitCode),
      kill: (signal) => child.kill(signal),
    };
  },
  signalGroup: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group has already gone.
    }
  },
  log,
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  now: Date.now,
});

const watchers: FSWatcher[] = [];
let stopping: Promise<never> | undefined;

const stop = (code: number): Promise<never> => {
  stopping ??= (async () => {
    for (const watcher of watchers) watcher.close();
    await supervisor.shutdown();
    await consoleServer.stop();
    process.exit(code);
  })();
  return stopping;
};

// Watching starts before the first backend does, so an edit made while it starts still restarts it.
for (const dir of BACKEND_SOURCE_DIRS) {
  watchers.push(
    watch(join(root, dir), { recursive: true }, (_event, file) => {
      const path = file === null ? dir : `${dir}/${file}`;
      if (file === null || isBackendSource(path)) supervisor.changed(path);
    }),
  );
}

const dependencyChanged = async (path: string) => {
  if (dependencyRecord === undefined || dependencyRecord === '') {
    // Outside a container `bun install` updates dependencies in place; restart to pick them up.
    supervisor.changed(path);
    return;
  }
  const check = await checkDependencies(root, dependencyRecord);
  if (check.ok) return;
  log(`dev: stopping: ${check.message}`);
  await stop(EXIT_STALE_DEPENDENCIES);
};

// Each input is watched itself: in a container it is a single-file bind mount, whose in-place edits are reported
// on the file, not its directory. A file replaced by renaming (as editors and `bun install` do) is watched afresh.
// A container's mount keeps showing the file it was created with after such a replacement; `bun run dev:stack`
// checks the checkout itself before it starts or recreates the runtime.
const watchInput = (path: string) => {
  const arm = () => {
    if (stopping !== undefined) return;
    try {
      const watcher = watch(join(root, path), (event) => {
        void dependencyChanged(path);
        if (event === 'rename') {
          watcher.close();
          setTimeout(arm, 100);
        }
      });
      watchers.push(watcher);
    } catch {
      // Missing for now (being replaced); try again shortly.
      setTimeout(arm, 500);
    }
  };
  arm();
};
for (const path of dependencyInputs(root)) watchInput(path);

let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1;
    if (signals > 1) {
      // A second request does not wait for the backend: it and its group are killed.
      if (supervisor.pid !== undefined) {
        try {
          process.kill(-supervisor.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      process.exit(130);
    }
    log('dev: stopping');
    void stop(0);
  });
}

// An explicit restart, e.g. after editing the operator configuration (`bun run dev:stack reload`).
process.on('SIGHUP', () => {
  void supervisor.restart('requested');
});

log('dev: console live reload enabled; backend restarts on backend source changes');
supervisor.start();
