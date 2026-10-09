import { describe, expect, test } from 'bun:test';
import { checkInputSchema, compileArgumentValidator, type SchemaRefusal } from './schema.ts';

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...extra,
});

describe('closed input-schema profile', () => {
  test('accepts the supported subset, including SDK-generated dialect annotations', () => {
    for (const schema of [
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          repository: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['repository'],
      },
      object({}, { additionalProperties: false }),
      object({ labels: { type: 'array', items: { type: 'string', maxLength: 50 }, minItems: 0, maxItems: 10 } }),
      object({ owner: object({ login: { type: 'string' } }, { required: ['login'] }) }),
      object({
        state: { type: 'string', enum: ['open', 'closed'], default: 'open', title: 'State', description: 'x' },
      }),
      object({ draft: { type: 'boolean', const: false }, note: { type: ['string', 'null'] } }),
      object({ ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } }),
      { type: 'object' },
    ]) {
      expect(checkInputSchema(schema)).toEqual({ ok: true });
    }
  });

  test('refuses references, composition, conditionals, patterns, formats and unknown keywords', () => {
    const cases: [unknown, SchemaRefusal][] = [
      [object({ a: { $ref: '#/$defs/a' } }, { $defs: { a: { type: 'string' } } }), 'schema_keyword_unsupported'],
      [object({ a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }), 'schema_type_unsupported'],
      [object({ a: { type: 'string', anyOf: [{ minLength: 1 }] } }), 'schema_keyword_unsupported'],
      [object({}, { allOf: [{ required: ['a'] }] }), 'schema_keyword_unsupported'],
      [object({}, JSON.parse('{"if":{"required":["a"]},"then":{"required":["b"]}}')), 'schema_keyword_unsupported'],
      [object({ a: { type: 'string', pattern: '^x' } }), 'schema_keyword_unsupported'],
      [object({ a: { type: 'string', format: 'uri' } }), 'schema_keyword_unsupported'],
      [object({}, { patternProperties: { '^x': { type: 'string' } } }), 'schema_keyword_unsupported'],
      [object({}, { additionalProperties: { type: 'string' } }), 'schema_keyword_unsupported'],
      [object({ a: { type: 'array', items: [{ type: 'string' }] } }), 'schema_value_invalid'],
      [object({ a: { type: 'string', 'x-unknown': true } }), 'schema_keyword_unsupported'],
      [object({ a: { type: 'string', minimum: 1 } }), 'schema_keyword_unsupported'],
      [object({ a: { type: ['string', 'number'] } }), 'schema_type_unsupported'],
      [
        object({ a: { type: 'string', $schema: 'http://json-schema.org/draft-07/schema#' } }),
        'schema_keyword_unsupported',
      ],
      [{ ...object({}), $schema: 'https://evil.example/schema' }, 'schema_keyword_unsupported'],
      [object({}, { $id: 'urn:x' }), 'schema_keyword_unsupported'],
      [object({ a: { type: 'string', enum: [{ nested: true }] } }), 'schema_value_invalid'],
      [object({ a: { type: 'string', maxLength: -1 } }), 'schema_value_invalid'],
      [{ type: 'array', items: { type: 'string' } }, 'schema_not_object'],
      ['{"type":"object"}', 'schema_not_object'],
    ];
    for (const [schema, reason] of cases) expect(checkInputSchema(schema)).toEqual({ ok: false, reason });
  });

  test('bounds depth and property count', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < 9; level++) deep = object({ child: deep });
    expect(checkInputSchema(deep)).toEqual({ ok: false, reason: 'schema_too_deep' });
    const wide = object(
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`p${index}`, { type: 'string' }])),
    );
    expect(checkInputSchema(wide)).toEqual({ ok: false, reason: 'schema_too_many_properties' });
  });
});

describe('argument validation against the approved schema', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      repository: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      state: { type: 'string', enum: ['open', 'closed'] },
    },
    required: ['repository'],
    additionalProperties: false,
  };

  test('enforces the schema without coercion and leaves the arguments and schema untouched', () => {
    const before = structuredClone(schema);
    const validate = compileArgumentValidator(schema);
    expect(schema).toEqual(before);
    const args = { repository: 'owner/repo-a' };
    expect(validate(args)).toBe(true);
    // A default is an annotation: it is not inserted.
    expect(args).toEqual({ repository: 'owner/repo-a' });
    for (const invalid of [
      { repository: 'owner/repo-a', limit: '3' },
      { repository: 'owner/repo-a', limit: 6 },
      { repository: 'owner/repo-a', state: 'merged' },
      { repository: 'owner/repo-a', extra: true },
      { repository: '' },
      {},
    ]) {
      const copy = structuredClone(invalid);
      expect(validate(invalid)).toBe(false);
      expect(invalid).toEqual(copy);
    }
  });

  test('refuses to compile a schema outside the profile', () => {
    expect(() => compileArgumentValidator(object({ a: { $ref: '#/x' } }))).toThrow('outside the supported profile');
  });
});
