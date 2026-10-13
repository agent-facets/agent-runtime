// On-demand skills (design Decision 3). An actor sees its available skills by ID and description only; loading one
// returns its retained instructions and the paths of its bundled references, and records the actor's membership in
// the same commit as the successful outcome (RunStore.completeToolOperation). A reference of a loaded skill is read
// from the run's retained bytes — never the filesystem — as screened, numbered UTF-8 lines in bounded pages.
//
// Reference eligibility is the membership the actor had when the model produced the issuing response: the boundary
// middleware freezes it into that response's runtime-owned metadata before the graph stores it, so a sibling load in
// the same response cannot enable a reference until a later response. What is advertised comes from the retained
// ceiling, so revocation never rewrites a run's execution definition; the owner's current grants are checked only
// when a new load or read actually runs, after any recorded replay.
import { resourcePathSchema, skillIdSchema } from '@agent-runtime/contracts';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import { AIMessage as AIMessageClass } from '@langchain/core/messages';
import { tool } from 'langchain';
import { z } from 'zod';
import { effectiveSkills } from '../capabilities/authority.ts';
import type { CapabilitySnapshot } from '../capabilities/records.ts';
import type { CapabilityConfig } from '../config/capabilities.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import { sanitizeToolOutcome } from '../security/pre-graph.ts';
import { projectLines } from '../workspace/projection.ts';
import { ENVELOPE_RESERVE_BYTES, largestFitting, ResultBudget, type ToolOutcome } from '../workspace/results.ts';

export const LOAD_SKILL_TOOL = 'mcp_LoadSkill';
export const READ_REFERENCE_TOOL = 'mcp_ReadSkillReference';
export const SKILL_TOOL_NAMES: readonly string[] = [LOAD_SKILL_TOOL, READ_REFERENCE_TOOL];
export const SKILL_PROTOCOL_VERSION = 1;
/** The response metadata key under which the runtime freezes an actor's loaded skills; never provider-supplied. */
export const LOADED_SKILLS_METADATA = 'agent_runtime_loaded_skills';
const RESULT_BYTES = 65_536;
const LINES_DEFAULT = 200;
const LINES_MAX = 2_000;

type SkillDefinition = CapabilitySnapshot['skills'][number];
type AgentDefinition = CapabilitySnapshot['agents'][number];

/** What an actor's skill tools need: the retained definitions, current grants and its recorded membership. */
export interface SkillScope {
  snapshot: CapabilitySnapshot;
  /** The delegate's retained agent; undefined for the root. */
  agent?: AgentDefinition;
  /** The owner's current grants, loaded at startup; they narrow new operations only. */
  current: CapabilityConfig | undefined;
  /** The actor's recorded loaded-skill membership. */
  loaded(): Promise<string[]>;
}

/** The skills an actor may ever use in this run: its retained ceiling, narrowed by command and agent. */
export function retainedSkillsFor(snapshot: CapabilitySnapshot, agent?: AgentDefinition): SkillDefinition[] {
  const narrow = (ids: readonly string[], allowed: readonly string[] | undefined) =>
    allowed === undefined ? ids : ids.filter((id) => allowed.includes(id));
  const ids = narrow(narrow(snapshot.authority.skills, snapshot.command.restrict?.skills), agent?.restrict?.skills);
  return snapshot.skills.filter((skill) => ids.includes(skill.id));
}

/** The membership frozen on the response that issued a call, validated against the actor's retained skills. */
export function frozenMembership(
  messages: readonly BaseMessage[] | undefined,
  toolCallId: string,
  retained: readonly SkillDefinition[],
): Set<string> | undefined {
  const issuers = (messages ?? []).filter(
    (message): message is AIMessage =>
      AIMessageClass.isInstance(message) && (message.tool_calls ?? []).some((call) => call.id === toolCallId),
  );
  if (issuers.length !== 1) return undefined;
  const value = (issuers[0] as AIMessage).response_metadata?.[LOADED_SKILLS_METADATA];
  const ids = new Set(retained.map((skill) => skill.id));
  if (!Array.isArray(value) || value.length > ids.size || new Set(value).size !== value.length) return undefined;
  return value.every((id) => typeof id === 'string' && ids.has(id)) ? new Set(value as string[]) : undefined;
}

const loadArguments = z.strictObject({ skill: skillIdSchema });
const readArguments = z.strictObject({
  skill: skillIdSchema,
  path: resourcePathSchema,
  startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  lineLimit: z.number().int().min(1).max(LINES_MAX).optional(),
});
const refusal = (code: string, message: string): ToolOutcome<never> => ({ outcome: 'refused', code, message });

interface ToolRuntimeView {
  signal?: AbortSignal;
  toolCallId?: string;
  configurable?: { thread_id?: unknown };
  state?: { messages?: BaseMessage[] };
}

