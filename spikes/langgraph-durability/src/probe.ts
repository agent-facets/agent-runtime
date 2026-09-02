// The independent execution witness.
//
// This is NOT an idempotency ledger. It has no unique constraint and suppresses
// nothing: every execution of every node is recorded, including the replays the
// engine is expected to perform. Deduplicating here would erase the exact
// finding the spike exists to measure.
//
// Two properties make it a valid witness:
//
//   1. It is written on a connection the graph does not own, in autocommit, so
//      a probe row survives a checkpoint that never commits.
//   2. Nothing it records is a graph state channel, so it cannot be restored
//      from a checkpoint and mistaken for a fresh execution.
//
// The latch table is the synchronisation substrate. Workers share no file, no
// volume, no tmpfs and no socket — the only thing two containers have in common
// is this database, which is what makes "fresh process" structurally true.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { PROBE_SCHEMA, TIMEOUTS } from "./contract.ts";

export const PROBE_DDL = `
CREATE SCHEMA IF NOT EXISTS ${PROBE_SCHEMA};

CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.event (
  id            bigserial PRIMARY KEY,
  thread_id     text        NOT NULL,
  case_id       text        NOT NULL,
  stage         text        NOT NULL,
  process_nonce uuid        NOT NULL,
  node          text        NOT NULL,
  phase         text        NOT NULL,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  txid          bigint      NOT NULL DEFAULT txid_current(),
  backend_pid   integer     NOT NULL DEFAULT pg_backend_pid(),
  app_name      text        NOT NULL DEFAULT current_setting('application_name'),
  observed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.latch (
  thread_id text    NOT NULL,
  name      text    NOT NULL,
  released  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (thread_id, name)
);
`;

export type Probe = {
  /** Per-process identity. Random by necessity: it must not be reproducible. */
  nonce: string;
  /**
   * Per-execution identity that IS reproducible.
   *
   * Used where a value has to distinguish one execution from another and also
   * survive into the managed digest — a random value there would make every
   * repeat differ and destroy the reproducibility claim, while a constant would
   * distinguish nothing.
   */
  label: string;
  record(node: string, phase: string, detail?: Record<string, unknown>): Promise<void>;
  waitLatch(name: string, timeoutMs?: number): Promise<void>;
  releaseAllLatches(): Promise<void>;
};

export function createProbe(db: Db, threadId: string, caseId: string, stage: string): Probe {
  const nonce = randomUUID();
  const label = `${caseId}:${stage}`;

  const record = async (
    node: string,
    phase: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    await db.pool.query(
      `INSERT INTO ${PROBE_SCHEMA}.event
         (thread_id, case_id, stage, process_nonce, node, phase, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [threadId, caseId, stage, nonce, node, phase, JSON.stringify(detail)],
    );
  };

  return {
    nonce,
    label,
    record,

    /**
     * Park until the named latch is released, recording the parked phase first.
     *
     * The recorded row is what the driver waits on before killing, so the kill
     * is anchored to observed database state rather than to a sleep. A sleep
     * before a kill is the single most common way this class of experiment
     * produces a result that cannot be reproduced.
     */
    waitLatch: async (name: string, timeoutMs = TIMEOUTS.latchWaitMs): Promise<void> => {
      await db.pool.query(
        `INSERT INTO ${PROBE_SCHEMA}.latch (thread_id, name, released)
         VALUES ($1, $2, false)
         ON CONFLICT (thread_id, name) DO NOTHING`,
        [threadId, name],
      );
      await record(name, "parked");

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // The wildcard row matters: a control or resume stage releases latches
        // BEFORE invoking, which is before the node has created its own row.
        // Without it, the release would update nothing and the node would then
        // insert a fresh unreleased latch and park forever.
        const { rows } = await db.pool.query<{ released: boolean | null }>(
          `SELECT bool_or(released) AS released
             FROM ${PROBE_SCHEMA}.latch
            WHERE thread_id = $1 AND name IN ($2, '*')`,
          [threadId, name],
        );
        if (rows[0]?.released) {
          await record(name, "released");
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`latch ${name} was never released within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.latchPollMs));
      }
    },

    releaseAllLatches: async (): Promise<void> => {
      await db.pool.query(
        `INSERT INTO ${PROBE_SCHEMA}.latch (thread_id, name, released)
         VALUES ($1, '*', true)
         ON CONFLICT (thread_id, name) DO UPDATE SET released = true`,
        [threadId],
      );
      await db.pool.query(
        `UPDATE ${PROBE_SCHEMA}.latch SET released = true WHERE thread_id = $1`,
        [threadId],
      );
    },
  };
}
