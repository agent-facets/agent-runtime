// Fixture state for the container smoke suite's image-rollback rehearsal (scripts/container-smoke.ts). The launcher
// bundles this file with its dependencies (the image ships no sources or node_modules) and runs it in a short-lived
// container of the image under test, on that fixture's own database and private-state volume:
//
//   seed     (runtime stopped)  synthetic credentials for both providers, and one run per provider recorded through
//                                the runtime's own stores, then cancelled before any work — never a fabricated result
//   inspect  (runtime running)  a fingerprint of all recorded runs, history, activity counters and credential files,
//                                read in a read-only transaction without taking runtime ownership
//
// Nothing here dispatches a graph or contacts a provider: the assembly's transports refuse every request.
import { createHash } from 'node:crypto';
import { parseOperatorConfig, providerSettingsFor } from '../../packages/runtime/src/config/operator.ts';
import type { CredentialRecord } from '../../packages/runtime/src/credentials/record.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { createExecutionAgent, executionAgentParams } from '../../packages/runtime/src/execution/agent.ts';
import type { ShippedManifests } from '../../packages/runtime/src/execution/code-manifest.ts';
import { executionDefinition } from '../../packages/runtime/src/execution/definition.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { AdmissionRefused, type RequestAdmission } from '../../packages/runtime/src/execution/terminal.ts';
import { createAppDatabase } from '../../packages/runtime/src/persistence/app-database.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import type { Provider, ProviderBinding } from '../../packages/runtime/src/records/schemas.ts';
import { createWorkspacePolicy } from '../../packages/runtime/src/workspace/policy.ts';

/** The manifests the image under test ships beside its bundle, as its runtime reads them. */
const SHIPPED_MANIFESTS = '/app/dist/execution-manifest.json';
const PROVIDERS = ['anthropic', 'openai'] as const satisfies readonly Provider[];
const SEEDED_AT_MS = 1_790_000_000_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const refuseRequests = (async () => {
  throw new Error('the rollback fixture sends no provider requests');
}) as unknown as typeof fetch;

const refuseAdmission: RequestAdmission = {
  admit: async () => {
    throw new AdmissionRefused('inspection_only');
  },
};

function credential(provider: Provider): CredentialRecord {
  const common = {
    version: 1,
    authMode: 'subscription',
    slot: 'default',
    generation: 1,
    updatedAtMs: SEEDED_AT_MS,
    lifecycle: 'usable',
    accessToken: `rollback-fixture-${provider}-access`,
    refreshToken: `rollback-fixture-${provider}-refresh`,
    expiresAtMs: SEEDED_AT_MS + 10 * 365 * 86_400_000,
  } as const;
  return provider === 'openai'
    ? { ...common, provider, account: { accountId: 'acct_rollback_fixture' } }
    : { ...common, provider, account: {} };
}

