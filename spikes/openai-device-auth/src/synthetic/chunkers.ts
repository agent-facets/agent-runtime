// Adversarial chunking.
//
// A response parser that only works when SSE events arrive whole is a parser
// that works in testing and fails on a real network. The one-byte and
// delimiter-straddling chunkers are the ones that matter: they break any
// implementation that scans decoded text for a pattern without buffering
// across chunk boundaries.

export type Chunker = {
  id: string;
  split: (payload: string) => Uint8Array[];
};

const encoder = new TextEncoder();

export const CHUNKERS: readonly Chunker[] = [
  {
    id: "whole-body",
    split: (payload) => [encoder.encode(payload)],
  },
  {
    id: "one-event-per-chunk",
    split: (payload) =>
      payload
        .split(/(?<=\n\n)/)
        .filter((part) => part.length > 0)
        .map((part) => encoder.encode(part)),
  },
  {
    id: "one-byte",
    split: (payload) => [...encoder.encode(payload)].map((byte) => Uint8Array.of(byte)),
  },
  {
    id: "delimiter-straddling",
    split: (payload) => {
      // Cut exactly between the two newlines that terminate each event so no
      // chunk ever contains a complete delimiter.
      const bytes = encoder.encode(payload);
      const out: Uint8Array[] = [];
      let start = 0;
      for (let index = 0; index < bytes.length - 1; index += 1) {
        if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
          out.push(bytes.subarray(start, index + 1));
          start = index + 1;
        }
      }
      out.push(bytes.subarray(start));
      return out.filter((chunk) => chunk.length > 0);
    },
  },
];
