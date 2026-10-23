// Projections of capability records onto the browser contracts (design Decision 9). Every field is chosen explicitly
// and every installed or advertised text is screened: a name, description, refusal subject or grant value that is not
// plain text, or that carries a credential the runtime recognizes, is left out (or shown as withheld) rather than
// echoed. Launch configuration, environment values, credential slots, program paths, saved-graph bindings and the
// retained snapshot itself never leave the server. Results are validated against the contract schemas.
import {
  type CatalogView,
  type ConnectionView,
  type ContributionView,
  catalogViewSchema,
  mcpToolNameSchema,
  type OriginView,
  type RunCapabilitiesView,
  reasonCodeSchema,
  runCapabilitiesSchema,
  type ServerObservation,
  type ServerView,
  serverViewSchema,
  type ToolGrantView,
  type UsageView,
} from '@agent-runtime/contracts';
import { selectionRevision } from '../capabilities/command.ts';
import type { Catalog, CatalogContribution, InstalledServer } from '../capabilities/installation.ts';
import { commandRunInputSchema, openSnapshot } from '../capabilities/records.ts';
import { serverDigest } from '../capabilities/server-access.ts';
import type { CapabilityConfig, GrantScalar } from '../config/capabilities.ts';
import { isStorableText } from '../domain/text.ts';
import type { DiscoveredTool } from '../mcp/discovery.ts';
import type { CapabilityRecord } from '../records/run-store.ts';
import type { ContentPolicy } from '../security/content-policy.ts';

/** One explicit inspection of a server, as recorded in memory. */
export interface Observation {
  observedAt: string;
  tools: DiscoveredTool[];
}

const SUBJECT = /^(?:command|skill|agent|mcp):[A-Za-z0-9@/._-]{1,255}$/;
const utf8 = new TextEncoder();

/** `text` when it can be shown: plain, storable, within `maxBytes` and free of recognized credentials. */
function shown(policy: ContentPolicy, text: unknown, maxBytes: number): string | undefined {
  if (typeof text !== 'string' || !isStorableText(text) || /\p{Cc}/u.test(text)) return undefined;
  if (utf8.encode(text).byteLength > maxBytes || policy.detect(text) !== undefined) return undefined;
  return text;
}

const reasonOf = (reason: string) => (reasonCodeSchema.safeParse(reason).success ? reason : 'refused');

export function grantView(
  policy: ContentPolicy,
  grant: { name: string; definitionDigest: string; argumentEquals: Record<string, GrantScalar> },
): ToolGrantView {
  return {
    tool: grant.name,
    definitionDigest: grant.definitionDigest,
    argumentEquals: Object.fromEntries(
      Object.entries(grant.argumentEquals).map(([field, value]) => {
        if (typeof value !== 'string') return [field, { kind: 'value', value }];
        const text = shown(policy, value, 1024);
        return [field, text === undefined ? { kind: 'withheld' } : { kind: 'value', value: text }];
      }),
    ),
  };
}

const originView = (origin: { facet: string; version: string; integrity: string }): OriginView => ({
  facet: origin.facet,
  version: origin.version,
  integrity: origin.integrity,
});

function contributionView(
  catalog: Catalog,
  contribution: CatalogContribution,
  config: CapabilityConfig,
  policy: ContentPolicy,
): ContributionView {
  const { availability } = contribution;
  const facet = catalog.installation.facets.find((entry) => entry.facet === contribution.facet);
  const ready = availability.kind === 'ready' ? availability.definition : undefined;
  const description = ready === undefined ? undefined : shown(policy, ready.description, 1024);
  const command = ready as (typeof ready & { arguments?: { required: boolean } }) | undefined;
  const subject = availability.kind === 'refused' ? availability.subject : undefined;
  return {
    id: contribution.id,
    kind: contribution.kind,
    name: contribution.name,
    ...(description === undefined ? {} : { description }),
    origins:
      ready === undefined
        ? [{ facet: contribution.facet, version: contribution.version, integrity: facet?.integrity ?? 'unknown' }]
        : ready.origins.map(originView),
    availability:
      availability.kind === 'ready'
        ? {
            kind: 'ready',
            ...(contribution.kind === 'command'
              ? { selectionRevision: selectionRevision(catalog.installationSha256, contribution.id) }
              : {}),
          }
        : {
            kind: 'refused',
            reason: reasonOf(availability.reason),
            ...(subject !== undefined && SUBJECT.test(subject) && policy.detect(subject) === undefined
              ? { subject }
              : {}),
          },
    ...(contribution.kind === 'command' && command?.arguments !== undefined
      ? { arguments: { required: command.arguments.required } }
      : {}),
    ...(contribution.kind === 'skill' ? { allowed: config.allowSkills.includes(contribution.id) } : {}),
    ...(contribution.kind === 'agent' ? { allowed: config.allowAgents.includes(contribution.id) } : {}),
  };
}

