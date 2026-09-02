// Deterministic local embeddings.
//
// A frozen lookup table, never an algorithm. Text absent from the fixture is a
// hard error rather than a hashed fallback: a fallback would be an algorithm,
// and an algorithm sharing any logic with the search path under test would make
// the ranking oracle circular.
//
// Every call is counted so "the Store embedded the query once per search" is a
// measured fact rather than an assumption — relevant to hybrid search, which
// could plausibly embed twice.

import { embeddingFixture } from "../contract.ts";

export type EmbeddingLog = {
  documents: string[];
  queries: string[];
};

export type DeterministicEmbeddings = {
  dims: number;
  log: EmbeddingLog;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export class UnknownEmbeddingTextError extends Error {
  constructor(text: string) {
    super(`no fixture vector for text: ${JSON.stringify(text)}`);
    this.name = "UnknownEmbeddingTextError";
  }
}

export function createEmbeddings(): DeterministicEmbeddings {
  const { dims, vectors } = embeddingFixture();
  const log: EmbeddingLog = { documents: [], queries: [] };

  const lookup = (text: string): number[] => {
    const vector = vectors[text];
    if (!vector) throw new UnknownEmbeddingTextError(text);
    return vector;
  };

  return {
    dims,
    log,
    embedDocuments: async (texts: string[]) => {
      log.documents.push(...texts);
      return texts.map(lookup);
    },
    embedQuery: async (text: string) => {
      log.queries.push(text);
      return lookup(text);
    },
  };
}
