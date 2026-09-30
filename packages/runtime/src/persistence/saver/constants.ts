// Kept separate from the saver adapter so application code can name the schema without importing node-postgres.
export const SAVER_SCHEMA = 'checkpoints';
export const SAVER_POOL_MAX = 4;
export const SAVER_APPLICATION_NAME = 'agent-runtime/checkpoints';
