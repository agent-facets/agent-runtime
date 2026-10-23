// OpenAI subscription inference: stock ChatOpenAI in streaming Responses mode, every physical request through the
// guarded terminal and adapted to the run's immutable profile. Operational readiness stays disabled until OpenAI
// authorization (device login and renewal) is implemented; this module is the offline transport.
import { ChatOpenAI } from '@langchain/openai';
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import type { ScreenScope } from '../../credentials/screening.ts';
import type {
  AppliedCredential,
  CredentialRenewal,
  EndpointPolicy,
  TerminalOptions,
} from '../../execution/terminal.ts';
import {
  adaptOpenAIRequest,
  classifyOpenAIError,
  type OpenAISubscriptionProfile,
  ResponsesCompletion,
} from './profile.ts';

export function openaiInferencePolicy(profile: OpenAISubscriptionProfile): EndpointPolicy {
  return Object.freeze({
    origin: profile.origin,
    routes: Object.freeze([Object.freeze({ method: 'POST', path: profile.path })]),
  });
}

/** The inert value ChatOpenAI requires as its API key; the profile's allowlisted headers never include it. */
export const SENTINEL_API_KEY = 'subscription-access-uses-the-terminal';

/**
 * A stock ChatOpenAI whose every request goes through `terminal`. Responses mode selects both the encoder and the
 * decoder; retries are off in the constructor and — deliberately — absent from `configuration`, where the request
 * path would honor them. One request at a time per model instance.
 */
export function createOpenAIModel(options: {
  model: string;
  terminal: typeof fetch;
  profile: OpenAISubscriptionProfile;
}) {
  return new ChatOpenAI({
    model: options.model,
    useResponsesApi: true,
    streaming: true,
    maxRetries: 0,
    maxConcurrency: 1,
    zdrEnabled: true,
    apiKey: SENTINEL_API_KEY,
    configuration: { baseURL: options.profile.baseURL, fetch: options.terminal },
  });
}

/** Terminal hooks for one run bound to `profile`, `model` and its conversation identity. */
export function openaiTerminalHooks(options: {
  profile: OpenAISubscriptionProfile;
  model: string;
  conversationId: string;
}): Required<Pick<TerminalOptions, 'prepare' | 'completion'>> & {
  classify: NonNullable<TerminalOptions['failures']>['classify'];
} {
  return {
    prepare(request, credential: AppliedCredential) {
      return adaptOpenAIRequest(request, {
        ...options,
        accessToken: credential.accessToken ?? '',
        accountId: credential.account?.accountId ?? '',
      });
    },
    completion(response) {
      const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      // Streaming mode is always requested; any other successful body is not a complete response.
      return type === 'text/event-stream'
        ? new ResponsesCompletion()
        : { observe() {}, complete: false, failed: false };
    },
    classify(status, headers, body) {
      const retryAfter = headers.get('retry-after') ?? undefined;
      return { code: classifyOpenAIError(status, body), ...(retryAfter === undefined ? {} : { retryAfter }) };
    },
  };
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
    scope?.pin(state.credential);
    return {
      headers: {},
      generation: state.credential.generation,
      accessToken: state.credential.accessToken,
      account: state.credential.account,
    };
  };
}

export function openaiRenewal(coordinator: CredentialCoordinator): CredentialRenewal {
  return {
    async recoverable(response) {
      return response.status === 401;
    },
    async renew(rejectedGeneration, signal) {
      const state = await coordinator.refresh({ observedGeneration: rejectedGeneration, signal });
      if (state.kind !== 'ready') throw new CredentialRefusal(state.kind);
    },
  };
}
