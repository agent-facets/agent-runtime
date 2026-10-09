import { describe, expect, test } from 'bun:test';
import { validateRuntimeMetadata } from './metadata.ts';

describe('runtime metadata profile', () => {
  test('accepts version 1 with each kind of supported field', () => {
    expect(
      validateRuntimeMetadata('command', {
        name: 'run',
        description: 'Run it',
        runtimeVersion: 1,
        requires: [
          { kind: 'skill', name: 'guide' },
          { kind: 'agent', facet: '@team/tools', name: 'helper' },
          { kind: 'native', name: 'mcp_Read' },
        ],
        restrict: { native: ['mcp_Read'], skills: [], agents: [{ name: 'helper' }] },
      }),
    ).toEqual({
      ok: true,
      description: 'Run it',
      runtime: {
        runtimeVersion: 1,
        arguments: { required: false },
        requires: [
          { kind: 'skill', name: 'guide' },
          { kind: 'agent', facet: '@team/tools', name: 'helper' },
          { kind: 'native', name: 'mcp_Read' },
        ],
        restrict: { native: ['mcp_Read'], skills: [], agents: [{ name: 'helper' }] },
      },
    });
    expect(validateRuntimeMetadata('skill', { runtimeVersion: 1 })).toEqual({
      ok: true,
      description: '',
      runtime: { runtimeVersion: 1, requires: [] },
    });
  });

  test('refuses fields belonging to another kind and malformed references', () => {
    expect(validateRuntimeMetadata('agent', { runtimeVersion: 1, arguments: { required: true } })).toEqual({
      ok: false,
      reason: 'unsupported_field',
      fields: ['arguments'],
    });
    for (const requires of [
      [{ kind: 'native', name: 'shell' }],
      [{ kind: 'skill', name: '../escape' }],
      [{ kind: 'skill', name: 'guide', extra: true }],
      [{ kind: 'prose', text: 'needs the guide' }],
    ]) {
      expect(validateRuntimeMetadata('skill', { runtimeVersion: 1, requires })).toEqual({
        ok: false,
        reason: 'invalid_field',
        fields: ['requires'],
      });
    }
    expect(validateRuntimeMetadata('command', { runtimeVersion: 1, restrict: { shell: ['*'] } }).ok).toBe(false);
  });

  test('an agent cannot permit further delegation, but may deny it', () => {
    expect(validateRuntimeMetadata('agent', { runtimeVersion: 1, restrict: { agents: [{ name: 'x' }] } })).toEqual({
      ok: false,
      reason: 'nested_delegation_unsupported',
      fields: ['restrict'],
    });
    expect(validateRuntimeMetadata('agent', { runtimeVersion: 1, restrict: { agents: [] } }).ok).toBe(true);
  });
});
