// Operator authorization commands, run inside the runtime image from the owner's private terminal:
//
//   auth anthropic login  [--slot <slot>]   open the printed URL on any device, then paste the code back
//   auth anthropic status [--slot <slot>]   the slot's state; never refreshes, never prints token values
//
// The slot defaults to the configured provider's credential slot, else `default`. Output is safe status only.
import { parseArgs } from 'node:util';
import { type AuthFailureReason, beginLogin } from '@agent-runtime/anthropic-subscription';
import { providerSettingsFor } from '../config/operator.ts';
import { loadConfig, withOperatorConfig } from '../config.ts';
import { CredentialCoordinator, type CredentialState } from '../credentials/coordinator.ts';
import { CredentialLockError } from '../credentials/lock.ts';
import { slotSchema } from '../credentials/record.ts';
import { CredentialStore } from '../credentials/store.ts';
import {
  anthropicIssuer,
  createAnthropicAuthTransport,
  LoginFailed,
  loginAnthropic,
} from '../providers/anthropic/credentials.ts';

export interface AuthCommandIo {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** One line typed or pasted by the owner. */
  readLine(signal: AbortSignal): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

const USAGE = 'usage: auth anthropic <login|status> [--slot <slot>]';

const LOGIN_FAILURES: Record<AuthFailureReason, string> = {
  state_mismatch: 'The pasted code belongs to a different login attempt. Run the login again and use its URL.',
  invalid_input: 'That does not look like an authorization code. Paste the whole code shown after authorizing.',
  rejected: 'Anthropic refused the code. It may have expired or already been used; run the login again.',
  throttled: 'Anthropic is limiting authorization requests. Wait a little, then run the login again.',
  not_sent: 'The authorization service could not be reached. Check connectivity, then run the login again.',
  outcome_unknown: 'The authorization did not complete. Run the login again.',
  aborted: 'The login was cancelled.',
};

function describe(state: CredentialState, now: number): string {
  switch (state.kind) {
    case 'ready': {
      const minutes = Math.floor((state.credential.expiresAtMs - now) / 60_000);
      const expiry = new Date(state.credential.expiresAtMs).toISOString();
      return minutes > 0
        ? `ready (generation ${state.credential.generation}; access expires ${expiry}, in ${minutes} min; it renews automatically)`
        : `ready (generation ${state.credential.generation}; access expired ${expiry}; it renews on next use)`;
    }
    case 'unconfigured':
      return 'not authorized: run `auth anthropic login`';
    case 'reauthorization_required':
      return 'authorization is no longer usable: run `auth anthropic login`';
    case 'temporarily_unavailable':
      return 'credential storage is not private or not readable; see troubleshooting in the README';
  }
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
  if (provider !== 'anthropic' || (action !== 'login' && action !== 'status') || extra.length > 0) {
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
    (config.operator === undefined ? undefined : providerSettingsFor(config.operator, 'anthropic')?.credentialSlot) ??
    'default';
  if (!slotSchema.safeParse(slot).success) {
    io.err('invalid --slot: use lowercase letters, digits, "-" and "_"');
    return 2;
  }

  const now = io.now ?? Date.now;
  const store = CredentialStore.forStateDir(config.stateDir);
  const transport = createAnthropicAuthTransport(io.fetch);
  const coordinator = new CredentialCoordinator({
    store,
    provider: 'anthropic',
    slot,
    issuer: anthropicIssuer({ transport, now }),
    now,
  });
  const label = `anthropic/${slot}`;

  if (action === 'status') {
    const read = await store.read('anthropic', slot);
    const state: CredentialState =
      read.kind === 'missing'
        ? { kind: 'unconfigured' }
        : read.kind === 'unsafe'
          ? { kind: 'temporarily_unavailable' }
          : read.kind === 'invalid' || read.record.lifecycle !== 'usable'
            ? { kind: 'reauthorization_required' }
            : { kind: 'ready', credential: read.record };
    io.out(`${label}: ${describe(state, now())}`);
    return state.kind === 'ready' ? 0 : 1;
  }

  const flow = await beginLogin();
  try {
    const state = await loginAnthropic({
      coordinator,
      transport,
      flow,
      now,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      readCode: async (signal) => {
        io.out('Open this URL in a browser on any device and sign in with your Claude Pro/Max account:');
        io.out('');
        io.out(flow.authorizationUrl);
        io.out('');
        io.out('Then paste the authorization code shown there and press Enter:');
        return io.readLine(signal);
      },
    });
    io.out(`${label}: ${describe(state, now())}`);
    return state.kind === 'ready' ? 0 : 1;
  } catch (error) {
    if (error instanceof LoginFailed) io.err(LOGIN_FAILURES[error.reason]);
    else if (error instanceof CredentialLockError)
      io.err(
        'Another authorization or renewal for this provider is in progress, or credential storage is not private.',
      );
    else io.err('The authorization could not be stored. Nothing was changed.');
    return 1;
  }
}
