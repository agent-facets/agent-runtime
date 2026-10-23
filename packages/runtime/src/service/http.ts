// The `/api/v1` routes (design Decision 13). Common validation comes first — method, JSON content type, a bounded
// body, then the command envelope — and only then the run service, which owns every decision. A browser request's
// signal is never passed on: closing a connection cannot stop or change a run.
import {
  API_PREFIX,
  type CommandErrorCode,
  type ErrorCode,
  parseAnswerSubmission,
  parseCancelRun,
  parseStartRun,
  REQUEST_BODY_MAX_BYTES,
} from '@agent-runtime/contracts';
import { type ApiResult, type RunService, refusal } from './runs.ts';
import { openEventStream, type StreamTiming } from './stream.ts';

const COMMAND_ERRORS: Record<CommandErrorCode, { code: ErrorCode; message: string }> = {
  invalid_request: { code: 'invalid_request', message: 'The request body does not have the expected fields.' },
  goal_required: { code: 'goal_required', message: 'A goal is required.' },
  goal_too_long: { code: 'goal_too_long', message: 'The goal is longer than 8 KiB.' },
  goal_not_storable: { code: 'goal_not_storable', message: 'The goal contains text that cannot be stored.' },
};

export const RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

export function jsonResponse(result: ApiResult, extra: Record<string, string> = {}): Response {
  return Response.json(result.body, { status: result.status, headers: { ...RESPONSE_HEADERS, ...extra } });
}

/** The service, or why the API cannot serve yet (persistence starting or failed, execution unconfigured). */
export type ServiceProvider = () => RunService | { unavailable: string };

type Route =
  | { name: 'options' }
  | { name: 'runs' }
  | { name: 'run'; runId: string }
  | { name: 'events'; runId: string }
  | { name: 'stream'; runId: string }
  | { name: 'answer'; runId: string; questionId: string }
  | { name: 'cancel'; runId: string };

const ALLOWED: Record<Route['name'], 'GET' | 'POST' | 'GET, POST'> = {
  options: 'GET',
  runs: 'GET, POST',
  run: 'GET',
  events: 'GET',
  stream: 'GET',
  answer: 'POST',
  cancel: 'POST',
};

const SEGMENT = '([^/]{1,128})';
const ROUTES: [RegExp, (match: RegExpExecArray) => Route][] = [
  [/^\/options$/, () => ({ name: 'options' })],
  [/^\/runs$/, () => ({ name: 'runs' })],
  [new RegExp(`^/runs/${SEGMENT}$`), (m) => ({ name: 'run', runId: m[1] as string })],
  [new RegExp(`^/runs/${SEGMENT}/events$`), (m) => ({ name: 'events', runId: m[1] as string })],
  [new RegExp(`^/runs/${SEGMENT}/stream$`), (m) => ({ name: 'stream', runId: m[1] as string })],
  [
    new RegExp(`^/runs/${SEGMENT}/questions/${SEGMENT}/answer$`),
    (m) => ({ name: 'answer', runId: m[1] as string, questionId: m[2] as string }),
  ],
  [new RegExp(`^/runs/${SEGMENT}/cancel$`), (m) => ({ name: 'cancel', runId: m[1] as string })],
];

function route(pathname: string): Route | undefined {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return undefined;
  const rest = pathname.slice(API_PREFIX.length);
  for (const [pattern, build] of ROUTES) {
    const match = pattern.exec(rest);
    if (match !== null) return build(match);
  }
  return undefined;
}

/** Reads a JSON body no larger than the API limit; refuses other content types, oversized and malformed bodies. */
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return { ok: false, result: refusal('json_required', 'Requests that change anything must be JSON.') };
  }
  const tooLarge = { ok: false as const, result: refusal('request_too_large', 'The request body is too large.') };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > REQUEST_BODY_MAX_BYTES)) return tooLarge;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REQUEST_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, result: refusal('invalid_request', 'The request body is not valid JSON.') };
  }
}

/** The part of Bun's server the API uses: lifting the idle timeout for one long-lived event stream. */
export interface StreamServer {
  timeout(request: Request, seconds: number): void;
}

export async function handleApi(
  request: Request,
  services: ServiceProvider,
  server?: StreamServer,
  timing?: StreamTiming,
): Promise<Response> {
  const url = new URL(request.url);
  const target = route(url.pathname);
  if (target === undefined) return jsonResponse(refusal('not_found', 'No such API resource.'));
  const allowed = ALLOWED[target.name];
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  if (!allowed.split(', ').includes(method)) {
    return jsonResponse(refusal('method_not_allowed', 'That method is not supported here.'), { allow: allowed });
  }

  let body: unknown;
  if (method === 'POST') {
    const read = await readJson(request);
    if (!read.ok) return jsonResponse(read.result);
    body = read.value;
  }

  const service = services();
  if ('unavailable' in service) {
    return jsonResponse(refusal('service_unavailable', 'Agent execution is not available right now.'));
  }
  const query = url.searchParams;

  switch (target.name) {
    case 'options':
      return jsonResponse(await service.options());
    case 'runs': {
      if (method === 'GET')
        return jsonResponse(await service.listRuns({ limit: query.get('limit'), cursor: query.get('cursor') }));
      const command = parseStartRun(body);
      if (!command.ok)
        return jsonResponse(refusal(COMMAND_ERRORS[command.code].code, COMMAND_ERRORS[command.code].message));
      return jsonResponse(await service.createRun(command.value));
    }
    case 'run':
      return jsonResponse(await service.detail(target.runId));
    case 'events':
      return jsonResponse(
        await service.events(target.runId, {
          after: query.get('after'),
          through: query.get('through'),
          limit: query.get('limit'),
        }),
      );
    case 'stream': {
      // A reconnecting browser reports the last event it received; that supersedes the URL's initial cursor.
      const cursor = request.headers.get('last-event-id') ?? query.get('after');
      const opened = await openEventStream(service.store, target.runId, cursor, {
        signal: request.signal,
        ...(timing === undefined ? {} : { timing }),
      });
      if (!(opened instanceof Response)) return jsonResponse(opened);
      // Only this request is exempt from the server's idle timeout. (Bun 1.3.14 was observed not to time out a
      // response that is still streaming; this keeps the stream open should that change.)
      server?.timeout(request, 0);
      return opened;
    }
    case 'answer': {
      const command = parseAnswerSubmission(body);
      if (!command.ok) return jsonResponse(refusal('invalid_request', COMMAND_ERRORS.invalid_request.message));
      return jsonResponse(await service.answer(target.runId, target.questionId, command.value));
    }
    case 'cancel': {
      const command = parseCancelRun(body);
      if (!command.ok) return jsonResponse(refusal('invalid_request', COMMAND_ERRORS.invalid_request.message));
      return jsonResponse(await service.cancel(target.runId, command.value.requestId));
    }
  }
}
