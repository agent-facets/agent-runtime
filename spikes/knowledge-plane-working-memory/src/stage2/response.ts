// The bounded response envelope.
//
// A model returns one JSON object and nothing else. Parsing is strict and
// failures are classified rather than repaired: a response that could not be
// parsed is a measured outcome of that arm on that turn, not a transport problem
// to be retried away. Silently re-asking until the shape is right would let an
// arm that produces malformed output look identical to one that does not.

export type AgentResponse = {
  decision: string;
  actionsTaken: string[];
  constraintsApplied: string[];
  factsUsed: string[];
  references: string[];
  uncertainties: string[];
  needsHumanDecision: boolean;
  humanQuestion: string | null;
  rationale: string;
};

export type ParseOutcome =
  | { ok: true; response: AgentResponse; repaired: "none" | "fence_stripped" }
  | { ok: false; reason: "not_json" | "not_object" | "missing_field" | "wrong_type"; detail: string };

const REQUIRED_STRING_ARRAYS = [
  "actionsTaken",
  "constraintsApplied",
  "factsUsed",
  "references",
  "uncertainties",
] as const;

/**
 * Strip a markdown fence, and nothing else.
 *
 * The one repair permitted, because a fence is a formatting habit rather than a
 * failure of the decision, and it is detectable without interpreting content.
 * Every other malformation is reported as-is.
 */
function stripFence(text: string): { body: string; stripped: boolean } {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (match && match[1] !== undefined) return { body: match[1].trim(), stripped: true };
  return { body: trimmed, stripped: false };
}

export function parseResponse(text: string): ParseOutcome {
  const { body, stripped } = stripFence(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, reason: "not_json", detail: (error as Error).message.slice(0, 200) };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object", detail: typeof parsed };
  }

  const source = parsed as Record<string, unknown>;

  for (const field of ["decision", "rationale"]) {
    if (typeof source[field] !== "string") {
      return { ok: false, reason: "missing_field", detail: field };
    }
  }
  if (typeof source.needsHumanDecision !== "boolean") {
    return { ok: false, reason: "wrong_type", detail: "needsHumanDecision" };
  }
  for (const field of REQUIRED_STRING_ARRAYS) {
    const value = source[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      return { ok: false, reason: "wrong_type", detail: field };
    }
  }

  const humanQuestion = source.humanQuestion;
  if (humanQuestion !== null && typeof humanQuestion !== "string") {
    return { ok: false, reason: "wrong_type", detail: "humanQuestion" };
  }

  return {
    ok: true,
    repaired: stripped ? "fence_stripped" : "none",
    response: {
      decision: source.decision as string,
      actionsTaken: source.actionsTaken as string[],
      constraintsApplied: source.constraintsApplied as string[],
      factsUsed: source.factsUsed as string[],
      references: source.references as string[],
      uncertainties: source.uncertainties as string[],
      needsHumanDecision: source.needsHumanDecision as boolean,
      humanQuestion: (humanQuestion ?? null) as string | null,
      rationale: source.rationale as string,
    },
  };
}

/** Every field a matcher may search, lowercased once. */
export function searchableText(response: AgentResponse): {
  all: string;
  asserted: string;
  constraints: string;
} {
  const parts = [
    response.decision,
    ...response.actionsTaken,
    ...response.constraintsApplied,
    ...response.factsUsed,
    ...response.references,
    ...response.uncertainties,
    response.humanQuestion ?? "",
    response.rationale,
  ];
  return {
    all: parts.join(" \n ").toLowerCase(),
    // What the response ASSERTS, excluding hedged or escalated material. A value
    // named only under uncertainty has not been promoted to a local fact.
    asserted: [
      response.decision,
      ...response.actionsTaken,
      ...response.constraintsApplied,
      ...response.factsUsed,
    ]
      .join(" \n ")
      .toLowerCase(),
    constraints: [response.constraintsApplied.join(" "), response.decision, response.rationale]
      .join(" \n ")
      .toLowerCase(),
  };
}
