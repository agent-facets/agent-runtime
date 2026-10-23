// Capability snapshot assembly (design Decisions 4, 6 and 10): everything a new command run may use, captured once at
// acceptance. Available skills and agents are the ready ones the owner currently allows, narrowed by the command's
// restriction and, transitively, by their own declared prerequisites. Their full instructions and resources are kept
// even if never loaded, so the run can use them after a pause, an update or removal of the installation. MCP servers
// and tools are those the start's required-tool preflight bound. The original authority ceiling is recorded beside
// them; current grants can later only narrow it. Nothing private (credential values, slots, paths) is ever included,
// and a snapshot containing recognizable credential material is refused rather than redacted.

import type { CapabilityConfig } from '../config/capabilities.ts';
import { type ContentPolicy, stringsIn } from '../security/content-policy.ts';
import type { Catalog } from './installation.ts';
import {
  CAPABILITY_LIMITS,
  CapabilityRecordError,
  type CapabilitySnapshot,
  type CommandRunInput,
  sealSnapshot,
} from './records.ts';

type Definitions = CapabilitySnapshot;
type CommandDefinition = Definitions['command'];
type SkillDefinition = Definitions['skills'][number];
type AgentDefinition = Definitions['agents'][number];
type Requirement = CommandDefinition['requires'][number];

/** What the required-tool preflight bound for this start; empty when the command needs no MCP tool. */
export interface BoundTools {
  servers: Definitions['servers'];
  tools: Definitions['tools'];
  authority: Definitions['authority']['servers'];
}

export const NO_BOUND_TOOLS: BoundTools = Object.freeze({ servers: [], tools: [], authority: [] }) as BoundTools;

export type SnapshotAssembly =
  | { ok: true; digest: string; snapshot: CapabilitySnapshot }
  | {
      ok: false;
      reason:
        | 'prerequisite_not_granted'
        | 'prerequisite_restricted'
        | 'tool_unavailable'
        | 'credential_in_definition'
        | 'snapshot_too_large'
        | 'snapshot_invalid';
      subject?: string;
    };

const NATIVE = ['mcp_Read', 'mcp_Search', 'mcp_AskUser'] as const;
const mcpSubject = (requirement: { serverId: string; toolName: string }) =>
  `mcp:${requirement.serverId}/${requirement.toolName}`;
const narrow = (ids: Set<string>, allowed: readonly string[] | undefined) =>
  allowed === undefined ? ids : new Set([...ids].filter((id) => allowed.includes(id)));

