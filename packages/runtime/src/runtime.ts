import { createMcpPreflight } from './capabilities/preflight.ts';
import { configuredCredentialSlots } from './config/capabilities.ts';
import type { RuntimeConfig } from './config.ts';
import { type ConsoleFiles, loadConsole } from './console.ts';
import { loadConfiguredMcpCredentials, McpCredentialStore } from './credentials/mcp-store.ts';
import type { CodeManifest } from './execution/code-manifest.ts';
import { PersistenceError } from './persistence/errors.ts';
import type { OwnershipOptions } from './persistence/ownership.ts';
import { openPersistence, type Persistence } from './persistence/persistence.ts';
import { createProviderAssembly } from './providers/assembly.ts';
import { RunStore } from './records/run-store.ts';
import type { Provider } from './records/schemas.ts';
import { formatDiagnostic } from './security/diagnostics.ts';
import { type DevelopmentConsole, type PersistenceStatus, startServer } from './server.ts';
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
  /** Opens persistence; tests substitute one that fails without waiting out a connection timeout. */
  openPersistence?: typeof openPersistence;
  /** Development only: the live-reloading console, served in place of the bundled one. */
  developmentConsole?: DevelopmentConsole;
  /** The manifest of the running code per provider; by default the shipped manifest, or computed from source. */
  code?: (provider: Provider) => Promise<CodeManifest>;
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
    ...(options.developmentConsole === undefined ? {} : { developmentConsole: options.developmentConsole }),
  });
  const consoleLoaded =
    options.developmentConsole !== undefined
      ? Promise.resolve()
      : (options.loadConsole ?? loadConsole)().then(
          (files) => {
            consoleFiles = files;
          },
          () => {
            log(formatDiagnostic({ event: 'console_unavailable', operation: 'startup' }));
          },
        );
  // Persistence startup, once begun; shutdown waits for it so whatever it opened is closed before stopping ends.
  let startup: Promise<void> = Promise.resolve();

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
      // Startup sees `stopping` at its next stage and goes no further; anything it opened is then closed below.
      await startup.catch(() => {});
      // An unfinished console login is aborted and settles (releasing its credential lock) before shutdown ends.
      await Promise.all([runs?.login.stop(), runs?.openaiLogin.stop()]);
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
  startup =
    url === undefined
      ? Promise.resolve()
      : (options.openPersistence ?? openPersistence)({ url, onFault, ownership: options.ownership }).then(
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
            if (stopping !== undefined) return;
            // Configured MCP credentials are read only now, under runtime ownership, so stopped-runtime
            // provisioning cannot change a slot between this read and the service accepting input.
            if (operator !== undefined && providers !== undefined) {
              const loaded = await loadConfiguredMcpCredentials(
                McpCredentialStore.forStateDir(options.config.stateDir),
                configuredCredentialSlots(operator),
              );
              providers.admitMcpCredentials(loaded);
              if (loaded.unusable.length > 0) {
                log(
                  formatDiagnostic({
                    event: 'mcp_credentials_unusable',
                    operation: 'startup',
                    count: loaded.unusable.length,
                  }),
                );
              }
            }
            const configFile = options.config.configFile;
            if (stopping !== undefined) return;
            if (operator !== undefined && providers !== undefined && configFile !== undefined) {
              runs = new RunService({
                ...(options.code === undefined ? {} : { code: options.code }),
                operator,
                locations: { stateDir: options.config.stateDir, configFile },
                persistence: opened,
                assembly: providers,
                failStop: () => {
                  log(formatDiagnostic({ event: 'fail_stop', operation: 'persistence' }));
                  void stop(1);
                },
                log,
                // Slots cannot change while this process owns the database (`auth mcp set` needs it stopped), so
                // a slot read here holds the value screened at startup.
                preflight: createMcpPreflight({
                  stateDir: options.config.stateDir,
                  bunPath: process.execPath,
                  readCredential: (slot) => McpCredentialStore.forStateDir(options.config.stateDir).read(slot),
                }),
              });
            }
            if (opened.ownership.lost === undefined && stopping === undefined) status = 'ready';
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
    started: Promise.all([startup, providersReported, consoleLoaded]).then(() => {}),
    stopped,
    stop,
  };
}
