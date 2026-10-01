// A run's recorded history, in sequence order. Every value is rendered as text.
import type { RunEvent, RunState } from '@agent-runtime/contracts';
import { FAILURE_LABELS, formatTime, formatValue, providerLabel, STATE_LABELS } from './format.ts';

export function History({ events, state }: { events: readonly RunEvent[]; state: RunState }) {
  const resultSeq = state.kind === 'succeeded' ? state.resultSeq : undefined;
  return (
    <ol className="history">
      {events.map((event) => (
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
          Model request {ordinal}: {described} · {budget.consumed} of {budget.maximum} used
          {budget.unconfirmed > 0 ? `, ${budget.unconfirmed} unconfirmed` : ''}
        </p>
      );
    }
    case 'assistant.message':
      return (
        <div className={final ? 'message final' : 'message'}>
          {final && <p className="label">Result</p>}
          <p className="text">{event.payload.text}</p>
        </div>
      );
    case 'tool.operation': {
      const { toolName, disposition } = event.payload;
      return (
        <div className="tool">
          <p>
            Tool <code>{toolName}</code>:{' '}
            {disposition.kind === 'completed'
              ? disposition.outcome === 'ok'
                ? 'completed'
                : disposition.outcome === 'refused'
                  ? 'refused'
                  : 'failed'
              : disposition.kind === 'abandoned'
                ? `abandoned (${disposition.reason.replaceAll('_', ' ')})`
                : disposition.kind === 'paused'
                  ? 'waiting for your answer'
                  : 'started'}
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
          <p className="label">Question</p>
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
  }
}
