// Command starts (design Decisions 3 and 6): which installed command a request names, whether the owner saw the
// current installation, and the task goal its raw argument text renders. Arguments are owner text, never template
// input: the literal `$ARGUMENTS` marker is replaced by them as plain text, and without the marker they are appended
// in a labelled owner-input section. Nothing is interpolated, expanded, executed or truncated, and a refused
// selection never falls back to a free-form goal or another command.
import { GOAL_MAX_BYTES } from '@agent-runtime/contracts';
import { utf8Bytes } from '../domain/text.ts';
import { digestOf } from '../records/canonical.ts';
import { type ContentPolicy, screenOwnerInput } from '../security/content-policy.ts';
import type { Catalog } from './installation.ts';
import type { CommandRunInput } from './records.ts';

export const ARGUMENTS_MARKER = '$ARGUMENTS';
export const OWNER_INPUT_HEADING = '## Owner input';

type CommandDefinition = Extract<Catalog['contributions'][number]['availability'], { kind: 'ready' }>['definition'] & {
  body: string;
  arguments: { required: boolean };
};

/**
 * The revision under which a command is offered: its ID within one sealed installation. Any change to the pinned
 * installation changes every revision, so a start prepared against an older view is refused rather than reinterpreted.
 */
export function selectionRevision(installationSha256: string, commandId: string): string {
  return digestOf({ version: 1, installation: installationSha256, command: commandId });
}

export type Rendering =
  | { ok: true; goal: string }
  | { ok: false; reason: 'arguments_required' | 'goal_blank' | 'goal_too_long' | 'goal_not_storable' };

/** The task goal for a command's body and raw arguments. */
export function renderCommand(definition: Pick<CommandDefinition, 'body' | 'arguments'>, args: string): Rendering {
  if (definition.arguments.required && !/\S/.test(args)) return { ok: false, reason: 'arguments_required' };
  const goal = definition.body.includes(ARGUMENTS_MARKER)
    ? // split/join, not String.replace: replacement patterns such as `$&` in the arguments stay literal.
      definition.body.split(ARGUMENTS_MARKER).join(args)
    : /\S/.test(args)
      ? `${definition.body.replace(/\s+$/, '')}\n\n${OWNER_INPUT_HEADING}\n\n${args}`
      : definition.body;
  if (!goal.isWellFormed() || goal.includes('\u0000')) return { ok: false, reason: 'goal_not_storable' };
  if (!/\S/.test(goal)) return { ok: false, reason: 'goal_blank' };
  if (utf8Bytes(goal) > GOAL_MAX_BYTES) return { ok: false, reason: 'goal_too_long' };
  return { ok: true, goal };
}

export type CommandStart =
  | { ok: true; command: CommandDefinition; goal: string }
  | {
      ok: false;
      code:
        | 'credential_in_input'
        | 'capability_selection_changed'
        | 'capability_unavailable'
        | 'command_arguments_invalid';
      reason: string;
      subject?: string;
    };

/**
 * Resolves a new command start against the current catalog, in order: the owner's text is screened (and never
 * echoed), the selection must be the one currently offered, the command must be usable, and its goal must render.
 */
export function prepareCommandStart(catalog: Catalog, input: CommandRunInput, policy: ContentPolicy): CommandStart {
  if (!screenOwnerInput(policy, input.arguments).ok) {
    return { ok: false, code: 'credential_in_input', reason: 'credential_in_input' };
  }
  const subject = input.commandId;
  if (input.selectionRevision !== selectionRevision(catalog.installationSha256, input.commandId)) {
    return { ok: false, code: 'capability_selection_changed', reason: 'selection_changed', subject };
  }
  const contribution = catalog.contributions.find(
    (candidate) => candidate.id === input.commandId && candidate.kind === 'command',
  );
  if (contribution === undefined)
    return { ok: false, code: 'capability_unavailable', reason: 'command_missing', subject };
  if (contribution.availability.kind !== 'ready') {
    const { reason, subject: blocked } = contribution.availability;
    return { ok: false, code: 'capability_unavailable', reason, subject: blocked ?? subject };
  }
  const command = contribution.availability.definition as CommandDefinition;
  const rendered = renderCommand(command, input.arguments);
  if (!rendered.ok) return { ok: false, code: 'command_arguments_invalid', reason: rendered.reason, subject };
  return { ok: true, command, goal: rendered.goal };
}
