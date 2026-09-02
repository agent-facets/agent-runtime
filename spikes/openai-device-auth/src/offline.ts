// The offline driver.
//
// Prints one JSON object to stdout and writes nothing outside a scratch
// directory, so the container can run unprivileged with no bind mounts and the
// driver script owns every artefact. Exit codes follow the spike convention:
// a reproducible negative is a valid result, a broken apparatus is not.

import {
  digest,
  emit,
  EVIDENCE_SCHEMA,
  EXIT_HARNESS_FAULT,
  measureNetworkIsolation,
  outcomeFor,
  SPIKE_ID,
} from "./evidence.ts";
import { runAuthStoreExperiment } from "./experiments/auth-store.ts";
import { redactCanonicalForEvidence } from "./transport/canonical.ts";
import { runLiveGuardCases } from "./experiments/live-guards.ts";
import { runTransportExperiment } from "./experiments/transport.ts";
import { CODEX_SOURCE_COMMIT, CODEX_SOURCE_TAG, CODEX_VERSION } from "./reference.ts";

const started = Date.now();

try {
  const isolation = await measureNetworkIsolation();
  const authStore = await runAuthStoreExperiment();
  const transport = await runTransportExperiment();
  const liveGuards = await runLiveGuardCases();

  const acceptance: Record<string, boolean> = {
    ...authStore.acceptance,
    ...transport.acceptance,
    ...liveGuards.acceptance,
    network_isolated: isolation.isolated,
  };

  const evidence = {
    schema: EVIDENCE_SCHEMA,
    spike: SPIKE_ID,
    run_index: process.env.SPIKE_RUN_INDEX ?? null,
    provenance: {
      codex_version: CODEX_VERSION,
      codex_source_tag: CODEX_SOURCE_TAG,
      codex_source_commit: CODEX_SOURCE_COMMIT,
      node_version: process.version,
    },
    isolation,
    auth_store: {
      device: authStore.device,
      refresh: authStore.refresh,
      single_flight: authStore.singleFlight,
      durability: authStore.durability,
      negative_controls: authStore.negativeControls,
    },
    transport: {
      environment_scrubbed: transport.environmentScrubbed,
      allowlist_errors: transport.allowlistErrors,
      allowlist_size: transport.allowlistSize,
      cases: transport.cases.map((entry) => ({
        id: entry.id,
        purpose: entry.purpose,
        dispatched: entry.dispatched,
        violations: entry.violations,
        violation_codes: entry.violationCodes,
        body_operations: entry.bodyOperations,
        removed_headers: entry.removedHeaders,
        token_resolver_calls: entry.tokenResolverCalls,
        control_differs: entry.controlDiffers,
      })),
      oracle: {
        ...transport.oracle,
        // Redacted only on the way out: every comparison above ran against the
        // unredacted capture.
        canonical: transport.oracle.canonical
          ? redactCanonicalForEvidence(transport.oracle.canonical)
          : null,
      },
      comparison: transport.comparison,
      user_turn: transport.userTurn,
      fetch_lane_headers: transport.fetchLaneHeaders,
      mutations: transport.mutations,
      differential_mutation: transport.differentialMutation,
      streaming: transport.streaming,
      truncated_stream_rejected: transport.truncatedStreamRejected,
      responses_api_control: transport.responsesApiControl,
      forward_attempts: transport.forwardAttempts,
      poison_fired: transport.poisonFired,
    },
    live_guards: liveGuards.cases,
    acceptance,
    managed_digest: digest({
      acceptance,
      request: transport.managedDigestInput,
    }),
    duration_ms: Date.now() - started,
    outcome: outcomeFor(acceptance),
  };

  process.exit(emit(evidence as unknown as Record<string, unknown>));
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: EVIDENCE_SCHEMA,
        spike: SPIKE_ID,
        outcome: {
          status: "fault",
          fault: { step: "offline-driver", message: (error as Error).message },
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exit(EXIT_HARNESS_FAULT);
}
