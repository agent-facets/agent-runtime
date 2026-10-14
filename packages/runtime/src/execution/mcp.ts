// Approved MCP tools in a command run (design Decisions 4, 5, 6 and 8). Each retained tool an actor may use is offered
// under its retained canonical name (`mcp_<serverId>_<toolName>`), with its retained adapted description and schema;
// the adapter's own invocation helpers are never used. Each tool closes over its retained server/tool pair, which is
// what is authorized and sent: the name is never split back into its parts. A call is first resolved by the operation ledger (an exact completed call is answered from
// its record without any of the following). A new call must then be permitted now — the run's captured ceiling
// intersected with the owner's current grants and the command's and agent's restrictions — on the connection the run
// retained, with the original arguments valid against the approved raw schema and free of credentials. The server's
// current listing must still advertise the approved definition. Only then is dispatch intent recorded and exactly one
// request sent, inside the run's dispatch gate. The outcome is recorded before the model can see it; an outcome that
// cannot be established stops the run, and nothing is retried or reconnected.
import type { ActorRef } from '@agent-runtime/contracts';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { authorizeMcpCall, type McpAuthorization } from '../capabilities/authority.ts';
import type { CapabilitySnapshot, ExternalOutcome } from '../capabilities/records.ts';
import { type LaunchDeps, planServerLaunch } from '../capabilities/server-access.ts';
import type { CapabilityConfig } from '../config/capabilities.ts';
import { callTool, checkArguments } from '../mcp/call.ts';
import type { InvocationConnections } from '../mcp/connections.ts';
import { deadline } from '../mcp/deadline.ts';
import { DISCOVERY_LIMITS, discoverTools, sessionListPage } from '../mcp/discovery.ts';
import { type ArgumentValidator, compileArgumentValidator } from '../mcp/schema.ts';
import { openSession } from '../mcp/session.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import { sanitizeToolOutcome } from '../security/pre-graph.ts';
import type { ToolOutcome } from '../workspace/results.ts';
import { ExecutionFailure } from './failures.ts';
import {
  AdmissionUnknown,
  type ExternalAdmission,
  identityFor,
  type OperationLedger,
  outcomeContent,
  recordableOutcome,
} from './operations.ts';

/** Version 2: canonical tool names, carried by each provider's wire-name translation. */
export const MCP_PROTOCOL_VERSION = 2;

/** What an actor's MCP tools need beyond the retained definitions. */
export interface McpPort {
  /** The owner's current grants, loaded at startup; they narrow new calls only. */
  current: CapabilityConfig | undefined;
  /** This invocation's connections, shared by its root and delegates. */
  connections: InvocationConnections;
  launch: LaunchDeps;
  /** The invocation's cancellation. */
  signal: () => AbortSignal;
}

type RetainedTool = CapabilitySnapshot['tools'][number];
type AgentDefinition = CapabilitySnapshot['agents'][number];

const sameTool = (a: { serverId: string; toolName: string }, b: { serverId: string; toolName: string }) =>
  a.serverId === b.serverId && a.toolName === b.toolName;

/**
 * The retained tools an actor may ever call in this run: in the captured ceiling with the definition it was granted
 * for, narrowed by the command's and the agent's restrictions. Current grants are not consulted, so what is offered
 * (and the run's execution definition) never changes with configuration.
 */
export function retainedMcpToolsFor(snapshot: CapabilitySnapshot, agent?: AgentDefinition): RetainedTool[] {
  return snapshot.tools.filter((retained) => {
    const server = snapshot.servers.find((candidate) => candidate.serverId === retained.serverId);
    const ceiling = snapshot.authority.servers.find(
      (candidate) => candidate.serverId === retained.serverId && candidate.serverDigest === server?.serverDigest,
    );
    if (
      !ceiling?.tools.some(
        (grant) => grant.name === retained.toolName && grant.definitionDigest === retained.definitionDigest,
      )
    ) {
      return false;
    }
    const command = snapshot.command.restrict?.mcp;
    if (command !== undefined && !command.some((entry) => sameTool(entry, retained))) return false;
    const own = agent?.restrict?.mcp;
    return own === undefined || own.some((entry) => sameTool(entry, retained));
  });
}

const AUTHORIZATION_MESSAGES: Record<Extract<McpAuthorization, { ok: false }>['reason'], string> = {
  tool_unavailable: 'That tool is not available to this run.',
  not_in_run_authority: 'That tool was not granted when this run started.',
  restricted: 'That tool is not available to this agent.',
  server_not_approved: 'The owner has not approved this server.',
  server_denied: 'The owner has denied this server.',
  server_reapproval_required: "This server's declaration or program changed and needs the owner's approval again.",
  tool_not_granted: 'The owner has not granted this tool.',
  tool_reapproval_required: "This tool's definition changed and needs the owner's approval again.",
  argument_out_of_scope: 'The arguments are outside what the owner granted for this tool.',
};

