// The N-party rendezvous.
//
// Spike 05's latch was two-party and release-driven: a node parked, the driver
// polled for the parked row, and killed. It cannot express "all four setup
// callers have opened a connection and none has issued DDL yet", which is the
// precondition every concurrency claim in this spike rests on.
//
// The proof that participants overlapped is a row set, not a promise. Arrivals
// are persisted before the release row exists and are ordered by a bigserial, so
// "all arrived before release" is answerable from the table alone. A separate
// backend sample taken while the parties are parked is the second, independent
// witness: it can see overlap that the arrival timestamps alone could not
// distinguish from a fast sequence.

import type { Db } from "./db.ts";
import { PROBE_SCHEMA, TIMEOUTS } from "./contract.ts";

export type Arrival = {
  seq: string;
  party: number;
  role: string;
  process_nonce: string;
  backend_pid: number;
  txid: string | null;
  arrived_at: string;
};

export type BarrierRecord = {
  name: string;
  partiesExpected: number;
  partiesArrived: number;
  arrivals: Arrival[];
  /** Every arrival is strictly older than the release. */
  allArrivedBeforeRelease: boolean;
  distinctBackends: number;
  distinctNonces: number;
  /** Peak distinct parties observed attached while the barrier was unreleased. */
  peakConcurrentParties: number;
  arrivalOrderParties: number[];
  releasedAt: string | null;
};

export async function arm(
  db: Db,
  caseId: string,
  name: string,
  parties: number,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.barrier (case_id, name, parties)
     VALUES ($1, $2, $3)
     ON CONFLICT (case_id, name) DO NOTHING`,
    [caseId, name, parties],
  );
}

export async function arrive(
  db: Db,
  caseId: string,
  name: string,
  party: number,
  role: string,
  nonce: string,
  txid: string | null = null,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.barrier_arrival
       (case_id, name, party, role, process_nonce, txid)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (case_id, name, party) DO NOTHING`,
    [caseId, name, party, role, nonce, txid],
  );
}

export async function waitForRelease(
  db: Db,
  caseId: string,
  name: string,
  timeoutMs = TIMEOUTS.barrierWaitMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.pool.query<{ released: boolean }>(
      `SELECT released FROM ${PROBE_SCHEMA}.barrier WHERE case_id = $1 AND name = $2`,
      [caseId, name],
    );
    if (rows[0]?.released) return;
    if (Date.now() > deadline) {
      throw new Error(`barrier ${name} was never released within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.barrierPollMs));
  }
}

/**
 * Distinct PARTIES currently attached, not connections: a participant opens
 * several pools, so counting backends would report overlap that does not exist.
 * Coordinator and observer names do not match `:p%` and are excluded by shape.
 */
async function participantParties(db: Db, caseId: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(DISTINCT split_part(application_name, '#', 1))::text AS count
       FROM pg_stat_activity
      WHERE application_name LIKE $1
        AND pid <> pg_backend_pid()`,
    [`${caseId}:p%`],
  );
  return Number(rows[0]?.count ?? "0");
}

export async function waitForArrivals(
  db: Db,
  caseId: string,
  name: string,
  parties: number,
  timeoutMs = TIMEOUTS.barrierArrivalMs,
): Promise<{ arrivals: Arrival[]; peakConcurrentParties: number }> {
  const deadline = Date.now() + timeoutMs;
  let peak = 0;
  for (;;) {
    const { rows } = await db.pool.query<Arrival>(
      `SELECT seq::text AS seq, party, role, process_nonce::text AS process_nonce,
              backend_pid, txid::text AS txid, arrived_at::text AS arrived_at
         FROM ${PROBE_SCHEMA}.barrier_arrival
        WHERE case_id = $1 AND name = $2
        ORDER BY seq`,
      [caseId, name],
    );
    peak = Math.max(peak, await participantParties(db, caseId));
    if (rows.length >= parties) return { arrivals: rows, peakConcurrentParties: peak };
    if (Date.now() > deadline) {
      throw new Error(
        `barrier ${name}: only ${rows.length} of ${parties} parties arrived within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.barrierPollMs));
  }
}

export async function release(db: Db, caseId: string, name: string): Promise<string | null> {
  const { rows } = await db.pool.query<{ released_at: string }>(
    `UPDATE ${PROBE_SCHEMA}.barrier
        SET released = true, released_at = clock_timestamp()
      WHERE case_id = $1 AND name = $2
      RETURNING released_at::text AS released_at`,
    [caseId, name],
  );
  return rows[0]?.released_at ?? null;
}

export function summariseBarrier(
  name: string,
  partiesExpected: number,
  arrivals: Arrival[],
  peakConcurrentParties: number,
  releasedAt: string | null,
): BarrierRecord {
  const allBefore =
    releasedAt !== null &&
    arrivals.length === partiesExpected &&
    arrivals.every((arrival) => Date.parse(arrival.arrived_at) < Date.parse(releasedAt));

  return {
    name,
    partiesExpected,
    partiesArrived: arrivals.length,
    arrivals,
    allArrivedBeforeRelease: allBefore,
    distinctBackends: new Set(arrivals.map((a) => a.backend_pid)).size,
    distinctNonces: new Set(arrivals.map((a) => a.process_nonce)).size,
    peakConcurrentParties,
    // Volatile and retained verbatim: deleting it would hide serialisation,
    // digesting it would destroy reproducibility. It is excluded from the
    // managed digest instead.
    arrivalOrderParties: arrivals.map((a) => a.party),
    releasedAt,
  };
}
