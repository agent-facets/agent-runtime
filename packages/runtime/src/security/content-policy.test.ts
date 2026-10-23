import { describe, expect, test } from 'bun:test';
import { exactSecretMatcher, NO_KNOWN_CREDENTIALS } from '../credentials/matcher.ts';
import { createContentPolicy, REDACTION, screenOwnerInput } from './content-policy.ts';

// Synthetic credentials only. The "live" value stands in for a token held by the credential boundary.
const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy(exactSecretMatcher([LIVE]));

const SAMPLES: Record<string, string> = {
  anthropic_key: 'sk-ant-oat01-SyntheticSyntheticSynthetic0123456789_-AA',
  openai_key: 'sk-proj-SyntheticSyntheticSyntheticSyntheticSynthetic0123',
  github_token: 'ghp_SyntheticSyntheticSyntheticSynthetic01',
  slack_token: 'xoxb-1234567890-synthetic-synthetic',
  private_key: '-----BEGIN OPENSSH PRIVATE KEY-----',
  bearer_token: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  known_credential: `token=${LIVE}`,
};

// Ordinary repository content that must pass through unchanged.
const FALSE_POSITIVES = [
  'const aVeryLongIdentifierNameThatGoesOnAndOn_WithUnderscores123 = 1;',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '00000000-0000-4000-8000-000000000001',
  'client_id = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"',
  'claude-sonnet-4-5 anthropic.subscription.v1 gpt-5-codex',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'const key = process.env.OPENAI_API_KEY;',
  'body.refresh_token = stored.refresh_token;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a source-code sample, not a template
  'headers.Authorization = `Bearer ${accessToken}`;',
  'Authorization: Bearer <token>',
  'export ANTHROPIC_API_KEY=sk-ant-...',
  'OPENAI_API_KEY="sk-your-key-here"',
  '```ts\nconst x = 1;\n```',
  '日本語のテキスト 😀 e\u0301',
  'src/components/very/long/path/to/a/file/in/the/repository/SomeComponent.test.tsx',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
];

describe('credential detection', () => {
  test('recognizes each supported credential format and exact live values', () => {
    for (const [rule, sample] of Object.entries(SAMPLES)) expect(policy.detect(`prefix ${sample} suffix`)).toBe(rule);
  });

  test('leaves ordinary code, identifiers, hashes, placeholders and non-ASCII text unchanged', () => {
    for (const text of FALSE_POSITIVES) {
      expect(policy.detect(text)).toBeUndefined();
      expect(policy.redact(text)).toBe(text);
    }
  });

  test('the exact matcher refuses values it could not safely recognize, rather than ignoring them', () => {
    for (const value of ['', 'short', 'x'.repeat(15), 'has a space in it here', 'x'.repeat(16_385)]) {
      expect(() => exactSecretMatcher([value])).toThrow(TypeError);
    }
    expect(exactSecretMatcher(['x'.repeat(16)]).spans(`a ${'x'.repeat(16)} b`)).toEqual([[2, 18]]);
  });

  test('requires a matcher from the credential boundary; there is no silent pattern-only default', () => {
    const forged = { spans: () => [] };
    expect(() => createContentPolicy(forged)).toThrow(TypeError);
    expect(() => createContentPolicy(undefined as never)).toThrow(TypeError);
    expect(createContentPolicy(NO_KNOWN_CREDENTIALS).detect(SAMPLES.github_token as string)).toBe('github_token');
  });

  test('the matcher exposes no way to enumerate its values', () => {
    const matcher = exactSecretMatcher([LIVE]);
    expect(Object.keys(matcher)).toEqual(['spans']);
    expect(JSON.stringify(matcher)).not.toContain('synthetic');
    expect(Object.isFrozen(matcher)).toBe(true);
  });

  test('masks a whole private-key block, and withholds a malformed one through the end', () => {
    const body = 'MIIEvSYNTHETICBODYLINE1\nMIIEvSYNTHETICBODYLINE2';
    const closed = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nafter`;
    const redacted = policy.redact(closed);
    expect(redacted).toBe(`before\n${REDACTION}\n${REDACTION}\n${REDACTION}\n${REDACTION}\nafter`);
    expect(redacted.split('\n')).toHaveLength(closed.split('\n').length);
    const crlf = closed.replaceAll('\n', '\r\n');
    expect(policy.redact(crlf)).toBe(redacted.replaceAll('\n', '\r\n'));

    for (const malformed of [
      `a\n-----BEGIN PRIVATE KEY-----\n${body}\nstill secret`,
      `a\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nstill secret`,
      `a\n-----BEGIN PRIVATE KEY-----\n${body}\n-----BEGIN CERTIFICATE-----\nx\n-----END PRIVATE KEY-----\nstill secret`,
    ]) {
      const result = policy.redact(malformed);
      expect(result.startsWith('a\n')).toBe(true);
      expect(result).not.toContain('SYNTHETIC');
      expect(result).not.toContain('still secret');
    }

    const two = `-----BEGIN PRIVATE KEY-----\nONE\n-----END PRIVATE KEY-----\nmid\n-----BEGIN EC PRIVATE KEY-----\nTWO\n-----END EC PRIVATE KEY-----`;
    expect(policy.redact(two)).toBe(
      [REDACTION, REDACTION, REDACTION, 'mid', REDACTION, REDACTION, REDACTION].join('\n'),
    );
  });

  test('overlapping credentials become one span, and redaction of separated credentials is idempotent', () => {
    const overlapping = createContentPolicy(exactSecretMatcher([LIVE, LIVE.slice(10)]));
    expect(overlapping.redact(`x ${LIVE} y`)).toBe(`x ${REDACTION} y`);
    for (const text of Object.values(SAMPLES)) {
      const once = policy.redact(text);
      expect(policy.detect(once)).toBeUndefined();
      expect(policy.redact(once)).toBe(once);
    }
  });

  test('a boundary-anchored format can become recognizable only after its neighbour is replaced', () => {
    // No word boundary precedes "ghp_" until the adjacent live credential becomes "]". Redaction is one pass;
    // callers must check the rendered result (sanitizeToolOutcome does) instead of redacting repeatedly.
    const adjacent = `${LIVE}${SAMPLES.github_token}`;
    expect(policy.detect(policy.redact(adjacent))).toBe('github_token');
  });

  test('redacts visibly, replacing every occurrence', () => {
    const text = `a ${SAMPLES.anthropic_key} b ${LIVE} c ${LIVE}`;
    const redacted = policy.redact(text);
    expect(redacted).toBe(`a ${REDACTION} b ${REDACTION} c ${REDACTION}`);
    expect(policy.detect(redacted)).toBeUndefined();
  });
});

describe('owner input screening', () => {
  test('refuses goals and answers containing credentials, including inside choice arrays, and echoes nothing', () => {
    for (const value of [`Use ${LIVE} to log in`, [false, SAMPLES.github_token], SAMPLES.private_key]) {
      const screened = screenOwnerInput(policy, value);
      expect(screened).toEqual({ ok: false, code: 'credential_in_input' });
      expect(JSON.stringify(screened)).not.toContain('synthetic');
    }
  });

  test('accepts ordinary input exactly, including false, null and empty values', () => {
    for (const value of ['Inspect README.md', false, null, '', 0, ['a', null], ...FALSE_POSITIVES]) {
      expect(screenOwnerInput(policy, value)).toEqual({ ok: true });
    }
  });
});