/** Refusals the owner must resolve by configuration; anything else that stops a launch is an availability problem. */
const LAUNCH_REFUSALS = new Set([
  'server_not_approved',
  'server_denied',
  'server_reapproval_required',
  'transport_unsupported',
  'declaration_invalid',
  'credential_in_declaration',
]);

const refused = (code: string, message: string): ToolOutcome<never> => ({ outcome: 'refused', code, message });
const failed = (code: string, message: string): ToolOutcome<never> => ({ outcome: 'error', code, message });

/** The recorded form of a call's outcome. */
function toolOutcomeOf(outcome: ExternalOutcome, policy: ContentPolicy): ToolOutcome<unknown> {
  switch (outcome.kind) {
    case 'ok': {
      const result = {
        ...(outcome.text === undefined ? {} : { text: outcome.text }),
        ...(outcome.json === undefined ? {} : { json: outcome.json }),
      };
      const safe = recordableOutcome(sanitizeToolOutcome(policy, { outcome: 'ok', result }));
      // The call completed; a result that cannot be returned safely is a failure, not a refusal of the call.
      return safe.outcome === 'ok'
        ? safe
        : failed('mcp_result_withheld', 'The tool result could not be returned safely and was withheld.');
    }
    case 'refused':
      return refused(outcome.reason, outcome.message);
    case 'unavailable':
    case 'failed':
      return failed(outcome.reason, outcome.message);
    case 'uncertain':
      return { outcome: 'uncertain', code: outcome.reason, message: outcome.message };
  }
}

interface ToolRuntimeView {
  signal?: AbortSignal;
  toolCallId?: string;
  configurable?: { thread_id?: unknown };
  state?: { messages?: BaseMessage[] };
}

/** The model message that issued a call, and the call exactly as the model issued it. */
function issuedCall(messages: readonly BaseMessage[] | undefined, toolCallId: string) {
  const issuers = (messages ?? []).filter(
    (message): message is AIMessage =>
      AIMessage.isInstance(message) && (message.tool_calls ?? []).some((call) => call.id === toolCallId),
  );
  const issuer = issuers.length === 1 ? issuers[0] : undefined;
  const call = issuer?.tool_calls?.find((candidate) => candidate.id === toolCallId);
  if (issuer === undefined || typeof issuer.id !== 'string' || issuer.id === '' || call === undefined) return undefined;
  return { messageId: issuer.id, call };
}