export function assembleSnapshot(input: {
  catalog: Catalog;
  command: CommandDefinition;
  submission: CommandRunInput;
  renderedGoal: string;
  grants: CapabilityConfig;
  bound?: BoundTools;
  policy: ContentPolicy;
}): SnapshotAssembly {
  const { catalog, command, grants, policy } = input;
  const bound = input.bound ?? NO_BOUND_TOOLS;
  const boundTools = new Set(bound.tools.map((tool) => `${tool.serverId}/${tool.toolName}`));
  const ready = <T>(kind: 'skill' | 'agent') =>
    new Map(
      catalog.contributions.flatMap((contribution) =>
        contribution.kind === kind && contribution.availability.kind === 'ready'
          ? [[contribution.id, contribution.availability.definition as T] as const]
          : [],
      ),
    );
  const readySkills = ready<SkillDefinition>('skill');
  const readyAgents = ready<AgentDefinition>('agent');

  // The owner's current allowlists, narrowed by the command's restriction.
  let skills = narrow(narrow(new Set(readySkills.keys()), grants.allowSkills), command.restrict?.skills);
  let agents = narrow(narrow(new Set(readyAgents.keys()), grants.allowAgents), command.restrict?.agents);

  // A skill or agent whose own prerequisites are not available is not available either.
  const satisfied = (requires: readonly Requirement[]) =>
    requires.every((requirement) =>
      requirement.kind === 'skill'
        ? skills.has(requirement.id)
        : requirement.kind === 'agent'
          ? agents.has(requirement.id)
          : requirement.kind === 'mcp'
            ? boundTools.has(`${requirement.serverId}/${requirement.toolName}`)
            : true,
    );
  for (let changed = true; changed; ) {
    const before = skills.size + agents.size;
    skills = new Set([...skills].filter((id) => satisfied((readySkills.get(id) as SkillDefinition).requires)));
    agents = new Set([...agents].filter((id) => satisfied((readyAgents.get(id) as AgentDefinition).requires)));
    changed = skills.size + agents.size !== before;
  }

  // The command's own prerequisites must all be available to this run.
  for (const requirement of command.requires) {
    if (requirement.kind === 'skill' && !skills.has(requirement.id)) {
      return { ok: false, reason: 'prerequisite_not_granted', subject: requirement.id };
    }
    if (requirement.kind === 'agent' && !agents.has(requirement.id)) {
      return { ok: false, reason: 'prerequisite_not_granted', subject: requirement.id };
    }
    if (requirement.kind === 'native' && command.restrict?.native?.includes(requirement.name) === false) {
      return { ok: false, reason: 'prerequisite_restricted', subject: `command:${command.name}` };
    }
    if (requirement.kind === 'mcp' && !boundTools.has(`${requirement.serverId}/${requirement.toolName}`)) {
      return { ok: false, reason: 'tool_unavailable', subject: mcpSubject(requirement) };
    }
  }

  const skillDefinitions = [...skills].sort().map((id) => readySkills.get(id) as SkillDefinition);
  const agentDefinitions = [...agents].sort().map((id) => readyAgents.get(id) as AgentDefinition);

  // Screened before anything is retained: definitions, bound tool definitions and decoded text resources.
  const credential = credentialSubject(policy, [
    [`command:${command.name}`, command],
    ...skillDefinitions.map((skill) => [skill.id, skill] as [string, unknown]),
    ...agentDefinitions.map((agent) => [agent.id, agent] as [string, unknown]),
    ...bound.servers.map((server) => [`mcp:${server.serverId}`, server] as [string, unknown]),
    ...bound.tools.map((tool) => [mcpSubject(tool), tool] as [string, unknown]),
  ]);
  if (credential !== undefined) return { ok: false, reason: 'credential_in_definition', subject: credential };

  try {
    const sealed = sealSnapshot({
      version: 1,
      profile: 1,
      installation: { sha256: catalog.installationSha256 },
      command,
      input: { arguments: input.submission.arguments, renderedGoal: input.renderedGoal },
      skills: skillDefinitions,
      agents: agentDefinitions,
      servers: bound.servers,
      tools: bound.tools,
      authority: {
        native: [...NATIVE],
        skills: [...skills].sort(),
        agents: [...agents].sort(),
        servers: bound.authority,
      },
      limits: {
        maxDelegations: Math.min(grants.maxDelegationsPerRun, CAPABILITY_LIMITS.delegationsMaximum),
        delegationDepth: CAPABILITY_LIMITS.delegationDepth,
      },
    });
    return { ok: true, digest: sealed.digest, snapshot: sealed.payload };
  } catch (error) {
    if (error instanceof CapabilityRecordError) {
      return { ok: false, reason: error.reason === 'snapshot_too_large' ? 'snapshot_too_large' : 'snapshot_invalid' };
    }
    throw error;
  }
}

/** The first definition carrying recognizable credential material, including inside UTF-8 text resources. */
function credentialSubject(policy: ContentPolicy, definitions: readonly [string, unknown][]): string | undefined {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [subject, definition] of definitions) {
    for (const text of stringsIn(definition)) if (policy.detect(text) !== undefined) return subject;
    const resources = (definition as { resources?: { content: string }[] }).resources ?? [];
    for (const resource of resources) {
      let text: string;
      try {
        text = decoder.decode(Buffer.from(resource.content, 'base64'));
      } catch {
        // Binary resources are retained losslessly but are never readable by an agent.
        continue;
      }
      if (policy.detect(text) !== undefined) return subject;
    }
  }
  return undefined;
}
