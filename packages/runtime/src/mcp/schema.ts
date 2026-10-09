// The closed input-schema profile for MCP tools (design Decision 5). An advertised schema is checked structurally
// against a small, enforceable subset before anything compiles it: object roots, scalar types (with a nullable
// pair), nested objects, homogeneous arrays, `required`, closed or open objects, enum/const and numeric, string and
// array bounds. Annotations are kept but never applied: a default is not inserted, a title changes nothing.
// References, composition, conditionals, patterns, formats and any keyword not listed here are refused, so approval
// covers exactly what validation enforces. Validation uses the raw approved schema and the original arguments.
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CAPABILITY_LIMITS, schemaShape } from '../capabilities/records.ts';

export type SchemaRefusal =
  | 'schema_not_object'
  | 'schema_keyword_unsupported'
  | 'schema_type_unsupported'
  | 'schema_value_invalid'
  | 'schema_too_deep'
  | 'schema_too_many_properties';

const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);
const TYPES = new Set([...SCALARS, 'object', 'array', 'null']);
const ANNOTATIONS = new Set(['title', 'description', 'default']);
const BY_TYPE: Record<string, Set<string>> = {
  object: new Set(['properties', 'required', 'additionalProperties']),
  array: new Set(['items', 'minItems', 'maxItems']),
  string: new Set(['minLength', 'maxLength']),
  number: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  boolean: new Set(),
  null: new Set(),
};
const SCHEMA_URIS = new Set([
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft/2020-12/schema',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = (value: unknown) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/** The schema's declared types: one type, or a scalar paired with `null`. */
function typesOf(node: Record<string, unknown>): string[] | SchemaRefusal {
  const type = node.type;
  if (typeof type === 'string') return TYPES.has(type) ? [type] : 'schema_type_unsupported';
  if (Array.isArray(type) && type.length === 2 && new Set(type).size === 2 && type.includes('null')) {
    const other = type.find((entry) => entry !== 'null');
    return typeof other === 'string' && SCALARS.has(other) ? (type as string[]) : 'schema_type_unsupported';
  }
  return 'schema_type_unsupported';
}

function checkNode(node: unknown, root: boolean): SchemaRefusal | undefined {
  if (!isRecord(node)) return 'schema_value_invalid';
  const types = typesOf(node);
  if (typeof types === 'string') return types;
  const allowed = new Set([
    ...ANNOTATIONS,
    'type',
    'enum',
    'const',
    ...types.flatMap((type) => [...(BY_TYPE[type] ?? [])]),
  ]);
  if (root) allowed.add('$schema');
  for (const key of Object.keys(node)) if (!allowed.has(key)) return 'schema_keyword_unsupported';

  for (const key of ['title', 'description'] as const) {
    if (node[key] !== undefined && typeof node[key] !== 'string') return 'schema_value_invalid';
  }
  if (node.$schema !== undefined && (typeof node.$schema !== 'string' || !SCHEMA_URIS.has(node.$schema))) {
    return 'schema_keyword_unsupported';
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0 || !node.enum.every(isScalar))) {
    return 'schema_value_invalid';
  }
  if (node.const !== undefined && !isScalar(node.const)) return 'schema_value_invalid';
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (node[key] !== undefined && !(typeof node[key] === 'number' && Number.isFinite(node[key])))
      return 'schema_value_invalid';
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (node[key] !== undefined && !isCount(node[key])) return 'schema_value_invalid';
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    return 'schema_keyword_unsupported';
  }
  if (node.required !== undefined) {
    const required = node.required;
    if (
      !Array.isArray(required) ||
      !required.every((name) => typeof name === 'string') ||
      new Set(required).size !== required.length
    ) {
      return 'schema_value_invalid';
    }
  }
  if (node.properties !== undefined) {
    if (!isRecord(node.properties)) return 'schema_value_invalid';
    for (const child of Object.values(node.properties)) {
      const refused = checkNode(child, false);
      if (refused !== undefined) return refused;
    }
  }
  if (node.items !== undefined) {
    // One schema for every element; tuple forms are not part of the profile.
    const refused = checkNode(node.items, false);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/** Whether an advertised input schema is inside the closed profile and its size bounds. */
export function checkInputSchema(schema: unknown): { ok: true } | { ok: false; reason: SchemaRefusal } {
  if (!isRecord(schema) || schema.type !== 'object') return { ok: false, reason: 'schema_not_object' };
  const refused = checkNode(schema, true);
  if (refused !== undefined) return { ok: false, reason: refused };
  const shape = schemaShape(schema);
  if (shape.depth > CAPABILITY_LIMITS.schemaDepth) return { ok: false, reason: 'schema_too_deep' };
  if (shape.properties > CAPABILITY_LIMITS.schemaProperties) return { ok: false, reason: 'schema_too_many_properties' };
  return { ok: true };
}

export type ArgumentValidator = (args: Record<string, unknown>) => boolean;

// The SDK's public AJV validator: no coercion, no defaults inserted and no extra properties removed.
const validator = new AjvJsonSchemaValidator();

/**
 * A validator for arguments against an approved schema, which must already have passed `checkInputSchema`. The
 * dialect annotation is not operative and is left out of compilation; the approved schema itself is not changed.
 */
export function compileArgumentValidator(schema: Record<string, unknown>): ArgumentValidator {
  const checked = checkInputSchema(schema);
  if (!checked.ok) throw new TypeError(`schema outside the supported profile: ${checked.reason}`);
  const { $schema: _dialect, ...operative } = structuredClone(schema);
  const validate = validator.getValidator(operative as Parameters<typeof validator.getValidator>[0]);
  return (args) => validate(args).valid;
}
