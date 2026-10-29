# Proposal

## Why

Independent application size ceilings can reject valid work before the provider evaluates it. Removing those ceilings requires operational monitoring and accurate failure reports, including evidence that survives runtime termination.

## What Changes

- Ordinary user and agent messages SHALL have no independent application size ceiling.
- The policy SHALL cover goals, command arguments, rendered goals, questions, text answers, delegated tasks, discussion topics, and advice.
- Complete model messages, common tool results, affected HTTP request bodies, inference requests, and aggregate capability snapshots SHALL follow the same policy.
- The runtime SHALL NOT replace removed limits with guessed values, hidden deployment defaults, truncation, or automatic conversation compression.
- Providers SHALL remain authoritative for their request and context capacity. Local capacity checks SHALL require a verified provider contract.
- Confirmed size or context rejection SHALL NOT cause automatic retry of an unchanged request.
- Failure reports SHALL distinguish reliable provider rejection evidence from transport, serialization, and storage failures.
- Accepted inputs and existing uncertainty and replay guarantees SHALL remain intact. Failure SHALL NOT become false success.
- Monitoring SHALL operate before affected limits stop enforcement. Instrument registration alone SHALL NOT establish readiness.
- Monitoring SHALL cover message, request, result, record, and checkpoint sizes; latency; failures; reported token usage; and host resource conditions.
- Independent host evidence SHALL remain available after runtime termination, including out-of-memory termination.
- Telemetry SHALL exclude message bodies, credentials, and raw provider error bodies. Metric labels SHALL exclude message content and run identities.
- Later application limits SHALL require documented constraints or measured evidence and separate owner approval.

## Non-goals

This change SHALL NOT remove identifier validation, credential screening, strict input shapes, or permission checks.

It SHALL NOT remove separate facet-content, startup-skill, approval-artifact, owner-evidence, execution-budget, deadline, or sandbox controls.

Intentional paging for workspace reads, searches, and bundled references SHALL remain.

This change SHALL NOT add automatic compaction, guessed capacity limits, or automatic enforcement based on measurements.

It SHALL NOT claim unlimited capacity or guaranteed recovery from resource exhaustion.

This proposal SHALL NOT select a monitoring stack, deploy collectors, remove enforcement, or authorize live capacity experiments.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `execution`: Common message-size policy, faithful capacity failures, preserved accepted inputs, operational monitoring, and evidence-based limits.

## Design work remaining

The design MUST resolve:

- The complete inventory of affected validators, transport settings, record checks, SQL constraints, and error mappings.
- The telemetry destination, collection topology, durable storage, and owner inspection.
- The independent host source and evidence available after runtime termination.
- Measurement boundaries, units, and correlation without sensitive content or per-run metric labels.
- Reliable provider failure classification and identification of remaining platform constraints.
- Verification of successful collection and host evidence before enforcement stops.
- Deployment order, failure handling, and deterministic verification without unapproved live traffic.

No `design.md` or `tasks.md` SHALL be created during this decomposition.

## Impact

This change is item 07 in the [release roadmap](../ROADMAP.md). Its monitoring prerequisite applies wherever another change removes an affected ceiling.

Affected areas include message contracts, HTTP parsing, subscription adapters, model and tool outcomes, persistence validation, deployment monitoring, and console failure explanations.

The root README's persistence, execution, provider, and deployment sections informed this proposal. Deployment configuration under `deploy/runtime/` also informs the required collection topology.

External follow-ups SHALL include those README sections, `architecture/09-data-model-and-lifecycle.md`, deployment guidance, and safe console failure reporting.

Documentation SHALL state that resource exhaustion can occur before provider rejection. Capacity claims SHALL require supporting measurements.

Automated verification SHALL use deterministic provider substitutes. Live provider traffic and capacity experiments SHALL require separate owner approval.

The repository has no files under `docs/`. This decomposition SHALL NOT edit implementation files or deploy monitoring.
