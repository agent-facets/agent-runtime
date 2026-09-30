import type { RuntimeConfig } from './config.ts';
import { PersistenceError } from './persistence/errors.ts';
import type { OwnershipOptions } from './persistence/ownership.ts';
import { openPersistence, type Persistence } from './persistence/persistence.ts';
import { type PersistenceStatus, startServer } from './server.ts';

export interface RuntimeHandle {
  readonly port: number;
  status(): PersistenceStatus;
  /** Resolves when persistence startup has finished, successfully or not. */
  readonly started: Promise<void>;
  /** Resolves with the exit code once the runtime has stopped. */
  readonly stopped: Promise<number>;
  stop(code?: number): Promise<number>;
}

export interface RuntimeOptions {
  config: RuntimeConfig;
  log?: (line: string) => void;
  ownership?: OwnershipOptions;
}

/** The readiness state reported for a failed persistence startup. */
export function statusForStartupFailure(code: PersistenceError['code']): PersistenceStatus {
  if (code === 'owned_elsewhere') return 'owned_elsewhere';
  if (code === 'schema_incompatible') return 'schema_incompatible';
  return 'unavailable';
}

const FAIL_STOP_FAULTS = new Set<PersistenceError['code']>(['ownership_lost', 'database_connection_closed']);

export function startRuntime(options: RuntimeOptions): RuntimeHandle {
  const log = options.log ?? ((line: string) => console.error(line));
  let status: PersistenceStatus = options.config.databaseUrl === undefined ? 'unconfigured' : 'starting';
  let persistence: Persistence | undefined;
  let stopping: Promise<number> | undefined;
  let resolveStopped: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => {
    resolveStopped = resolve;
  });

  const server = startServer({ port: options.config.port, persistenceStatus: () => status });

  const stop = (code = 0): Promise<number> => {
    stopping ??= (async () => {
      if (status === 'starting' || status === 'ready' || status === 'unconfigured') status = 'stopping';
      // Admission stops first; persistence (and with it ownership) is released last.
      await server.stop(true);
      await persistence?.close();
      resolveStopped(code);
      return code;
    })();
    return stopping;
  };

  const onFault = (error: PersistenceError) => {
    if (error.code === 'shutdown' || stopping !== undefined) return;
    log(`persistence fault: ${error.code}`);
    if (FAIL_STOP_FAULTS.has(error.code)) {
      status = 'ownership_lost';
      void stop(1);
    }
  };

  const url = options.config.databaseUrl;
  const started =
    url === undefined
      ? Promise.resolve()
      : openPersistence({ url, onFault, ownership: options.ownership }).then(
          async (opened) => {
            if (stopping !== undefined) {
              await opened.close();
              return;
            }
            persistence = opened;
            if (opened.ownership.lost === undefined) status = 'ready';
          },
          (error: unknown) => {
            const code = error instanceof PersistenceError ? error.code : 'database_unavailable';
            status = statusForStartupFailure(code);
            log(`persistence startup failed: ${code}`);
            // Exiting lets the supervisor retry, e.g. once a predecessor's ownership session has ended. An
            // incompatible schema cannot fix itself, so that process stays up, unready, for the operator.
            if (status !== 'schema_incompatible') void stop(1);
          },
        );

  return { port: server.port ?? options.config.port, status: () => status, started, stopped, stop };
}
