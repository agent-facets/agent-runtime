// A session's conversation: the owner's message, then every recorded event in sequence order. Consecutive routine
// activity (model requests and tool calls that went as expected) is folded into a disclosure in place; messages,
// questions, answers, failures and anything uncertain are always shown. Nothing is reordered, and every event stays
// reachable. Every value is rendered as text.
import type { ActorRef, RunCapabilitiesView, RunEvent, RunState, ToolBinding } from '@agent-runtime/contracts';
import { Json, originsLabel } from './Capabilities.tsx';
import {
  actorLabel,
  DELEGATION_OUTCOME_LABELS,
  FAILURE_LABELS,
  formatTime,
  formatValue,
  providerLabel,
} from './format.ts';
import { Prose } from './Markdown.tsx';
import { ChevronIcon, code, cx, hint, muted, Status, summaryLine } from './ui.tsx';

export type ConversationBlock =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'activity'; actor: ActorRef | undefined; events: RunEvent[] };

/** Model requests and tool operations that later completed normally, so their earlier steps are routine. */
function settledNormally(events: readonly RunEvent[]) {
  const attempts = new Set<string>();
  const operations = new Set<string>();
  for (const event of events) {
    if (event.kind === 'model.attempt' && event.payload.state.kind === 'completed') {
      if (event.payload.state.outcome === 'ok') attempts.add(event.payload.attemptId);
    }
    if (event.kind === 'tool.operation' && event.payload.disposition.kind === 'completed') {
      if (event.payload.disposition.outcome === 'ok') operations.add(event.payload.operationId);
    }
  }
  return { attempts, operations };
}

/** Whether an event is routine bookkeeping that may be folded away; anything else is always shown. */
function routine(event: RunEvent, settled: ReturnType<typeof settledNormally>): boolean {
  switch (event.kind) {
    case 'run.created':
      return true;
    case 'run.status':
      return event.payload.state.kind === 'working';
    case 'model.attempt': {
      const { state } = event.payload;
      if (state.kind === 'reserved' || state.kind === 'dispatched') return true;
      if (state.kind === 'completed' && state.outcome === 'ok') return true;
      return settled.attempts.has(event.payload.attemptId);
    }
    case 'tool.operation': {
      const { disposition } = event.payload;
      if (disposition.kind === 'started') return true;
      if (disposition.kind === 'completed' && disposition.outcome === 'ok') return true;
      // A request that may have been sent, or a call paused for an answer, is routine only once it completed.
      if (disposition.kind === 'dispatching' || disposition.kind === 'paused') {
        return settled.operations.has(event.payload.operationId);
      }
      return false;
    }
    default:
      return false;
  }
}

/** Who did routine work: activity by different agents (or delegations of one agent) is never folded together. */
function actorKey(event: RunEvent): string {
  const actor = 'actor' in event.payload ? event.payload.actor : undefined;
  return actor?.kind === 'delegate' ? `delegate:${actor.delegationId}` : 'root';
}

/**
 * The conversation's blocks, in sequence order: each shown event on its own, and each run of consecutive routine
 * events by one actor as one activity block. Assistant turns without text are left out (their tool events say what
 * happened), except a result, which is always shown.
 */
