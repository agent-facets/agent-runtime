// Turning the frozen mutation script into contract requests.
//
// Shared by both lanes so neither can receive a differently shaped request. The
// script declares intent; this module supplies the envelope the contract
// requires — actor, authorization intent, idempotency key, stale guard, and the
// deterministic tick — and nothing else.

import { createHash } from "node:crypto";

import { tickToInstant } from "./contract.ts";
import type {
  Actor,
  CommandRequest,
  EffectClass,
  Ref,
  StaleGuard,
} from "./knowledge/contract.ts";
import { CONTRACT_VERSION } from "./knowledge/contract.ts";
import type { Corpus, Mutation } from "./corpus.ts";

const EFFECT_CLASS: Record<string, EffectClass> = {
  RegisterSourceRef: "additive",
  CreateEntity: "additive",
  CreateClaim: "additive",
  AssertRelationship: "additive",
  LinkEvidence: "additive",
  ReinforceClaim: "additive",
  RecordContradiction: "additive",
  SummarizeClaims: "additive",
  CreateWorkItem: "additive",
  PutActiveContext: "additive",
  IngestPeerActivity: "additive",
  OpenCandidateFromPeerReport: "additive",
  CorrectEntity: "corrective",
  CorrectClaim: "corrective",
  SupersedeClaim: "corrective",
  ReviseRelationship: "corrective",
  InvalidateRelationship: "corrective",
  ResolveConflict: "corrective",
  UpdateWorkItem: "corrective",
  MergeEntities: "destructive",
  RetractClaim: "destructive",
  CanonizeClaim: "authority",
  DecanonizeClaim: "authority",
  PublishActivityRecord: "publish",
};

const ACTORS: Record<string, Actor> = {
  agent: {
    actorId: "agent.coder@node.ada",
    actorClass: "agent",
    nodeId: "node.ada",
    onBehalfOf: null,
  },
  human: { actorId: "ada", actorClass: "human", nodeId: "node.ada", onBehalfOf: null },
  peer: {
    actorId: "agent.coder@node.bo",
    actorClass: "peer_publisher",
    nodeId: "node.bo",
    onBehalfOf: null,
  },
};

/** Refs a command touches, used as the declared blast radius. */
function scopeFor(mutation: Mutation): Ref[] {
  const args = mutation.args as Record<string, unknown>;
  const refs: Ref[] = [];
  const push = (kind: Ref["kind"], id: unknown): void => {
    if (typeof id === "string") refs.push({ kind, id });
  };
  push("source", args.sourceRefId);
  push("entity", args.entityId);
  push("entity", args.survivorId);
  push("entity", args.mergedId);
  push("claim", args.claimId);
  push("relationship", args.relationshipId);
  push("contradiction", args.contradictionId);
  push("active_context", args.activeContextId);
  if (mutation.cmd === "PublishActivityRecord") push("activity_record", args.recordId);
  if (mutation.cmd === "IngestPeerActivity") push("activity_record", args.recordId);
  if (mutation.cmd === "OpenCandidateFromPeerReport") push("claim", args.candidateId);
  for (const target of (args.summarizes as string[]) ?? []) refs.push({ kind: "claim", id: target });
  return refs;
}

export function idempotencyKey(mutation: Mutation): string {
  return createHash("sha256")
    .update(JSON.stringify({ t: mutation.t, cmd: mutation.cmd, args: mutation.args }))
    .digest("hex")
    .slice(0, 32);
}

export type GuardResolver = (ref: Ref) => string | null;

/**
 * Build the request.
 *
 * `useStaleToken` is honoured literally: the caller supplies the token it read
 * BEFORE the intervening update, which is the whole point of the stale-write
 * case. Nothing here silently refreshes it.
 */
export function requestFor(
  mutation: Mutation,
  corpus: Corpus,
  versionOf: GuardResolver,
  staleTokens: Map<string, string>,
): CommandRequest {
  const actor = ACTORS[mutation.actor ?? "agent"] ?? ACTORS.agent!;
  const effectClass = EFFECT_CLASS[mutation.cmd] ?? "additive";

  let guard: StaleGuard = { mode: "unguarded", reason: `${mutation.cmd} is additive` };
  if (mutation.guard?.mode === "expected_version" && mutation.guard.target) {
    const target = mutation.guard.target;
    const kind: Ref["kind"] = target.startsWith("ent:")
      ? "entity"
      : target.startsWith("rel:")
        ? "relationship"
        : "claim";
    const ref: Ref = { kind, id: target };
    const expected = mutation.guard.useStaleToken
      ? (staleTokens.get(target) ?? "<no-token-was-ever-observed>")
      : (versionOf(ref) ?? "<absent>");
    guard = { mode: "expected_version", targets: [{ ref, expected }] };
  }

  const args: Record<string, unknown> = { ...mutation.args };

  // Records the policy needs in full are materialised from the corpus here, so
  // the script stays a list of intentions rather than a copy of the fixture.
  if (mutation.cmd === "RegisterSourceRef") {
    const source = corpus.sources.find((entry) => entry.id === args.sourceRefId);
    if (source) {
      args.record = {
        sourceRefId: source.id,
        system: source.system,
        externalId: source.externalId,
        uri: source.uri,
        contentHash: null,
        sourceAuthority: source.sourceAuthority,
        publisherNodeId: null,
        sensitivity: source.sensitivity,
        visibility: source.visibility,
      };
    }
  }
  if (mutation.cmd === "CreateEntity") {
    const entity = corpus.entities.find((entry) => entry.id === args.entityId);
    if (entity) {
      args.record = {
        entityId: entity.id,
        kind: entity.kind,
        canonicalName: entity.canonicalName,
        aliases: entity.aliases,
        mergedInto: null,
        sensitivity: entity.sensitivity,
        visibility: entity.visibility,
        versionToken: "",
      };
    }
  }
  if (mutation.cmd === "IngestPeerActivity") {
    const record = corpus.peerRecords.find((entry) => entry.recordId === args.recordId);
    if (record) args.record = record;
  }
  if (mutation.cmd === "PublishActivityRecord") {
    args.record = { ...mutation.args, publisherNodeId: String(args.recordId).split("/")[0] };
  }
  if (mutation.cmd === "PutActiveContext") {
    args.record = { ...mutation.args };
  }

  return {
    contractVersion: CONTRACT_VERSION,
    command: mutation.cmd as CommandRequest["command"],
    actor,
    intent: {
      effectClass,
      scope: scopeFor(mutation),
      decisionRef: (mutation.args as { decisionId?: string }).decisionId ?? null,
      justification: mutation.note ?? "",
    },
    idempotency: { key: idempotencyKey(mutation), keyScope: "global" },
    guard,
    tick: mutation.t,
    args,
  };
}

export function instantFor(mutation: Mutation): string {
  return tickToInstant(mutation.t);
}
