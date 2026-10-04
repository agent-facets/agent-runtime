// One invocation of a run bound to OpenAI subscription access: the stock model, its guarded terminal (with the run's
// durable admission and tracked work), the profile's preparation/completion/failure hooks, the one renewal retry,
// and the screening scope and failure reports the model boundary consumes. This is the OpenAI adapter's execution
// root: its closure is part of the execution definition of runs bound to OpenAI.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import { type CredentialScreen, ScreenScope } from '../../credentials/screening.ts';
import { ModelCallReports } from '../../execution/failures.ts';
import { createTerminal, type RequestAdmission } from '../../execution/terminal.ts';
import type { ProviderBinding } from '../../records/schemas.ts';
import {
  createOpenAIModel,
  openaiCredentials,
  openaiInferencePolicy,
  openaiRenewal,
  openaiTerminalHooks,
} from './inference.ts';
import { openaiProfileFor } from './profile.ts';

export interface OpenAIInvocation {
  binding: ProviderBinding;
  /** The run: the conversation identity the profile's session headers carry. */
  runId: string;
  coordinator: CredentialCoordinator;
  screen: CredentialScreen;
  admission: RequestAdmission;
  /** The invocation's service-owned signal, available once the invocation has started. */
  signal: () => AbortSignal;
  /** Receives each request's settlement and any credential write it triggers. */
  track: (work: Promise<unknown>) => void;
  deadlineMs: number;
  transport?: typeof fetch;
  /** Told the event-name summary (never content) of a response stream judged incomplete. */
  onStreamIncomplete?: (streamEvents: string) => void;
}

/** The same shape as the Anthropic adapter's; declared here so neither adapter's closure includes the other. */
export interface WiredModel {
  model: BaseChatModel;
  /** For the model boundary: ends the call's screening leases. */
  modelCallSettled: () => void;
  /** For the model boundary: the call's classified unsuccessful responses. */
  reports: ModelCallReports;
}

export function wireOpenAIInvocation(options: OpenAIInvocation): WiredModel | { unavailable: 'profile_unsupported' } {
  const profile = openaiProfileFor(options.binding.profileId);
  if (profile === undefined) return { unavailable: 'profile_unsupported' };
  const { coordinator } = options;
  const scope = new ScreenScope(options.screen);
  const reports = new ModelCallReports();
  const hooks = openaiTerminalHooks({
    profile,
    model: options.binding.model,
    conversationId: options.runId,
    onIncomplete: (streamEvents) => options.onStreamIncomplete?.(streamEvents),
  });
  // Generations produced by this invocation's renewal: a rejection of one of those is definitive.
  const renewed = new Set<number>();

  const terminal = createTerminal({
    policy: openaiInferencePolicy(profile),
    get signal() {
      return options.signal();
    },
    deadlineMs: options.deadlineMs,
    credentials: openaiCredentials(coordinator, scope),
    admission: options.admission,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    track: options.track,
    prepare: hooks.prepare,
    completion: hooks.completion,
    failures: {
      classify: hooks.classify,
      report(failure) {
        reports.record(failure);
        if (failure.status === 401 && renewed.has(failure.generation)) {
          // Rejected again right after renewal: stop using it until the owner authorizes again.
          options.track(coordinator.markRejected(failure.generation, 'authorization_rejected'));
        }
      },
    },
    renewal: openaiRenewal(coordinator, (generation) => renewed.add(generation)),
  });

  return {
    model: createOpenAIModel({ model: options.binding.model, terminal, profile }),
    modelCallSettled: () => scope.release(),
    reports,
  };
}
