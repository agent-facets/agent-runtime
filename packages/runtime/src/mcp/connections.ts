// The MCP connections one invocation owns (design Decision 5). The root and its delegates share one connection per
// approved server identity, opened on first use and used by one call at a time; every connection closes when the
// invocation settles — at a question, a result, a failure or cancellation — and is never reopened by this holder
// once lost or closed. Session-local server state is therefore not durable; the per-server data directory is. Once an
// external outcome is unknown, no further call of the invocation may be sent.
import { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { closeSession, type McpSession, type SessionOpen } from './session.ts';

export type ConnectionOpen = SessionOpen | { ok: false; reason: 'connection_closed' | 'invocation_settled' | string };

export class InvocationConnections {
  readonly #sessions = new Map<string, Promise<ConnectionOpen>>();
  readonly #exclusive = new KeyedSerializer();
  #closing: Promise<void> | undefined;
  #stopped: string | undefined;

  /** Runs `body` with exclusive use of the connection for `key`; calls on other connections are not delayed. */
  exclusive<T>(key: string, body: () => Promise<T>): Promise<T> {
    return this.#exclusive.run(key, body);
  }

  /**
   * The connection for `key`, opened with `open` on first use. A connection that has closed — after an uncertain
   * call, a failed listing or settlement — is not reopened: later calls find it unavailable.
   */
  async session(key: string, open: () => Promise<ConnectionOpen>): Promise<ConnectionOpen> {
    if (this.#closing !== undefined) return { ok: false, reason: 'invocation_settled' };
    let opening = this.#sessions.get(key);
    if (opening === undefined) {
      opening = open();
      this.#sessions.set(key, opening);
      const opened = await opening;
      // A failed open leaves nothing to reuse; the next new operation may try again.
      if (!opened.ok) this.#sessions.delete(key);
      return opened;
    }
    const opened = await opening;
    if (opened.ok && opened.session.client.transport === undefined) return { ok: false, reason: 'connection_closed' };
    return opened;
  }

  /** Closes the connection for `key` now (its listing failed); it is not reopened in this invocation. */
  async discard(key: string): Promise<void> {
    const opened = await this.#sessions.get(key);
    if (opened?.ok) await closeSession(opened.session);
  }

  /** Records that an external outcome is unknown; no further call of this invocation is sent. */
  stop(operationId: string): void {
    this.#stopped ??= operationId;
  }

  /** The operation whose unknown outcome stopped dispatch, if any. */
  get stopped(): string | undefined {
    return this.#stopped;
  }

  /** Closes every connection, including ones still opening, and waits for their processes. Idempotent. */
  closeAll(): Promise<void> {
    this.#closing ??= (async () => {
      const opened = await Promise.all([...this.#sessions.values()]);
      await Promise.all(
        opened.flatMap((entry) => (entry.ok ? [closeSession((entry as { session: McpSession }).session)] : [])),
      );
    })();
    return this.#closing;
  }
}
