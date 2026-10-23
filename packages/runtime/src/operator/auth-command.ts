// Operator authorization commands, run inside the runtime image from the owner's private terminal:
//
//   auth anthropic login  [--slot <slot>]   open the printed URL on any device, then paste the code back
//   auth openai login     [--slot <slot>]   open the printed page on any device and enter the printed code
//   auth <provider> status [--slot <slot>]  the slot's state; never refreshes, never prints token values
//   auth <provider> renew  [--slot <slot>]  renews the stored authorization once, now; no model request
//   auth mcp set <slot>                     stores an MCP server credential read from standard input
//   auth mcp status <slot>                  missing, present or unusable; never prints the value
//
// The slot defaults to the configured provider's credential slot, else `default`. Output is safe status only.
// `auth mcp set` needs the runtime stopped: it takes the runtime's singleton ownership (without migrating or claiming
// an epoch) and refuses while anything else holds it. The value takes effect when the runtime next starts.
import { parseArgs } from 'node:util';
import { type AuthFailureReason, beginLogin } from '@agent-runtime/anthropic-subscription';
import { providerSettingsFor } from '../config/operator.ts';
import { loadConfig, withOperatorConfig } from '../config.ts';
import { CredentialCoordinator, type CredentialIssuer, type CredentialState } from '../credentials/coordinator.ts';
import { CredentialLockError } from '../credentials/lock.ts';
import { McpCredentialStore, mcpSecretSchema } from '../credentials/mcp-store.ts';
import { CREDENTIAL_TOKEN_MAX_LENGTH, slotSchema } from '../credentials/record.ts';
import { CredentialStore, CredentialStoreError } from '../credentials/store.ts';
import { MaintenanceRefused, withMaintenanceOwnership } from '../persistence/maintenance.ts';
import {
  anthropicIssuer,
  createAnthropicAuthTransport,
  LoginFailed,
  loginAnthropic,
} from '../providers/anthropic/credentials.ts';
import type { OpenAIAuthFailureReason } from '../providers/openai/auth.ts';
import {
  beginOpenAILogin,
  completeOpenAILogin,
  createOpenAIAuthTransport,
  OpenAILoginFailed,
  openaiIssuer,
} from '../providers/openai/credentials.ts';
import type { Provider } from '../records/schemas.ts';