export function createSkillTools(context: { scope: SkillScope; contentPolicy: () => ContentPolicy }) {
  const { scope } = context;
  const retained = retainedSkillsFor(scope.snapshot, scope.agent);
  if (retained.length === 0) return [];
  const listing = retained.map((skill) => `- ${skill.id}: ${skill.description}`).join('\n');
  const permitted = (id: string) => effectiveSkills(scope.snapshot, scope.current, scope.agent).includes(id);
  const done = (outcome: ToolOutcome<unknown>) => JSON.stringify(sanitizeToolOutcome(context.contentPolicy(), outcome));

  const load = tool(
    async (args: unknown) => {
      const parsed = loadArguments.safeParse(args);
      if (!parsed.success) return done(refusal('invalid_argument', 'Name one skill by its ID.'));
      const skill = retained.find((candidate) => candidate.id === parsed.data.skill);
      if (skill === undefined) return done(refusal('skill_unavailable', 'That skill is not available to this agent.'));
      if (!permitted(skill.id)) return done(refusal('skill_not_permitted', 'That skill is no longer permitted.'));
      return done({
        outcome: 'ok',
        result: {
          skill: skill.id,
          text: skill.instructions,
          references: skill.resources.map((resource) => ({ path: resource.path, bytes: resource.byteLength })),
        },
      });
    },
    {
      name: LOAD_SKILL_TOOL,
      description: [
        'Load one skill to receive its full instructions and the paths of its bundled references. Available skills:',
        listing,
        'Loading grants no other access. A loaded skill’s references can be read from your next response onwards.',
      ].join('\n'),
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['skill'],
        properties: { skill: { type: 'string', description: 'The skill ID, for example "skill:review".' } },
      },
    },
  );

  const read = tool(
    async (args: unknown, runtime: ToolRuntimeView) => {
      const parsed = readArguments.safeParse(args);
      if (!parsed.success)
        return done(refusal('invalid_argument', 'Give a skill ID, a reference path and optional paging.'));
      const skill = retained.find((candidate) => candidate.id === parsed.data.skill);
      if (skill === undefined) return done(refusal('skill_unavailable', 'That skill is not available to this agent.'));
      const loaded =
        typeof runtime.toolCallId === 'string'
          ? frozenMembership(runtime.state?.messages, runtime.toolCallId, retained)
          : undefined;
      if (!loaded?.has(skill.id)) {
        return done(
          refusal(
            'skill_not_loaded',
            'Load the skill first. A skill loaded in the same response can be read from the next response.',
          ),
        );
      }
      if (!permitted(skill.id)) return done(refusal('skill_not_permitted', 'That skill is no longer permitted.'));
      const resource = skill.resources.find((candidate) => candidate.path === parsed.data.path);
      if (resource === undefined) return done(refusal('reference_missing', 'The skill has no reference at that path.'));
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(resource.content, 'base64'));
      } catch {
        return done(refusal('reference_not_text', 'That reference is not UTF-8 text.'));
      }
      return done({
        outcome: 'ok',
        result: pageLines(text, context.contentPolicy(), {
          skill: skill.id,
          path: resource.path,
          startLine: parsed.data.startLine ?? 1,
          lineLimit: parsed.data.lineLimit ?? LINES_DEFAULT,
        }),
      });
    },
    {
      name: READ_REFERENCE_TOOL,
      description:
        'Read a bundled text reference of a skill you loaded in an earlier response, as numbered lines. Read-only.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['skill', 'path'],
        properties: {
          skill: { type: 'string' },
          path: { type: 'string', description: 'A path from the skill’s reference list.' },
          startLine: { type: 'integer', minimum: 1 },
          lineLimit: { type: 'integer', minimum: 1, maximum: LINES_MAX },
        },
      },
    },
  );
  return [load, read];
}

/** Numbered lines of a whole, screened text: protected material is located before any line is chosen or clipped. */
function pageLines(
  text: string,
  policy: ContentPolicy,
  request: { skill: string; path: string; startLine: number; lineLimit: number },
) {
  const spans = policy.spans(text);
  const budget = new ResultBudget(RESULT_BYTES - ENVELOPE_RESERVE_BYTES);
  const lines: { line: number; text: string; clipped?: true }[] = [];
  let total = 0;
  let next: number | undefined;
  for (const projected of projectLines(text, spans, policy.marker)) {
    total++;
    if (total < request.startLine || next !== undefined) continue;
    if (lines.length === request.lineLimit) {
      next = total;
      continue;
    }
    const entry = { line: total, text: projected.text };
    if (budget.tryAdd(entry)) {
      lines.push(entry);
      continue;
    }
    if (lines.length === 0) {
      const remaining = budget.remaining;
      const prefix = largestFitting(
        entry.text,
        (candidate) => ResultBudget.costOf({ line: total, text: candidate, clipped: true }) <= remaining,
      );
      lines.push({ line: total, text: prefix, clipped: true });
      next = total + 1;
    } else {
      next = total;
    }
  }
  if (next !== undefined && next > total) next = undefined;
  return {
    skill: request.skill,
    path: request.path,
    totalLines: total,
    startLine: request.startLine,
    lines,
    complete: next === undefined,
    ...(next === undefined ? {} : { nextStartLine: next }),
  };
}
