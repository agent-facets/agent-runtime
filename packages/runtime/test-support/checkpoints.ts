// Synthetic checkpoint inputs for integration suites. Test-only: not part of the runtime build.
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { CheckpointStore } from '../src/persistence/saver/checkpoint-saver.ts';

export function putSyntheticCheckpoint(store: CheckpointStore, threadId: string) {
  return store.saver.put(
    { configurable: { thread_id: threadId, checkpoint_ns: '' } },
    emptyCheckpoint(),
    { source: 'input', step: -1, parents: {} },
    {},
  );
}

export function readCheckpoint(store: CheckpointStore, threadId: string) {
  return store.saver.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: '' } });
}
