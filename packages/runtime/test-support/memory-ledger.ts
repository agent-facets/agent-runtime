// An in-memory operation ledger with the database ledger's rules, recording every call it sees. Test-only.
import {
  type OperationLedger,
  type OperationStart,
  ToolCallConflict,
  type ToolCallIdentity,
} from '../src/execution/operations.ts';
import type { ToolOutcome } from '../src/workspace/results.ts';

interface Row {
  identity: ToolCallIdentity;
  outcome?: ToolOutcome<unknown>;
}

export class MemoryLedger implements OperationLedger {
  readonly log: string[] = [];
  readonly rows = new Map<string, Row>();
  dispatchable = true;

  async start(identity: ToolCallIdentity): Promise<OperationStart> {
    if (!this.dispatchable) {
      this.log.push(`refused:${identity.toolName}`);
      return { kind: 'not_dispatchable' };
    }
    const existing = this.rows.get(identity.providerToolCallId);
    if (existing !== undefined) {
      const same =
        existing.identity.operationId === identity.operationId &&
        existing.identity.toolName === identity.toolName &&
        existing.identity.argumentDigest === identity.argumentDigest;
      if (!same) {
        this.log.push(`conflict:${identity.providerToolCallId}`);
        throw new ToolCallConflict();
      }
      if (existing.outcome !== undefined) {
        this.log.push(`reuse:${identity.toolName}`);
        return { kind: 'reuse', outcome: existing.outcome };
      }
      this.log.push(`restart:${identity.toolName}`);
      return { kind: 'execute' };
    }
    this.rows.set(identity.providerToolCallId, { identity });
    this.log.push(`start:${identity.toolName}`);
    return { kind: 'execute' };
  }

  async complete(identity: ToolCallIdentity, outcome: ToolOutcome<unknown>): Promise<void> {
    const row = this.rows.get(identity.providerToolCallId);
    if (row === undefined) throw new Error('completion of an unstarted operation');
    row.outcome = outcome;
    this.log.push(
      `complete:${identity.toolName}:${outcome.outcome}${outcome.outcome === 'ok' ? '' : `:${outcome.code}`}`,
    );
  }
}
