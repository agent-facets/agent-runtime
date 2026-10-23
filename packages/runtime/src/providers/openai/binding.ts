// One invocation of a run bound to OpenAI subscription access: the stock model, its guarded terminal (with the run's
// durable admission and tracked work), failure classification, the one renewal retry, the screening scope, the
// parsed-response check and the tool-name translation the model boundary consumes. This is the OpenAI adapter's execution root: its closure is part
// of the execution definition of runs bound to OpenAI.
import type { CredentialCoordinator } from '../../credentials/coordinator.ts';
import { type CredentialScreen, ScreenScope } from '../../credentials/screening.ts';
import { ModelCallReports } from '../../execution/failures.ts';
import { createTerminal, type RequestAdmission } from '../../execution/terminal.ts';
import type { ProviderBinding } from '../../records/schemas.ts';
import type { WiredModel } from '../model.ts';
import { toolNameTranslation } from '../tool-names.ts';
import {
  classifyOpenAIError,
  createOpenAIModel,
  OPENAI_INFERENCE_POLICY,
  OPENAI_PROFILE_IDS,
  OPENAI_TOOL_NAME,
  openaiCredentials,
  openaiRenewal,
  openaiResponseRefusal,
} from './inference.ts';

export interface OpenAIInvocation {
  binding: ProviderBinding;
  /** The run: the conversation identity its requests carry. */
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
}

export function wireOpenAIInvocation(options: OpenAIInvocation): WiredModel | { unavailable: 'profile_unsupported' } {
  if (!OPENAI_PROFILE_IDS.includes(options.binding.profileId)) return { unavailable: 'profile_unsupported' };
  const { coordinator } = options;
  const scope = new ScreenScope(options.screen);
  const reports = new ModelCallReports();
  // Generations produced by this invocation's renewal: a rejection of one of those is definitive.
  const renewed = new Set<number>();

  const terminal = createTerminal({
    policy: OPENAI_INFERENCE_POLICY,
    get signal() {
      return options.signal();
    },
    deadlineMs: options.deadlineMs,
    credentials: openaiCredentials(coordinator, scope),
    admission: options.admission,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    track: options.track,
    failures: {
      classify(status, headers, body) {
        const retryAfter = headers.get('retry-after') ?? undefined;
        return { code: classifyOpenAIError(status, body), ...(retryAfter === undefined ? {} : { retryAfter }) };
      },
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
    model: createOpenAIModel({ model: options.binding.model, terminal, conversationId: options.runId }),
    modelCallSettled: () => scope.release(),
    reports,
    responseRefusal: openaiResponseRefusal,
    toolNames: toolNameTranslation((name) => OPENAI_TOOL_NAME.test(name)),
  };
}
