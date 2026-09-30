import { describe, expect, test } from 'bun:test';
import { createContentPolicy, REDACTION, screenOwnerInput } from './content-policy.ts';

// Synthetic credentials only. The "live" value stands in for a token held by the credential boundary.
const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy({ values: () => [LIVE, 'short'] });

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

  test('ignores known values too short to match safely', () => {
    expect(policy.detect('a short word')).toBeUndefined();
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
