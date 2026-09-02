// A checkpointer wrapper that can hold the first superstep's persistence open.
//
// This is the mechanism control for durability mode, modelled on the upstream
// `GateFirstSuperstepPersistenceSaver` in the pinned release's own
// `durability.sync.test.ts`. It delegates everything to the real PostgresSaver;
// the only difference is that the first `put` of a loop checkpoint and the
// first `putWrites` block until released.
//
// With `sync`, the scheduler must not dispatch the next node while they are
// held. With `async`, it must. That single difference is the entire crash
// window the architecture's durability guarantee depends on, and holding the
// write open is the only way to observe it deterministically rather than by
// racing a real disk.

import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => {
    throw new Error("deferred resolver was not initialised");
  };
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class GatedSaver extends BaseCheckpointSaver {
  inner: BaseCheckpointSaver;

  checkpointStarted: Deferred;

  writesStarted: Deferred;

  checkpointGate: Deferred;

  writesGate: Deferred;

  gateCheckpoint: boolean;

  gateWrites: boolean;

  /**
   * Which task's write was actually held.
   *
   * Recorded rather than assumed: the gate fires on the FIRST `putWrites`, and
   * in the pinned release that is the first node's task write only because none
   * of these graphs use delta channels at the input step. A version that adds an
   * input-step write would silently gate something else, and this field is what
   * makes that visible in the evidence instead of invisible.
   */
  firstGatedTaskId: string | null;

  constructor(inner: BaseCheckpointSaver) {
    super(inner.serde);
    this.inner = inner;
    this.checkpointStarted = deferred();
    this.writesStarted = deferred();
    this.checkpointGate = deferred();
    this.writesGate = deferred();
    this.gateCheckpoint = true;
    this.gateWrites = true;
    this.firstGatedTaskId = null;
  }

  /** Resolves once both the first checkpoint and the first task write are held. */
  get held(): Promise<void> {
    return Promise.all([this.checkpointStarted.promise, this.writesStarted.promise]).then(
      () => undefined,
    );
  }

  release(): void {
    this.checkpointGate.resolve();
    this.writesGate.resolve();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.inner.getTuple(config);
  }

  list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    return this.inner.list(config, options);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    if (this.gateCheckpoint && metadata.source === "loop") {
      this.gateCheckpoint = false;
      this.checkpointStarted.resolve();
      await this.checkpointGate.promise;
    }
    return this.inner.put(config, checkpoint, metadata, newVersions);
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (this.gateWrites) {
      this.gateWrites = false;
      this.firstGatedTaskId = taskId;
      this.writesStarted.resolve();
      await this.writesGate.promise;
    }
    return this.inner.putWrites(config, writes, taskId);
  }

  async deleteThread(threadId: string): Promise<void> {
    return this.inner.deleteThread(threadId);
  }
}
