// Capability inspection behind the browser API (design Decision 9): the installed catalog, an explicit server
// inspection and what one run retained and used. Reading the catalog or a run never starts anything. Inspection is
// the only action here that starts a process: it is explicit, made against the catalog revision the owner was shown,
// limited to a server whose connection the owner has approved for exactly what is installed, and it initializes,
// lists tools and closes — no tool or model is called and no approval changes. What it finds is remembered in this
// process only, for display: it is never authority, and new runs still check their servers themselves.
import {
  type CatalogView,
  type DiscoveryResult,
  discoverServerSchema,
  type RunCapabilitiesView,
  serverIdSchema,
} from '@agent-runtime/contracts';
import type { CatalogLoad } from '../capabilities/installation.ts';
import { type LaunchDeps, planServerLaunch } from '../capabilities/server-access.ts';
import type { CapabilityConfig } from '../config/capabilities.ts';
import { type DiscoveredTool, inspectServer } from '../mcp/discovery.ts';
import { type RunStore, RunStoreError } from '../records/run-store.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import {
  catalogView,
  connectionOf,
  type Observation,
  observationKey,
  runCapabilitiesView,
  serverView,
} from './capability-views.ts';
import { type ApiResult, refusal } from './results.ts';

/** Remembered inspections: one per installation, server and connection binding, the oldest dropped first. */
const OBSERVATIONS_MAX = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LAUNCH_REFUSALS: Record<string, string> = {
  server_not_approved: 'The owner has not approved a connection to this server.',
  server_denied: 'The owner has denied this server.',
  server_reapproval_required: "This server's declaration or program changed and needs the owner's approval again.",
  transport_unsupported: 'This server uses a transport the runtime does not support.',
  declaration_invalid: "This server's declaration cannot be launched as installed.",
  credential_in_declaration: "This server's declaration contains credential material.",
};

export interface CapabilityServiceOptions {
  config: CapabilityConfig | undefined;
  catalog: () => Promise<CatalogLoad | { kind: 'unconfigured' }>;
  launch: LaunchDeps;
  /** The credential screen for everything shown and every inspection. */
  policy: () => ContentPolicy;
  store: Pick<RunStore, 'readCapabilityRecord'>;
  /** Test seam: the bounded inspection itself. */
  inspect?: typeof inspectServer;
  now?: () => Date;
}

export class CapabilityService {
  readonly #observations = new Map<string, Observation>();
  readonly #inspections = new Map<string, Promise<{ ok: true; tools: DiscoveredTool[] } | { ok: false }>>();
  readonly #inspect: typeof inspectServer;
  readonly #now: () => Date;

  constructor(private readonly options: CapabilityServiceOptions) {
    this.#inspect = options.inspect ?? inspectServer;
    this.#now = options.now ?? (() => new Date());
  }

  async #load(): Promise<CatalogLoad | { kind: 'unconfigured' }> {
    if (this.options.config === undefined) return { kind: 'unconfigured' };
    try {
      return await this.options.catalog();
    } catch {
      return { kind: 'unavailable', reason: 'installation_unreadable' };
    }
  }

  readonly #observed = (key: string) => this.#observations.get(key);

  /** The installed catalog with configured grants and remembered inspections. Starts nothing. */
  async catalog(): Promise<ApiResult<CatalogView>> {
    const load = await this.#load();
    try {
      return { status: 200, body: catalogView(load, this.options.config, this.options.policy(), this.#observed) };
    } catch {
      return refusal('capabilities_unavailable', 'The installed capabilities cannot be shown right now.');
    }
  }

  /** Inspects one approved server: initialize, list tools, close. */
  async discover(serverId: string, body: unknown): Promise<ApiResult<DiscoveryResult>> {
    const request = discoverServerSchema.safeParse(body);
    if (!request.success) return refusal('invalid_request', 'The request body does not have the expected fields.');
    if (!serverIdSchema.safeParse(serverId).success) return refusal('not_found', 'No such server.');
    const config = this.options.config;
    const load = await this.#load();
    if (config === undefined || load.kind === 'unconfigured') {
      return refusal('capability_unavailable', 'Installed capabilities are not configured for this deployment.');
    }
    if (load.kind !== 'ready') {
      return refusal('capabilities_unavailable', 'The installed capabilities cannot be read right now.');
    }
    const { catalog } = load;
    if (request.data.catalogRevision !== catalog.installationSha256) {
      return refusal(
        'capability_selection_changed',
        'The installed capabilities changed since they were shown. Review them again.',
      );
    }
    const server = catalog.installation.servers.find((candidate) => candidate.serverId === serverId);
    if (server === undefined) return refusal('not_found', 'No such server is installed.');
    const subject = { subject: `mcp:${serverId}` };
    const policy = this.options.policy();
    const connection = connectionOf(server, config);
    if (connection.kind === 'program_unavailable') {
      return refusal('mcp_server_unavailable', "This server's program is not available.", subject);
    }
    const plan = await planServerLaunch(server, config, this.options.launch, policy);
    if (!plan.ok) {
      const message = LAUNCH_REFUSALS[plan.reason];
      return message === undefined
        ? refusal('mcp_server_unavailable', 'This server could not be started.', subject)
        : refusal('capability_unavailable', message, subject);
    }

    // Concurrent inspections of one binding share one process.
    const key = observationKey(catalog, serverId, connection);
    let inspection = this.#inspections.get(key);
    if (inspection === undefined) {
      inspection = (async () => {
        try {
          const found = await this.#inspect({ params: plan.params, policy });
          return 'tools' in found ? { ok: true as const, tools: found.tools } : { ok: false as const };
        } catch {
          return { ok: false as const };
        }
      })();
      this.#inspections.set(key, inspection);
      void inspection.then((result) => {
        this.#inspections.delete(key);
        if (!result.ok) return;
        this.#observations.delete(key);
        this.#observations.set(key, { observedAt: this.#now().toISOString(), tools: result.tools });
        while (this.#observations.size > OBSERVATIONS_MAX) {
          const oldest = this.#observations.keys().next().value;
          if (oldest === undefined) break;
          this.#observations.delete(oldest);
        }
      });
    }
    // Remembering the result was attached first, so it has happened by the time this resumes.
    const result = await inspection;
    if (!result.ok) {
      return refusal('mcp_server_unavailable', 'The server could not be inspected. Nothing was called.', subject);
    }
    try {
      return {
        status: 200,
        body: {
          catalogRevision: catalog.installationSha256,
          server: serverView(catalog, server, config, policy, this.#observed),
        },
      };
    } catch {
      return refusal('capabilities_unavailable', 'The inspection result cannot be shown.', subject);
    }
  }

  /** What one run retained and used, from its own records only. Starts nothing and reads no installation. */
  async run(runId: string): Promise<ApiResult<RunCapabilitiesView>> {
    if (!UUID.test(runId)) return refusal('not_found', 'No such run.');
    try {
      const record = await this.options.store.readCapabilityRecord(runId);
      return { status: 200, body: runCapabilitiesView(record, this.options.config, this.options.policy()) };
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'run_not_found') {
        return refusal('not_found', 'No such run.', { runId });
      }
      return refusal('storage_unavailable', 'Run storage is unavailable right now; try again shortly.', { runId });
    }
  }
}
