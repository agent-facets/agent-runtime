import type { RuntimeConfig } from './config.ts';
import { type ConsoleFiles, loadConsole } from './console.ts';
import { PersistenceError } from './persistence/errors.ts';
import type { OwnershipOptions } from './persistence/ownership.ts';
import { openPersistence, type Persistence } from './persistence/persistence.ts';
import { createProviderAssembly } from './providers/assembly.ts';
import { RunStore } from './records/run-store.ts';
import { formatDiagnostic } from './security/diagnostics.ts';
import { type PersistenceStatus, startServer } from './server.ts';
import { handleApi, type ServiceProvider } from './service/http.ts';
import { RunService } from './service/runs.ts';

export interface RuntimeHandle {
  readonly port: number;
  status(): PersistenceStatus;
  /** Resolves when persistence startup and the provider readiness report have finished, successfully or not. */
  readonly started: Promise<void>;
  /** Resolves with the exit code once the runtime has stopped. */
  readonly stopped: Promise<number>;
  stop(code?: number): Promise<number>;
}

export interface RuntimeOptions {
  config: RuntimeConfig;
  /** Receives safe diagnostic lines (security/diagnostics.ts); never free text. */
  log?: (line: string) => void;
  ownership?: OwnershipOptions;
  /** Loads the console's files; tests substitute a fixed set. */
  loadConsole?: () => Promise<ConsoleFiles>;
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

  // The run service exists once persistence is ready and agent execution is configured; until then the API reports
  // itself unavailable rather than accept anything.
  let runs: RunService | undefined;
  const services: ServiceProvider = () => {
    if (runs !== undefined && status === 'ready') return runs;
    return { unavailable: operator === undefined ? 'unconfigured' : status };
  };
  let consoleFiles: ConsoleFiles | undefined;
  const server = startServer({
    port: options.config.port,
    persistenceStatus: () => status,
    api: (request, server) => handleApi(request, services, server),
    console: () => consoleFiles,
    agentExecution: () =>
      operator === undefined ? 'unconfigured' : 'unavailable' in services() ? 'unavailable' : 'ready',
    ...(options.config.publicOrigin === undefined ? {} : { publicOrigin: options.config.publicOrigin }),
  });
  const consoleLoaded = (options.loadConsole ?? loadConsole)().then(
    (files) => {
      consoleFiles = files;
    },
    () => {
      log(formatDiagnostic({ event: 'console_unavailable', operation: 'startup' }));
    },
  );

  // Provider integrations for configured providers. Readiness only reads stored credentials; nothing logs in,
  // refreshes or sends inference here.
  const operator = options.config.operator;
  const providers =
    operator === undefined
      ? undefined
      : createProviderAssembly({ config: operator, stateDir: options.config.stateDir });
  const providersReported = (async () => {
    if (operator === undefined || providers === undefined) return;
    for (const provider of ['anthropic', 'openai'] as const) {
      if (operator.providers[provider] === undefined) continue;
      const readiness = await providers.registry.readiness(provider);
      log(formatDiagnostic({ event: 'provider_readiness', operation: 'startup', provider, reason: readiness }));
    }
  })();

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
    log(formatDiagnostic({ event: 'persistence_fault', operation: 'persistence', reason: error.code }));
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
            // Former active work is classified before anything can be dispatched: interrupted, or cancelled if
            // its cancellation had been accepted. Nothing is resumed or retried.
            let reconciled: { interrupted: number; cancelled: number };
            try {
              reconciled = await new RunStore(opened.app, opened.ownership).reconcileAfterRestart();
            } catch {
              status = 'unavailable';
              log(formatDiagnostic({ event: 'startup_reconciliation_failed', operation: 'startup' }));
              void stop(1);
              return;
            }
            log(
              formatDiagnostic({
                event: 'startup_reconciled',
                operation: 'startup',
                count: reconciled.interrupted + reconciled.cancelled,
              }),
            );
            const configFile = options.config.configFile;
            if (operator !== undefined && providers !== undefined && configFile !== undefined) {
              runs = new RunService({
                operator,
                locations: { stateDir: options.config.stateDir, configFile },
                persistence: opened,
                assembly: providers,
                failStop: () => {
                  log(formatDiagnostic({ event: 'fail_stop', operation: 'persistence' }));
                  void stop(1);
                },
                log,
              });
            }
            if (opened.ownership.lost === undefined) status = 'ready';
          },
          (error: unknown) => {
            const code = error instanceof PersistenceError ? error.code : 'database_unavailable';
            status = statusForStartupFailure(code);
            log(formatDiagnostic({ event: 'persistence_startup_failed', operation: 'startup', reason: code }));
            // Exiting lets the supervisor retry, e.g. once a predecessor's ownership session has ended. An
            // incompatible schema cannot fix itself, so that process stays up, unready, for the operator.
            if (status !== 'schema_incompatible') void stop(1);
          },
        );

  return {
    port: server.port ?? options.config.port,
    status: () => status,
    started: Promise.all([started, providersReported, consoleLoaded]).then(() => {}),
    stopped,
    stop,
  };
}
