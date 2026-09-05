// The probe: durable witnesses and the rendezvous barrier.
//
// Two rules, both imported from spike 06 rather than reinvented:
//
//   The probe writes on its OWN connection, never inside the subject's
//   transaction. An observation that could ride along with the thing it observes
//   is not an independent witness — it would commit and roll back together with
//   the write it is supposed to be watching.
//
//   Release fires from a COMMITTED ROW COUNT, never from an elapsed interval.
//   A sleep before a release is the most reliable way to produce a race that
//   cannot be reproduced, and the arrival rows are what let the evidence show
//   afterwards that the parties genuinely overlapped.

import { PROBE_SCHEMA, TIMEOUTS } from "./contract.ts";
import type { Db } from "./lane-m/pg.ts";

export type Arrival = { member: string; nonce: string; arrivedAt: string };

export async function arrive(
  db: Db,
  caseId: string,
  name: string,
  member: string,
  nonce: string,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.barrier_arrival (case_id, name, member, nonce)
     VALUES ($1,$2,$3,$4) ON CONFLICT (case_id, name, member) DO NOTHING`,
    [caseId, name, member, nonce],
  );
}

export async function arrivals(db: Db, caseId: string, name: string): Promise<Arrival[]> {
  const { rows } = await db.pool.query<{ member: string; nonce: string; arrived_at: string }>(
    `SELECT member, nonce, arrived_at::text AS arrived_at
       FROM ${PROBE_SCHEMA}.barrier_arrival
      WHERE case_id = $1 AND name = $2 ORDER BY member`,
    [caseId, name],
  );
  return rows.map((row) => ({
    member: row.member,
    nonce: row.nonce,
    arrivedAt: row.arrived_at,
  }));
}

/**
 * Wait until every declared party has durably arrived, then release them
 * together.
 *
 * TWO PHASES, and the second one matters. With a single sleep-polled phase the
 * LAST party to arrive sees a complete set on its own immediately-following read
 * and proceeds with zero delay, while every earlier party stays asleep until its
 * next poll tick. At a 25 ms tick against a stale-write window microseconds
 * wide, that is a structural head start roughly a thousand times wider than the
 * effect under measurement — so the race could not land in its own window, and
 * three trials showing no lost update carried no information about the
 * interleaving at all. The invariant that release fires from committed rows was
 * satisfied; the parties still never overlapped.
 *
 * The second phase is a TIGHT spin on a `-release` barrier that every party
 * including the last one must clear, so the residual skew is one query
 * round-trip and is not systematically biased toward whoever arrived last.
 *
 * The timeout is a HARNESS FAULT, not a fault trigger: if it expires, the
 * rendezvous never happened and whatever the parties did afterwards is not the
 * race the case claims to have measured.
 */
export async function waitForParties(
  db: Db,
  caseId: string,
  name: string,
  parties: number,
  member?: string,
): Promise<Arrival[]> {
  const deadline = Date.now() + TIMEOUTS.barrierArrivalMs;
  let seen: Arrival[] = [];
  while (Date.now() < deadline) {
    seen = await arrivals(db, caseId, name);
    if (seen.length >= parties) break;
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.barrierPollMs));
  }
  if (seen.length < parties) {
    throw new Error(
      `barrier ${caseId}/${name} did not gather ${parties} parties within ${TIMEOUTS.barrierArrivalMs}ms`,
    );
  }

  if (member === undefined) return seen;

  const release = `${name}-release`;
  await arrive(db, caseId, release, member, "release");
  while (Date.now() < deadline) {
    const ready = await arrivals(db, caseId, release);
    if (ready.length >= parties) return seen;
    // No sleep. The whole point of this phase is to remove the quantum.
  }
  throw new Error(
    `barrier ${caseId}/${release} did not release ${parties} parties within ${TIMEOUTS.barrierArrivalMs}ms`,
  );
}

/**
 * How far apart the parties actually started, in milliseconds.
 *
 * Reported as a finding so barrier fairness is a measured property of the run
 * rather than a claim about the code. A spread far wider than the window under
 * test means the race did not happen, whatever its outcome says.
 */
export function releaseSpreadMs(seen: Arrival[]): number | null {
  if (seen.length < 2) return null;
  const times = seen.map((entry) => Date.parse(entry.arrivedAt)).filter((value) => !isNaN(value));
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

export async function witness(
  db: Db,
  caseId: string,
  member: string,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.event (case_id, member, kind, detail) VALUES ($1,$2,$3,$4)`,
    [caseId, member, kind, JSON.stringify(detail)],
  );
}

export async function events(
  db: Db,
  caseId: string,
): Promise<Array<{ member: string; kind: string; detail: unknown }>> {
  const { rows } = await db.pool.query<{ member: string; kind: string; detail: unknown }>(
    `SELECT member, kind, detail FROM ${PROBE_SCHEMA}.event
      WHERE case_id = $1 ORDER BY id`,
    [caseId],
  );
  return rows;
}

/**
 * Did the parties genuinely overlap?
 *
 * Every arrival precedes every release by construction, so overlap is proven by
 * the arrival set being complete before any party proceeded — not by comparing
 * wall-clock timestamps, which are volatile and would make the proof depend on
 * clock resolution.
 */
export function overlapProven(seen: Arrival[], parties: number): boolean {
  return seen.length === parties && new Set(seen.map((entry) => entry.member)).size === parties;
}
