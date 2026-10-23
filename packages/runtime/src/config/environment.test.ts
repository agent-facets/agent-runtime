import { describe, expect, test } from 'bun:test';
import { environmentProblems } from './environment.ts';

describe('environment guard', () => {
  test('refuses every enabled tracing spelling and fails closed on ambiguous values', () => {
    for (const variable of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2']) {
      for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'maybe', ' true ']) {
        expect(environmentProblems({ [variable]: value })).toEqual([{ variable, reason: 'tracing_enabled' }]);
      }
      for (const value of ['', 'false', 'FALSE', '0']) expect(environmentProblems({ [variable]: value })).toEqual([]);
    }
  });

  test('refuses conflicting current and legacy tracing flags', () => {
    expect(environmentProblems({ LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'true' })).toEqual([
      { variable: 'LANGCHAIN_TRACING_V2', reason: 'tracing_enabled' },
    ]);
  });

  test('refuses proxies in either case, endpoint overrides, TLS overrides and request logging', () => {
    const env = {
      https_proxy: 'http://proxy.invalid:3128',
      HTTP_PROXY: 'http://proxy.invalid:3128',
      all_proxy: 'socks5://proxy.invalid',
      ANTHROPIC_BASE_URL: 'https://gateway.invalid',
      OPENAI_BASE_URL: 'https://gateway.invalid',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
      ANTHROPIC_LOG: 'debug',
      OPENAI_LOG: 'info',
      BUN_CONFIG_VERBOSE_FETCH: 'curl',
      DEBUG: '*',
    };
    const problems = environmentProblems(env);
    expect(problems.map((problem) => problem.variable).sort()).toEqual(Object.keys(env).sort());
    expect(JSON.stringify(problems)).not.toContain('invalid');
  });

  test('refuses gateway routing and request identity overrides, but not a disabled gateway', () => {
    const env = {
      LANGSMITH_GATEWAY: 'true',
      OPENAI_ORGANIZATION: 'org-invalid',
      OPENAI_ORG_ID: 'org-invalid',
      OPENAI_PROJECT: 'proj-invalid',
      openai_project_id: 'proj-invalid',
    };
    expect(environmentProblems(env)).toEqual([
      { variable: 'LANGSMITH_GATEWAY', reason: 'endpoint_override' },
      { variable: 'OPENAI_ORGANIZATION', reason: 'request_override' },
      { variable: 'OPENAI_ORG_ID', reason: 'request_override' },
      { variable: 'OPENAI_PROJECT', reason: 'request_override' },
      { variable: 'openai_project_id', reason: 'request_override' },
    ]);
    for (const value of ['', 'false', '0', 'no']) expect(environmentProblems({ LANGSMITH_GATEWAY: value })).toEqual([]);
    expect(environmentProblems({ LANGSMITH_GATEWAY: 'https://gateway.invalid' })).toHaveLength(1);
  });

  test('permits harmless settings, and ignores ambient API keys', () => {
    expect(
      environmentProblems({
        NO_PROXY: 'localhost',
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        ANTHROPIC_LOG: 'warn',
        HTTPS_PROXY: '',
        ANTHROPIC_API_KEY: 'sk-ant-synthetic',
        OPENAI_API_KEY: 'sk-synthetic',
        PATH: '/usr/bin',
      }),
    ).toEqual([]);
  });
});
