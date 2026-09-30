// The provider assembly the service composes: the registry of integrations usable now, with their credential
// readiness, and the model wiring for one invocation of a run's stored binding. Anthropic is registered; OpenAI
// stays `integration_unavailable` until its authorization exists. One credential screen covers every request the
// service makes, so the content policy it supplies screens all generations in use.
import { PROFILE_IDS } from '@agent-runtime/anthropic-subscription';
import type { OperatorConfig } from '../config/operator.ts';
import { DEFAULT_MODEL_REQUEST_DEADLINE_SECONDS } from '../config/operator.ts';
import { CredentialCoordinator } from '../credentials/coordinator.ts';
import { CredentialScreen } from '../credentials/screening.ts';
import { CredentialStore } from '../credentials/store.ts';
import type { RequestAdmission } from '../execution/terminal.ts';
import type { ProviderBinding } from '../records/schemas.ts';
import { type ContentPolicy, createContentPolicy } from '../security/content-policy.ts';
import { type WiredModel, wireAnthropicInvocation } from './anthropic/binding.ts';
import { anthropicIssuer, createAnthropicAuthTransport } from './anthropic/credentials.ts';
import { type ProviderIntegration, ProviderRegistry } from './registry.ts';

export interface ProviderAssemblyOptions {
  config: OperatorConfig | undefined;
  stateDir: string;
  /** Inference and token transports; Bun's fetch unless a test injects a witness. */
  inferenceTransport?: typeof fetch;
  authTransport?: typeof fetch;
  now?: () => number;
}

export interface InvocationRequest {
  /** The run's stored binding — never the current defaults. */
  binding: ProviderBinding;
  admission: RequestAdmission;
  signal: () => AbortSignal;
  track: (work: Promise<unknown>) => void;
}

export type Unwired = { unavailable: 'integration_unavailable' | 'profile_unsupported' };

export interface ProviderAssembly {
  registry: ProviderRegistry;
  contentPolicy(): ContentPolicy;
  wire(request: InvocationRequest): WiredModel | Unwired;
}

export function createProviderAssembly(options: ProviderAssemblyOptions): ProviderAssembly {
  const store = CredentialStore.forStateDir(options.stateDir);
  const screen = new CredentialScreen();
  const auth = createAnthropicAuthTransport(options.authTransport);
  const now = options.now ?? Date.now;
  const coordinators = new Map<string, CredentialCoordinator>();
  const anthropicCoordinator = (slot: string) => {
    let coordinator = coordinators.get(slot);
    if (coordinator === undefined) {
      coordinator = new CredentialCoordinator({
        store,
        provider: 'anthropic',
        slot,
        issuer: anthropicIssuer({ transport: auth, now }),
        now,
      });
      coordinators.set(slot, coordinator);
    }
    return coordinator;
  };

  const anthropic: ProviderIntegration = {
    provider: 'anthropic',
    profiles: new Set(PROFILE_IDS),
    // Reads the stored record only: readiness never logs in, refreshes or sends inference.
    async credentialReadiness(slot) {
      const read = await store.read('anthropic', slot);
      if (read.kind === 'record' && read.record.lifecycle === 'usable') return 'ready';
      if (read.kind === 'unsafe') return 'temporarily_unavailable';
      return 'reauthorization_required';
    },
  };
  const registry = new ProviderRegistry(options.config, [anthropic]);
  const deadlineMs = (options.config?.modelRequestDeadlineSeconds ?? DEFAULT_MODEL_REQUEST_DEADLINE_SECONDS) * 1000;

  return {
    registry,
    contentPolicy: () => createContentPolicy(screen.matcher()),
    wire(request) {
      const resolved = registry.reconstruct(request.binding);
      if (!resolved.ok) {
        return {
          unavailable: resolved.code === 'profile_unsupported' ? 'profile_unsupported' : 'integration_unavailable',
        };
      }
      const { binding } = resolved;
      switch (binding.provider) {
        case 'anthropic':
          return wireAnthropicInvocation({
            binding,
            coordinator: anthropicCoordinator(binding.credentialSlot),
            screen,
            admission: request.admission,
            signal: request.signal,
            track: request.track,
            deadlineMs,
            ...(options.inferenceTransport === undefined ? {} : { transport: options.inferenceTransport }),
          });
        case 'openai':
          return { unavailable: 'integration_unavailable' };
      }
    },
  };
}
