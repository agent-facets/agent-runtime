// Environment settings that could silently change where provider traffic goes, what it trusts, or where request
// contents are copied. Startup refuses them before any framework or provider module is loaded. Only variable
// names are reported, never values.
//
// Ambient API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) are deliberately not refused: nothing in the runtime
// reads them, bindings are selected only from operator configuration, and provider clients receive explicit
// credentials. Tests prove they cannot select a billed mode or reach a subscription request.

const FALSE_VALUES = new Set(['', '0', 'false']);

type Rule = { names: readonly string[]; allowed: (value: string) => boolean; reason: EnvironmentProblem['reason'] };

const RULES: readonly Rule[] = [
  {
    // Remote tracing would copy prompts, workspace content and results to a third party.
    names: ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2'],
    allowed: (value) => FALSE_VALUES.has(value.trim().toLowerCase()),
    reason: 'tracing_enabled',
  },
  {
    names: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'],
    allowed: (value) => value === '',
    reason: 'proxy_override',
  },
  {
    names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'],
    allowed: (value) => value === '',
    reason: 'endpoint_override',
  },
  {
    // Disabled verification or substituted trust roots would let an intermediary read credentials.
    names: ['NODE_TLS_REJECT_UNAUTHORIZED'],
    allowed: (value) => value === '' || value === '1',
    reason: 'tls_override',
  },
  {
    names: ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'],
    allowed: (value) => value === '',
    reason: 'tls_override',
  },
  {
    // These log full requests, including authorization headers.
    names: ['ANTHROPIC_LOG', 'OPENAI_LOG'],
    allowed: (value) => ['', 'off', 'error', 'warn'].includes(value.trim().toLowerCase()),
    reason: 'debug_logging',
  },
  {
    names: ['BUN_CONFIG_VERBOSE_FETCH', 'DEBUG'],
    allowed: (value) => FALSE_VALUES.has(value.trim().toLowerCase()),
    reason: 'debug_logging',
  },
];

export interface EnvironmentProblem {
  variable: string;
  reason: 'tracing_enabled' | 'proxy_override' | 'endpoint_override' | 'tls_override' | 'debug_logging';
}

/** Names are matched case-insensitively: proxy variables in particular are honored in either case. */
export function environmentProblems(env: Record<string, string | undefined>): EnvironmentProblem[] {
  const problems: EnvironmentProblem[] = [];
  for (const [variable, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = variable.toUpperCase();
    const rule = RULES.find((candidate) => candidate.names.includes(upper));
    if (rule !== undefined && !rule.allowed(value)) problems.push({ variable, reason: rule.reason });
  }
  return problems.sort((a, b) => (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0));
}