export function createMcpTools(context: {
  runId: string;
  actor: ActorRef;
  snapshot: CapabilitySnapshot;
  agent?: AgentDefinition;
  port: McpPort;
  operations: OperationLedger;
  contentPolicy: () => ContentPolicy;
}) {
  const { snapshot, port, operations } = context;
  const validators = new Map<string, ArgumentValidator | undefined>();
  const validatorFor = (retained: RetainedTool) => {
    const key = `${retained.serverId}\n${retained.toolName}`;
    if (!validators.has(key)) {
      try {
        validators.set(key, compileArgumentValidator(retained.raw.inputSchema as Record<string, unknown>));
      } catch {
        validators.set(key, undefined);
      }
    }
    return validators.get(key);
  };

  return retainedMcpToolsFor(snapshot, context.agent).map((retained) => {
    const server = snapshot.servers.find((candidate) => candidate.serverId === retained.serverId);
    if (server === undefined) throw new ExecutionFailure('invariant_violation');
    const binding = {
      kind: 'mcp' as const,
      serverId: retained.serverId,
      toolName: retained.toolName,
      definitionDigest: retained.definitionDigest,
    };
    const connectionKey = `${server.serverId}\n${server.serverDigest}`;

    return tool(
      async (_parsed: unknown, runtime: ToolRuntimeView) => {
        const policy = context.contentPolicy();
        const issued =
          typeof runtime.toolCallId === 'string' ? issuedCall(runtime.state?.messages, runtime.toolCallId) : undefined;
        const args = issued?.call.args as Record<string, unknown> | undefined;
        const identity =
          issued === undefined || args === undefined
            ? undefined
            : identityFor(
                context.runId,
                issued.messageId,
                { id: issued.call.id as string, name: retained.adapted.name, args },
                { actor: context.actor, binding },
              );
        if (identity === undefined || args === undefined) throw new ExecutionFailure('tool_call_unrepresentable');
        const unknown = (operationId: string) => {
          port.connections.stop(operationId);
          return new ExecutionFailure('mcp_outcome_unknown', undefined, operationId);
        };
        const stopped = port.connections.stopped;
        if (stopped !== undefined) throw new ExecutionFailure('mcp_outcome_unknown', undefined, stopped);

        // Permitted now: the run's ceiling, current grants, restrictions and the argument scope.
        const authorized = authorizeMcpCall({
          snapshot,
          current: port.current,
          ...(context.agent === undefined ? {} : { agent: context.agent }),
          serverId: retained.serverId,
          toolName: retained.toolName,
          args,
        });
        if (!authorized.ok) {
          return outcomeContent(refused(authorized.reason, AUTHORIZATION_MESSAGES[authorized.reason]));
        }
        const validate = validatorFor(retained);
        if (validate === undefined) {
          return outcomeContent(refused('tool_unavailable', AUTHORIZATION_MESSAGES.tool_unavailable));
        }
        const checked = checkArguments({ args, validate, policy });
        if (checked !== undefined) return outcomeContent(toolOutcomeOf(checked, policy));

        return port.connections.exclusive(connectionKey, async () => {
          const signal = port.signal();
          const opened = await port.connections.session(connectionKey, async () => {
            const plan = await planServerLaunch(server, port.current, port.launch, policy, server.serverDigest);
            if (!plan.ok) return plan;
            const limit = deadline(DISCOVERY_LIMITS.deadlineMs, signal);
            try {
              return await openSession(plan.params, limit, signal);
            } finally {
              limit.dispose();
            }
          });
          if (!opened.ok) {
            if (signal.aborted) throw new ExecutionFailure('dispatch_refused');
            return outcomeContent(
              LAUNCH_REFUSALS.has(opened.reason)
                ? refused(opened.reason, "The server's connection is not approved as configured.")
                : failed('mcp_server_unavailable', 'The server could not be started or reached.'),
            );
          }
          const { session } = opened;

          // The server must still advertise exactly the approved definition.
          const limit = deadline(DISCOVERY_LIMITS.deadlineMs, signal);
          let listing: Awaited<ReturnType<typeof discoverTools>>;
          try {
            listing = await discoverTools({ listPage: sessionListPage(session), limit, policy, outer: signal });
          } finally {
            limit.dispose();
          }
          if (!listing.ok) {
            await port.connections.discard(connectionKey);
            if (signal.aborted) throw new ExecutionFailure('dispatch_refused');
            return outcomeContent(failed('mcp_server_unavailable', "The server's tools could not be listed."));
          }
          const advertised = listing.tools.find((candidate) => candidate.name === retained.toolName);
          if (advertised?.status !== 'supported') {
            return outcomeContent(refused('tool_unavailable', 'The server no longer offers this tool.'));
          }
          if (advertised.definitionDigest !== retained.definitionDigest) {
            return outcomeContent(refused('tool_reapproval_required', AUTHORIZATION_MESSAGES.tool_reapproval_required));
          }

          if (operations.admitExternal === undefined || operations.completeExternal === undefined) {
            throw new ExecutionFailure('invariant_violation');
          }
          let admission: ExternalAdmission | undefined;
          let result: Awaited<ReturnType<typeof callTool>>;
          try {
            result = await callTool({
              session,
              toolName: retained.toolName,
              args,
              validate,
              timeoutMs: authorized.timeoutSeconds * 1000,
              signal,
              policy,
              operationId: identity.operationId,
              admit: async (send) => {
                if (port.connections.stopped !== undefined) return;
                admission = await (operations.admitExternal as NonNullable<OperationLedger['admitExternal']>)(
                  identity,
                  send,
                );
              },
            });
          } catch (error) {
            if (error instanceof AdmissionUnknown) throw new ExecutionFailure('commit_unknown');
            // Nothing was recorded, so nothing was sent.
            if (admission === undefined) throw new ExecutionFailure('tool_handling_failed');
            throw unknown(identity.operationId);
          }
          if (!result.dispatched) {
            if (admission === 'unresolved') throw unknown(identity.operationId);
            if (admission === 'not_dispatchable' || signal.aborted) throw new ExecutionFailure('dispatch_refused');
            if (admission === 'not_recorded') throw new ExecutionFailure('tool_handling_failed');
            const pending = port.connections.stopped;
            if (pending !== undefined) throw new ExecutionFailure('mcp_outcome_unknown', undefined, pending);
            return outcomeContent(toolOutcomeOf(result.outcome, policy));
          }

          // Sent: the outcome is recorded before anything else sees it.
          const outcome = toolOutcomeOf(result.outcome, policy);
          try {
            await operations.completeExternal(identity, outcome);
          } catch {
            // Sent, and its outcome cannot be shown to be recorded: what happened is unknown.
            throw unknown(identity.operationId);
          }
          if (outcome.outcome === 'uncertain') throw unknown(identity.operationId);
          return outcomeContent(outcome);
        });
      },
      { name: retained.adapted.name, description: retained.adapted.description, schema: retained.adapted.schema },
    );
  });
}

/** The public binding of an MCP wire name for an actor, from the retained definitions. */
export function mcpBindings(snapshot: CapabilitySnapshot, agent?: AgentDefinition) {
  return new Map(
    retainedMcpToolsFor(snapshot, agent).map((retained) => [
      retained.adapted.name,
      {
        kind: 'mcp' as const,
        serverId: retained.serverId,
        toolName: retained.toolName,
        definitionDigest: retained.definitionDigest,
      },
    ]),
  );
}
