// The official PostgreSQL checkpointer is the only approved user of node-postgres. Application records
// never use this pool; it exists solely so the saver's pool limits and error handling are owned here.
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { PersistenceError } from '../errors.ts';
import { SAVER_APPLICATION_NAME, SAVER_POOL_MAX, SAVER_SCHEMA } from './constants.ts';

const CONNECT_TIMEOUT_MS = 5_000;

export interface CheckpointStore {
  readonly saver: PostgresSaver;
  /** Runs the official saver migrations. Callers must hold the migration lock. */
  setup(): Promise<void>;
  /** Current saver pool occupancy, for budget verification. */
  poolStats(): { total: number; idle: number; waiting: number };
  /** Ends the saver and its pool. */
  close(): Promise<void>;
}

export interface CheckpointStoreOptions {
  url: string;
  /** Called at most once for an idle or checked-out client error; the saver operation itself still rejects. */
  onFault: (error: PersistenceError) => void;
}

export function createCheckpointStore(options: CheckpointStoreOptions): CheckpointStore {
  let closing = false;
  let faulted = false;
  const fault = () => {
    if (closing || faulted) return;
    faulted = true;
    options.onFault(new PersistenceError('checkpoint_pool_error', 'a checkpoint database connection failed'));
  };

  const pool = new pg.Pool({
    connectionString: options.url,
    max: SAVER_POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: SAVER_APPLICATION_NAME,
  });
  // Idle client errors reach the pool; a checked-out client's errors reach only that client.
  pool.on('error', fault);
  pool.on('connect', (client) => {
    client.on('error', fault);
  });

  const saver = new PostgresSaver(pool, undefined, { schema: SAVER_SCHEMA });
  return {
    saver,
    setup: () => saver.setup(),
    poolStats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    async close() {
      closing = true;
      // Ends the supplied pool; it is not ended separately.
      await saver.end();
    },
  };
}