export function conversationBlocks(events: readonly RunEvent[], resultSeq: string | undefined): ConversationBlock[] {
  const settled = settledNormally(events);
  const blocks: ConversationBlock[] = [];
  let open: { key: string; block: Extract<ConversationBlock, { kind: 'activity' }> } | undefined;
  for (const event of events) {
    if (event.kind === 'assistant.message' && event.payload.text.trim() === '' && event.seq !== resultSeq) continue;
    if (!routine(event, settled)) {
      open = undefined;
      blocks.push({ kind: 'event', event });
      continue;
    }
    const key = actorKey(event);
    if (open === undefined || open.key !== key) {
      const actor = 'actor' in event.payload ? event.payload.actor : undefined;
      open = { key, block: { kind: 'activity', actor, events: [] } };
      blocks.push(open.block);
    }
    open.block.events.push(event);
  }
  return blocks;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What an activity block contains, counted from its events; it never claims more than they record. */
export function activitySummary(events: readonly RunEvent[]): string {
  const tools = new Set<string>();
  const requests = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool.operation') tools.add(event.payload.operationId);
    if (event.kind === 'model.attempt') requests.add(event.payload.attemptId);
  }
  const parts = [
    ...(tools.size > 0 ? [plural(tools.size, 'tool call', 'tool calls')] : []),
    ...(requests.size > 0 ? [plural(requests.size, 'model request', 'model requests')] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : plural(events.length, 'event', 'events');
}

export function Conversation({
  goal,
  startedAt,
  events,
  state,
  capabilities,
  pendingQuestionId,
}: {
  /** The owner's message that started the session. */
  goal: string;
  startedAt: string;
  events: readonly RunEvent[];
  state: RunState;
  /** The run's retained capabilities, when known: they name the facet each contribution came from. */
  capabilities?: RunCapabilitiesView | undefined;
  /** The question waiting for an answer: its record is marked, and it is answered below the conversation. */
  pendingQuestionId?: string | undefined;
}) {
  const resultSeq = state.kind === 'succeeded' ? state.resultSeq : undefined;
  const blocks = conversationBlocks(events, resultSeq);
  return (
    <ol className="conversation space-y-6">
      <li className="turn turn-user flex flex-col items-end">
        <div className="mb-1 flex items-baseline gap-2 text-xs">
          <Stamp at={startedAt} />
          <span className="speaker font-medium text-zinc-700 dark:text-zinc-300">You</span>
        </div>
        <p className="max-w-[85%] rounded-2xl rounded-tr-md bg-zinc-100 px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap dark:bg-zinc-800">
          {goal}
        </p>
      </li>
      {blocks.map((block) =>
        block.kind === 'activity' ? (
          <li key={`activity-${block.events[0]?.seq}`} className="activity">
            <details className="group">
              <summary className={summaryLine}>
                <ChevronIcon />
                {block.actor?.kind === 'delegate' && <span className="actor">{actorLabel(block.actor)} · </span>}
                Activity <span className={hint}>· {activitySummary(block.events)}</span>
              </summary>
              <ol className="activity-events mt-2 ml-1.5 space-y-2 border-l border-zinc-200 pl-4 text-sm dark:border-zinc-800">
                {block.events.map((event) => (
                  <li key={event.seq} className={eventClass(event)} data-seq={event.seq}>
                    <Stamp at={event.recordedAt} />
                    <EventBody event={event} final={false} capabilities={capabilities} />
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ) : (
          <ShownEvent
            key={block.event.seq}
            event={block.event}
            final={block.event.seq === resultSeq}
            capabilities={capabilities}
            pending={block.event.kind === 'question.asked' && block.event.payload.questionId === pendingQuestionId}
          />
        ),
      )}
    </ol>
  );
}

const eventClass = (event: RunEvent) => `event event-${event.kind.replace('.', '-')}`;

function Stamp({ at }: { at: string }) {
  return (
    <time dateTime={at} title={at} className={cx('block text-xs', muted)}>
      {formatTime(at)}
    </time>
  );
}

function ShownEvent({
  event,
  final,
  capabilities,
  pending,
}: {
  event: RunEvent;
  final: boolean;
  capabilities: RunCapabilitiesView | undefined;
  pending: boolean;
}) {
  if (event.kind === 'assistant.message') {
    const actor = event.payload.actor;
    return (
      <li className={`turn turn-assistant ${eventClass(event)}`} data-seq={event.seq}>
        <div className="mb-1 flex flex-wrap items-baseline gap-2">
          <span className="speaker text-sm font-semibold">
            {actor?.kind === 'delegate' ? actorLabel(actor) : 'Assistant'}
          </span>
          {final && (
            <span className="badge rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Result
            </span>
          )}
          <Stamp at={event.recordedAt} />
        </div>
        <div className={final ? 'message final' : 'message'}>
          <Prose text={event.payload.text} />
        </div>
      </li>
    );
  }
  const tone = notable(event);
  return (
    <li
      className={cx(
        eventClass(event),
        'text-sm',
        tone === 'problem' &&
          'notable rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/30',
        tone === 'uncertain' &&
          'notable rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30',
        event.kind === 'question.asked' &&
          cx(
            'rounded-xl border px-4 py-3',
            pending
              ? 'border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'
              : 'border-zinc-200 dark:border-zinc-800',
          ),
      )}
      data-seq={event.seq}
    >
      <Stamp at={event.recordedAt} />
      <EventBody event={event} final={final} capabilities={capabilities} />
      {pending && (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">Waiting for your answer below.</p>
      )}
    </li>
  );
}

/** A shown event that reports something going wrong (problem) or not known (uncertain), so it stands out. */
function notable(event: RunEvent): 'problem' | 'uncertain' | undefined {
  switch (event.kind) {
    case 'model.attempt': {
      const { state } = event.payload;
      return state.kind === 'unconfirmed' ? 'uncertain' : 'problem';
    }
    case 'tool.operation': {
      const { disposition } = event.payload;
      if (disposition.kind === 'paused') return undefined;
      if (disposition.kind === 'dispatching') return 'uncertain';
      if (disposition.kind === 'completed' && disposition.outcome === 'uncertain') return 'uncertain';
      return 'problem';
    }
    case 'run.status':
      return event.payload.state.kind === 'failed' || event.payload.state.kind === 'interrupted'
        ? 'problem'
        : undefined;
    default:
      return undefined;
  }
}

function Actor({ actor }: { actor: ActorRef | undefined }) {
  const label = actorLabel(actor);
  return label === undefined ? null : <span className="actor">{label}: </span>;
}

function toolStatus(disposition: Extract<RunEvent, { kind: 'tool.operation' }>['payload']['disposition']): string {
  switch (disposition.kind) {
    case 'completed':
      return disposition.outcome === 'ok'
        ? 'completed'
        : disposition.outcome === 'refused'
          ? 'refused'
          : disposition.outcome === 'uncertain'
            ? 'outcome unknown: it may or may not have taken effect'
            : 'failed';
    case 'abandoned':
      return `abandoned (${disposition.reason.replaceAll('_', ' ')})`;
    case 'paused':
      return 'waiting for your answer';
    case 'dispatching':
      return 'request may have been sent';
    case 'started':
      return 'started';
  }
}

/** The facet a bound contribution came from, from the run's retained definitions. */
function originOf(binding: ToolBinding | undefined, capabilities: RunCapabilitiesView | undefined): string | undefined {
  if (binding === undefined || capabilities?.kind !== 'command') return undefined;
  const { bound } = capabilities;
  switch (binding.kind) {
    case 'mcp': {
      const tool = bound.tools.find(
        (candidate) => candidate.serverId === binding.serverId && candidate.toolName === binding.toolName,
      );
      return tool === undefined ? undefined : originsLabel(tool.origins);
    }
    case 'skill_load':
    case 'skill_reference': {
      const skill = bound.skills.find((candidate) => candidate.id === binding.skillId);
      return skill === undefined ? undefined : originsLabel(skill.origins);
    }
    case 'delegation': {
      const agent = bound.agents.find((candidate) => candidate.id === binding.agentId);
      return agent === undefined ? undefined : originsLabel(agent.origins);
    }
    case 'native':
      return undefined;
  }
}

function toolLabel(payload: Extract<RunEvent, { kind: 'tool.operation' }>['payload']): string {
  const { binding, toolName } = payload;
  switch (binding?.kind) {
    case 'mcp':
      return `${binding.serverId} / ${binding.toolName}`;
    case 'skill_load':
      return `load skill ${binding.skillId}`;
    case 'skill_reference':
      return `read ${binding.skillId} / ${binding.path}`;
    case 'delegation':
      return `delegate to ${binding.agentId}`;
    default:
      return toolName;
  }
}

const TEXT = 'whitespace-pre-wrap break-words';

function EventBody({
  event,
  final,
  capabilities,
}: {
  event: RunEvent;
  final: boolean;
  capabilities: RunCapabilitiesView | undefined;
}) {
  switch (event.kind) {
    case 'run.created':
      return (
        <p>
          Session started with {providerLabel(event.payload.provider)} · {event.payload.model}, limit{' '}
          {event.payload.budgetMax} model requests.
        </p>
      );
    case 'run.status':
      return (
        <p className="status-change">
          Status: <Status kind={event.payload.state.kind} />
          {event.payload.state.kind === 'failed' &&
            ` — ${FAILURE_LABELS[event.payload.state.failure.category]}: ${event.payload.state.failure.message}`}
        </p>
      );
    case 'model.attempt': {
      const { ordinal, state, budget } = event.payload;
      const described =
        state.kind === 'completed'
          ? `completed (${state.outcome})`
          : state.kind === 'abandoned'
            ? `not sent (${state.reason.replaceAll('_', ' ')})`
            : state.kind === 'unconfirmed'
              ? 'unconfirmed: it may or may not have reached the provider'
              : state.kind;
      return (
        <p className="attempt">
          <Actor actor={event.payload.actor} />
          Model request {ordinal}: {described} · {budget.consumed} of {budget.maximum} used
          {budget.unconfirmed > 0 ? `, ${budget.unconfirmed} unconfirmed` : ''}
        </p>
      );
    }
    case 'assistant.message':
      return (
        <div className={final ? 'message final' : 'message'}>
          <Prose text={event.payload.text} />
        </div>
      );
    case 'tool.operation': {
      const { disposition, binding } = event.payload;
      const origin = originOf(binding, capabilities);
      return (
        <div className="tool">
          <p>
            <Actor actor={event.payload.actor} />
            Tool <code className={code}>{toolLabel(event.payload)}</code>
            {origin !== undefined && <span className={hint}> ({origin})</span>}: {toolStatus(disposition)}
          </p>
          {disposition.kind === 'completed' && (
            <details className="group mt-1">
              <summary className={summaryLine}>
                <ChevronIcon />
                Result
              </summary>
              <Json value={disposition.result} />
            </details>
          )}
        </div>
      );
    }
    case 'question.asked':
      return (
        <div className="question-record mt-1 space-y-1">
          <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            {event.payload.actor?.kind === 'delegate' ? `Question from ${actorLabel(event.payload.actor)}` : 'Question'}
          </p>
          <p className={cx(TEXT, 'text-[0.9375rem]')}>{event.payload.prompt}</p>
          {event.payload.input.kind === 'choice' && (
            <ul className="list-disc pl-5">
              {event.payload.input.options.map((option) => (
                <li key={JSON.stringify(option.value)}>
                  {option.label} <span className={hint}>({formatValue(option.value)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'question.answered':
      return (
        <p className="answer">
          Answer accepted: <strong>{formatValue(event.payload.answer)}</strong>
        </p>
      );
    case 'question.closed':
      return <p>Question closed without an answer ({event.payload.reason.replaceAll('_', ' ')}).</p>;
    case 'cancellation.accepted':
      return <p>Stop requested.</p>;
    case 'run.command':
      return (
        <p className="command">
          Command <code className={code}>{event.payload.commandId}</code>
          {capabilities?.kind === 'command' && capabilities.command.id === event.payload.commandId && (
            <span className={hint}> ({originsLabel(capabilities.command.origins)})</span>
          )}{' '}
          selected
          {event.payload.arguments === '' ? '.' : ' with arguments:'}
          {event.payload.arguments !== '' && <span className={TEXT}> {event.payload.arguments}</span>}
        </p>
      );
    case 'delegation.started':
      return (
        <div className="delegation border-l-2 border-zinc-300 pl-3 dark:border-zinc-700">
          <p>
            Delegated to{' '}
            {actorLabel({ kind: 'delegate', delegationId: event.payload.delegationId, agentId: event.payload.agentId })}
            :
          </p>
          <p className={TEXT}>{event.payload.task}</p>
        </div>
      );
    case 'delegation.finished':
      return (
        <p className="delegation">
          Delegation {event.payload.delegationId.slice(0, 8)} {DELEGATION_OUTCOME_LABELS[event.payload.outcome]}.
        </p>
      );
  }
}
