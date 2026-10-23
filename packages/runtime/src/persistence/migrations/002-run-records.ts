// Run records. Every named JSON object is checked here for its discriminator, exact keys and primitive types
// (the runtime decoders in records/ apply the same shapes). Validators are total: they return false rather than
// raising or yielding NULL, because a CHECK that evaluates to NULL passes. Cross-row consistency is checked at
// commit by a deferred constraint trigger, so a transaction may be temporarily inconsistent between statements.

export const RUN_RECORDS_SQL = String.raw`
-- JSON primitive helpers -----------------------------------------------------------------------------------------

create function runtime.json_keys(value jsonb, required text[], optional text[] default '{}') returns boolean
language plpgsql immutable as $$
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  if not (value ?& required) then return false; end if;
  return not exists (select 1 from jsonb_object_keys(value) k where not (k = any (required || optional)));
end $$;

create function runtime.json_string(value jsonb, max_length integer, allow_empty boolean default false) returns boolean
language plpgsql immutable as $$
begin
  if value is null or jsonb_typeof(value) <> 'string' then return false; end if;
  return char_length(value #>> '{}') <= max_length and (allow_empty or char_length(value #>> '{}') > 0);
end $$;

create function runtime.json_matches(value jsonb, pattern text) returns boolean
language plpgsql immutable as $$
begin
  if value is null or jsonb_typeof(value) <> 'string' then return false; end if;
  return (value #>> '{}') ~ pattern;
end $$;

create function runtime.json_int(value jsonb, min_value numeric, max_value numeric) returns boolean
language plpgsql immutable as $$
declare n numeric;
begin
  if value is null or jsonb_typeof(value) <> 'number' then return false; end if;
  n := (value #>> '{}')::numeric;
  return n = trunc(n) and n between min_value and max_value;
end $$;

create function runtime.json_is_scalar(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return value is not null and jsonb_typeof(value) in ('string', 'number', 'boolean', 'null');
end $$;

create function runtime.json_uuid(value jsonb) returns boolean language sql immutable
return runtime.json_matches(value, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

create function runtime.json_digest(value jsonb) returns boolean language sql immutable
return runtime.json_matches(value, '^[0-9a-f]{64}$');

create function runtime.json_instant(value jsonb) returns boolean language sql immutable
return runtime.json_matches(value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$');

create function runtime.json_positive_decimal(value jsonb) returns boolean language sql immutable
return runtime.json_matches(value, '^[1-9][0-9]{0,17}$');

create function runtime.json_code(value jsonb) returns boolean language sql immutable
return runtime.json_matches(value, '^[a-z][a-z0-9_]{0,63}$');

create function runtime.is_digest(value text) returns boolean language sql immutable
return coalesce(value ~ '^[0-9a-f]{64}$', false);

create function runtime.is_identifier(value text) returns boolean language sql immutable
return coalesce(char_length(value) between 1 and 256 and value !~ '[[:cntrl:]]', false);

-- Record validators ----------------------------------------------------------------------------------------------

create function runtime.valid_workspace(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_keys(value, '{id,label,root,policyDigest}')
    and runtime.json_matches(value -> 'id', '^[a-z0-9][a-z0-9_-]{0,63}$')
    and runtime.json_string(value -> 'label', 256)
    and runtime.json_matches(value -> 'root', '^/')
    and runtime.json_string(value -> 'root', 4096)
    and runtime.json_digest(value -> 'policyDigest');
end $$;

create function runtime.valid_binding(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_keys(value, '{provider,authMode,model,profileId,credentialSlot}')
    and runtime.json_matches(value -> 'provider', '^(anthropic|openai)$')
    and runtime.json_matches(value -> 'authMode', '^subscription$')
    and runtime.json_string(value -> 'model', 256)
    and runtime.json_matches(value -> 'profileId', '^[a-z0-9][a-z0-9._-]{0,127}$')
    and runtime.json_matches(value -> 'credentialSlot', '^[a-z0-9][a-z0-9_-]{0,63}$');
end $$;

create function runtime.valid_operation_ref(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'runtime' then return runtime.json_keys(value, '{kind}');
    when 'model_attempt' then return runtime.json_keys(value, '{kind,attemptId}') and runtime.json_uuid(value -> 'attemptId');
    when 'tool_operation' then
      return runtime.json_keys(value, '{kind,operationId}') and runtime.json_digest(value -> 'operationId');
    else return false;
  end case;
end $$;

create function runtime.valid_failure(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  if not runtime.json_keys(value, '{category,reason,message,operation}', '{remediation,retryAfterSeconds}') then
    return false;
  end if;
  return runtime.json_matches(value -> 'category',
      '^(authorization|rate_or_quota_limit|provider_failure|step_limit|continuation_unavailable|tool_failure|runtime_failure)$')
    and runtime.json_code(value -> 'reason')
    and runtime.json_string(value -> 'message', 2048)
    and runtime.valid_operation_ref(value -> 'operation')
    and (not value ? 'remediation' or runtime.json_string(value -> 'remediation', 1024))
    and (not value ? 'retryAfterSeconds' or runtime.json_int(value -> 'retryAfterSeconds', 0, 604800));
end $$;

create function runtime.valid_run_state(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'working' then
      return runtime.json_keys(value, '{kind,invocationId,ownerEpoch}')
        and runtime.json_uuid(value -> 'invocationId') and runtime.json_positive_decimal(value -> 'ownerEpoch');
    when 'waiting' then
      return runtime.json_keys(value, '{kind,questionId,bindingDigest}')
        and runtime.json_digest(value -> 'questionId') and runtime.json_digest(value -> 'bindingDigest');
    when 'cancelling' then
      return runtime.json_keys(value, '{kind,cancellationId,acceptedAt}', '{invocationId}')
        and runtime.json_uuid(value -> 'cancellationId') and runtime.json_instant(value -> 'acceptedAt')
        and (not value ? 'invocationId' or runtime.json_uuid(value -> 'invocationId'));
    when 'succeeded' then
      return runtime.json_keys(value, '{kind,finishedAt,resultSeq}')
        and runtime.json_instant(value -> 'finishedAt') and runtime.json_positive_decimal(value -> 'resultSeq');
    when 'failed' then
      return runtime.json_keys(value, '{kind,finishedAt,failure}')
        and runtime.json_instant(value -> 'finishedAt') and runtime.valid_failure(value -> 'failure');
    when 'cancelled' then
      return runtime.json_keys(value, '{kind,finishedAt,cancellationId,acceptedAt}')
        and runtime.json_instant(value -> 'finishedAt') and runtime.json_uuid(value -> 'cancellationId')
        and runtime.json_instant(value -> 'acceptedAt');
    when 'interrupted' then
      return runtime.json_keys(value, '{kind,detectedAt,lastActivityAt,invocationId}')
        and runtime.json_instant(value -> 'detectedAt') and runtime.json_instant(value -> 'lastActivityAt')
        and runtime.json_uuid(value -> 'invocationId');
    else return false;
  end case;
end $$;

create function runtime.valid_question_input(value jsonb) returns boolean
language plpgsql immutable as $$
declare
  option_count integer;
begin
  case value ->> 'kind'
    when 'text' then
      return runtime.json_keys(value, '{kind,minLength,maxLength}')
        and runtime.json_int(value -> 'minLength', 0, 8192) and runtime.json_int(value -> 'maxLength', 1, 8192)
        and (value ->> 'minLength')::numeric <= (value ->> 'maxLength')::numeric;
    when 'choice' then
      if not runtime.json_keys(value, '{kind,multiple,options}', '{minSelections,maxSelections}')
        or jsonb_typeof(value -> 'multiple') <> 'boolean' or jsonb_typeof(value -> 'options') <> 'array' then
        return false;
      end if;
      option_count := jsonb_array_length(value -> 'options');
      if option_count not between 1 and 50 then return false; end if;
      if exists (
        select 1 from jsonb_array_elements(value -> 'options') o
        where not (runtime.json_keys(o, '{label,value}') and runtime.json_string(o -> 'label', 256)
          and runtime.json_is_scalar(o -> 'value'))
      ) then return false; end if;
      if (select count(distinct o -> 'value') from jsonb_array_elements(value -> 'options') o) <> option_count then
        return false;
      end if;
      if (value -> 'multiple') = 'false'::jsonb then
        return not (value ? 'minSelections' or value ? 'maxSelections');
      end if;
      return runtime.json_int(value -> 'minSelections', 0, option_count)
        and runtime.json_int(value -> 'maxSelections', 1, option_count)
        and (value ->> 'minSelections')::numeric <= (value ->> 'maxSelections')::numeric;
    else return false;
  end case;
end $$;

create function runtime.valid_question_binding(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  return runtime.json_keys(value,
      '{threadId,checkpointNs,checkpointId,taskId,interruptId,ordinal,operationId,payloadDigest,requiredStateDigest,definitionDigest}')
    and runtime.json_uuid(value -> 'threadId')
    and runtime.json_string(value -> 'checkpointNs', 512, true)
    and runtime.json_string(value -> 'checkpointId', 256)
    and runtime.json_string(value -> 'taskId', 256)
    and runtime.json_string(value -> 'interruptId', 256)
    and runtime.json_int(value -> 'ordinal', 0, 0)
    and runtime.json_digest(value -> 'operationId')
    and runtime.json_digest(value -> 'payloadDigest')
    and runtime.json_digest(value -> 'requiredStateDigest')
    and runtime.json_digest(value -> 'definitionDigest');
end $$;

create function runtime.valid_answer(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  if runtime.json_is_scalar(value) then return true; end if;
  return jsonb_typeof(value) = 'array'
    and not exists (select 1 from jsonb_array_elements(value) e where not runtime.json_is_scalar(e));
end $$;

create function runtime.valid_question_disposition(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'pending' then return runtime.json_keys(value, '{kind}');
    -- Presence of the answer property is required; its value may legitimately be false, null, 0 or empty.
    when 'answered' then
      return runtime.json_keys(value, '{kind,answer,acceptedAt,invocationId}')
        and runtime.valid_answer(value -> 'answer')
        and runtime.json_instant(value -> 'acceptedAt') and runtime.json_uuid(value -> 'invocationId');
    when 'closed' then
      return runtime.json_keys(value, '{kind,reason,closedAt}')
        and runtime.json_code(value -> 'reason') and runtime.json_instant(value -> 'closedAt');
    else return false;
  end case;
end $$;

create function runtime.valid_tool_disposition(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'started' then return runtime.json_keys(value, '{kind}');
    when 'paused' then return runtime.json_keys(value, '{kind,questionId}') and runtime.json_digest(value -> 'questionId');
    when 'completed' then
      return runtime.json_keys(value, '{kind,outcome,result}')
        and runtime.json_matches(value -> 'outcome', '^(ok|refused|error)$')
        and jsonb_typeof(value -> 'result') = 'object'
        and octet_length((value -> 'result')::text) <= 70000;
    when 'abandoned' then return runtime.json_keys(value, '{kind,reason}') and runtime.json_code(value -> 'reason');
    else return false;
  end case;
end $$;

create function runtime.valid_attempt_state(value jsonb) returns boolean
language plpgsql immutable as $$
begin
  case value ->> 'kind'
    when 'reserved' then return runtime.json_keys(value, '{kind}');
    when 'dispatched' then
      return runtime.json_keys(value, '{kind,dispatchedAt}') and runtime.json_instant(value -> 'dispatchedAt');
    when 'completed' then
      return runtime.json_keys(value, '{kind,dispatchedAt,completedAt,outcome}', '{providerRequestId}')
        and runtime.json_instant(value -> 'dispatchedAt') and runtime.json_instant(value -> 'completedAt')
        and runtime.json_matches(value -> 'outcome', '^(ok|failed)$')
        and (not value ? 'providerRequestId' or runtime.json_string(value -> 'providerRequestId', 256));
    when 'abandoned' then
      return runtime.json_keys(value, '{kind,reason,at}')
        and runtime.json_code(value -> 'reason') and runtime.json_instant(value -> 'at');
    when 'unconfirmed' then
      return runtime.json_keys(value, '{kind,detectedAt}') and runtime.json_instant(value -> 'detectedAt');
    else return false;
  end case;
end $$;

create function runtime.valid_event(kind text, payload jsonb) returns boolean
language plpgsql immutable as $$
begin
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
      return runtime.json_keys(payload, '{attemptId,ordinal,state,budget}')
        and runtime.json_uuid(payload -> 'attemptId') and runtime.json_int(payload -> 'ordinal', 1, 2147483647)
        and runtime.valid_attempt_state(payload -> 'state')
        and runtime.json_keys(payload -> 'budget', '{maximum,consumed,unconfirmed}')
        and runtime.json_int(payload #> '{budget,maximum}', 1, 2147483647)
        and runtime.json_int(payload #> '{budget,consumed}', 0, 2147483647)
        and runtime.json_int(payload #> '{budget,unconfirmed}', 0, 2147483647);
    when 'assistant.message' then
      return runtime.json_keys(payload, '{messageId,text}')
        and runtime.json_string(payload -> 'messageId', 256) and runtime.json_string(payload -> 'text', 1048576, true);
    when 'tool.operation' then
      return runtime.json_keys(payload, '{operationId,toolName,disposition}')
        and runtime.json_digest(payload -> 'operationId') and runtime.json_string(payload -> 'toolName', 128)
        and runtime.valid_tool_disposition(payload -> 'disposition');
    when 'question.asked' then
      return runtime.json_keys(payload, '{questionId,prompt,input}')
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
    else return false;
  end case;
end $$;

create function runtime.operation_id(run_id uuid, model_message_id text, provider_tool_call_id text) returns text
language sql immutable
return encode(sha256(convert_to(run_id::text || E'\n' || model_message_id || E'\n' || provider_tool_call_id, 'UTF8')), 'hex');

-- Tables ---------------------------------------------------------------------------------------------------------

create table runtime.execution_definitions (
  digest text primary key check (runtime.is_digest(digest)),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now()
);

create table runtime.runs (
  run_id uuid primary key,
  create_request_id uuid not null unique,
  input_digest text not null check (runtime.is_digest(input_digest)),
  goal text not null check (goal ~ '\S' and octet_length(goal) <= 8192),
  workspace jsonb not null check (runtime.valid_workspace(workspace)),
  binding jsonb not null check (runtime.valid_binding(binding)),
  definition_digest text not null references runtime.execution_definitions (digest),
  budget_max integer not null check (budget_max > 0),
  consumed integer not null default 0 check (consumed >= 0),
  unconfirmed integer not null default 0 check (unconfirmed >= 0),
  state jsonb not null check (runtime.valid_run_state(state)),
  state_kind text generated always as (state ->> 'kind') stored,
  state_invocation_id uuid generated always as (
    case when state ->> 'invocationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (state ->> 'invocationId')::uuid end) stored,
  state_question_id text generated always as (case when state ->> 'kind' = 'waiting' then state ->> 'questionId' end) stored,
  state_result_seq bigint generated always as (
    case when state ->> 'kind' = 'succeeded' and state ->> 'resultSeq' ~ '^[1-9][0-9]{0,17}$'
      then (state ->> 'resultSeq')::bigint end) stored,
  revision bigint not null default 0 check (revision >= 0),
  last_seq bigint not null default 0 check (last_seq >= 0),
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  check (consumed::bigint + unconfirmed::bigint <= budget_max)
);

create table runtime.invocations (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  invocation_id uuid not null,
  owner_epoch bigint not null check (owner_epoch > 0),
  kind text not null check (kind in ('initial', 'answer')),
  question_id text,
  started_at timestamptz not null default now(),
  disposition text not null check (disposition in ('active', 'settled', 'interrupted')),
  ended_at timestamptz,
  primary key (run_id, invocation_id),
  check ((kind = 'answer') = (question_id is not null)),
  check ((disposition = 'active') = (ended_at is null))
);
create unique index invocations_one_active on runtime.invocations (run_id) where disposition = 'active';

create table runtime.tool_operations (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  operation_id text not null check (runtime.is_digest(operation_id)),
  model_message_id text not null check (runtime.is_identifier(model_message_id)),
  provider_tool_call_id text not null check (runtime.is_identifier(provider_tool_call_id)),
  tool_name text not null check (char_length(tool_name) between 1 and 128),
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object'),
  argument_digest text not null check (runtime.is_digest(argument_digest)),
  disposition jsonb not null check (runtime.valid_tool_disposition(disposition)),
  created_at timestamptz not null default now(),
  primary key (run_id, operation_id),
  unique (run_id, provider_tool_call_id),
  check (operation_id = runtime.operation_id(run_id, model_message_id, provider_tool_call_id)),
  check (disposition ->> 'kind' <> 'paused' or disposition ->> 'questionId' = operation_id)
);

create table runtime.questions (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  question_id text not null check (runtime.is_digest(question_id)),
  operation_id text not null,
  prompt text not null check (char_length(prompt) between 1 and 16384),
  input jsonb not null check (runtime.valid_question_input(input)),
  binding jsonb not null check (runtime.valid_question_binding(binding)),
  payload_digest text not null check (runtime.is_digest(payload_digest)),
  binding_digest text not null check (runtime.is_digest(binding_digest)),
  disposition jsonb not null check (runtime.valid_question_disposition(disposition)),
  disposition_kind text generated always as (disposition ->> 'kind') stored,
  answer_invocation_id uuid generated always as (
    case when disposition ->> 'kind' = 'answered'
      and disposition ->> 'invocationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (disposition ->> 'invocationId')::uuid end) stored,
  created_at timestamptz not null default now(),
  primary key (run_id, question_id),
  check (question_id = operation_id),
  check (binding ->> 'threadId' = run_id::text),
  check (binding ->> 'operationId' = operation_id),
  check (binding ->> 'payloadDigest' = payload_digest),
  foreign key (run_id, operation_id) references runtime.tool_operations (run_id, operation_id)
    deferrable initially deferred,
  foreign key (run_id, answer_invocation_id) references runtime.invocations (run_id, invocation_id)
    deferrable initially deferred
);
create unique index questions_one_pending on runtime.questions (run_id) where disposition_kind = 'pending';

alter table runtime.invocations add foreign key (run_id, question_id)
  references runtime.questions (run_id, question_id) deferrable initially deferred;

create table runtime.model_attempts (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  attempt_id uuid not null,
  invocation_id uuid not null,
  ordinal integer not null check (ordinal > 0),
  provider text not null check (provider in ('anthropic', 'openai')),
  model text not null check (char_length(model) between 1 and 256),
  profile_id text not null check (char_length(profile_id) between 1 and 128),
  admitted_at timestamptz not null default now(),
  state jsonb not null check (runtime.valid_attempt_state(state)),
  state_kind text generated always as (state ->> 'kind') stored,
  primary key (run_id, attempt_id),
  unique (run_id, ordinal),
  foreign key (run_id, invocation_id) references runtime.invocations (run_id, invocation_id)
    deferrable initially deferred
);

create table runtime.events (
  run_id uuid not null references runtime.runs (run_id) deferrable initially deferred,
  seq bigint not null check (seq > 0),
  -- clock_timestamp(), not now(): sequences are allocated under the run lock, so the time of allocation (unlike the
  -- transaction start time) follows sequence order.
  recorded_at timestamptz not null default clock_timestamp(),
  kind text not null,
  payload jsonb not null,
  source_key text not null check (char_length(source_key) between 1 and 512),
  primary key (run_id, seq),
  unique (run_id, source_key),
  check (runtime.valid_event(kind, payload))
);

alter table runtime.runs
  add foreign key (run_id, state_invocation_id) references runtime.invocations (run_id, invocation_id)
    deferrable initially deferred,
  add foreign key (run_id, state_question_id) references runtime.questions (run_id, question_id)
    deferrable initially deferred,
  add foreign key (run_id, state_result_seq) references runtime.events (run_id, seq) deferrable initially deferred;

-- Immutability and transitions -----------------------------------------------------------------------------------

create function runtime.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'runtime records of this kind are immutable' using errcode = 'P0001', constraint = TG_TABLE_NAME || '_immutable';
end $$;

create trigger events_immutable before update or delete on runtime.events
  for each row execute function runtime.forbid_change();
create trigger execution_definitions_immutable before update or delete on runtime.execution_definitions
  for each row execute function runtime.forbid_change();
create trigger runs_no_delete before delete on runtime.runs for each row execute function runtime.forbid_change();
create trigger questions_no_delete before delete on runtime.questions for each row execute function runtime.forbid_change();
create trigger invocations_no_delete before delete on runtime.invocations
  for each row execute function runtime.forbid_change();
create trigger model_attempts_no_delete before delete on runtime.model_attempts
  for each row execute function runtime.forbid_change();
create trigger tool_operations_no_delete before delete on runtime.tool_operations
  for each row execute function runtime.forbid_change();

create function runtime.reject(message text) returns void language plpgsql as $$
begin
  raise exception '%', message using errcode = 'P0001';
end $$;

create function runtime.guard_run_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.create_request_id, new.input_digest, new.goal, new.workspace, new.binding,
      new.definition_digest, new.budget_max, new.created_at)
    is distinct from (old.run_id, old.create_request_id, old.input_digest, old.goal, old.workspace, old.binding,
      old.definition_digest, old.budget_max, old.created_at) then
    perform runtime.reject('run identity, input and budget maximum are immutable');
  end if;
  if old.state ->> 'kind' in ('succeeded', 'failed', 'cancelled', 'interrupted')
    and (new.state, new.consumed, new.unconfirmed) is distinct from (old.state, old.consumed, old.unconfirmed) then
    perform runtime.reject('a terminal run outcome is immutable');
  end if;
  if new.state is distinct from old.state and new.revision <= old.revision then
    perform runtime.reject('a state change must advance the run revision');
  end if;
  if new.revision < old.revision or new.last_seq < old.last_seq then
    perform runtime.reject('run revision and event sequence never decrease');
  end if;
  return new;
end $$;
create trigger runs_guard before update on runtime.runs for each row execute function runtime.guard_run_update();

create function runtime.guard_question_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.question_id, new.operation_id, new.prompt, new.input, new.binding, new.payload_digest,
      new.binding_digest, new.created_at)
    is distinct from (old.run_id, old.question_id, old.operation_id, old.prompt, old.input, old.binding,
      old.payload_digest, old.binding_digest, old.created_at) then
    perform runtime.reject('question content and binding are immutable');
  end if;
  if new.disposition is distinct from old.disposition and old.disposition ->> 'kind' <> 'pending' then
    perform runtime.reject('an answered or closed question cannot change');
  end if;
  return new;
end $$;
create trigger questions_guard before update on runtime.questions
  for each row execute function runtime.guard_question_update();

create function runtime.guard_invocation() returns trigger language plpgsql as $$
declare current_epoch bigint;
begin
  if tg_op = 'INSERT' then
    select epoch into current_epoch from runtime.runtime_owner where singleton = 1;
    if current_epoch is distinct from new.owner_epoch or new.disposition <> 'active' then
      perform runtime.reject('an invocation must start active under the current owner epoch');
    end if;
    return new;
  end if;
  if (new.run_id, new.invocation_id, new.owner_epoch, new.kind, new.question_id, new.started_at)
    is distinct from (old.run_id, old.invocation_id, old.owner_epoch, old.kind, old.question_id, old.started_at) then
    perform runtime.reject('invocation identity is immutable');
  end if;
  if new.disposition is distinct from old.disposition and old.disposition <> 'active' then
    perform runtime.reject('a settled or interrupted invocation cannot change');
  end if;
  return new;
end $$;
create trigger invocations_guard before insert or update on runtime.invocations
  for each row execute function runtime.guard_invocation();

create function runtime.guard_attempt_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.attempt_id, new.invocation_id, new.ordinal, new.provider, new.model, new.profile_id,
      new.admitted_at)
    is distinct from (old.run_id, old.attempt_id, old.invocation_id, old.ordinal, old.provider, old.model,
      old.profile_id, old.admitted_at) then
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
create trigger model_attempts_guard before update on runtime.model_attempts
  for each row execute function runtime.guard_attempt_update();

create function runtime.guard_tool_update() returns trigger language plpgsql as $$
begin
  if (new.run_id, new.operation_id, new.model_message_id, new.provider_tool_call_id, new.tool_name, new.arguments,
      new.argument_digest, new.created_at)
    is distinct from (old.run_id, old.operation_id, old.model_message_id, old.provider_tool_call_id, old.tool_name,
      old.arguments, old.argument_digest, old.created_at) then
    perform runtime.reject('tool operation identity is immutable');
  end if;
  if new.disposition is distinct from old.disposition and not coalesce(
    (old.disposition ->> 'kind' = 'started' and new.disposition ->> 'kind' in ('paused', 'completed', 'abandoned'))
    or (old.disposition ->> 'kind' = 'paused' and new.disposition ->> 'kind' in ('completed', 'abandoned')), false
  ) then
    perform runtime.reject('invalid tool operation transition');
  end if;
  return new;
end $$;
create trigger tool_operations_guard before update on runtime.tool_operations
  for each row execute function runtime.guard_tool_update();

-- Cross-row consistency, checked at commit -----------------------------------------------------------------------

create function runtime.check_run(p_run uuid) returns void language plpgsql as $$
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
      if r.state_kind = 'succeeded' and not exists (select 1 from runtime.events
          where run_id = p_run and seq = r.state_result_seq and kind = 'assistant.message') then
        perform runtime.reject('success must reference a recorded assistant result');
      end if;
      if r.state_kind = 'interrupted' and not exists (select 1 from runtime.invocations
          where run_id = p_run and invocation_id = r.state_invocation_id and disposition = 'interrupted') then
        perform runtime.reject('an interrupted run must reference its interrupted invocation');
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
end $$;

create function runtime.enforce_run_consistency() returns trigger language plpgsql as $$
begin
  perform runtime.check_run(new.run_id);
  return null;
end $$;

create constraint trigger runs_consistency after insert or update on runtime.runs
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger invocations_consistency after insert or update on runtime.invocations
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger questions_consistency after insert or update on runtime.questions
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger model_attempts_consistency after insert or update on runtime.model_attempts
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger tool_operations_consistency after insert or update on runtime.tool_operations
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
create constraint trigger events_consistency after insert on runtime.events
  deferrable initially deferred for each row execute function runtime.enforce_run_consistency();
`;
