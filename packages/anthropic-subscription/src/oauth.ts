// Derived from @ex-machina/opencode-anthropic-auth src/constants.ts (revision 156cb66); see PROVENANCE.md.
// Only the subscription (Claude Pro/Max) authorization is kept; the console (API-key) login is not (D8).

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CODE_CALLBACK_URL = 'https://platform.claude.com/oauth/code/callback';

/** The token endpoint: the only destination of exchange and refresh requests. */
export const TOKEN_ENDPOINT = Object.freeze({
  origin: 'https://platform.claude.com',
  path: '/v1/oauth/token',
  method: 'POST',
} as const);
export const TOKEN_URL = `${TOKEN_ENDPOINT.origin}${TOKEN_ENDPOINT.path}`;

/**
 * The upstream scope list, unchanged for consent parity. `org:create_api_key` is requested because the reference
 * client requests it; nothing in this runtime creates an API key (D8).
 */
export const OAUTH_SCOPES = Object.freeze([
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]);

/** The client identification the reference sends on token requests. */
export const TOKEN_REQUEST_HEADERS = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json, text/plain, */*',
  'user-agent': 'axios/1.13.6',
});
