// The provider assembly the service composes: the registry of integrations usable now, with their credential
// readiness, and the model wiring for one invocation of a run's stored binding. Anthropic is registered; OpenAI
// stays `integration_unavailable` until its authorization exists. One credential screen covers every request the
// service makes, so the content policy it supplies screens all generations in use.
import { PROFILE_IDS } from '@agent-runtime/anthropic-subscription';
import type { OperatorConfig } from '../config/operator.ts';
import { DEFAULT_MODEL_REQUEST_DEADLINE_SECONDS, providerSettingsFor } from '../config/operator.ts';
import { CredentialCoordinator } from '../credentials/coordinator.ts';
import { CredentialScreen, ownerInputMatcher } from '../credentials/screening.ts';
import { CredentialStore } from '../credentials/store.ts';
import type { RequestAdmission } from '../execution/terminal.ts';
import type { Provider, ProviderBinding } from '../records/schemas.ts';
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
  /**
   * The content policy owner input is screened with: every generation in use, plus the usable credentials stored
   * for each configured provider and the given bindings. Undefined when screening cannot be completed.
   */
  ownerInputPolicy(bindings?: readonly ProviderBinding[]): Promise<ContentPolicy | undefined>;
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
    async ownerInputPolicy(bindings = []) {
      const slots = new Map<string, { provider: Provider; slot: string }>();
      for (const provider of ['anthropic', 'openai'] as const) {
        const settings = options.config === undefined ? undefined : providerSettingsFor(options.config, provider);
        if (settings !== undefined)
          slots.set(`${provider}/${settings.credentialSlot}`, { provider, slot: settings.credentialSlot });
      }
      for (const binding of bindings) {
        slots.set(`${binding.provider}/${binding.credentialSlot}`, {
          provider: binding.provider,
          slot: binding.credentialSlot,
        });
      }
      const result = await ownerInputMatcher(screen, store, [...slots.values()]);
      return result.ok ? createContentPolicy(result.matcher) : undefined;
    },
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
