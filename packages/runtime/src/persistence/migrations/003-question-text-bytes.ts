// Question text limits in UTF-8 bytes. Migration 2 counted prompt characters, which lets a multibyte prompt exceed
// the specified 16 KiB. Existing rows are checked as the constraints are added: a database holding a question that
// violates them fails this migration (and startup) rather than having recorded history rewritten.

export const QUESTION_TEXT_BYTES_SQL = `
-- Mirrors questionTextBytes() in records/schemas.ts: prompt, option labels and string option values.
create function runtime.question_text_bytes(prompt text, input jsonb) returns bigint
language sql immutable
return octet_length(prompt) + coalesce((
  select sum(octet_length(o ->> 'label') + case when jsonb_typeof(o -> 'value') = 'string'
    then octet_length(o ->> 'value') else 0 end)
  from jsonb_array_elements(case when jsonb_typeof(input -> 'options') = 'array' then input -> 'options'
    else '[]'::jsonb end) o), 0);

alter table runtime.questions
  add constraint questions_prompt_bytes check (octet_length(prompt) <= 16384),
  add constraint questions_text_bytes check (runtime.question_text_bytes(prompt, input) <= 65536);

alter table runtime.events
  add constraint events_question_text_bytes check (
    kind <> 'question.asked' or (
      octet_length(payload ->> 'prompt') <= 16384
      and runtime.question_text_bytes(payload ->> 'prompt', payload -> 'input') <= 65536));
`;
