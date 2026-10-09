// A connection to one approved MCP server: the verified launch plan becomes an owned stdio transport, the SDK client
// initializes within the caller's deadline, and closing waits until the process has actually gone. The client
// declares no capabilities, so a server's sampling, elicitation and roots requests are refused by the protocol; list
// change notifications trigger nothing. No connection is retried or restarted here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Deadline } from './deadline.ts';
import { type OwnedTransport, ownedTransport, type StdioServerParameters } from './transport.ts';

export const CLIENT_INFO = Object.freeze({ name: 'agent-runtime', version: '1' });
/** How long closing waits for the process after the SDK's own escalation (2 s grace, SIGTERM, 2 s, SIGKILL). */
export const CLOSE_SETTLE_MS = 6_000;

export interface McpSession {
  client: Client;
  owned: OwnedTransport;
}

export type SessionOpen =
  | { ok: true; session: McpSession }
  | { ok: false; reason: 'connection_failed' | 'connection_timeout' | 'cancelled' | 'tools_unsupported' };

/** Starts the server and initializes it, within the deadline; on any failure the process is closed again. */
export async function openSession(
  params: StdioServerParameters,
  limit: Deadline,
  outer?: AbortSignal,
  transportFor: (params: StdioServerParameters) => OwnedTransport = ownedTransport,
): Promise<SessionOpen> {
  const owned = transportFor(params);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  // Dependency errors carry raw server text; they are never logged or returned.
  client.onerror = () => {};
  try {
    await client.connect(owned.transport, limit.requestOptions());
  } catch {
    await closeSession({ client, owned });
    if (outer?.aborted) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: limit.expired() ? 'connection_timeout' : 'connection_failed' };
  }
  if (client.getServerCapabilities()?.tools === undefined) {
    await closeSession({ client, owned });
    return { ok: false, reason: 'tools_unsupported' };
  }
  return { ok: true, session: { client, owned } };
}

/** Closes the connection and waits for the process to be gone; false if it could not be confirmed in time. */
export async function closeSession(session: McpSession, settleMs = CLOSE_SETTLE_MS): Promise<boolean> {
  await session.client.close().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), settleMs);
  });
  const settled = await Promise.race([session.owned.exited.then(() => true as const), timedOut]);
  clearTimeout(timer);
  return settled;
}
