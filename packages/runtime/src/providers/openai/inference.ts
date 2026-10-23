// OpenAI subscription inference: stock ChatOpenAI in streaming Responses mode against the ChatGPT Codex backend,
// every physical request through the guarded terminal. The model is configured only through its public options;
// requests are not rewritten and responses are not parsed here. The SDK parses the stream, and a response counts only
// once that parse reports it completed (`openaiResponseRefusal`). ./binding.ts wires one invocation from these parts.
import type { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import type { ScreenScope } from '../../credentials/screening.ts';
import type { AppliedCredential, CredentialRenewal, EndpointPolicy } from '../../execution/terminal.ts';
import type { ProviderErrorCode } from '../failure-mapping.ts';

/** The binding profile for this configuration. Earlier profiles (`codex-0.151.0`) belong to the retired adapter. */
export const OPENAI_PROFILE_ID = 'codex-responses-v1';
export const OPENAI_PROFILE_IDS: readonly string[] = Object.freeze([OPENAI_PROFILE_ID]);

export const OPENAI_INFERENCE_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_INFERENCE_POLICY: EndpointPolicy = Object.freeze({
  origin: 'https://chatgpt.com',
  routes: Object.freeze([Object.freeze({ method: 'POST' as const, path: '/backend-api/codex/responses' })]),
});

/** Identifies this application to the backend; it does not claim to be a Codex client. */
export const OPENAI_ORIGINATOR = 'agent_runtime';

/** The inert value ChatOpenAI requires as its API key; the terminal replaces the authorization header. */
export const SENTINEL_API_KEY = 'subscription-access-uses-the-terminal';

/**
 * A stock ChatOpenAI whose every request goes through `terminal`. Retries are off in the constructor and absent from
 * `configuration`, where the SDK's request path would honor them. Organization, project and logging are fixed so no
 * ambient setting can change a request. `conversationId` is the run: it groups the run's requests.
 */
export function createOpenAIModel(options: { model: string; terminal: typeof fetch; conversationId: string }) {
  return new ChatOpenAI({
    model: options.model,
    useResponsesApi: true,
    streaming: true,
    maxRetries: 0,
    maxConcurrency: 1,
    // Stateless: `store: false`, with each turn's full output (encrypted reasoning, tool calls) replayed as input.
    zdrEnabled: true,
    supportsStrictToolCalling: false,
    apiKey: SENTINEL_API_KEY,
    modelKwargs: {
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
      text: { verbosity: 'low' },
    },
    configuration: {
      baseURL: OPENAI_INFERENCE_BASE_URL,
      fetch: options.terminal,
      organization: null,
      project: null,
      logLevel: 'off',
      defaultHeaders: {
        accept: 'text/event-stream',
        originator: OPENAI_ORIGINATOR,
        'session-id': options.conversationId,
        'thread-id': options.conversationId,
        'x-client-request-id': options.conversationId,
      },
    },
  });
}

/**
 * Why a parsed response is not a complete, successful one, or undefined if it is. Only the SDK's own parse is read:
 * the status the backend's terminal event reported. A stream that ended without `response.completed` has none.
 */
export function openaiResponseRefusal(message: AIMessage): string | undefined {
  const metadata = (message.response_metadata ?? {}) as Record<string, unknown>;
  const status = metadata.status;
  if (status === undefined) return 'response_status_missing';
  if (status !== 'completed') return status === 'incomplete' ? 'response_incomplete' : 'response_not_completed';
  if (metadata.error !== undefined && metadata.error !== null) return 'response_error';
  if ((message.invalid_tool_calls ?? []).length > 0) return 'response_tool_call_invalid';
  return undefined;
}

class CredentialRefusal extends Error {
  override readonly name = 'CredentialRefusal';
  constructor(readonly reason: string) {
    super('provider credentials are not available');
  }
}

/** Token and account from one generation, pinned in the run's screen before the request can be sent. */
export function openaiCredentials(coordinator: CredentialCoordinator, scope?: ScreenScope) {
  return async (signal: AbortSignal): Promise<AppliedCredential> => {
    const state = await coordinator.current(signal);
    if (state.kind !== 'ready') throw new CredentialRefusal(state.kind);
    const accountId = state.credential.account?.accountId;
    if (!state.credential.accessToken || !accountId) throw new CredentialRefusal('credential_incomplete');
    scope?.pin(state.credential);
    return {
      headers: { authorization: `Bearer ${state.credential.accessToken}`, 'chatgpt-account-id': accountId },
      generation: state.credential.generation,
    };
  };
}

export function openaiRenewal(
  coordinator: CredentialCoordinator,
  /** Told which generation the renewal produced (or adopted). */
  onRenewed?: (generation: number) => void,
): CredentialRenewal {
  return {
    async recoverable(response) {
      return response.status === 401;
    },
    async renew(rejectedGeneration, signal) {
      const state = await coordinator.refresh({ observedGeneration: rejectedGeneration, signal });
      if (state.kind !== 'ready') throw new CredentialRefusal(state.kind);
      onRenewed?.(state.credential.generation);
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Safe provider codes from an unsuccessful response's status and allowlisted error code. */
export function classifyOpenAIError(status: number, body: string | undefined): ProviderErrorCode {
  let code: unknown;
  if (body !== undefined && body.length <= 16 * 1024) {
    try {
      const decoded: unknown = JSON.parse(body);
      const error = isRecord(decoded) ? decoded.error : undefined;
      if (isRecord(error)) code = error.code ?? error.type;
    } catch {
      // Not JSON: the status decides.
    }
  }
  if (code === 'usage_limit_reached' || code === 'usage_not_included' || code === 'insufficient_quota') {
    return 'quota_exhausted';
  }
  if (code === 'rate_limit_exceeded') return 'rate_limited';
  if (code === 'model_not_found' || code === 'unsupported_model') return 'model_unsupported';
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'bad_request';
  return 'unknown';
}
