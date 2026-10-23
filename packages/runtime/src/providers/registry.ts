// The explicit provider-binding registry: which (provider, auth mode) pairs exist, which request profiles an
// integration supports, and each provider's safe readiness. It is not a plugin system. Phase 1 knows exactly two
// pairs, both subscription access; no API-key mode exists, and nothing here consults ambient credentials.
import { type OperatorConfig, providerSettingsFor } from '../config/operator.ts';
import type { Provider, ProviderBinding } from '../records/schemas.ts';

export const SUPPORTED_PAIRS = Object.freeze([
  Object.freeze({ provider: 'anthropic', authMode: 'subscription' }),
  Object.freeze({ provider: 'openai', authMode: 'subscription' }),
] as const);

export type CredentialReadiness = 'ready' | 'reauthorization_required' | 'temporarily_unavailable';

/**
 * Safe readiness reported to the console and /readyz. `integration_unavailable` means the runtime cannot yet use
 * this provider at all (its integration is not delivered or not enabled); it is distinct from missing credentials.
 */
export type ProviderReadiness = 'unconfigured' | 'integration_unavailable' | CredentialReadiness;

/** Supplied by a delivered provider integration; none are registered until their blocks land. */
export interface ProviderIntegration {
  provider: Provider;
  /** Request profiles this integration implements. */
  profiles: ReadonlySet<string>;
  /** Credential state only; must not log in, refresh or send inference. */
  credentialReadiness(slot: string): Promise<CredentialReadiness>;
}

export type BindingResolution =
  | { ok: true; binding: ProviderBinding }
  | { ok: false; code: 'provider_unconfigured' | 'integration_unavailable' | 'profile_unsupported' };

export class ProviderRegistry {
  readonly #integrations: ReadonlyMap<Provider, ProviderIntegration>;

  constructor(
    private readonly config: OperatorConfig | undefined,
    integrations: readonly ProviderIntegration[] = [],
  ) {
    this.#integrations = new Map(integrations.map((integration) => [integration.provider, integration]));
  }

  /** The immutable binding a new run on this provider would snapshot, if the provider can be used. */
  resolve(provider: Provider): BindingResolution {
    const settings = this.config === undefined ? undefined : providerSettingsFor(this.config, provider);
    if (settings === undefined) return { ok: false, code: 'provider_unconfigured' };
    const integration = this.#integrations.get(provider);
    if (integration === undefined) return { ok: false, code: 'integration_unavailable' };
    if (!integration.profiles.has(settings.profileId)) return { ok: false, code: 'profile_unsupported' };
    return {
      ok: true,
      binding: Object.freeze({
        provider,
        authMode: settings.authMode,
        model: settings.model,
        profileId: settings.profileId,
        credentialSlot: settings.credentialSlot,
      }),
    };
  }

  /**
   * The binding a paused run was started with, if it can still be used. Unlike resolve(), it never consults the
   * current configuration's defaults: a changed default model leaves the stored one in force, and a binding that
   * can no longer be constructed is refused rather than replaced.
   */
  reconstruct(stored: ProviderBinding): BindingResolution {
    const supported = SUPPORTED_PAIRS.some(
      (pair) => pair.provider === stored.provider && pair.authMode === stored.authMode,
    );
    const integration = this.#integrations.get(stored.provider);
    if (!supported || integration === undefined) return { ok: false, code: 'integration_unavailable' };
    if (!integration.profiles.has(stored.profileId)) return { ok: false, code: 'profile_unsupported' };
    return { ok: true, binding: Object.freeze({ ...stored }) };
  }

  async readiness(provider: Provider): Promise<ProviderReadiness> {
    const resolution = this.resolve(provider);
    if (!resolution.ok) {
      return resolution.code === 'provider_unconfigured' ? 'unconfigured' : 'integration_unavailable';
    }
    const integration = this.#integrations.get(provider);
    if (integration === undefined) return 'integration_unavailable';
    try {
      return await integration.credentialReadiness(resolution.binding.credentialSlot);
    } catch {
      return 'temporarily_unavailable';
    }
  }
}
