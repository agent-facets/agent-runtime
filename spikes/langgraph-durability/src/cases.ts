// The case matrix.
//
// Case definitions live here rather than in the driver shell so that the
// experiment is described once, in one language, and the driver is a generic
// executor over `main.ts cases`. Every case gets its own thread id (the case
// id), and every repeat gets its own database, so no thread is ever reused.

export type Durability = "sync" | "async" | "exit";
export type SaverKind = "postgres" | "memory";
export type ResumeMode =
  | "none"
  | "null"
  | "command"
  | "command-false"
  | "input"
  | "checkpoint-id";

export type AwaitCondition = {
  parkedNode?: string;
  /** Requires a pending interrupt at the ROOT HEAD, not anywhere in history. */
  interruptWrite?: boolean;
  minPendingWrites?: number;
  forbidNodeEnter?: string;
};

export type CaseDef = {
  id: string;
  role: "candidate" | "control";
  graph: "sequential" | "parallel" | "interrupt";
  durability: Durability;
  saver: SaverKind;
  /** Gate the first superstep's persistence with the wrapper saver. */
  gate: boolean;
  /** Primary parks after `invoke` returns, so a paused process can be killed. */
  holdAfterInvoke: boolean;
  kill: { signal: "KILL" | "TERM"; expectExit: number } | null;
  awaitCondition: AwaitCondition | null;
  resume: ResumeMode;
  mutate: "delete-writes" | null;
  /** In-process gate assertion instead of a graph run. */
  gateProbe: Durability | null;
  purpose: string;
};

const base = {
  role: "candidate" as const,
  saver: "postgres" as SaverKind,
  gate: false,
  holdAfterInvoke: false,
  kill: null,
  awaitCondition: null,
  resume: "none" as ResumeMode,
  mutate: null,
  gateProbe: null,
};

const KILL = { signal: "KILL" as const, expectExit: 137 };

export const CASES: CaseDef[] = [
  // --- goldens -------------------------------------------------------------
  {
    ...base,
    id: "seq-golden",
    role: "control",
    graph: "sequential",
    durability: "sync",
    purpose: "uninterrupted sequential run; the state every sequential resume must equal",
  },
  {
    ...base,
    id: "par-golden",
    role: "control",
    graph: "parallel",
    durability: "sync",
    purpose: "uninterrupted parallel run; the state the pending-write resume must equal",
  },
  {
    ...base,
    id: "int-golden",
    role: "control",
    graph: "interrupt",
    durability: "sync",
    resume: "command",
    purpose:
      "interrupt raised and resumed inside ONE process; also the negative control for the fresh-process witness",
  },

  // --- candidates ----------------------------------------------------------
  {
    ...base,
    id: "seq-crash",
    graph: "sequential",
    durability: "sync",
    kill: KILL,
    awaitCondition: { parkedNode: "work" },
    resume: "null",
    purpose: "SIGKILL mid-node, resume in a fresh container from persisted state alone",
  },
  {
    ...base,
    id: "par-crash",
    graph: "parallel",
    durability: "sync",
    kill: KILL,
    awaitCondition: { parkedNode: "blocked", minPendingWrites: 1, forbidNodeEnter: "finish" },
    resume: "null",
    purpose: "SIGKILL with one branch's write already durable; only the unfinished branch may rerun",
  },
  {
    ...base,
    id: "int-crash",
    graph: "interrupt",
    durability: "sync",
    holdAfterInvoke: true,
    kill: KILL,
    awaitCondition: { interruptWrite: true, parkedNode: "hold" },
    resume: "command",
    purpose: "SIGKILL while paused on a dynamic interrupt, then resume with a decision",
  },

  // --- characterisation ----------------------------------------------------
  {
    ...base,
    id: "int-false",
    role: "control",
    graph: "interrupt",
    durability: "sync",
    holdAfterInvoke: true,
    kill: KILL,
    awaitCondition: { interruptWrite: true, parkedNode: "hold" },
    resume: "command-false",
    purpose:
      "Command({resume:false}) on the pinned release: mapCommand branches on truthiness, so no resume write is emitted",
  },

  // --- durability modes ----------------------------------------------------
  {
    ...base,
    id: "gate-sync",
    role: "control",
    graph: "sequential",
    durability: "sync",
    gateProbe: "sync",
    purpose: "sync must not dispatch the next node while the superstep's persistence is held",
  },
  {
    ...base,
    id: "gate-async",
    role: "control",
    graph: "sequential",
    durability: "async",
    gateProbe: "async",
    purpose: "async dispatches the next node while persistence is still pending",
  },
  {
    ...base,
    id: "async-crash",
    role: "control",
    graph: "sequential",
    durability: "async",
    gate: true,
    kill: KILL,
    awaitCondition: { parkedNode: "work" },
    resume: "null",
    purpose: "the async crash window, measured: the next node ran but no loop checkpoint landed",
  },
  {
    ...base,
    id: "exit-crash",
    role: "control",
    graph: "sequential",
    durability: "exit",
    kill: KILL,
    awaitCondition: { parkedNode: "work" },
    resume: "null",
    purpose: "exit mode writes nothing mid-run, so a SIGKILL loses the entire run",
  },

  // --- anti-tautology controls --------------------------------------------
  {
    ...base,
    id: "mem-crash",
    role: "control",
    graph: "sequential",
    durability: "sync",
    saver: "memory",
    kill: KILL,
    awaitCondition: { parkedNode: "work" },
    resume: "null",
    purpose: "MemorySaver cannot survive process replacement; proves the checkpointer is load-bearing",
  },
  {
    ...base,
    id: "fake-resume",
    role: "control",
    graph: "sequential",
    durability: "sync",
    kill: KILL,
    awaitCondition: { parkedNode: "work" },
    resume: "input",
    purpose:
      "resubmitting the original input reaches the same final state; proves output equality alone is a tautology",
  },
  {
    ...base,
    id: "ckpt-id-resume",
    role: "control",
    graph: "parallel",
    durability: "sync",
    kill: KILL,
    awaitCondition: { parkedNode: "blocked", minPendingWrites: 1, forbidNodeEnter: "finish" },
    resume: "checkpoint-id",
    purpose: "an explicit checkpoint_id disables completed-task skipping, so the finished branch reruns",
  },
  {
    ...base,
    id: "delete-writes",
    role: "control",
    graph: "parallel",
    durability: "sync",
    kill: KILL,
    awaitCondition: { parkedNode: "blocked", minPendingWrites: 1, forbidNodeEnter: "finish" },
    mutate: "delete-writes",
    resume: "null",
    purpose: "removing the pending writes forces the finished branch to rerun; proves reuse is what skipped it",
  },
  {
    ...base,
    id: "sigterm",
    role: "control",
    graph: "sequential",
    durability: "sync",
    kill: { signal: "TERM", expectExit: 0 },
    awaitCondition: { parkedNode: "work" },
    resume: "null",
    purpose: "SIGTERM runs the shutdown handler; proves the kill witness distinguishes a crash from an exit",
  },
];

export function findCase(id: string): CaseDef {
  const found = CASES.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown case: ${id}`);
  return found;
}