export interface AuthCommandIo {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** One line typed or pasted by the owner. */
  readLine(signal: AbortSignal): Promise<string>;
  /**
   * The whole of standard input, without one trailing line break, for a secret that must never appear in arguments.
   * Undefined when it exceeds `maxBytes` (the rest is not read) or is not UTF-8.
   */
  readSecret?(maxBytes: number, signal: AbortSignal): Promise<string | undefined>;
  /** Test seam: exclusive maintenance ownership of the configured database. */
  maintenance?: <T>(url: string, body: () => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test seam: the wait between device-login polls. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

const USAGE = 'usage: auth <anthropic|openai> <login|status|renew> [--slot <slot>] | auth mcp <set|status> <slot>';

const ANTHROPIC_LOGIN_FAILURES: Record<AuthFailureReason, string> = {
  state_mismatch: 'The pasted code belongs to a different login attempt. Run the login again and use its URL.',
  invalid_input: 'That does not look like an authorization code. Paste the whole code shown after authorizing.',
  rejected: 'Anthropic refused the code. It may have expired or already been used; run the login again.',
  throttled: 'Anthropic is limiting authorization requests. Wait a little, then run the login again.',
  not_sent: 'The authorization service could not be reached. Check connectivity, then run the login again.',
  outcome_unknown: 'The authorization did not complete. Run the login again.',
  aborted: 'The login was cancelled.',
};

const OPENAI_LOGIN_FAILURES: Record<OpenAIAuthFailureReason, string> = {
  aborted: 'The login was cancelled.',
  not_sent: 'The authorization service could not be reached. Check connectivity, then run the login again.',
  throttled: 'OpenAI is limiting authorization requests. Wait a little, then run the login again.',
  rejected: 'OpenAI refused the authorization. Run the login again.',
  denied: 'The sign-in was refused or abandoned. Run the login again.',
  expired: 'The code was not approved in time. Run the login again.',
  invalid_response: 'OpenAI answered with something this runtime cannot use. Run the login again.',
  outcome_unknown: 'The authorization did not complete. Run the login again.',
};

const NAMES: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

function describe(provider: Provider, state: CredentialState, now: number): string {
  switch (state.kind) {
    case 'ready': {
      const minutes = Math.floor((state.credential.expiresAtMs - now) / 60_000);
      const expiry = new Date(state.credential.expiresAtMs).toISOString();
      return minutes > 0
        ? `ready (generation ${state.credential.generation}; access expires ${expiry}, in ${minutes} min; it renews automatically)`
        : `ready (generation ${state.credential.generation}; access expired ${expiry}; it renews on next use)`;
    }
    case 'unconfigured':
      return `not authorized: run \`auth ${provider} login\``;
    case 'reauthorization_required':
      return `authorization is no longer usable: run \`auth ${provider} login\``;
    case 'temporarily_unavailable':
      return 'credential storage is not private or not readable; see troubleshooting in the README';
  }
}

function stateOf(read: Awaited<ReturnType<CredentialStore['read']>>): CredentialState {
  if (read.kind === 'missing') return { kind: 'unconfigured' };
  if (read.kind === 'unsafe') return { kind: 'temporarily_unavailable' };
  if (read.kind === 'invalid' || read.record.lifecycle !== 'usable') return { kind: 'reauthorization_required' };
  return { kind: 'ready', credential: read.record };
}

export async function runAuthCommand(argv: string[], io: AuthCommandIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { slot: { type: 'string' } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { slot: { type: 'string' } }, allowPositionals: true, strict: true });
  } catch {
    io.err(USAGE);
    return 2;
  }
  const [provider, action, ...extra] = parsed.positionals;
  if (provider === 'mcp') {
    const [slot, ...rest] = extra;
    if ((action !== 'set' && action !== 'status') || slot === undefined || rest.length > 0 || parsed.values.slot) {
      io.err(USAGE);
      return 2;
    }
    return runMcpCommand(action, slot, io);
  }
  if (
    (provider !== 'anthropic' && provider !== 'openai') ||
    (action !== 'login' && action !== 'status' && action !== 'renew') ||
    extra.length > 0
  ) {
    io.err(USAGE);
    return 2;
  }

  let config: Awaited<ReturnType<typeof withOperatorConfig>>;
  try {
    config = await withOperatorConfig(loadConfig(io.env));
  } catch (error) {
    io.err(
      `configuration problem: ${error instanceof Error && error.name === 'ConfigError' ? error.message : 'invalid'}`,
    );
    return 1;
  }
  const slot =
    parsed.values.slot ??
    (config.operator === undefined ? undefined : providerSettingsFor(config.operator, provider)?.credentialSlot) ??
    'default';
  if (!slotSchema.safeParse(slot).success) {
    io.err('invalid --slot: use lowercase letters, digits, "-" and "_"');
    return 2;
  }

  const now = io.now ?? Date.now;
  const store = CredentialStore.forStateDir(config.stateDir);
  const anthropicTransport = createAnthropicAuthTransport(io.fetch);
  const openaiTransport = createOpenAIAuthTransport(io.fetch);
  const issuer: CredentialIssuer =
    provider === 'anthropic'
      ? anthropicIssuer({ transport: anthropicTransport, now })
      : openaiIssuer({ transport: openaiTransport, now });
  const coordinator = new CredentialCoordinator({ store, provider, slot, issuer, now });
  const label = `${provider}/${slot}`;
  const signal = io.signal === undefined ? {} : { signal: io.signal };

  if (action === 'status') {
    const state = stateOf(await store.read(provider, slot));
    io.out(`${label}: ${describe(provider, state, now())}`);
    return state.kind === 'ready' ? 0 : 1;
  }

  if (action === 'renew') {
    const before = stateOf(await store.read(provider, slot));
    if (before.kind !== 'ready') {
      io.out(`${label}: ${describe(provider, before, now())}`);
      return 1;
    }
    // Refreshes whatever is current: one token request, and no model request.
    const after = await coordinator.refresh(io.signal === undefined ? {} : { signal: io.signal });
    if (after.kind === 'ready' && after.credential.generation > before.credential.generation) {
      io.out(`${label}: renewed (generation ${before.credential.generation} → ${after.credential.generation})`);
    } else {
      io.err(`${NAMES[provider]} did not renew the authorization.`);
    }
    io.out(`${label}: ${describe(provider, after, now())}`);
    return after.kind === 'ready' && after.credential.generation > before.credential.generation ? 0 : 1;
  }

