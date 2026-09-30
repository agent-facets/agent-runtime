import { describe, expect, test } from 'bun:test';
import { ConfigError, parseOperatorConfig, providerSettingsFor } from './operator.ts';

const context = { stateDir: '/var/lib/agent-runtime', configFile: '/etc/agent-runtime/config.json' };

const valid = {
  version: 1,
  workspace: { id: 'main', label: 'Main repository', root: '/workspace' },
  providers: {
    anthropic: { authMode: 'subscription', model: 'owner-selected-model', profileId: 'anthropic-subscription' },
  },
  defaultProvider: 'anthropic',
};

const parse = (value: unknown) => parseOperatorConfig(JSON.stringify(value), context);

function refused(value: unknown): string {
  try {
    parse(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('configuration was accepted');
}

describe('operator configuration', () => {
  test('accepts a minimal configuration and applies documented defaults', () => {
    const config = parse(valid);
    expect(config.stepBudget).toBe(50);
    expect(config.modelRequestDeadlineSeconds).toBe(300);
    expect(config.workspace.excludeNames).toEqual([]);
    expect(providerSettingsFor(config, 'anthropic')).toEqual({
      provider: 'anthropic',
      authMode: 'subscription',
      model: 'owner-selected-model',
      profileId: 'anthropic-subscription',
      credentialSlot: 'default',
    });
    expect(providerSettingsFor(config, 'openai')).toBeUndefined();
  });

  test('refuses authority-bearing and unknown settings, naming them without their values', () => {
    const secret = 'sk-ant-synthetic-value-0000';
    const cases: unknown[] = [
      { ...valid, apiKey: secret },
      { ...valid, providers: { anthropic: { ...valid.providers.anthropic, baseURL: 'https://gateway.invalid' } } },
      { ...valid, providers: { anthropic: { ...valid.providers.anthropic, apiKey: secret } } },
      { ...valid, workspace: { ...valid.workspace, tools: ['mcp_Write'] } },
      { ...valid, checkpointId: 'abc' },
    ];
    for (const value of cases) {
      const message = refused(value);
      expect(message).toStartWith('operator configuration: unsupported setting');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('gateway.invalid');
    }
    // A setting whose name is itself suspicious is not echoed.
    expect(refused({ ...valid, [secret]: true })).toBe('operator configuration: unsupported setting ?');
  });

  test('refuses unsupported auth modes, providers and model/profile shapes', () => {
    const anthropic = valid.providers.anthropic;
    for (const value of [
      { ...valid, providers: { anthropic: { ...anthropic, authMode: 'api_key' } } },
      { ...valid, providers: { 'anthropic-api': anthropic } },
      { ...valid, providers: { anthropic: { ...anthropic, model: '' } } },
      { ...valid, providers: { anthropic: { ...anthropic, profileId: 'Bad Profile' } } },
      { ...valid, providers: {} },
      { ...valid, defaultProvider: 'openai' },
      { ...valid, stepBudget: 0 },
      { ...valid, stepBudget: 1.5 },
      { ...valid, version: 2 },
    ]) {
      expect(() => parse(value)).toThrow(ConfigError);
    }
  });

  test('requires a normalized workspace root separate from private state and configuration', () => {
    for (const root of ['relative', '/', '/workspace/', '/work//space', '/workspace/../etc', '/work\u0001space']) {
      expect(() => parse({ ...valid, workspace: { ...valid.workspace, root } })).toThrow(ConfigError);
    }
    for (const root of ['/var/lib', '/var/lib/agent-runtime', '/var/lib/agent-runtime/credentials', '/etc']) {
      expect(() => parse({ ...valid, workspace: { ...valid.workspace, root } })).toThrow(ConfigError);
    }
    expect(parse({ ...valid, workspace: { ...valid.workspace, root: '/var/lib/agent-runtime-other' } })).toBeDefined();
  });

  test('exclusions are names and relative paths only', () => {
    const accepted = parse({
      ...valid,
      workspace: { ...valid.workspace, excludeNames: ['secrets.yaml'], excludePaths: ['ops/keys'] },
    });
    expect(accepted.workspace.excludePaths).toEqual(['ops/keys']);
    for (const workspace of [
      { ...valid.workspace, excludeNames: ['a/b'] },
      { ...valid.workspace, excludeNames: ['..'] },
      { ...valid.workspace, excludePaths: ['/etc'] },
      { ...valid.workspace, excludePaths: ['a/../b'] },
    ]) {
      expect(() => parse({ ...valid, workspace })).toThrow(ConfigError);
    }
  });

  test('the parsed configuration is immutable and independent of its source object', () => {
    const source = structuredClone(valid);
    const config = parseOperatorConfig(JSON.stringify(source), context);
    source.workspace.root = '/elsewhere';
    expect(config.workspace.root).toBe('/workspace');
    expect(Object.isFrozen(config.workspace)).toBe(true);
    expect(() => {
      (config.workspace as { root: string }).root = '/elsewhere';
    }).toThrow();
  });

  test('refuses malformed and oversized files', () => {
    expect(() => parseOperatorConfig('{', context)).toThrow('not valid JSON');
    expect(() => parseOperatorConfig(' '.repeat(65_537), context)).toThrow('too large');
  });
});
