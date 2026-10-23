// Text measurement shared by input validation and record decoders. Lengths declared by the owner or the agent
// (text-answer bounds, labels) count Unicode code points, as PostgreSQL char_length does; storage ceilings count
// UTF-8 bytes. JavaScript's String.length counts UTF-16 units and is used for neither.

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Text PostgreSQL can store faithfully: well-formed Unicode without NUL. Lone surrogates cannot be encoded as
 * UTF-8, and jsonb refuses U+0000, so such input is refused before it reaches storage rather than altered.
 */
export function isStorableText(text: string): boolean {
  return !text.includes('\u0000') && !LONE_SURROGATE.test(text);
}
