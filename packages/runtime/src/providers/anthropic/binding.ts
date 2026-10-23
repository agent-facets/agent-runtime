// One invocation of a run bound to Anthropic subscription access: the stock model, its guarded terminal (with the
// run's durable admission and tracked work), the profile's preparation/completion/failure hooks, the one renewal
// retry, and the screening scope and failure reports the model boundary consumes. This is the Anthropic adapter's
// execution root: its closure is part of the execution definition of runs bound to Anthropic.
import { profileFor } from '@agent-runtime/anthropic-subscription';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import { type CredentialScreen, ScreenScope } from '../../credentials/screening.ts';
import { ModelCallReports } from '../../execution/failures.ts';
import { createTerminal, type RequestAdmission } from '../../execution/terminal.ts';
import type { ProviderBinding } from '../../records/schemas.ts';
import {
  ANTHROPIC_INFERENCE_POLICY,
  anthropicCredentials,
  anthropicRenewal,
  anthropicTerminalHooks,
  createAnthropicModel,
} from './inference.ts';

export interface AnthropicInvocation {
  binding: ProviderBinding;
  coordinator: CredentialCoordinator;
  screen: CredentialScreen;
  admission: RequestAdmission;
  /** The invocation's service-owned signal, available once the invocation has started. */
  signal: () => AbortSignal;
  /** Receives each request's settlement and any credential write it triggers. */
  track: (work: Promise<unknown>) => void;
  deadlineMs: number;
  transport?: typeof fetch;
}

export interface WiredModel {
  model: BaseChatModel;
  /** For the model boundary: ends the call's screening leases. */
  modelCallSettled: () => void;
  /** For the model boundary: the call's classified unsuccessful responses. */
  reports: ModelCallReports;
}

export function wireAnthropicInvocation(
  options: AnthropicInvocation,
): WiredModel | { unavailable: 'profile_unsupported' } {
  const profile = profileFor(options.binding.profileId);
  if (profile === undefined) return { unavailable: 'profile_unsupported' };
  const { coordinator } = options;
  const scope = new ScreenScope(options.screen);
  const reports = new ModelCallReports();
  const hooks = anthropicTerminalHooks(profile);
  // Generations produced by this invocation's renewal: a rejection of one of those is definitive.
  const renewed = new Set<number>();

  const terminal = createTerminal({
    policy: ANTHROPIC_INFERENCE_POLICY,
    get signal() {
      return options.signal();
    },
    deadlineMs: options.deadlineMs,
    credentials: anthropicCredentials(coordinator, scope),
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
    renewal: anthropicRenewal(coordinator, profile, (generation) => renewed.add(generation)),
  });

  return {
    model: createAnthropicModel({ model: options.binding.model, terminal }),
    modelCallSettled: () => scope.release(),
    reports,
  };
}