  try {
    let state: CredentialState;
    if (provider === 'anthropic') {
      const flow = await beginLogin();
      state = await loginAnthropic({
        coordinator,
        transport: anthropicTransport,
        flow,
        now,
        ...signal,
        readCode: async (readSignal) => {
          io.out('Open this URL in a browser on any device and sign in with your Claude Pro/Max account:');
          io.out('');
          io.out(flow.authorizationUrl);
          io.out('');
          io.out('Then paste the authorization code shown there and press Enter:');
          return io.readLine(readSignal);
        },
      });
    } else {
      const session = await beginOpenAILogin({ transport: openaiTransport, now, ...signal });
      io.out('Open this page in a browser on any device and sign in with your ChatGPT account:');
      io.out('');
      io.out(session.verificationUrl);
      io.out('');
      io.out(`Then enter this code: ${session.userCode}`);
      io.out('Waiting for you to approve it (up to 15 minutes; Ctrl-C cancels)…');
      state = await completeOpenAILogin({
        coordinator,
        transport: openaiTransport,
        session,
        now,
        ...signal,
        ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
      });
    }
    io.out(`${label}: ${describe(provider, state, now())}`);
    return state.kind === 'ready' ? 0 : 1;
  } catch (error) {
    if (error instanceof LoginFailed) io.err(ANTHROPIC_LOGIN_FAILURES[error.reason]);
    else if (error instanceof OpenAILoginFailed) io.err(OPENAI_LOGIN_FAILURES[error.reason]);
    else if (error instanceof CredentialLockError)
      io.err(
        'Another authorization or renewal for this provider is in progress, or credential storage is not private.',
      );
    else io.err('The authorization could not be stored. Nothing was changed.');
    return 1;
  }
}

/** `auth mcp set|status <slot>`: no provider or MCP request is ever made, and nothing is deleted. */
async function runMcpCommand(action: 'set' | 'status', slot: string, io: AuthCommandIo): Promise<number> {
  if (!slotSchema.safeParse(slot).success) {
    io.err('invalid slot: use lowercase letters, digits, "-" and "_"');
    return 2;
  }
  let config: Awaited<ReturnType<typeof withOperatorConfig>>;
  try {
    config = await withOperatorConfig(loadConfig(io.env));
  } catch (error) {
    io.err(
      `configuration problem: ${error instanceof Error && error.name === 'ConfigError' ? error.message : 'invalid'}`,
    );
    return 1;
  }
  const store = McpCredentialStore.forStateDir(config.stateDir);
  const label = `mcp/${slot}`;

  if (action === 'status') {
    const read = await store.read(slot);
    const state = read.kind === 'present' ? 'present' : read.kind;
    io.out(`${label}: ${state}`);
    return read.kind === 'present' ? 0 : 1;
  }

  if (config.databaseUrl === undefined) {
    io.err('auth mcp set needs DATABASE_URL to confirm the runtime is stopped. Nothing was changed.');
    return 1;
  }
  if (io.readSecret === undefined) {
    io.err('auth mcp set reads the value from standard input. Nothing was changed.');
    return 1;
  }
  const signal = io.signal ?? new AbortController().signal;
  const value = await io.readSecret(CREDENTIAL_TOKEN_MAX_LENGTH, signal);
  if (value === undefined || !mcpSecretSchema.safeParse(value).success) {
    io.err(
      'The value must be 16 to 16384 printable ASCII characters without spaces, read from standard input. Nothing was changed.',
    );
    return 1;
  }
  try {
    await (io.maintenance ?? withMaintenanceOwnership)(config.databaseUrl, () => store.replace(slot, value));
  } catch (error) {
    if (error instanceof MaintenanceRefused) {
      io.err(
        error.reason === 'runtime_running'
          ? 'Stop the runtime first: it (or another maintenance command) owns the database. Nothing was changed.'
          : 'The database is unavailable, so the runtime cannot be confirmed stopped. Nothing was changed.',
      );
    } else if (error instanceof CredentialStoreError && error.code === 'unsafe_storage') {
      io.err('MCP credential storage is not private; see troubleshooting in the README. Nothing was changed.');
    } else {
      io.err(`The value could not be stored durably; check \`auth mcp status ${slot}\`.`);
    }
    return 1;
  }
  io.out(`${label}: present (takes effect when the runtime next starts)`);
  return 0;
}
