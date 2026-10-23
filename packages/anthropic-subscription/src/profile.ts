// Derived from @ex-machina/opencode-anthropic-auth src/constants.ts (revision 156cb66); see PROVENANCE.md.
// A request profile is an explicit, immutable value selected by ID (D6). A changed client version, beta set,
// identity or billing rule is a new profile with a new ID, never an edit of an existing one, so a paused run keeps
// the profile it started with or is refused visibly.

export interface SubscriptionProfile {
  readonly id: string;
  /** The Claude Code version reported in the user agent and the billing block; they must agree. */
  readonly clientVersion: string;
  readonly entrypoint: string;
  readonly userAgent: string;
  /** Sent first, in this order, followed by any other betas the request carries. */
  readonly requiredBetas: readonly string[];
  /** The first system block after the billing block. */
  readonly identity: string;
  readonly origin: string;
  readonly path: string;
  /** Tool names the profile accepts: the reference client's PascalCase-after-prefix convention (D1). */
  readonly toolName: RegExp;
}

const formatUserAgent = (version: string) => `claude-cli/${version} (external, cli)`;

export const CLAUDE_CLI_2_1_280: SubscriptionProfile = Object.freeze({
  id: 'claude-cli-2.1.280',
  clientVersion: '2.1.280',
  entrypoint: 'sdk-cli',
  userAgent: formatUserAgent('2.1.280'),
  requiredBetas: Object.freeze(['oauth-2025-04-20', 'interleaved-thinking-2025-05-14']),
  identity: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  origin: 'https://api.anthropic.com',
  path: '/v1/messages',
  toolName: /^mcp_[A-Z][A-Za-z0-9_]*$/,
});

const PROFILES: ReadonlyMap<string, SubscriptionProfile> = new Map([[CLAUDE_CLI_2_1_280.id, CLAUDE_CLI_2_1_280]]);

/** Profile IDs this package implements. */
export const PROFILE_IDS: readonly string[] = Object.freeze([...PROFILES.keys()]);

export function profileFor(id: string): SubscriptionProfile | undefined {
  return PROFILES.get(id);
}