/** The owner's current approval of an installed server's connection, and its current approval digest. */
export function connectionOf(
  server: Pick<InstalledServer, 'serverId' | 'declaration'>,
  config: CapabilityConfig,
): ConnectionView {
  const access = config.servers.find((candidate) => candidate.serverId === server.serverId);
  if (access === undefined) return { kind: 'not_configured' };
  const program = config.localPrograms[access.programId];
  const currentDigest = program === undefined ? undefined : serverDigest(server, access, program);
  const digest = currentDigest === undefined ? {} : { currentDigest };
  if (access.approval.kind === 'denied') return { kind: 'denied', ...digest };
  if (currentDigest === undefined) return { kind: 'program_unavailable' };
  return { kind: access.approval.serverDigest === currentDigest ? 'approved' : 'reapproval_required', ...digest };
}

/** The key one inspection is remembered under: the installation, the server and its exact connection binding. */
export function observationKey(catalog: Catalog, serverId: string, connection: ConnectionView): string {
  return `${catalog.installationSha256}\n${serverId}\n${connection.currentDigest ?? 'unbound'}`;
}

function observationView(
  observation: Observation,
  grants: { name: string; definitionDigest: string }[],
  policy: ContentPolicy,
): ServerObservation {
  return {
    observedAt: observation.observedAt,
    tools: observation.tools.map((tool) => {
      const name = mcpToolNameSchema.safeParse(tool.name).success ? tool.name : undefined;
      if (tool.status === 'refused' || name === undefined) {
        return {
          status: 'refused' as const,
          ...(name === undefined ? {} : { name }),
          reason: reasonOf(tool.status === 'refused' ? tool.reason : 'tool_name_unsupported'),
        };
      }
      const grant = grants.find((candidate) => candidate.name === tool.name);
      const description = shown(policy, tool.raw.description, 32 * 1024);
      return {
        status: 'supported' as const,
        name,
        ...(description === undefined ? {} : { description }),
        definitionDigest: tool.definitionDigest,
        definition: tool.raw as Record<string, never>,
        grant:
          grant === undefined
            ? ('not_granted' as const)
            : grant.definitionDigest === tool.definitionDigest
              ? ('granted' as const)
              : ('reapproval_required' as const),
      };
    }),
  };
}

export function serverView(
  catalog: Catalog,
  server: InstalledServer,
  config: CapabilityConfig,
  policy: ContentPolicy,
  observations: (key: string) => Observation | undefined,
): ServerView {
  const connection = connectionOf(server, config);
  const access = config.servers.find((candidate) => candidate.serverId === server.serverId);
  const grants = access?.approval.kind === 'approved' ? access.approval.tools : [];
  const observation = observations(observationKey(catalog, server.serverId, connection));
  return serverViewSchema.parse({
    serverId: server.serverId,
    origins: server.origins.map(originView),
    transport: server.declaration.type,
    connection,
    grants: grants.map((grant) => grantView(policy, grant)),
    ...(observation === undefined ? {} : { observation: observationView(observation, grants, policy) }),
  });
}

export function catalogView(
  load: { kind: 'unconfigured' } | { kind: 'unavailable'; reason: string } | { kind: 'ready'; catalog: Catalog },
  config: CapabilityConfig | undefined,
  policy: ContentPolicy,
  observations: (key: string) => Observation | undefined,
): CatalogView {
  if (load.kind === 'unconfigured' || config === undefined) return { kind: 'unconfigured' };
  if (load.kind === 'unavailable') return { kind: 'unavailable', reason: reasonOf(load.reason) };
  const { catalog } = load;
  return catalogViewSchema.parse({
    kind: 'ready',
    catalogRevision: catalog.installationSha256,
    contributions: catalog.contributions.map((contribution) => contributionView(catalog, contribution, config, policy)),
    servers: catalog.installation.servers.map((server) => serverView(catalog, server, config, policy, observations)),
  });
}

// --- One run's capabilities ---------------------------------------------------------------------------------------

const MAX_CODES = 8;

