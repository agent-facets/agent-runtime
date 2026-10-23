// Canonical JSON (recursively sorted object keys, arrays in order) and SHA-256, matching the runtime's encoding so
// exports and sealed bundles have one byte representation for one value.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, '$'));
}

function sortKeys(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => sortKeys(item, `${path}[${index}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key], `${path}.${key}`)]),
    );
  }
  throw new TypeError(`${path} is not JSON data`);
}

/** The bytes written for a canonical document: canonical JSON followed by one newline. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}
