import { describe, expect, test } from 'bun:test';
import { createContentPolicy } from '../security/content-policy.ts';
import { CredentialScreen } from './screening.ts';

const generation = (n: number, provider: 'anthropic' | 'openai' = 'anthropic') => ({
  provider,
  slot: 'default',
  generation: n,
  accessToken: `synthetic-access-${provider}-${n}-token`,
  refreshToken: `synthetic-refresh-${provider}-${n}-token`,
});

describe('credential screen', () => {
  test('a generation is screened as soon as it is observed, and earlier ones stay screened', () => {
    const screen = new CredentialScreen();
    const policy = () => createContentPolicy(screen.matcher());
    expect(policy().detect(generation(1).accessToken)).toBeUndefined();
    screen.observe(generation(1));
    expect(policy().detect(`x ${generation(1).accessToken} y`)).toBe('known_credential');
    expect(policy().detect(generation(1).refreshToken)).toBe('known_credential');
    screen.observe(generation(2));
    for (const value of [generation(1).accessToken, generation(2).accessToken, generation(2).refreshToken]) {
      expect(policy().detect(value)).toBe('known_credential');
    }
  });

  test('generations of each provider are kept separately, and only the oldest beyond the bound is dropped', () => {
    const screen = new CredentialScreen(3);
    screen.observe(generation(1));
    screen.observe(generation(1, 'openai'));
    screen.observe(generation(2));
    screen.observe(generation(2));
    expect(createContentPolicy(screen.matcher()).detect(generation(1).accessToken)).toBe('known_credential');
    screen.observe(generation(3));
    const policy = createContentPolicy(screen.matcher());
    expect(policy.detect(generation(1).accessToken)).toBeUndefined();
    for (const value of [generation(1, 'openai').accessToken, generation(2).accessToken, generation(3).accessToken]) {
      expect(policy.detect(value)).toBe('known_credential');
    }
  });

  test('the screen exposes only matchers', () => {
    const screen = new CredentialScreen();
    screen.observe(generation(1));
    expect(Object.keys(screen)).toEqual([]);
    expect(JSON.stringify(screen)).not.toContain('synthetic');
    expect(JSON.stringify(screen.matcher())).not.toContain('synthetic');
  });
});
