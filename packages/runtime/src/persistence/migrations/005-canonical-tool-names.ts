// Canonical MCP tool names (design Decision 6) are `mcp_<serverId>_<toolName>`: a server ID of at most 64 characters
// and a tool name of at most 128 give at most 197. The model-facing name of a tool call is recorded in its operation
// and history event, which allowed 128. Forward only: both bounds are widened to 197 with supersets that accept every
// row they accepted before; no row is rewritten, and the server/tool component bounds are unchanged.

export const CANONICAL_TOOL_NAMES_SQL = String.raw`
do $$
declare
  dropped integer := 0;
  c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'runtime.tool_operations'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%char_length(tool_name)%128%'
  loop
    execute format('alter table runtime.tool_operations drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped <> 1 then raise exception 'unexpected tool name constraints (%)', dropped; end if;
end $$;

alter table runtime.tool_operations
  add constraint tool_operations_tool_name check (char_length(tool_name) between 1 and 197);

create or replace function runtime.valid_event(kind text, payload jsonb) returns boolean
language plpgsql immutable as $$
begin
  -- Only agent activity may name an actor; owner and system events have no such field.
  if kind in ('model.attempt', 'assistant.message', 'tool.operation', 'question.asked')
    and payload ? 'actor' and not runtime.valid_actor_ref(payload -> 'actor') then
    return false;
  end if;
  case kind
    when 'run.created' then
      return runtime.json_keys(payload, '{requestId,provider,model,budgetMax}')
        and runtime.json_uuid(payload -> 'requestId')
        and runtime.json_matches(payload -> 'provider', '^(anthropic|openai)$')
        and runtime.json_string(payload -> 'model', 256)
        and runtime.json_int(payload -> 'budgetMax', 1, 2147483647);
    when 'run.status' then
      return runtime.json_keys(payload, '{revision,state}')
        and runtime.json_positive_decimal(payload -> 'revision') and runtime.valid_run_state(payload -> 'state');
    when 'model.attempt' then
      return runtime.json_keys(payload, '{attemptId,ordinal,state,budget}', '{actor}')
        and runtime.json_uuid(payload -> 'attemptId') and runtime.json_int(payload -> 'ordinal', 1, 2147483647)
        and runtime.valid_attempt_state(payload -> 'state')
        and runtime.json_keys(payload -> 'budget', '{maximum,consumed,unconfirmed}')
        and runtime.json_int(payload #> '{budget,maximum}', 1, 2147483647)
        and runtime.json_int(payload #> '{budget,consumed}', 0, 2147483647)
        and runtime.json_int(payload #> '{budget,unconfirmed}', 0, 2147483647);
    when 'assistant.message' then
      return runtime.json_keys(payload, '{messageId,text}', '{actor}')
        and runtime.json_string(payload -> 'messageId', 256) and runtime.json_string(payload -> 'text', 1048576, true);
    when 'tool.operation' then
      return runtime.json_keys(payload, '{operationId,toolName,disposition}', '{actor,binding}')
        and runtime.json_digest(payload -> 'operationId') and runtime.json_string(payload -> 'toolName', 197)
        and runtime.valid_tool_disposition(payload -> 'disposition')
        and (not payload ? 'binding' or runtime.valid_tool_binding(payload -> 'binding'));
    when 'question.asked' then
      return runtime.json_keys(payload, '{questionId,prompt,input}', '{actor}')
        and runtime.json_digest(payload -> 'questionId') and runtime.json_string(payload -> 'prompt', 16384)
        and runtime.valid_question_input(payload -> 'input');
    when 'question.answered' then
      return runtime.json_keys(payload, '{questionId,answer,invocationId,acceptedAt}')
        and runtime.json_digest(payload -> 'questionId') and runtime.valid_answer(payload -> 'answer')
        and runtime.json_uuid(payload -> 'invocationId') and runtime.json_instant(payload -> 'acceptedAt');
    when 'question.closed' then
      return runtime.json_keys(payload, '{questionId,reason,closedAt}')
        and runtime.json_digest(payload -> 'questionId') and runtime.json_code(payload -> 'reason')
        and runtime.json_instant(payload -> 'closedAt');
    when 'cancellation.accepted' then
      return runtime.json_keys(payload, '{cancellationId,requestId,acceptedAt}')
        and runtime.json_uuid(payload -> 'cancellationId') and runtime.json_uuid(payload -> 'requestId')
        and runtime.json_instant(payload -> 'acceptedAt');
    when 'run.command' then
      return runtime.json_keys(payload, '{commandId,selectionRevision,arguments,snapshotDigest}')
        and runtime.json_contribution(payload -> 'commandId', 'command')
        and runtime.json_digest(payload -> 'selectionRevision')
        and runtime.json_string(payload -> 'arguments', 8192, true)
        and runtime.json_digest(payload -> 'snapshotDigest');
    when 'delegation.started' then
      return runtime.json_keys(payload, '{delegationId,agentId,parentActor,task}')
        and runtime.json_digest(payload -> 'delegationId')
        and runtime.json_contribution(payload -> 'agentId', 'agent')
        and runtime.valid_actor_ref(payload -> 'parentActor')
        and runtime.json_string(payload -> 'task', 8192) and runtime.json_matches(payload -> 'task', '\S');
    when 'delegation.finished' then
      return runtime.json_keys(payload, '{delegationId,outcome,operationId}')
        and runtime.json_digest(payload -> 'delegationId')
        and runtime.json_matches(payload -> 'outcome', '^(result|refused|failed|abandoned)$')
        and runtime.json_digest(payload -> 'operationId');
    else return false;
  end case;
end $$;
`;
