// Facet-backed capability records (design Decisions 6–8). Forward only: earlier migrations are untouched, and
// existing rows are never rewritten. Every existing run gains its root actor; it has no capability binding, so it
// stays a native run. Record validators used by existing CHECK constraints are replaced with supersets that accept
// every row they accepted before plus the new versioned variants. New cross-row rules join the deferred per-run
// consistency check, so related rows that refer to each other can be inserted in one transaction.

export const CAPABILITY_RECORDS_SQL = String.raw`
-- New validators --------------------------------------------------------------------------------------------------

create function runtime.json_contribution(value jsonb, kind text) returns boolean language sql immutable
return runtime.json_matches(value, '^' || kind || ':[a-z0-9][a-z0-9._-]{0,127}$');

create function runtime.is_actor_key(value text) returns boolean language sql immutable
return coalesce(value = 'root' or runtime.is_digest(value), false);

create function runtime.valid_actor_ref(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'root' then return runtime.json_keys(value, '{kind}');
    when 'delegate' then
      return runtime.json_keys(value, '{kind,delegationId,agentId}')
        and runtime.json_digest(value -> 'delegationId') and runtime.json_contribution(value -> 'agentId', 'agent');
    else return false;
  end case;
end $$;

create function runtime.valid_resource_path(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_string(value, 512)
    and runtime.json_matches(value, '^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$')
    and not runtime.json_matches(value, '(^|/)\.\.?(/|$)');
end $$;

create function runtime.valid_tool_binding(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'native' then
      return runtime.json_keys(value, '{kind,name}') and runtime.json_matches(value -> 'name', '^(mcp_Read|mcp_Search|mcp_AskUser)$');
    when 'skill_load' then
      return runtime.json_keys(value, '{kind,skillId}') and runtime.json_contribution(value -> 'skillId', 'skill');
    when 'skill_reference' then
      return runtime.json_keys(value, '{kind,skillId,path}') and runtime.json_contribution(value -> 'skillId', 'skill')
        and runtime.valid_resource_path(value -> 'path');
    when 'delegation' then
      return runtime.json_keys(value, '{kind,agentId}') and runtime.json_contribution(value -> 'agentId', 'agent');
    when 'mcp' then
      return runtime.json_keys(value, '{kind,serverId,toolName,definitionDigest}')
        and runtime.json_matches(value -> 'serverId', '^[a-z0-9][a-z0-9_-]{0,63}$')
        and runtime.json_matches(value -> 'toolName', '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
        and runtime.json_digest(value -> 'definitionDigest');
    else return false;
  end case;
end $$;

create function runtime.valid_delegate_outcome(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'result' then return runtime.json_keys(value, '{kind,text}') and runtime.json_string(value -> 'text', 65536, true);
    when 'refused', 'failed' then
      return runtime.json_keys(value, '{kind,reason,message}')
        and runtime.json_code(value -> 'reason') and runtime.json_string(value -> 'message', 2048);
    else return false;
  end case;
end $$;

create function runtime.valid_delegate_state(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'active' then return runtime.json_keys(value, '{kind}');
    when 'waiting' then return runtime.json_keys(value, '{kind,questionId}') and runtime.json_digest(value -> 'questionId');
    when 'completed' then
      return runtime.json_keys(value, '{kind,outcome}') and runtime.valid_delegate_outcome(value -> 'outcome');
    when 'abandoned' then return runtime.json_keys(value, '{kind,reason}') and runtime.json_code(value -> 'reason');
    else return false;
  end case;
end $$;

create function runtime.valid_command_input(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_keys(value, '{kind,commandId,selectionRevision,arguments,provider}')
    and runtime.json_matches(value -> 'kind', '^command$')
    and runtime.json_contribution(value -> 'commandId', 'command')
    and runtime.json_digest(value -> 'selectionRevision')
    and runtime.json_string(value -> 'arguments', 8192, true)
    and runtime.json_matches(value -> 'provider', '^(anthropic|openai)$');
end $$;

create function runtime.valid_question_leaf(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_uuid(value -> 'threadId')
    and runtime.json_string(value -> 'checkpointNs', 512, true)
    and runtime.json_string(value -> 'checkpointId', 256)
    and runtime.json_string(value -> 'taskId', 256)
    and runtime.json_string(value -> 'interruptId', 256)
    and runtime.json_digest(value -> 'operationId')
    and runtime.json_digest(value -> 'payloadDigest')
    and runtime.json_digest(value -> 'requiredStateDigest')
    and runtime.json_digest(value -> 'definitionDigest');
end $$;

create function runtime.operation_id_v2(run_id uuid, actor_key text, model_message_id text, provider_tool_call_id text)
returns text language sql immutable
return encode(sha256(convert_to('v2' || E'\n' || run_id::text || E'\n' || actor_key || E'\n' || model_message_id
  || E'\n' || provider_tool_call_id, 'UTF8')), 'hex');

-- Supersets of existing validators --------------------------------------------------------------------------------

create or replace function runtime.valid_question_binding(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  if not value ? 'version' then
    return runtime.json_keys(value,
        '{threadId,checkpointNs,checkpointId,taskId,interruptId,ordinal,operationId,payloadDigest,requiredStateDigest,definitionDigest}')
      and runtime.valid_question_leaf(value) and runtime.json_int(value -> 'ordinal', 0, 0);
  end if;
  if value -> 'version' <> '2'::jsonb or not runtime.valid_question_leaf(value) then return false; end if;
  case value ->> 'actor'
    when 'root' then
      return runtime.json_keys(value,
        '{version,actor,threadId,checkpointNs,checkpointId,taskId,interruptId,operationId,payloadDigest,requiredStateDigest,definitionDigest}');
    when 'delegate' then
      return runtime.json_keys(value,
          '{version,actor,delegationId,agentId,parent,threadId,checkpointNs,checkpointId,taskId,interruptId,operationId,payloadDigest,requiredStateDigest,definitionDigest}')
        and runtime.json_digest(value -> 'delegationId')
        and runtime.json_contribution(value -> 'agentId', 'agent')
        and runtime.json_string(value -> 'checkpointNs', 512)
        and runtime.json_keys(value -> 'parent', '{checkpointNs,checkpointId,taskId,operationId}')
        and runtime.json_string(value #> '{parent,checkpointNs}', 512, true)
        and runtime.json_string(value #> '{parent,checkpointId}', 256)
        and runtime.json_string(value #> '{parent,taskId}', 256)
        and (value #> '{parent,operationId}') = (value -> 'delegationId');
    else return false;
  end case;
end $$;

create or replace function runtime.valid_tool_disposition(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'started' then return runtime.json_keys(value, '{kind}');
    when 'paused' then return runtime.json_keys(value, '{kind,questionId}') and runtime.json_digest(value -> 'questionId');
    when 'dispatching' then return runtime.json_keys(value, '{kind}');
    when 'completed' then
      return runtime.json_keys(value, '{kind,outcome,result}')
        and runtime.json_matches(value -> 'outcome', '^(ok|refused|error|uncertain)$')
        and jsonb_typeof(value -> 'result') = 'object'
        and octet_length((value -> 'result')::text) <= 70000;
    when 'abandoned' then return runtime.json_keys(value, '{kind,reason}') and runtime.json_code(value -> 'reason');
    else return false;
  end case;
end $$;

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
        and runtime.json_digest(payload -> 'operationId') and runtime.json_string(payload -> 'toolName', 128)
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

-- Tables ----------------------------------------------------------------------------------------------------------

-- Content-addressed and immutable. The digest is over canonical JSON, which only the runtime computes; it
-- revalidates shape, bounds and digest before every use. The size check here is a storage ceiling on jsonb's text
-- form (which adds separators); the 16 MiB canonical limit is the runtime's.
create table runtime.capability_snapshots (
  digest text primary key check (runtime.is_digest(digest)),
  payload jsonb not null check (
    runtime.json_keys(payload, '{version,profile,installation,command,input,skills,agents,servers,tools,authority,limits}')
    and payload -> 'version' = '1'::jsonb and payload -> 'profile' = '1'::jsonb
    and octet_length(payload::text) <= 33554432),
  created_at timestamptz not null default now()
);

-- A command run's immutable submitted input, retained definitions and captured delegation limit. Native goal runs,
-- including every run recorded before this migration, have none.
create table runtime.run_capabilities (
  run_id uuid primary key references runtime.runs (run_id) deferrable initially deferred,
  input jsonb not null check (runtime.valid_command_input(input)),
  snapshot_digest text not null references runtime.capability_snapshots (digest),
  max_delegations integer not null check (max_delegations between 1 and 32),
  created_at timestamptz not null default now()
);

create table runtime.run_actors (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  actor_key text not null check (runtime.is_actor_key(actor_key)),
  kind text not null check (kind in ('root', 'delegate')),
  parent_actor text,
  agent_id text,
  task_digest text,
  checkpoint_ns text,
  state jsonb,
  state_kind text generated always as (state ->> 'kind') stored,
  delegation_operation_id text generated always as (case when kind = 'delegate' then actor_key end) stored,
  created_at timestamptz not null default now(),
  primary key (run_id, actor_key),
  check ((kind = 'root') = (actor_key = 'root')),
  check (kind <> 'root' or (parent_actor is null and agent_id is null and task_digest is null
    and checkpoint_ns is null and state is null)),
  check (kind <> 'delegate' or coalesce(parent_actor = 'root'
    and agent_id ~ '^agent:[a-z0-9][a-z0-9._-]{0,127}$' and runtime.is_digest(task_digest)
    and char_length(checkpoint_ns) between 1 and 512 and runtime.valid_delegate_state(state), false)),
  foreign key (run_id, parent_actor) references runtime.run_actors (run_id, actor_key) deferrable initially deferred,
  foreign key (run_id, delegation_operation_id) references runtime.tool_operations (run_id, operation_id)
    deferrable initially deferred
);

-- Every run has exactly one root actor, created with the run.
insert into runtime.run_actors (run_id, actor_key, kind) select run_id, 'root', 'root' from runtime.runs;

create table runtime.loaded_skills (
  run_id uuid not null,
  actor_key text not null,
  skill_id text not null check (skill_id ~ '^skill:[a-z0-9][a-z0-9._-]{0,127}$'),
  operation_id text not null check (runtime.is_digest(operation_id)),
  definition_digest text not null check (runtime.is_digest(definition_digest)),
  created_at timestamptz not null default now(),
  primary key (run_id, actor_key, skill_id),
  foreign key (run_id, actor_key) references runtime.run_actors (run_id, actor_key) deferrable initially deferred,
  foreign key (run_id, operation_id) references runtime.tool_operations (run_id, operation_id)
    deferrable initially deferred
);

-- Actor-scoped operations. Version 1 keeps its identity formula and is always the root's; a provider call ID is
-- unique per actor rather than per run.
do $$
declare
  dropped integer := 0;
  c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'runtime.tool_operations'::regclass
      and ((contype = 'c' and pg_get_constraintdef(oid) like '%operation_id(run_id, model_message_id, provider_tool_call_id)%')
        or (contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (run_id, provider_tool_call_id)'))
  loop
    execute format('alter table runtime.tool_operations drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped <> 2 then raise exception 'unexpected tool operation constraints (%)', dropped; end if;
end $$;

alter table runtime.tool_operations
  add column identity_version smallint not null default 1 check (identity_version in (1, 2)),
  add column actor_key text not null default 'root' check (runtime.is_actor_key(actor_key)),
  add column tool_binding jsonb check (tool_binding is null or runtime.valid_tool_binding(tool_binding)),
  add constraint tool_operations_identity check (
    (identity_version = 1 and actor_key = 'root'
      and operation_id = runtime.operation_id(run_id, model_message_id, provider_tool_call_id))
    or (identity_version = 2
      and operation_id = runtime.operation_id_v2(run_id, actor_key, model_message_id, provider_tool_call_id))),
  add constraint tool_operations_actor_call unique (run_id, actor_key, provider_tool_call_id),
  add constraint tool_operations_actor foreign key (run_id, actor_key)
    references runtime.run_actors (run_id, actor_key) deferrable initially deferred,
  -- Dispatch intent and uncertainty exist only for external (MCP) calls.
  add constraint tool_operations_external_only check (
    (disposition ->> 'kind' <> 'dispatching' and coalesce(disposition ->> 'outcome', '') <> 'uncertain')
    or tool_binding ->> 'kind' = 'mcp');

alter table runtime.model_attempts
  add column actor_key text not null default 'root',
  add constraint model_attempts_actor foreign key (run_id, actor_key)
    references runtime.run_actors (run_id, actor_key) deferrable initially deferred;

alter table runtime.questions
  add column actor_key text not null default 'root',
  add constraint questions_actor foreign key (run_id, actor_key)
    references runtime.run_actors (run_id, actor_key) deferrable initially deferred,
  add constraint questions_asker check (case
    when binding ->> 'actor' = 'delegate' then actor_key = binding ->> 'delegationId'
    else actor_key = 'root' end);

-- Immutability and transitions ------------------------------------------------------------------------------------

create trigger capability_snapshots_immutable before update or delete on runtime.capability_snapshots
  for each row execute function runtime.forbid_change();
create trigger run_capabilities_immutable before update or delete on runtime.run_capabilities
  for each row execute function runtime.forbid_change();
create trigger loaded_skills_immutable before update or delete on runtime.loaded_skills
  for each row execute function runtime.forbid_change();
create trigger run_actors_no_delete before delete on runtime.run_actors
  for each row execute function runtime.forbid_change();

create function runtime.create_root_actor() returns trigger language plpgsql as $$
begin
  insert into runtime.run_actors (run_id, actor_key, kind) values (new.run_id, 'root', 'root');
  return null;
end $$;
create trigger runs_root_actor after insert on runtime.runs for each row execute function runtime.create_root_actor();

create function runtime.guard_actor() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'delegate' and new.state ->> 'kind' <> 'active' then
      perform runtime.reject('a delegate starts active');
    end if;
    return new;
  end if;
  if (new.run_id, new.actor_key, new.kind, new.parent_actor, new.agent_id, new.task_digest, new.checkpoint_ns,
      new.created_at)
    is distinct from (old.run_id, old.actor_key, old.kind, old.parent_actor, old.agent_id, old.task_digest,
      old.checkpoint_ns, old.created_at) then
    perform runtime.reject('actor identity is immutable');
  end if;
  if new.state is distinct from old.state and not coalesce(
    (old.state ->> 'kind' = 'active' and new.state ->> 'kind' in ('waiting', 'completed', 'abandoned'))
    or (old.state ->> 'kind' = 'waiting' and new.state ->> 'kind' in ('active', 'completed', 'abandoned')), false
  ) then
    perform runtime.reject('invalid delegate transition');
  end if;
  return new;
end $$;
create trigger run_actors_guard before insert or update on runtime.run_actors
  for each row execute function runtime.guard_actor();

create or replace function runtime.guard_question_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.question_id, new.operation_id, new.prompt, new.input, new.binding, new.payload_digest,
      new.binding_digest, new.actor_key, new.created_at)
    is distinct from (old.run_id, old.question_id, old.operation_id, old.prompt, old.input, old.binding,
      old.payload_digest, old.binding_digest, old.actor_key, old.created_at) then
    perform runtime.reject('question content and binding are immutable');
  end if;
  if new.disposition is distinct from old.disposition and old.disposition ->> 'kind' <> 'pending' then
    perform runtime.reject('an answered or closed question cannot change');
  end if;
  return new;
end $$;

create or replace function runtime.guard_attempt_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.attempt_id, new.invocation_id, new.ordinal, new.provider, new.model, new.profile_id,
      new.admitted_at, new.actor_key)
    is distinct from (old.run_id, old.attempt_id, old.invocation_id, old.ordinal, old.provider, old.model,
      old.profile_id, old.admitted_at, old.actor_key) then
    perform runtime.reject('model attempt identity is immutable');
  end if;
  -- Generated columns of NEW are not yet computed in a BEFORE trigger, so the JSON is read directly.
  if new.state is distinct from old.state and not coalesce(
    (old.state ->> 'kind' = 'reserved' and new.state ->> 'kind' in ('dispatched', 'abandoned', 'unconfirmed'))
    or (old.state ->> 'kind' = 'dispatched' and new.state ->> 'kind' in ('completed', 'unconfirmed')), false
  ) then
    perform runtime.reject('invalid model attempt transition');
  end if;
  return new;
end $$;

create or replace function runtime.guard_tool_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.operation_id, new.model_message_id, new.provider_tool_call_id, new.tool_name, new.arguments,
      new.argument_digest, new.identity_version, new.actor_key, new.tool_binding, new.created_at)
    is distinct from (old.run_id, old.operation_id, old.model_message_id, old.provider_tool_call_id, old.tool_name,
      old.arguments, old.argument_digest, old.identity_version, old.actor_key, old.tool_binding, old.created_at) then
    perform runtime.reject('tool operation identity is immutable');
  end if;
  if new.disposition is distinct from old.disposition and not coalesce(
    (old.disposition ->> 'kind' = 'started'
      and new.disposition ->> 'kind' in ('paused', 'dispatching', 'completed', 'abandoned'))
    or (old.disposition ->> 'kind' = 'paused' and new.disposition ->> 'kind' in ('completed', 'abandoned'))
    or (old.disposition ->> 'kind' = 'dispatching' and new.disposition ->> 'kind' = 'completed'), false
  ) then
    perform runtime.reject('invalid tool operation transition');
  end if;
  -- An unknown external effect follows only a recorded dispatch intent; intent never becomes "abandoned".
  if new.disposition ->> 'outcome' = 'uncertain' and old.disposition ->> 'kind' <> 'dispatching' then
    perform runtime.reject('only a dispatched external operation can be uncertain');
  end if;
  return new;
end $$;

-- Cross-row consistency, checked at commit ------------------------------------------------------------------------

create or replace function runtime.check_run(p_run uuid) returns void language plpgsql as $$
declare
  r runtime.runs%rowtype;
  active_id uuid;
  active_epoch bigint;
  active_count integer;
  pending_id text;
  pending_binding text;
  n_consumed integer;
  n_unconfirmed integer;
  max_seq bigint;
  n_events bigint;
  capability runtime.run_capabilities%rowtype;
  n_delegates integer;
begin
  select * into r from runtime.runs where run_id = p_run;
  if not found then return; end if;

  select count(*) filter (where state_kind in ('dispatched', 'completed')),
         count(*) filter (where state_kind in ('reserved', 'unconfirmed'))
    into n_consumed, n_unconfirmed from runtime.model_attempts where run_id = p_run;
  if n_consumed <> r.consumed or n_unconfirmed <> r.unconfirmed then
    perform runtime.reject('run budget counters disagree with its model attempts');
  end if;
  if exists (select 1 from runtime.model_attempts a where a.run_id = p_run
      and (a.provider, a.model, a.profile_id)
        is distinct from (r.binding ->> 'provider', r.binding ->> 'model', r.binding ->> 'profileId')) then
    perform runtime.reject('a model attempt does not match the run provider binding');
  end if;

  select coalesce(max(seq), 0), count(*) into max_seq, n_events from runtime.events where run_id = p_run;
  if max_seq <> r.last_seq or n_events <> r.last_seq then
    perform runtime.reject('run event history is not a contiguous sequence ending at last_seq');
  end if;

  select count(*), min(invocation_id::text)::uuid, min(owner_epoch) into active_count, active_id, active_epoch
    from runtime.invocations where run_id = p_run and disposition = 'active';
  select question_id, binding_digest into pending_id, pending_binding
    from runtime.questions where run_id = p_run and disposition_kind = 'pending';

  case r.state_kind
    when 'working' then
      if active_id is distinct from r.state_invocation_id or active_epoch::text <> r.state ->> 'ownerEpoch' then
        perform runtime.reject('a working run must reference its sole active invocation and owner epoch');
      end if;
      if pending_id is not null then perform runtime.reject('a working run cannot have a pending question'); end if;
    when 'waiting' then
      if active_count > 0 then perform runtime.reject('a waiting run cannot have an active invocation'); end if;
      if pending_id is distinct from r.state_question_id or pending_binding is distinct from r.state ->> 'bindingDigest' then
        perform runtime.reject('a waiting run must reference its sole pending question and binding');
      end if;
      if exists (select 1 from runtime.model_attempts where run_id = p_run and state_kind in ('reserved', 'dispatched')) then
        perform runtime.reject('a waiting run cannot have an unsettled model attempt');
      end if;
    when 'cancelling' then
      if pending_id is not null then perform runtime.reject('cancellation closes unanswered questions'); end if;
      if active_count > 0 and active_id is distinct from r.state_invocation_id then
        perform runtime.reject('a cancelling run may retain only its referenced invocation');
      end if;
    else
      if active_count > 0 or pending_id is not null then
        perform runtime.reject('a finished run has no active invocation or pending question');
      end if;
      -- Only the root agent's new final message can be a run's successful result.
      if r.state_kind = 'succeeded' and not exists (select 1 from runtime.events
          where run_id = p_run and seq = r.state_result_seq and kind = 'assistant.message'
            and coalesce(payload #>> '{actor,kind}', 'root') = 'root') then
        perform runtime.reject('success must reference a recorded root assistant result');
      end if;
      if r.state_kind = 'interrupted' and not exists (select 1 from runtime.invocations
          where run_id = p_run and invocation_id = r.state_invocation_id and disposition = 'interrupted') then
        perform runtime.reject('an interrupted run must reference its interrupted invocation');
      end if;
      if exists (select 1 from runtime.run_actors where run_id = p_run and state_kind in ('active', 'waiting')) then
        perform runtime.reject('a finished run has no active or waiting delegate');
      end if;
  end case;

  if exists (select 1 from runtime.questions q
      left join runtime.invocations i on i.run_id = q.run_id and i.invocation_id = q.answer_invocation_id
      where q.run_id = p_run and q.disposition_kind = 'answered'
        and (i.invocation_id is null or i.kind <> 'answer' or i.question_id is distinct from q.question_id)) then
    perform runtime.reject('an answered question must reference the invocation that continues from it');
  end if;
  if exists (select 1 from runtime.invocations i
      join runtime.questions q on q.run_id = i.run_id and q.question_id = i.question_id
      where i.run_id = p_run and i.kind = 'answer'
        and (q.disposition_kind <> 'answered' or q.answer_invocation_id is distinct from i.invocation_id)) then
    perform runtime.reject('an answer invocation must continue from its answered question');
  end if;

  -- Actors -------------------------------------------------------------------------------------------------------
  if not exists (select 1 from runtime.run_actors where run_id = p_run and actor_key = 'root') then
    perform runtime.reject('a run must have its root actor');
  end if;
  select * into capability from runtime.run_capabilities where run_id = p_run;
  select count(*) into n_delegates from runtime.run_actors where run_id = p_run and kind = 'delegate';
  if n_delegates > coalesce(capability.max_delegations, 0) then
    perform runtime.reject('delegations exceed the run''s captured limit');
  end if;
  if exists (select 1 from runtime.run_actors a
      left join runtime.tool_operations o on o.run_id = a.run_id and o.operation_id = a.actor_key
      where a.run_id = p_run and a.kind = 'delegate'
        and (o.operation_id is null or o.actor_key is distinct from a.parent_actor
          or o.tool_binding is distinct from jsonb_build_object('kind', 'delegation', 'agentId', a.agent_id))) then
    perform runtime.reject('a delegate must be started by its parent''s delegation operation');
  end if;
  if exists (select 1 from runtime.run_actors a where a.run_id = p_run and a.state_kind = 'waiting'
      and not exists (select 1 from runtime.questions q where q.run_id = a.run_id
        and q.question_id = a.state ->> 'questionId' and q.actor_key = a.actor_key)) then
    perform runtime.reject('a waiting delegate must reference its own question');
  end if;
  if exists (select 1 from runtime.questions q join runtime.run_actors a on a.run_id = q.run_id and a.actor_key = q.actor_key
      where q.run_id = p_run and q.disposition_kind = 'pending' and a.kind = 'delegate'
        and (a.state_kind is distinct from 'waiting' or a.state ->> 'questionId' is distinct from q.question_id)) then
    perform runtime.reject('a pending delegated question must have its delegate waiting on it');
  end if;
  if exists (select 1 from runtime.questions q join runtime.tool_operations o
      on o.run_id = q.run_id and o.operation_id = q.operation_id
      where q.run_id = p_run and o.actor_key <> q.actor_key) then
    perform runtime.reject('a question must be asked by the actor that issued its operation');
  end if;

  -- Loaded skills ------------------------------------------------------------------------------------------------
  if exists (select 1 from runtime.loaded_skills s
      left join runtime.tool_operations o on o.run_id = s.run_id and o.operation_id = s.operation_id
      where s.run_id = p_run and (capability.run_id is null or o.operation_id is null or o.actor_key <> s.actor_key
        or o.disposition ->> 'kind' <> 'completed' or o.disposition ->> 'outcome' <> 'ok'
        or o.tool_binding is distinct from jsonb_build_object('kind', 'skill_load', 'skillId', s.skill_id))) then
    perform runtime.reject('a loaded skill must come from its actor''s successful load in a command run');
  end if;

  -- Command binding and its history ------------------------------------------------------------------------------
  if capability.run_id is null then
    if exists (select 1 from runtime.events where run_id = p_run and kind = 'run.command') then
      perform runtime.reject('only a command run records a command selection');
    end if;
  elsif not exists (select 1 from runtime.events
      where run_id = p_run and kind = 'run.command'
        and payload ->> 'snapshotDigest' = capability.snapshot_digest
        and payload ->> 'commandId' = capability.input ->> 'commandId'
        and payload ->> 'selectionRevision' = capability.input ->> 'selectionRevision'
        and payload -> 'arguments' = capability.input -> 'arguments') then
    perform runtime.reject('a command run and its recorded selection must agree');
  end if;
  if (select count(*) from runtime.events where run_id = p_run and kind = 'run.command') > 1 then
    perform runtime.reject('a run records one command selection');
  end if;
  if exists (select 1 from runtime.events e where e.run_id = p_run and e.payload #>> '{actor,kind}' = 'delegate'
      and not exists (select 1 from runtime.run_actors a where a.run_id = e.run_id
        and a.actor_key = e.payload #>> '{actor,delegationId}' and a.agent_id = e.payload #>> '{actor,agentId}')) then
    perform runtime.reject('attributed activity must name one of the run''s delegates');
  end if;
end $$;

create constraint trigger run_capabilities_consistency after insert on runtime.run_capabilities
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger run_actors_consistency after insert or update on runtime.run_actors
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger loaded_skills_consistency after insert on runtime.loaded_skills
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
`;