/** Aggregates recorded operations by kind and public subject; operations recorded without a binding are left out. */
function usageOf(operations: CapabilityRecord['operations']): UsageView[] {
  const rows = new Map<string, UsageView>();
  for (const operation of operations) {
    const binding = operation.binding;
    if (binding === undefined) continue;
    const subject =
      binding.kind === 'native'
        ? binding.name
        : binding.kind === 'skill_load' || binding.kind === 'skill_reference'
          ? binding.skillId
          : binding.kind === 'delegation'
            ? binding.agentId
            : `${binding.serverId}/${binding.toolName}`;
    const key = `${binding.kind} ${subject}`;
    const row = rows.get(key) ?? {
      kind: binding.kind,
      subject,
      ok: 0,
      refused: 0,
      error: 0,
      uncertain: 0,
      pending: 0,
      codes: [],
    };
    const { disposition } = operation;
    let code: unknown;
    if (disposition.kind === 'completed') {
      row[disposition.outcome] += 1;
      code = disposition.outcome === 'ok' ? undefined : disposition.result.code;
    } else if (disposition.kind === 'abandoned') {
      row.error += 1;
      code = disposition.reason;
    } else {
      row.pending += 1;
    }
    if (typeof code === 'string' && reasonCodeSchema.safeParse(code).success) {
      if (!row.codes.includes(code) && row.codes.length < MAX_CODES) row.codes.push(code);
    }
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function runCapabilitiesView(
  record: CapabilityRecord,
  current: CapabilityConfig | undefined,
  policy: ContentPolicy,
): RunCapabilitiesView {
  const { throughSeq, binding } = record;
  if (binding === undefined) return { kind: 'native', throughSeq };
  let snapshot: ReturnType<typeof openSnapshot>;
  let input: ReturnType<typeof commandRunInputSchema.parse>;
  try {
    snapshot = openSnapshot(binding.snapshotDigest, binding.payload);
    input = commandRunInputSchema.parse(binding.input);
  } catch {
    return { kind: 'unavailable', reason: 'snapshot_unreadable', throughSeq };
  }
  const serverOrigins = new Map(snapshot.servers.map((server) => [server.serverId, server.origins.map(originView)]));
  const ref = (definition: { id: string; name: string; origins: OriginView[] }) => ({
    id: definition.id,
    name: definition.name,
    origins: definition.origins.map(originView),
  });
  return runCapabilitiesSchema.parse({
    kind: 'command',
    throughSeq,
    snapshotDigest: binding.snapshotDigest,
    command: {
      id: snapshot.command.id,
      name: snapshot.command.name,
      origins: snapshot.command.origins.map(originView),
      selectionRevision: input.selectionRevision,
      arguments: input.arguments,
      renderedGoal: snapshot.input.renderedGoal,
    },
    bound: {
      skills: snapshot.skills.map(ref),
      agents: snapshot.agents.map(ref),
      tools: snapshot.tools.map((tool) => ({
        serverId: tool.serverId,
        toolName: tool.toolName,
        definitionDigest: tool.definitionDigest,
        origins: serverOrigins.get(tool.serverId) ?? [],
      })),
    },
    used: {
      operations: usageOf(record.operations),
      loadedSkills: record.loadedSkills.map((loaded) => ({
        skillId: loaded.skillId,
        actor:
          loaded.actorKey === 'root'
            ? { kind: 'root' }
            : { kind: 'delegate', delegationId: loaded.actorKey, agentId: loaded.agentId },
      })),
      delegations: record.delegates.map((delegate) => ({
        delegationId: delegate.delegationId,
        agentId: delegate.agentId,
        state: delegate.state.kind === 'completed' ? delegate.state.outcome.kind : delegate.state.kind,
      })),
    },
    limits: { maxDelegations: binding.maxDelegations, delegationDepth: snapshot.limits.delegationDepth },
    permissions: {
      captured: {
        native: snapshot.authority.native,
        skills: snapshot.authority.skills,
        agents: snapshot.authority.agents,
        servers: snapshot.authority.servers.map((server) => ({
          serverId: server.serverId,
          serverDigest: server.serverDigest,
          grants: server.tools.map((grant) => grantView(policy, grant)),
        })),
      },
      current:
        current === undefined
          ? { kind: 'unconfigured' }
          : {
              kind: 'configured',
              skills: current.allowSkills,
              agents: current.allowAgents,
              servers: snapshot.servers.map((server) => {
                const access = current.servers.find((candidate) => candidate.serverId === server.serverId);
                const approval = access?.approval;
                return {
                  serverId: server.serverId,
                  connection:
                    approval === undefined
                      ? 'not_configured'
                      : approval.kind === 'denied'
                        ? 'denied'
                        : approval.serverDigest === server.serverDigest
                          ? 'approved_as_retained'
                          : 'approved_otherwise',
                  grants: approval?.kind === 'approved' ? approval.tools.map((grant) => grantView(policy, grant)) : [],
                };
              }),
            },
    },
  });
}
