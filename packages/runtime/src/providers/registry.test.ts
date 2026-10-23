import { describe, expect, test } from 'bun:test';
import { parseOperatorConfig } from '../config/operator.ts';
import { providerBindingSchema } from '../records/schemas.ts';
import { type ProviderIntegration, ProviderRegistry, SUPPORTED_PAIRS } from './registry.ts';

const config = parseOperatorConfig(
  JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main', root: '/workspace' },
    providers: { anthropic: { authMode: 'subscription', model: 'owner-model', profileId: 'anthropic-sub' } },
    defaultProvider: 'anthropic',
  }),
  { stateDir: '/var/lib/agent-runtime', configFile: '/etc/agent-runtime/config.json' },
);

const integration = (overrides: Partial<ProviderIntegration> = {}): ProviderIntegration => ({
  provider: 'anthropic',
  profiles: new Set(['anthropic-sub']),
  credentialReadiness: async () => 'ready',
  ...overrides,
});

describe('provider registry', () => {
  test('knows exactly the two subscription pairs', () => {
    expect(SUPPORTED_PAIRS).toEqual([
      { provider: 'anthropic', authMode: 'subscription' },
      { provider: 'openai', authMode: 'subscription' },
    ]);
  });

  test('without a delivered integration, a configured provider is unavailable rather than missing credentials', async () => {
    const registry = new ProviderRegistry(config);
    expect(registry.resolve('anthropic')).toEqual({ ok: false, code: 'integration_unavailable' });
    expect(await registry.readiness('anthropic')).toBe('integration_unavailable');
    expect(await registry.readiness('openai')).toBe('unconfigured');
    expect(await new ProviderRegistry(undefined).readiness('anthropic')).toBe('unconfigured');
  });

  test('resolves an immutable binding snapshot for a supported profile', () => {
    const resolution = new ProviderRegistry(config, [integration()]).resolve('anthropic');
    if (!resolution.ok) throw new Error(resolution.code);
    expect(providerBindingSchema.parse(resolution.binding)).toEqual({
      provider: 'anthropic',
      authMode: 'subscription',
      model: 'owner-model',
      profileId: 'anthropic-sub',
      credentialSlot: 'default',
    });
    expect(Object.isFrozen(resolution.binding)).toBe(true);
  });

  test('a stored binding is reconstructed as stored, never replaced by current defaults', () => {
    const stored = {
      provider: 'anthropic',
      authMode: 'subscription',
      model: 'model-the-run-started-with',
      profileId: 'anthropic-sub',
      credentialSlot: 'default',
    } as const;
    const registry = new ProviderRegistry(config, [integration()]);
    expect(registry.reconstruct(stored)).toEqual({ ok: true, binding: stored });
    expect(registry.resolve('anthropic')).toMatchObject({ ok: true, binding: { model: 'owner-model' } });
    expect(registry.reconstruct({ ...stored, profileId: 'retired-profile' })).toEqual({
      ok: false,
      code: 'profile_unsupported',
    });
    expect(new ProviderRegistry(config).reconstruct(stored)).toEqual({ ok: false, code: 'integration_unavailable' });
    expect(registry.reconstruct({ ...stored, provider: 'openai' })).toEqual({
      ok: false,
      code: 'integration_unavailable',
    });
  });

  test('refuses a profile the integration does not implement before any dispatch', () => {
    const registry = new ProviderRegistry(config, [integration({ profiles: new Set(['other']) })]);
    expect(registry.resolve('anthropic')).toEqual({ ok: false, code: 'profile_unsupported' });
  });

  test('reports credential readiness and treats readiness errors as temporary', async () => {
    const states = ['ready', 'reauthorization_required', 'temporarily_unavailable'] as const;
    for (const state of states) {
      const registry = new ProviderRegistry(config, [integration({ credentialReadiness: async () => state })]);
      expect(await registry.readiness('anthropic')).toBe(state);
    }
    const failing = new ProviderRegistry(config, [
      integration({
        credentialReadiness: async () => {
          throw new Error('boom');
        },
      }),
    ]);
    expect(await failing.readiness('anthropic')).toBe('temporarily_unavailable');
  });

  test('ambient API keys cannot select a provider, mode or binding', () => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-synthetic-ambient';
    process.env.OPENAI_API_KEY = 'sk-synthetic-ambient';
    try {
      const registry = new ProviderRegistry(config, [integration()]);
      expect(registry.resolve('openai')).toEqual({ ok: false, code: 'provider_unconfigured' });
      const resolution = registry.resolve('anthropic');
      expect(JSON.stringify(resolution)).not.toContain('synthetic-ambient');
      if (resolution.ok) expect(resolution.binding.authMode).toBe('subscription');
    } finally {
      if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.o;
    }
  });
});
