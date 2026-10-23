// Text admission and line handling for workspace reads and search. A file is text only if every byte is valid
// UTF-8 and it contains no NUL; the check covers the whole admitted file, not just the lines returned. A leading
// UTF-8 byte-order mark is not part of line 1.

const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Line boundaries: LF separates lines, a CR before the LF is not part of the line, a final newline does not start
 * another line, and an empty file has no lines. Yields [start, end) offsets without building an array.
 */
export function* lineSpans(text: string): Generator<[number, number]> {
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    yield [start, end > start && text.charCodeAt(end - 1) === 13 && newline >= 0 ? end - 1 : end];
    if (newline < 0) return;
    start = newline + 1;
  }
}

const encoder = new TextEncoder();

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function clipToBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = char.codePointAt(0) as number;
    const width = size < 0x80 ? 1 : size < 0x800 ? 2 : size < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += char.length;
  }
  return text.slice(0, end);
}
