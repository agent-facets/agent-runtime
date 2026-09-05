// The neutral token estimator.
//
// Budgets are enforced in neutral tokens, not provider tokens. Two providers
// tokenise differently, so a provider-native budget would admit a different
// number of facts on Anthropic than on OpenAI and confound the model-class
// comparison with the treatment itself.
//
// Provider-reported usage is still recorded — it is the cost measurement — but
// it never decides what goes into a context.

/** Pinned before any live call. A change to this constant changes every budget. */
export const ESTIMATOR_ID = "neutral-bytes-div4/1";

export function neutralTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function neutralTokensOf(parts: readonly string[]): number {
  let total = 0;
  for (const part of parts) total += neutralTokens(part);
  return total;
}
