// The operator surface.
//
//   node src/cli.ts setup
//   node src/cli.ts stage-source --source harbor-policy@1
//   node src/cli.ts stage        --source harbor-policy@1 --extraction-file /artifacts/...
//   node src/cli.ts show         --proposal prop_...
//   node src/cli.ts pending      --project synthetic:harbor
//   node src/cli.ts apply        --proposal prop_... --decision-id d1 --action correct \
//                                --target-token st_... --proposal-digest <digest> \
//                                --rationale "..." --operator owner --origin owner
//   node src/cli.ts read         --project synthetic:harbor
//   node src/cli.ts history      --project synthetic:harbor
//
// `apply` takes the digest and the target token as explicit arguments on
// purpose. An operator approves a specific proposal against a specific reviewed
// state, and passing them back in is what makes that binding checkable instead
// of assumed. There is no --force, and no command that sets a value directly.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Action, DecisionOrigin, KnowledgeKey } from "./reconcile.ts";
import { ReconcileError, makeSnapshot } from "./reconcile.ts";
import { Store } from "./store.ts";

type Manifest = {
  key: { subject: string; predicate: string };
  sources: Array<{
    id: string;
    project: string;
    sourceId: string;
    sourceRevision: number;
    file: string;
    policyIntervalStart: string;
  }>;
};

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = flag(name);
  if (!value) throw new ReconcileError("ARG_MISSING", `--${name} is required`);
  return value;
}

function loadManifest(): { manifest: Manifest; dir: string } {
  const path = flag("manifest") ?? resolve(HERE, "../fixtures/manifest.json");
  return {
    manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest,
    dir: dirname(path),
  };
}

function keyFor(project: string, manifest: Manifest): KnowledgeKey {
  return { project, subject: manifest.key.subject, predicate: manifest.key.predicate };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { manifest, dir } = loadManifest();
  const store = await Store.connect();

  try {
    switch (command) {
      case "setup": {
        await store.setup();
        emit({ command, ok: true });
        return;
      }

      case "stage-source": {
        const ref = required("source");
        const entry = manifest.sources.find((source) => source.id === ref);
        if (!entry) throw new ReconcileError("SOURCE_UNKNOWN", `${ref} is not in the manifest`);

        const snapshot = makeSnapshot({
          project: entry.project,
          sourceId: entry.sourceId,
          sourceRevision: entry.sourceRevision,
          text: readFileSync(resolve(dir, entry.file), "utf8"),
          policyIntervalStart: entry.policyIntervalStart,
        });
        const result = await store.putSource(snapshot);
        emit({
          command,
          snapshotId: snapshot.snapshotId,
          digest: snapshot.digest,
          bytes: Buffer.byteLength(snapshot.text, "utf8"),
          created: result.created,
        });
        return;
      }

      case "stage": {
        const ref = required("source");
        const entry = manifest.sources.find((source) => source.id === ref);
        if (!entry) throw new ReconcileError("SOURCE_UNKNOWN", `${ref} is not in the manifest`);

        const file = flag("extraction-file");
        const inline = flag("extraction-text");
        if (!file && !inline) {
          throw new ReconcileError("ARG_MISSING", "--extraction-file or --extraction-text");
        }

        let extractionText = inline ?? "";
        let extractionRef = flag("extraction-ref") ?? "inline";
        if (file) {
          const artifact = JSON.parse(readFileSync(file, "utf8")) as { text?: unknown };
          if (typeof artifact.text !== "string") {
            throw new ReconcileError("EXTRACTION_ARTIFACT_INVALID", "artifact has no text field");
          }
          extractionText = artifact.text;
          extractionRef = flag("extraction-ref") ?? file;
        }

        const staged = await store.stageCandidate({
          snapshotId: `${entry.project}|${entry.sourceId}@${entry.sourceRevision}`,
          key: keyFor(entry.project, manifest),
          extractionText,
          extractionRef,
        });

        emit({
          command,
          replay: staged.replay,
          disposition: staged.disposition,
          proposal: staged.proposal,
          evidence: staged.evidence,
          currentlyAccepted: staged.head,
          decision: staged.decision,
        });
        return;
      }

      case "show": {
        const proposal = await store.getProposal(required("proposal"));
        if (!proposal) throw new ReconcileError("PROPOSAL_UNKNOWN", "no such proposal");
        emit({ command, proposal });
        return;
      }

      case "pending": {
        emit({ command, pending: await store.listPending(required("project")) });
        return;
      }

      case "apply": {
        const outcome = await store.applyDecision({
          decisionId: required("decision-id"),
          proposalId: required("proposal"),
          proposalDigest: required("proposal-digest"),
          targetToken: required("target-token"),
          action: required("action") as Action,
          rationale: required("rationale"),
          operator: required("operator"),
          origin: required("origin") as DecisionOrigin,
          decidedAt: flag("decided-at") ?? new Date().toISOString(),
        });
        emit({ command, outcome });
        return;
      }

      case "read": {
        const key = keyFor(required("project"), manifest);
        emit({ command, key, accepted: await store.readAccepted(key) });
        return;
      }

      case "history": {
        const key = keyFor(required("project"), manifest);
        emit({ command, key, revisions: await store.listRevisions(key) });
        return;
      }

      default: {
        process.stderr.write(
          "usage: node src/cli.ts <setup|stage-source|stage|show|pending|apply|read|history>\n",
        );
        process.exit(2);
      }
    }
  } finally {
    await store.close();
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ReconcileError ? error.code : "UNEXPECTED";
  process.stderr.write(`${JSON.stringify({ error: code, message: String(error instanceof Error ? error.message : error) })}\n`);
  process.exit(1);
}
