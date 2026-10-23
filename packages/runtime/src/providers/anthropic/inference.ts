// Anthropic subscription inference: the stock ChatAnthropic model, with every physical request going through the
// guarded terminal, adapted to the run's immutable request profile by the internal subscription package.
//
// Nothing here rewrites a response. Unsuccessful responses are classified into safe provider codes; successful
// event streams are checked, unchanged, for a complete end.
import {
  adaptInferenceRequest,
  classifyInferenceError,
  type InferenceErrorKind,
  MAX_ERROR_BODY_BYTES,
  StreamCompletion,
  type SubscriptionProfile,
} from '@agent-runtime/anthropic-subscription';
import { ChatAnthropic } from '@langchain/anthropic';
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import type { ScreenScope } from '../../credentials/screening.ts';
import type {
  AppliedCredential,
  CredentialRenewal,
  EndpointPolicy,
  TerminalOptions,
} from '../../execution/terminal.ts';
import type { ProviderErrorCode } from '../failure-mapping.ts';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

/** The SDK's request (no query) and the adapted request (`?beta=true`) are the only permitted forms. */
export const ANTHROPIC_INFERENCE_POLICY: EndpointPolicy = Object.freeze({
  origin: ANTHROPIC_API_ORIGIN,
  routes: Object.freeze([Object.freeze({ method: 'POST', path: '/v1/messages', queries: ['', '?beta=true'] })]),
});

/**
 * The inert value ChatAnthropic requires as its API key. The terminal strips it; its presence also stops the SDK
 * from looking for an ambient API key.
 */
export const SENTINEL_API_KEY = 'subscription-access-uses-the-terminal';

/**
 * A stock ChatAnthropic whose every request goes through `terminal`. Retries are off at every layer (the SDK client
 * is built with none, the model's caller has none, and the model boundary forces none per call), the endpoint is
 * explicit so neither the environment nor a gateway can redirect it, and the browser-access header is never sent.
 */
export function createAnthropicModel(options: { model: string; terminal: typeof fetch; maxTokens?: number }) {
  return new ChatAnthropic({
    model: options.model,
    apiKey: SENTINEL_API_KEY,
    anthropicApiUrl: ANTHROPIC_API_ORIGIN,
    maxRetries: 0,
    streaming: true,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    clientOptions: { fetch: options.terminal, dangerouslyAllowBrowser: false },
  });
}

const ERROR_CODES: Record<InferenceErrorKind, ProviderErrorCode> = {
  authentication: 'auth_rejected',
  permission: 'auth_rejected',
  rate_limited: 'rate_limited',
  overloaded: 'overloaded',
  client_version_rejected: 'model_unsupported',
  model_not_found: 'model_unsupported',
  request_too_large: 'bad_request',
  invalid_request: 'bad_request',
  server_error: 'server_error',
  unknown: 'unknown',
};

/** Terminal hooks for one run bound to `profile`. */
export function anthropicTerminalHooks(profile: SubscriptionProfile): Required<
  Pick<TerminalOptions, 'prepare' | 'completion'>
> & {
  classify: NonNullable<TerminalOptions['failures']>['classify'];
} {
  return {
    prepare(request, credential: AppliedCredential) {
      if (credential.accessToken === undefined) return { refused: 'credential_not_applicable' };
      const adapted = adaptInferenceRequest(
        { url: request.url.href, method: request.method, headers: request.headers, body: request.body },
        { profile, accessToken: credential.accessToken },
      );
      if (!adapted.ok) return { refused: adapted.reason };
      return { url: new URL(adapted.url), method: adapted.method, headers: adapted.headers, body: adapted.body };
    },
    completion(response) {
      const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      // A JSON response cannot end early without failing to parse; an event stream can.
      return type === 'text/event-stream' ? new StreamCompletion() : undefined;
    },
    classify(status, headers, body) {
      const bounded = body !== undefined && body.length <= MAX_ERROR_BODY_BYTES ? body : undefined;
      const retryAfter = headers.get('retry-after') ?? undefined;
      return {
        code: ERROR_CODES[classifyInferenceError(status, bounded, profile)],
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    },
  };
}

class CredentialRefusal extends Error {
  override readonly name = 'CredentialRefusal';
  constructor(readonly reason: string) {
    super('provider credentials are not available');
  }
}

/**
 * Resolves the slot's current credential (refreshing it when due) and pins its generation in the run's screen
 * before the request can be admitted or sent. The access token is placed by the profile's request preparation.
 */
export function anthropicCredentials(coordinator: CredentialCoordinator, scope?: ScreenScope) {
  return async (signal: AbortSignal): Promise<AppliedCredential> => {
    const state = await coordinator.current(signal);
    if (state.kind !== 'ready') throw new CredentialRefusal(state.kind);
    scope?.pin(state.credential);
    return { headers: {}, generation: state.credential.generation, accessToken: state.credential.accessToken };
  };
}

/**
 * The one permitted renewal: an authentication rejection renews the rejected generation (or adopts a newer one
 * already stored). A renewal that cannot produce a usable credential reports whether that is definitive.
 */
export function anthropicRenewal(
  coordinator: CredentialCoordinator,
  profile: SubscriptionProfile,
  /** Told which generation the renewal produced (or adopted). */
  onRenewed?: (generation: number) => void,
): CredentialRenewal {
  return {
    async recoverable(response) {
      if (response.status !== 401) return false;
      const body = await response.text().catch(() => undefined);
      return classifyInferenceError(401, body, profile) === 'authentication';
    },
    async renew(rejectedGeneration, signal) {
      const state = await coordinator.refresh({ observedGeneration: rejectedGeneration, signal });
      if (state.kind !== 'ready') throw new CredentialRefusal(state.kind);
      onRenewed?.(state.credential.generation);
    },
  };
}
