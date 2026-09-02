// The proposed `effect_key`, read from runtime config and reconstructed from raw rows.
//
// `architecture/09-data-model-and-lifecycle.md:106` proposes
//
//     effect_key = hash(run, ns, parent_checkpoint, task, ordinal,
//                       tool, canonical_args)
//
// and rests two claims on it that the same document marks "assumed, not
// measured": that the key is STABLE across a crash resume, so a redelivered run
// does not repeat its side effects, and that it CHANGES across a genuine fork,
// so a deliberate replay does. This module exists to turn both into
// measurements.
//
// It is an ARCHITECTURE construct, not a vendor one. LangGraph publishes no
// effect key and promises nothing about one; every component below is either
// something the runtime supplies itself (`tool`, `canonical_args`, `ordinal`) or
// something the runtime has to scavenge out of the config the engine hands a
// node. Reporting any of this as a vendor guarantee would be a category error.
//
// Two oracle classes, deliberately independent:
//
//   config side  what a node can see about itself while it runs, which is what a
//                real effect wrapper would have to work from.
//   row side     `checkpoint_writes` read directly, which is what the ledger's
//                claims would actually have to be reconciled against later.
//
// They are NOT the same values, and the difference is a finding rather than a
// harness detail — see `graphNamespaceFor` below.

import { createHash } from "node:crypto";

import { stable } from "./canonical.ts";
import type { Probe } from "./probe.ts";

/**
 * The private key the engine uses to hand a task its own id
 * (`CONFIG_KEY_TASK_ID` in the pinned release). Named here rather than imported
 * because it is not exported from the package's public surface: a runtime that
 * wants the task id has to reach for a `__pregel_`-prefixed key the vendor is
 * free to rename in any release. Recorded so the report can say so precisely.
 */
const CONFIG_TASK_ID = "__pregel_task_id";

/**
 * The per-namespace map of ancestor checkpoint ids
 * (`CONFIG_KEY_CHECKPOINT_MAP`). Undocumented, but NOT private-prefixed, and it
 * is the only place inside a running task where the parent checkpoint id
 * survives — the engine sets `configurable.checkpoint_id` to `undefined` when it
 * builds a task's config.
 */
const CONFIG_CHECKPOINT_MAP = "checkpoint_map";

export type ConfigurableView = Record<string, unknown>;

export function configurableOf(config: unknown): ConfigurableView {
  const record = (config ?? {}) as { configurable?: unknown };
  return (record.configurable ?? {}) as ConfigurableView;
}

/**
 * The namespace a task's WRITES are stored under, as opposed to the namespace
 * the task itself runs in.
 *
 * These differ, and the difference matters to anyone reconstructing a key later.
 * The engine gives a task `checkpoint_ns = <graph ns> + <node>:<task id>`, but
 * `PregelLoop.putWrites` stores the row under the GRAPH's namespace. So a key
 * built from `config.configurable.checkpoint_ns` cannot be rediscovered by
 * reading `checkpoint_writes`, and — because the task namespace embeds the task
 * id — such a key would also make the `ns` and `task` components redundant with
 * each other.
 *
 * Derived here without parsing the vendor's separators, which the plan forbids
 * depending on: the graph namespace is whichever `checkpoint_map` key is the
 * longest prefix of the task namespace. `""` is a prefix of everything, so a
 * root-level task resolves to the root entry and nothing needs to know that `|`
 * and `:` are the separators of the day.
 */
export function graphNamespaceFor(
  taskNamespace: string,
  checkpointMap: Record<string, unknown>,
): string | null {
  const candidates = Object.keys(checkpointMap).filter(
    (key) => taskNamespace === key || taskNamespace.startsWith(key),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, key) => (key.length > longest.length ? key : longest), "");
}

export type EffectKeyComponents = {
  /** The run identity. This harness uses one thread per case, so: the thread. */
  run: string | null;
  /** The namespace the task's writes land under, NOT the task's own namespace. */
  ns: string | null;
  parentCheckpoint: string | null;
  task: string | null;
  /** Which effect this is within one execution of one node. Runtime-supplied. */
  ordinal: number;
  tool: string;
  canonicalArgs: string;
};

