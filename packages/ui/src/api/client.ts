// Typed access to the runtime's `/api/v1`. Every response body is validated against the shared contracts before
// the console uses it; anything else is an invalid response, never trusted. A request that could not be completed
// (the network failed, or the reply was unreadable) is reported as such: for a command, its outcome is unknown and
// it may only be retried with the same request identity.
import {
  type AnswerAccepted,
  answerAcceptedSchema,
  type CancellationAccepted,
  cancellationAcceptedSchema,
  type ErrorEnvelope,
  type EventPage,
  errorEnvelopeSchema,
  eventPageSchema,
  type Options,
  optionsSchema,
  type Provider,
  type RunList,
  type RunSnapshot,
  runListSchema,
  runSnapshotSchema,
} from '@agent-runtime/contracts';

/** Any contract schema: the console only needs to validate with it. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type ApiError = ErrorEnvelope['error'];

export type ApiOutcome<T> =
  | { ok: true; status: number; value: T }
  /** The server answered with a refusal; `error.acceptance` says whether anything was recorded. */
  | { ok: false; kind: 'refused'; status: number; error: ApiError }
  /** No usable answer arrived: whether a command took effect is unknown. */
  | { ok: false; kind: 'unreachable' | 'invalid_response'; status?: number };

/** The one fetch shape the client uses. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Base of the API, normally the page's own origin. */
  base?: string;
  fetch?: Fetch;
}

export class ApiClient {
  readonly #base: string;
  readonly #fetch: Fetch;

  constructor(options: ApiClientOptions = {}) {
    this.#base = options.base ?? '';
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The URL of a run's event stream after a cursor (for EventSource, which does its own fetching). */
  streamUrl(runId: string, after: string): string {
    return `${this.#base}/api/v1/runs/${encodeURIComponent(runId)}/stream?after=${encodeURIComponent(after)}`;
  }

  options(): Promise<ApiOutcome<Options>> {
    return this.#get('/api/v1/options', optionsSchema);
  }

  listRuns(cursor?: string): Promise<ApiOutcome<RunList>> {
    return this.#get(
      `/api/v1/runs${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      runListSchema,
    );
  }

  run(runId: string): Promise<ApiOutcome<RunSnapshot>> {
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}`, runSnapshotSchema);
  }

  events(runId: string, page: { after: string; through?: string; limit?: number }): Promise<ApiOutcome<EventPage>> {
    const query = new URLSearchParams({ after: page.after });
    if (page.through !== undefined) query.set('through', page.through);
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/events?${query}`, eventPageSchema);
  }

  startRun(command: { requestId: string; goal: string; provider: Provider }): Promise<ApiOutcome<RunSnapshot>> {
    return this.#post('/api/v1/runs', command, runSnapshotSchema);
  }

  answer(runId: string, questionId: string, answer: unknown): Promise<ApiOutcome<AnswerAccepted>> {
    return this.#post(
      `/api/v1/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(questionId)}/answer`,
      { answer },
      answerAcceptedSchema,
    );
  }

  cancel(runId: string, requestId: string): Promise<ApiOutcome<CancellationAccepted>> {
    return this.#post(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { requestId }, cancellationAcceptedSchema);
  }

  #get<T>(path: string, schema: Schema<T>): Promise<ApiOutcome<T>> {
    return this.#send(path, { method: 'GET', headers: { accept: 'application/json' } }, schema);
  }

  #post<T>(path: string, body: unknown, schema: Schema<T>): Promise<ApiOutcome<T>> {
    return this.#send(
      path,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      schema,
    );
  }

  async #send<T>(path: string, init: RequestInit, schema: Schema<T>): Promise<ApiOutcome<T>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      return { ok: false, kind: 'unreachable' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, kind: 'invalid_response', status: response.status };
    }
    if (response.ok) {
      const parsed = schema.safeParse(body);
      return parsed.success
        ? { ok: true, status: response.status, value: parsed.data }
        : { ok: false, kind: 'invalid_response', status: response.status };
    }
    const refused = errorEnvelopeSchema.safeParse(body);
    return refused.success
      ? { ok: false, kind: 'refused', status: response.status, error: refused.data.error }
      : { ok: false, kind: 'invalid_response', status: response.status };
  }
}
