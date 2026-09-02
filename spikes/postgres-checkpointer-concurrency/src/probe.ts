// The independent execution witness and the harness's own schema.
//
// This is NOT an idempotency ledger. It has no unique constraint and suppresses
// nothing: every execution of every node is recorded, including the replays the
// engine is expected to perform. Deduplicating here would erase the exact
// finding the spike exists to measure.
//
// Two properties make it a valid witness:
//   1. It is written on a connection the subject does not own, in autocommit, so
//      a probe row survives a transaction that never commits.
//   2. Nothing it records is a graph state channel, so it cannot be restored
//      from a checkpoint and mistaken for a fresh execution.
//
// Workers share no file, no volume, no tmpfs and no socket. The only thing two
// containers have in common is this database, which is what makes "fresh
// process" structurally true rather than asserted.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { PROBE_SCHEMA } from "./contract.ts";

export const PROBE_DDL = `
CREATE SCHEMA IF NOT EXISTS ${PROBE_SCHEMA};

CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.event (
  id            bigserial PRIMARY KEY,
  case_id       text        NOT NULL,
  party         integer     NOT NULL DEFAULT -1,
  role          text        NOT NULL,
  thread_id     text        NOT NULL DEFAULT '',
  process_nonce uuid        NOT NULL,
  node          text        NOT NULL,
  phase         text        NOT NULL,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  txid          bigint      NOT NULL DEFAULT txid_current(),
  backend_pid   integer     NOT NULL DEFAULT pg_backend_pid(),
  app_name      text        NOT NULL DEFAULT current_setting('application_name'),
  observed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Armed by the coordinator BEFORE any participant starts, so a late arrival is
-- detectable rather than invisible.
CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.barrier (
  case_id     text        NOT NULL,
  name        text        NOT NULL,
  parties     integer     NOT NULL,
  released    boolean     NOT NULL DEFAULT false,
  armed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (case_id, name)
);

CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.barrier_arrival (
  seq           bigserial   NOT NULL,
  case_id       text        NOT NULL,
  name          text        NOT NULL,
  party         integer     NOT NULL,
  role          text        NOT NULL,
  process_nonce uuid        NOT NULL,
  backend_pid   integer     NOT NULL DEFAULT pg_backend_pid(),
  txid          bigint,
  arrived_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (case_id, name, party)
);

-- Durable because the in-memory statement log dies with a SIGKILLed process,
-- and a kill case's whole claim is which vendor statement boundary it stopped at.
CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.gate_park (
  id          bigserial PRIMARY KEY,
  case_id     text        NOT NULL,
  party       integer     NOT NULL,
  gate        text        NOT NULL,
  position    text        NOT NULL,
  statement   text        NOT NULL,
  ordinal     integer     NOT NULL,
  backend_pid integer     NOT NULL DEFAULT pg_backend_pid(),
  parked_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz
);

-- A harness-owned table used to construct deliberate row-level conflicts, so the
-- lock-graph inspector can be validated against a conflict whose cause is known.
CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.conflict (
  key   text PRIMARY KEY,
  value text NOT NULL
);
`;

export type Probe = {
  /** Per-process identity. Random by necessity: it must not be reproducible. */
  nonce: string;
  caseId: string;
  party: number;
  role: string;
  record(node: string, phase: string, detail?: Record<string, unknown>): Promise<void>;
};

export function createProbe(db: Db, caseId: string, party: number, role: string): Probe {
  const nonce = randomUUID();

  const record = async (
    node: string,
    phase: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    await db.pool.query(
      `INSERT INTO ${PROBE_SCHEMA}.event
         (case_id, party, role, process_nonce, node, phase, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [caseId, party, role, nonce, node, phase, JSON.stringify(detail)],
    );
  };

  return { nonce, caseId, party, role, record };
}
