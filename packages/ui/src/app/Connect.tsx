// Connecting Anthropic from the console: open Anthropic's sign-in in another tab, then paste the code it shows.
// The code lives only in this component's memory and goes only to the login endpoint; it is cleared as soon as it
// is submitted or the login is cancelled.
import type { AuthAttempt, ProviderReadiness } from '@agent-runtime/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ApiClient, ApiOutcome } from '../api/client.ts';
import { formatTime } from './format.ts';

const STATUS_POLL_MS = 1_500;

type Notice = { tone: 'ok' | 'error' | 'uncertain'; text: string } | undefined;

const UNREACHABLE = 'The runtime could not be reached. Try again.';

export function ConnectAnthropic({
  client,
  readiness,
  onConnected,
}: {
  client: ApiClient;
  readiness: ProviderReadiness;
  /** Called once a login has been stored, so the page can reload provider readiness. */
  onConnected: () => void;
}) {
  const [attempt, setAttempt] = useState<AuthAttempt | undefined>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const settle = useCallback(
    (outcome: ApiOutcome<AuthAttempt>, lostReply: string) => {
      if (outcome.ok) {
        const next = outcome.value;
        if (next.state === 'connected') {
          setAttempt(undefined);
          setNotice({ tone: 'ok', text: 'Connected. You can start tasks now.' });
          onConnected();
        } else if (next.state === 'awaiting_code' || next.state === 'completing') {
          setAttempt(next);
        } else {
          setAttempt(undefined);
          setNotice({
            tone: 'error',
            text:
              next.failure?.message ??
              (next.state === 'expired' ? 'That sign-in expired. Start a new login.' : 'The login was cancelled.'),
          });
        }
        return;
      }
      if (outcome.kind === 'refused') {
        // A code from another sign-in is refused without using up this one; anything else ends it.
        if (outcome.error.code !== 'invalid_request') setAttempt(undefined);
        setNotice({ tone: 'error', text: outcome.error.message });
      } else {
        setNotice({ tone: 'uncertain', text: lostReply });
      }
    },
    [onConnected],
  );

  // While the exchange runs, its outcome is read back rather than assumed.
  useEffect(() => {
    if (attempt?.state !== 'completing') return;
    const attemptId = attempt.attemptId;
    const timer = setInterval(async () => {
      settle(await client.loginStatus(attemptId), 'Checking the login’s result…');
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [attempt, client, settle]);

  const begin = async () => {
    setBusy(true);
    setNotice(undefined);
    settle(await client.beginLogin(), UNREACHABLE);
    setBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (attempt === undefined || busy || !/\S/.test(code)) return;
    const pasted = code.trim();
    setCode('');
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.completeLogin(attempt.attemptId, pasted);
    if (!outcome.ok && outcome.kind !== 'refused') {
      // No reply: the exchange may have happened. Ask what became of it instead of sending the code again.
      settle(
        await client.loginStatus(attempt.attemptId),
        'No reply arrived. Check the connection status, then try again.',
      );
    } else settle(outcome, UNREACHABLE);
    setBusy(false);
  };

  const cancel = async () => {
    if (attempt === undefined) return;
    setCode('');
    setBusy(true);
    const outcome = await client.cancelLogin(attempt.attemptId);
    setBusy(false);
    if (outcome.ok && outcome.value.state === 'cancelled') {
      setAttempt(undefined);
      setNotice(undefined);
    } else settle(outcome, UNREACHABLE);
  };

  const shown = notice !== undefined && <p className={`notice ${notice.tone}`}>{notice.text}</p>;

  if (attempt?.state === 'completing') {
    return (
      <div className="connect" aria-live="polite">
        <p>Connecting Anthropic… This takes a few seconds.</p>
        {shown}
      </div>
    );
  }

  if (attempt?.state === 'awaiting_code' && attempt.authorizationUrl !== undefined) {
    return (
      <div className="connect">
        <h2>Connect Anthropic</h2>
        <ol>
          <li>
            <a className="button" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">
              Open Anthropic sign-in
            </a>{' '}
            <span className="hint">Opens in a new tab. Sign in with your Claude account and approve access.</span>
          </li>
          <li>
            Anthropic then shows a code. Copy it, come back to this tab and paste it below.
            <form aria-label="Anthropic authorization code" onSubmit={submit}>
              <div className="row">
                <label>
                  Code
                  <input
                    type="text"
                    name="code"
                    value={code}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy || !/\S/.test(code)}>
                  Connect
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => void cancel()}>
                  Cancel
                </button>
              </div>
            </form>
          </li>
        </ol>
        <p className="hint">This sign-in expires at {formatTime(attempt.expiresAt)}.</p>
        {shown}
      </div>
    );
  }

  return (
    <div className="connect">
      {readiness === 'ready' ? (
        <p className="hint">
          Anthropic is connected.{' '}
          <button type="button" className="secondary" disabled={busy} onClick={() => void begin()}>
            Reconnect
          </button>
        </p>
      ) : (
        <p>
          <button type="button" disabled={busy} onClick={() => void begin()}>
            Connect Anthropic
          </button>{' '}
          <span className="hint">Sign in with your Claude account to let tasks use it.</span>
        </p>
      )}
      {shown}
    </div>
  );
}
