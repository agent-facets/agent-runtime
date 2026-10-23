// Child process for credential coordination tests. Synthetic credentials and a fake issuer only; every issuer
// call is appended to an independent witness file (O_APPEND), so the parent can count real refreshes.
import { appendFileSync } from 'node:fs';
import { CredentialCoordinator, type CredentialIssuer } from '../../src/credentials/coordinator.ts';
import { CredentialStore } from '../../src/credentials/store.ts';

const [root, action, witness, issuerDelayMs = '0', callers = '1', lockWaitMs = '5000'] = process.argv.slice(2);
if (root === undefined || action === undefined || witness === undefined) throw new Error('usage');

const issuer: CredentialIssuer = {
  async refresh(current) {
    appendFileSync(witness, `refresh ${process.pid} ${current.generation}\n`);
    await Bun.sleep(Number(issuerDelayMs));
    // The refresh token is omitted, as issuers routinely do; the stored one must be preserved.
    return {
      kind: 'refreshed',
      credential: {
        accessToken: `synthetic-access-${process.pid}-${current.generation + 1}`,
        expiresAtMs: Date.now() + 3_600_000,
      },
    };
  },
};

const coordinator = new CredentialCoordinator({
  store: new CredentialStore(root),
  provider: 'openai',
  slot: 'default',
  issuer,
  lockWaitMs: Number(lockWaitMs),
});

process.stdout.write('ready\n');
let results: unknown[];
if (action === 'current') {
  results = await Promise.all(Array.from({ length: Number(callers) }, () => coordinator.current()));
} else if (action === 'authorize') {
  results = [
    await coordinator
      .authorize(
        async () => {
          appendFileSync(witness, `authorize ${process.pid}\n`);
          await Bun.sleep(Number(issuerDelayMs));
          return {
            accessToken: `login-access-token-${process.pid}`,
            refreshToken: `login-refresh-token-${process.pid}`,
            expiresAtMs: Date.now() + 3_600_000,
            account: { accountId: 'acct_login' },
          };
        },
        { lockWaitMs: Number(lockWaitMs) },
      )
      .catch((error: { code?: string }) => ({ kind: `error:${error.code}` })),
  ];
} else if (action === 'hold') {
  // Holds the provider lock (via a slow authorization) until killed or stopped.
  results = [
    await coordinator.authorize(() => {
      process.stdout.write('locked\n');
      return new Promise(() => {});
    }),
  ];
} else throw new Error(`unknown action ${action}`);
process.stdout.write(`${JSON.stringify(results)}\n`);
