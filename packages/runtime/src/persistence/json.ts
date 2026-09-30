// Bun SQL returns a jsonb `null` as JavaScript null (indistinguishable from SQL NULL) and binds a JavaScript
// string as a JSON string. Application records therefore cross the driver boundary as JSON text only:
// write with `${jsonText(value)}::text::jsonb`, read with `column::text` and `parseJsonText`.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class JsonEncodingError extends Error {
  override readonly name = 'JsonEncodingError';
}

function assertJson(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonEncodingError(`${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJson(item, `${path}[${index}]`);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`);
    return;
  }
  throw new JsonEncodingError(`${path} is not a JSON value`);
}

/** Serializes a value that must already be plain JSON; `undefined`, non-finite numbers and class instances are refused. */
export function jsonText(value: unknown): string {
  assertJson(value, '$');
  return JSON.stringify(value);
}

export function parseJsonText(text: unknown): JsonValue {
  if (typeof text !== 'string') throw new JsonEncodingError('expected JSON text from the database');
  return JSON.parse(text) as JsonValue;
}
