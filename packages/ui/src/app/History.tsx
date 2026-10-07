// A run's recorded history, in sequence order. Every value is rendered as text.
import type { ActorRef, RunEvent, RunState } from '@agent-runtime/contracts';
import {
  actorLabel,
  DELEGATION_OUTCOME_LABELS,
  FAILURE_LABELS,
  formatTime,
  formatValue,
  providerLabel,
  STATE_LABELS,
} from './format.ts';

export function History({ events, state }: { events: readonly RunEvent[]; state: RunState }) {
  const resultSeq = state.kind === 'succeeded' ? state.resultSeq : undefined;
  // A model turn that only called a tool has no text; its tool events say what happened. A result is always shown.
  const shown = events.filter(
    (event) => event.kind !== 'assistant.message' || event.payload.text.trim() !== '' || event.seq === resultSeq,
  );
  return (
    <ol className="history">
      {shown.map((event) => (
        <li key={event.seq} className={`event event-${event.kind.replace('.', '-')}`} data-seq={event.seq}>
          <time dateTime={event.recordedAt} title={event.recordedAt}>
            {formatTime(event.recordedAt)}
          </time>
          <EventBody event={event} final={event.seq === resultSeq} />
        </li>
      ))}
    </ol>
  );
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

function EventBody({ event, final }: { event: RunEvent; final: boolean }) {
  switch (event.kind) {
    case 'run.created':
      return (
        <p>
          Run started with {providerLabel(event.payload.provider)} · {event.payload.model}, budget{' '}
          {event.payload.budgetMax} model requests.
        </p>
      );
    case 'run.status':
      return (
        <p className="status-change">
          Status:{' '}
          <span className={`status status-${event.payload.state.kind}`}>{STATE_LABELS[event.payload.state.kind]}</span>
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
          {final && <p className="label">Result</p>}
          {!final && event.payload.actor !== undefined && (
            <p className="label">
              <Actor actor={event.payload.actor} />
            </p>
          )}
          <p className="text">{event.payload.text}</p>
        </div>
      );
    case 'tool.operation': {
      const { toolName, disposition, binding } = event.payload;
      return (
        <div className="tool">
          <p>
            <Actor actor={event.payload.actor} />
            Tool <code>{binding?.kind === 'mcp' ? `${binding.serverId} / ${binding.toolName}` : toolName}</code>:{' '}
            {toolStatus(disposition)}
          </p>
          {disposition.kind === 'completed' && (
            <details>
              <summary>Result</summary>
              <pre>{JSON.stringify(disposition.result, null, 2)}</pre>
            </details>
          )}
        </div>
      );
    }
    case 'question.asked':
      return (
        <div className="question-record">
          <p className="label">
            {event.payload.actor?.kind === 'delegate' ? `Question from ${actorLabel(event.payload.actor)}` : 'Question'}
          </p>
          <p className="text">{event.payload.prompt}</p>
          {event.payload.input.kind === 'choice' && (
            <ul>
              {event.payload.input.options.map((option) => (
                <li key={JSON.stringify(option.value)}>
                  {option.label} <span className="hint">({formatValue(option.value)})</span>
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
      return <p>Cancellation accepted.</p>;
    case 'run.command':
      return (
        <p className="command">
          Command <code>{event.payload.commandId}</code> selected
          {event.payload.arguments === '' ? '.' : ' with arguments:'}
          {event.payload.arguments !== '' && <span className="text"> {event.payload.arguments}</span>}
        </p>
      );
    case 'delegation.started':
      return (
        <div className="delegation">
          <p>
            Delegated to{' '}
            {actorLabel({ kind: 'delegate', delegationId: event.payload.delegationId, agentId: event.payload.agentId })}
            :
          </p>
          <p className="text">{event.payload.task}</p>
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
