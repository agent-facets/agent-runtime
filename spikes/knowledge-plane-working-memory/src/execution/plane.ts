// The execution plane.
//
// Postgres in BOTH lanes, deliberately. Work-item identity, run attempts, and
// the idempotency ledger are execution concerns, and giving them to whichever
// store happens to be canonical for knowledge would turn the comparison into a
// question about who owns the ledger. Holding them constant is what keeps the
// measured difference a difference about knowledge.
//
// The ledger is canonical and is NOT rebuildable from knowledge: a replayed
// command must return its stored receipt verbatim, and a reconstructed receipt
// would make a replay indistinguishable from a second execution.

import { EXECUTION_SCHEMA } from "../contract.ts";
import type { CommandResponse } from "../knowledge/contract.ts";
import type { Corpus } from "../corpus.ts";
import type { Db } from "../lane-m/pg.ts";

export type LedgerEntry = {
  key: string;
  command: string;
  requestHash: string;
  response: CommandResponse;
  committedTick: number;
};

export class ExecutionPlane {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Seed work items and attempts from the corpus.
   *
   * Identical bytes for both lanes, applied outside the knowledge contract on
   * purpose: a work item is given by the fixture, not derived by a knowledge
   * command, and routing it through the contract would let one lane's
   * persistence shape the execution plane the other one shares.
   */
  async seed(corpus: Corpus): Promise<{ workItems: number; attempts: number }> {
    let attempts = 0;
    for (const item of corpus.workItems) {
      await this.db.pool.query(
        `INSERT INTO ${EXECUTION_SCHEMA}.work_item (work_item_id, title, intent, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (work_item_id) DO UPDATE
           SET title = EXCLUDED.title, intent = EXCLUDED.intent`,
        [item.id, item.title, item.intent, "open"],
      );
      for (let index = 0; index < item.attempts.length; index += 1) {
        const attempt = item.attempts[index];
        if (!attempt) continue;
        const carried =
          item.handoff && item.handoff.toRun === attempt.id ? item.handoff.carriedConstraints : [];
        await this.db.pool.query(
          `INSERT INTO ${EXECUTION_SCHEMA}.run_attempt
             (run_id, work_item_id, ordinal, actor_id, outcome, carried_constraints)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (run_id) DO UPDATE
             SET outcome = EXCLUDED.outcome,
                 carried_constraints = EXCLUDED.carried_constraints`,
          [attempt.id, item.id, index + 1, attempt.actor, attempt.outcome, carried],
        );
        attempts += 1;
      }
    }
    return { workItems: corpus.workItems.length, attempts };
  }

  async lookup(key: string): Promise<LedgerEntry | null> {
    const { rows } = await this.db.pool.query<{
      key: string;
      command: string;
      request_hash: string;
      response: CommandResponse;
      committed_tick: number;
    }>(
      `SELECT key, command, request_hash, response, committed_tick
         FROM ${EXECUTION_SCHEMA}.idempotency WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      key: row.key,
      command: row.command,
      requestHash: row.request_hash,
      response: row.response,
      committedTick: row.committed_tick,
    };
  }

  async record(entry: LedgerEntry, keyScope: string): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO ${EXECUTION_SCHEMA}.idempotency
         (key, key_scope, command, request_hash, response, committed_tick)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO NOTHING`,
      [
        entry.key,
        keyScope,
        entry.command,
        entry.requestHash,
        JSON.stringify(entry.response),
        entry.committedTick,
      ],
    );
  }

  async openIntent(
    intentId: string,
    command: string,
    files: string[],
    ops: unknown,
    tick: number,
  ): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO ${EXECUTION_SCHEMA}.mutation_intent
         (intent_id, command, files, ops, state, opened_tick)
       VALUES ($1,$2,$3,$4,'pending',$5)
       ON CONFLICT (intent_id) DO NOTHING`,
      [intentId, command, files, JSON.stringify(ops), tick],
    );
  }

  async completeIntent(intentId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${EXECUTION_SCHEMA}.mutation_intent SET state = 'complete' WHERE intent_id = $1`,
      [intentId],
    );
  }

  async pendingIntents(): Promise<Array<{ intentId: string; command: string }>> {
    const { rows } = await this.db.pool.query<{ intent_id: string; command: string }>(
      `SELECT intent_id, command FROM ${EXECUTION_SCHEMA}.mutation_intent
        WHERE state = 'pending' ORDER BY intent_id`,
    );
    return rows.map((row) => ({ intentId: row.intent_id, command: row.command }));
  }

  async counts(): Promise<{ workItems: number; attempts: number; ledger: number }> {
    const { rows } = await this.db.pool.query<{
      work_items: string;
      attempts: string;
      ledger: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ${EXECUTION_SCHEMA}.work_item)::text   AS work_items,
         (SELECT count(*) FROM ${EXECUTION_SCHEMA}.run_attempt)::text AS attempts,
         (SELECT count(*) FROM ${EXECUTION_SCHEMA}.idempotency)::text AS ledger`,
    );
    const row = rows[0];
    return {
      workItems: Number(row?.work_items ?? "0"),
      attempts: Number(row?.attempts ?? "0"),
      ledger: Number(row?.ledger ?? "0"),
    };
  }
}