export type EffectRecord = EffectKeyComponents & {
  key: string;
  /**
   * What the node actually sees as `checkpoint_ns`. Retained separately because
   * it is NOT what the row carries, and a report that conflated them would be
   * describing a key nobody can reconstruct.
   */
  taskNamespace: string | null;
  /**
   * `configurable.checkpoint_id` as seen from inside the task. The engine clears
   * it deliberately, so this is expected to be null — which is precisely why the
   * parent checkpoint has to come from `checkpoint_map`.
   */
  configCheckpointId: string | null;
  /**
   * Whether `checkpoint_id` is PRESENT as a key, regardless of its value.
   *
   * Not the same question as `configCheckpointId`, and the difference decides
   * real behaviour: `PregelLoop.initialize` computes
   * `skipDoneTasks = !("checkpoint_id" in config.configurable)`, an `in` test,
   * while `_prepareSingleTask` builds every task's config with
   * `checkpoint_id: undefined`. A present-but-undefined key therefore reads as
   * "this is an explicit replay" to any loop initialised from a task's config —
   * which is exactly what a subgraph is.
   */
  configHasCheckpointIdKey: boolean;
  checkpointMapKeys: string[];
  /** Whether the task id was only reachable through the `__pregel_` private key. */
  taskIdFromPrivateKey: boolean;
  /**
   * Ablations. Each drops exactly one component, so a case can show that the
   * component is load-bearing by making the ablated key collide where the full
   * key does not. Without them "the keys differ" never distinguishes a key that
   * needs all seven parts from one that would work with three.
   */
  keyWithoutTask: string;
  keyWithoutOrdinal: string;
  keyWithoutNs: string;
  keyWithoutParent: string;
};

function hashComponents(parts: unknown[]): string {
  return createHash("sha256").update(stable(parts)).digest("hex");
}

/**
 * Reads every proposed component out of the config the engine handed this node,
 * and derives the key plus its four single-component ablations.
 *
 * `canonical_args` is `stable()` rather than `JSON.stringify` on purpose: an
 * argument object whose keys arrive in a different order is the same call, and a
 * key that said otherwise would defeat deduplication for a reason that has
 * nothing to do with the orchestrator.
 */
export function readEffectComponents(
  config: unknown,
  effect: { tool: string; args: unknown; ordinal: number },
): EffectRecord {
  const configurable = configurableOf(config);
  const taskNamespace = typeof configurable.checkpoint_ns === "string"
    ? configurable.checkpoint_ns
    : null;
  const checkpointMap = (configurable[CONFIG_CHECKPOINT_MAP] ?? {}) as Record<string, unknown>;
  const ns = taskNamespace === null ? null : graphNamespaceFor(taskNamespace, checkpointMap);
  const parentRaw = ns === null ? undefined : checkpointMap[ns];

  const components: EffectKeyComponents = {
    run: typeof configurable.thread_id === "string" ? configurable.thread_id : null,
    ns,
    parentCheckpoint: typeof parentRaw === "string" ? parentRaw : null,
    task: typeof configurable[CONFIG_TASK_ID] === "string"
      ? (configurable[CONFIG_TASK_ID] as string)
      : null,
    ordinal: effect.ordinal,
    tool: effect.tool,
    canonicalArgs: stable(effect.args),
  };

  const full = [
    components.run,
    components.ns,
    components.parentCheckpoint,
    components.task,
    components.ordinal,
    components.tool,
    components.canonicalArgs,
  ];

  return {
    ...components,
    key: hashComponents(full),
    taskNamespace,
    configCheckpointId: typeof configurable.checkpoint_id === "string"
      ? configurable.checkpoint_id
      : null,
    configHasCheckpointIdKey: "checkpoint_id" in configurable,
    checkpointMapKeys: Object.keys(checkpointMap).sort(),
    taskIdFromPrivateKey:
      configurable[CONFIG_TASK_ID] !== undefined && configurable.task_id === undefined,
    keyWithoutTask: hashComponents([
      components.run,
      components.ns,
      components.parentCheckpoint,
      components.ordinal,
      components.tool,
      components.canonicalArgs,
    ]),
    keyWithoutOrdinal: hashComponents([
      components.run,
      components.ns,
      components.parentCheckpoint,
      components.task,
      components.tool,
      components.canonicalArgs,
    ]),
    keyWithoutNs: hashComponents([
      components.run,
      components.parentCheckpoint,
      components.task,
      components.ordinal,
      components.tool,
      components.canonicalArgs,
    ]),
    keyWithoutParent: hashComponents([
      components.run,
      components.ns,
      components.task,
      components.ordinal,
      components.tool,
      components.canonicalArgs,
    ]),
  };
}

/**
 * Records one proposed effect to the independent probe.
 *
 * The probe write is autocommit on a connection the checkpointer does not own,
 * so an effect recorded by a superstep that never commits still leaves a trace —
 * which is the entire point when the question is whether a re-executed node
 * computes the SAME key it computed before it died.
 *
 * Nothing here deduplicates. A ledger would; this is the instrument that
 * measures whether a ledger COULD.
 */
export async function recordEffect(
  witness: Probe,
  config: unknown,
  effect: { tool: string; args: unknown; ordinal: number; node: string },
): Promise<EffectRecord> {
  const record = readEffectComponents(config, effect);
  await witness.record(effect.node, "effect", { ...record });
  return record;
}