async function seed() {
  const stateDir = required('RUNTIME_STATE_DIR');
  const configFile = required('RUNTIME_CONFIG_FILE');
  const operator = parseOperatorConfig(await Bun.file(configFile).text(), { stateDir, configFile });
  const credentials = CredentialStore.forStateDir(stateDir);
  for (const provider of PROVIDERS) await credentials.replace(credential(provider));

  const shipped = (await Bun.file(SHIPPED_MANIFESTS).json()) as ShippedManifests;
  const assembly = createProviderAssembly({
    config: operator,
    stateDir,
    inferenceTransport: refuseRequests,
    authTransport: refuseRequests,
  });
  const policy = createWorkspacePolicy(operator.workspace);
  const persistence = await openPersistence({ url: required('DATABASE_URL'), onFault: () => {} });
  try {
    const store = new RunStore(persistence.app, persistence.ownership);
    const gates = new KeyedSerializer();
    const runs: Partial<Record<Provider, string>> = {};
    for (const provider of PROVIDERS) {
      const settings = providerSettingsFor(operator, provider);
      const code = shipped.providers[provider];
      if (settings === undefined || code === undefined) throw new Error(`${provider} is not configured and shipped`);
      const binding: ProviderBinding = {
        provider,
        authMode: settings.authMode,
        model: settings.model,
        profileId: settings.profileId,
        credentialSlot: settings.credentialSlot,
      };
      // The definition is built as the service builds it for a new run: from the inspection-only agent of this
      // binding and the image's shipped manifest. Constructing the agent makes no request.
      const inspectionRunId = crypto.randomUUID();
      const wired = assembly.wire({
        binding,
        runId: inspectionRunId,
        admission: refuseAdmission,
        signal: () => AbortSignal.abort(),
        track: () => {},
      });
      if ('unavailable' in wired) throw new Error(`${provider} cannot be wired: ${wired.unavailable}`);
      const options = {
        runId: inspectionRunId,
        model: wired.model,
        checkpointer: persistence.checkpoints.saver,
        workspace: policy,
        contentPolicy: assembly.contentPolicy,
        operations: runOperationLedger({ store, gates, runId: inspectionRunId, invocationId: crypto.randomUUID() }),
        ...(wired.responseRefusal === undefined ? {} : { responseRefusal: wired.responseRefusal }),
      };
      const definition = await executionDefinition({
        code,
        agent: createExecutionAgent(options),
        params: executionAgentParams(options),
        binding,
        workspacePolicyDigest: policy.digest,
      });
      const { snapshot } = await store.createRun({
        requestId: crypto.randomUUID(),
        goal: `Rollback fixture (${provider}): recorded, then cancelled before any work.`,
        provider,
        workspace: { id: operator.workspace.id, label: policy.label, root: policy.root, policyDigest: policy.digest },
        binding,
        definition,
        budgetMax: operator.stepBudget,
      });
      const accepted = await store.acceptCancellation(snapshot.runId, crypto.randomUUID());
      if (accepted.kind !== 'accepted') throw new Error(`cancellation was not accepted: ${accepted.kind}`);
      const finished = await store.finishCancellation(snapshot.runId);
      if (finished.kind !== 'cancelled') throw new Error(`run did not finish cancelled: ${finished.kind}`);
      runs[provider] = snapshot.runId;
    }
    console.log(JSON.stringify({ runs }));
  } finally {
    await persistence.close();
  }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

async function inspect() {
  const stateDir = required('RUNTIME_STATE_DIR');
  const db = createAppDatabase({ url: required('DATABASE_URL'), onFault: () => {} });
  try {
    const recorded = await db.readOnly(async (tx) => {
      const [counts] = await tx`select
          (select count(*) from runtime.runs)::int as runs,
          (select count(*) from runtime.events)::int as events,
          (select count(*) from runtime.invocations)::int as invocations,
          (select count(*) from runtime.model_attempts)::int as model_attempts,
          (select count(*) from runtime.tool_operations)::int as tool_operations,
          (select count(*) from runtime.questions)::int as questions,
          (select count(*) from runtime.execution_definitions)::int as definitions,
          (select count(*) from checkpoints.checkpoints)::int as checkpoints`;
      const runs = await tx`select run_id::text as run_id, create_request_id::text as create_request_id, goal,
          workspace::text as workspace, binding::text as binding, definition_digest, budget_max::int as budget_max,
          consumed::int as consumed, unconfirmed::int as unconfirmed, state::text as state, revision::text as revision,
          last_seq::text as last_seq, created_at::text as created_at, last_activity_at::text as last_activity_at
        from runtime.runs order by run_id`;
      const events = await tx`select run_id::text as run_id, seq::text as seq, kind, payload::text as payload,
          source_key, recorded_at::text as recorded_at
        from runtime.events order by run_id, seq`;
      const invocations = await tx`select run_id::text as run_id, invocation_id::text as invocation_id,
          owner_epoch::text as owner_epoch, kind, disposition, started_at::text as started_at,
          ended_at::text as ended_at
        from runtime.invocations order by run_id, invocation_id`;
      const definitions = await tx`select digest, manifest::text as manifest from runtime.execution_definitions
        order by digest`;
      return {
        counts,
        runs: [...runs],
        events: [...events],
        invocations: [...invocations],
        definitions: [...definitions],
      };
    }, 'repeatable read');

    const store = CredentialStore.forStateDir(stateDir);
    const credentials = [];
    for (const provider of PROVIDERS) {
      const read = await store.read(provider, 'default');
      const bytes = await Bun.file(store.pathFor(provider, 'default')).bytes();
      credentials.push({
        provider,
        kind: read.kind,
        ...(read.kind === 'record' ? { generation: read.record.generation, lifecycle: read.record.lifecycle } : {}),
        sha256: sha256(bytes),
      });
    }

    const runs = recorded.runs.map((run) => ({
      runId: run.run_id as string,
      provider: (JSON.parse(run.binding as string) as ProviderBinding).provider,
      state: (JSON.parse(run.state as string) as { kind: string }).kind,
      consumed: run.consumed as number,
      unconfirmed: run.unconfirmed as number,
    }));
    // Token values never leave this process; only their files' digests do.
    console.log(
      JSON.stringify({
        fingerprint: sha256(JSON.stringify({ ...recorded, credentials })),
        counts: recorded.counts,
        runs,
        credentials,
      }),
    );
  } finally {
    await db.close();
  }
}

const mode = process.argv[2];
if (mode === 'seed') await seed();
else if (mode === 'inspect') await inspect();
else throw new Error('usage: rollback-state.js seed|inspect');
