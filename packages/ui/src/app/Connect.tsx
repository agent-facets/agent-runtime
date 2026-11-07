// Connecting a provider from the console.
//
// Anthropic: open Anthropic's sign-in in another tab, then paste the code it shows. The code lives only in this
// component's memory and goes only to the login endpoint; it is cleared as soon as it is submitted or the login is
// cancelled.
//
// OpenAI: the console shows a short code; the owner enters it on OpenAI's page in another tab and approves. The
// runtime notices the approval itself, and this panel follows the attempt until it settles.
import type { AuthAttempt, ProviderReadiness } from '@agent-runtime/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ApiClient, ApiOutcome } from '../api/client.ts';
import { formatTime } from './format.ts';
import { button, cx, field, label, muted, Notice } from './ui.tsx';

const PANEL = 'connect max-w-xl space-y-3 text-sm';
const STEPS = 'list-decimal space-y-3 pl-5';

const STATUS_POLL_MS = 1_500;

type ConnectNotice = { tone: 'ok' | 'error' | 'uncertain'; text: string } | undefined;

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
  const [message, setNotice] = useState<ConnectNotice>();

  const settle = useCallback(
    (outcome: ApiOutcome<AuthAttempt>, lostReply: string) => {
      if (outcome.ok) {
        const next = outcome.value;
        if (next.state === 'connected') {
          setAttempt(undefined);
          setNotice({ tone: 'ok', text: 'Connected. You can start sessions now.' });
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

  const shown = message !== undefined && <Notice tone={message.tone}>{message.text}</Notice>;

  if (attempt?.state === 'completing') {
    return (
      <div className={PANEL} aria-live="polite">
        <p>Connecting Anthropic… This takes a few seconds.</p>
        {shown}
      </div>
    );
  }

  if (attempt?.state === 'awaiting_code' && attempt.authorizationUrl !== undefined) {
    return (
      <div className={PANEL}>
        <h3 className="font-semibold">Connect Anthropic</h3>
        <ol className={STEPS}>
          <li className="space-y-1.5">
            <a className={button.primary} href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">
              Open Anthropic sign-in
            </a>
            <p className={muted}>Opens in a new tab. Sign in with your Claude account and approve access.</p>
          </li>
          <li>
            Anthropic then shows a code. Copy it, come back to this tab and paste it below.
            <form aria-label="Anthropic authorization code" onSubmit={submit} className="mt-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className={cx(label, 'min-w-48 flex-1')}>
                  Code
                  <input
                    type="text"
                    name="code"
                    value={code}
                    autoComplete="off"
                    spellCheck={false}
                    className={field}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button type="submit" className={button.primary} disabled={busy || !/\S/.test(code)}>
                  Connect
                </button>
                <button type="button" className={button.secondary} disabled={busy} onClick={() => void cancel()}>
                  Cancel
                </button>
              </div>
            </form>
          </li>
        </ol>
        <p className={muted}>This sign-in expires at {formatTime(attempt.expiresAt)}.</p>
        {shown}
      </div>
    );
  }

  return (
    <div className={PANEL}>
      {readiness === 'ready' ? (
        <p className={cx('flex flex-wrap items-center gap-3', muted)}>
          Anthropic is connected.
          <button type="button" className={button.secondary} disabled={busy} onClick={() => void begin()}>
            Reconnect
          </button>
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-3">
          <button type="button" className={button.primary} disabled={busy} onClick={() => void begin()}>
            Connect Anthropic
          </button>
          <span className={muted}>Sign in with your Claude account to let sessions use it.</span>
        </p>
      )}
      {shown}
    </div>
  );
}

export function ConnectOpenAI({
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
  const [busy, setBusy] = useState(false);
  const [message, setNotice] = useState<ConnectNotice>();

  const settle = useCallback(
    (outcome: ApiOutcome<AuthAttempt>, lostReply: string) => {
      if (outcome.ok) {
        const next = outcome.value;
        if (next.state === 'connected') {
          setAttempt(undefined);
          setNotice({ tone: 'ok', text: 'Connected. You can start sessions now.' });
          onConnected();
        } else if (next.state === 'awaiting_approval' || next.state === 'completing') {
          setAttempt(next);
        } else {
          setAttempt(undefined);
          setNotice({
            tone: 'error',
            text:
              next.failure?.message ??
              (next.state === 'expired'
                ? 'The code was not approved in time. Start a new login.'
                : 'The login was cancelled.'),
          });
        }
        return;
      }
      if (outcome.kind === 'refused') {
        setAttempt(undefined);
        setNotice({ tone: 'error', text: outcome.error.message });
      } else {
        setNotice({ tone: 'uncertain', text: lostReply });
      }
    },
    [onConnected],
  );

  // The runtime waits for the approval; the panel reads the attempt back until it settles.
  const pendingId = attempt?.attemptId;
  useEffect(() => {
    if (pendingId === undefined) return;
    const timer = setInterval(async () => {
      settle(await client.loginStatus(pendingId, 'openai'), 'Checking the login…');
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [pendingId, client, settle]);

  const begin = async () => {
    setBusy(true);
    setNotice(undefined);
    settle(await client.beginLogin('openai'), UNREACHABLE);
    setBusy(false);
  };

  const cancel = async () => {
    if (attempt === undefined) return;
    setBusy(true);
    const outcome = await client.cancelLogin(attempt.attemptId, 'openai');
    setBusy(false);
    if (outcome.ok && outcome.value.state === 'cancelled') {
      setAttempt(undefined);
      setNotice(undefined);
    } else settle(outcome, UNREACHABLE);
  };

  const shown = message !== undefined && <Notice tone={message.tone}>{message.text}</Notice>;

  if (attempt?.state === 'completing') {
    return (
      <div className={PANEL} aria-live="polite">
        <p>Approved. Connecting OpenAI… This takes a few seconds.</p>
        {shown}
      </div>
    );
  }

  if (attempt?.state === 'awaiting_approval' && attempt.authorizationUrl !== undefined) {
    return (
      <div className={PANEL} aria-live="polite">
        <h3 className="font-semibold">Connect OpenAI</h3>
        <ol className={STEPS}>
          <li className="space-y-1.5">
            <a className={button.primary} href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">
              Open OpenAI sign-in
            </a>
            <p className={muted}>Opens in a new tab. Sign in with your ChatGPT account.</p>
          </li>
          <li>
            Enter this code there and approve:{' '}
            <code className="user-code rounded-md bg-zinc-100 px-2 py-1 font-mono text-lg tracking-widest select-all dark:bg-zinc-800">
              {attempt.userCode}
            </code>
          </li>
          <li>Come back here. This panel updates by itself once you approve.</li>
        </ol>
        <p className={cx('flex flex-wrap items-center gap-3', muted)}>
          Waiting for approval until {formatTime(attempt.expiresAt)}.
          <button type="button" className={button.secondary} disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
        </p>
        {shown}
      </div>
    );
  }

  return (
    <div className={PANEL}>
      {readiness === 'ready' ? (
        <p className={cx('flex flex-wrap items-center gap-3', muted)}>
          OpenAI is connected.
          <button type="button" className={button.secondary} disabled={busy} onClick={() => void begin()}>
            Reconnect
          </button>
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-3">
          <button type="button" className={button.primary} disabled={busy} onClick={() => void begin()}>
            Connect OpenAI
          </button>
          <span className={muted}>Sign in with your ChatGPT account to let sessions use it.</span>
        </p>
      )}
      {shown}
    </div>
  );
}
