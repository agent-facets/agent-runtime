import { jsonText } from '../persistence/json.ts';

/** JSON with object keys sorted recursively and arrays in order; the basis of every content digest. */
export function canonicalJson(value: unknown): string {
  jsonText(value);
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/**
 * Event sequences and cursors are PostgreSQL bigints carried as decimal strings. They are compared as BigInt and
 * never converted to JavaScript numbers, which lose precision above 2^53.
 */
export function parseSequence(text: string): bigint {
  if (!DECIMAL.test(text)) throw new RangeError('sequence must be a non-negative decimal string');
  const value = BigInt(text);
  if (value > MAX_BIGINT) throw new RangeError('sequence exceeds the PostgreSQL bigint range');
  return value;
}
