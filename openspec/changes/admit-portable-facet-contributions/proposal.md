# Proposal

## Why

The runtime refuses portable instructions when their authors omit runtime-specific metadata. This prevents use of the published `voice-to-text` facet without changes by its author.

## What Changes

- Portable command, skill, and agent instructions SHALL be admitted without a runtime-specific declaration.
- Absent, null, and empty runtime metadata SHALL mean no declared runtime prerequisites or restrictions. Installer-supplied identity fields alone SHALL NOT make metadata explicit.
- Non-empty runtime settings SHALL retain strict validation. Missing or unsupported `runtimeVersion`, malformed settings, and unsupported behavior SHALL cause refusal rather than portable fallback.
- Supported explicit prerequisites and restrictions SHALL remain effective. Portable admission SHALL NOT grant authority or remove an explicit restriction.
- Settings for other coding tools and primary-file front matter SHALL NOT become runtime controls.
- Portable commands SHALL accept optional raw text arguments. Existing argument substitution and owner-input append behavior SHALL remain unchanged. Neither operation SHALL execute shell syntax.
- Runtime exports and sealed definitions SHALL distinguish portable admission from explicit runtime settings. Inspection SHALL NOT report ignored settings as enforced behavior.
- The installed-capability view and console SHALL identify portable or explicit admission for each ready contribution.
- **BREAKING:** Text exports, server exports, and sealed bundles SHALL use one current shape without internal `format` or `profile` fields. This preserves the approved single-format policy without implying compatibility with earlier representations.
- **BREAKING:** The runtime SHALL refuse continuation from retained snapshots whose definitions lack admission records. Snapshot-derived capability details SHALL be unavailable, including for completed runs. Recorded history and outcomes SHALL remain inspectable. The runtime SHALL NOT infer admission, decode earlier shapes, convert records, or reset data.
- After regeneration, contributions refused only for missing runtime metadata SHALL become ready. Ready portable commands SHALL need no additional command allowlist. Owner starts and existing admission checks SHALL still apply. Skills and agents SHALL retain their existing owner-selection controls.
- The implementation SHALL preserve external facet versions, dependency pins, and authored `runtimeVersion: 1` semantics. This change SHALL NOT require upstream CLI, SDK, or package-format changes.

## Non-goals

This change SHALL NOT define agent configuration, startup activation, reusable sessions, provider tool names, or Docker execution.

It SHALL NOT select facets for agents, approve MCP servers, grant tools, or execute skill scripts.

It SHALL NOT add per-agent availability or per-agent inspection. `resolve-agent-capability-plans` owns that behavior. Portable commands SHALL use the existing command execution path.

It SHALL NOT change the `version` and `profile` fields of retained run snapshots. Later roadmap items own those fields.

It SHALL NOT reset runtime data, change production facet selections, deploy the runtime, or send live provider requests.

It SHALL NOT add a consumer-specific opt-in marker, a wrapper command, or automatic interpretation of other tools' settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Admit portable contributions, preserve explicit restrictions, and identify admission without presenting other tools' settings as enforced runtime controls.
- `execution`: Start portable commands with optional raw text and unchanged argument semantics. Refuse incompatible continuation while preserving recorded history and identifying unavailable capability details.

## Impact

Affected code includes the facet adapter, export validation, bundle sealing, installation validation, and command-definition normalization.

Affected code also includes the catalog view contract, its projection, and contribution rows on the capabilities page.

The adapter and runtime SHALL agree on the current admission representation. Exports and sealed bundles SHALL be regenerated from their configured sources, not edited to turn old refusals into ready definitions.

Upgrade guidance SHALL require regeneration with compatible adapter and sealer versions, followed by an updated owner-pinned bundle digest. Earlier exports and bundles SHALL fail validation rather than trigger automatic conversion.

Guidance SHALL explain how to finish waiting runs before an incompatible upgrade, or cancel them by explicit owner action. This change SHALL NOT perform those actions.

The adapter, sealer, runtime, and console SHALL use compatible contracts in an approved deployment. Older strict console clients SHALL NOT be treated as compatible with the new required admission field.

An incompatible internal-format upgrade is not an ordinary restart. Current-format history and provenance guarantees SHALL remain unchanged after compatible restarts or facet removal.

This change is item 01 in the [release roadmap](../ROADMAP.md). The original change retains its approval history and scope references. New per-agent selection and session execution belong to later changes.

Verification SHALL cover absent, null, empty, identity-only, explicit, and invalid metadata. It SHALL cover preserved restrictions, deterministic exports, sealed-definition validation, and unchanged portable-command rendering.

Verification SHALL cover refusal order and codes, rejected format selectors, inspection labels, and safe refusal of earlier snapshots.

Process fixtures SHALL include portable commands, skills, and agents. Explicit prerequisites SHALL resolve to portable contributions without expanding authority.

Verification SHALL also establish admission of the unchanged published `voice-to-text` facet through the independent runtime installation. Startup-context and live-behavior proof belong to later changes.

That proof SHALL use a disposable runtime project with a pinned published version and integrity. The registry-backed step SHALL run separately from offline tests, with owner approval.

Affected integration and Docker fixtures SHALL use the current shapes. Missing Docker coverage SHALL NOT count as full verification.

The root [README](../../../README.md#runtime-facets) and [runtime installation guide](../../../deploy/runtime/facets/README.md#supported-subset) informed this proposal. Implementation SHALL correct their mandatory runtime-declaration guidance.

The README's [deployment section](../../../README.md#runtime-facets-in-a-deployment) SHALL explain regeneration, digest replacement, and the effect on waiting runs and historical capability details. The repository has no documentation under `docs/`.

External follow-ups SHALL remain assigned to this change: admission documentation, export and sealed-definition descriptions, installation guidance, and safe admission explanations in the console. This planning change SHALL NOT edit those implementation files.

The console [design system](../../../DESIGN_SYSTEM.md) governs the display change. Implementation SHALL update its capabilities pattern and complete its browser checks.
