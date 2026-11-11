# Proposal

## Why

The runtime refuses portable instructions when their authors omit runtime-specific metadata. This prevents use of the published `voice-to-text` facet without changes by its author.

## What Changes

- Portable command, skill, and agent instructions SHALL be admitted without a runtime-specific declaration.
- Absent, null, and empty runtime metadata SHALL mean no declared runtime prerequisites or restrictions. Installer-supplied identity fields alone SHALL NOT make metadata explicit.
- Non-empty runtime settings SHALL retain strict validation. Malformed settings, unsupported versions, and unsupported behavior SHALL cause refusal rather than portable fallback.
- Supported explicit prerequisites and restrictions SHALL remain effective. Portable admission SHALL NOT grant authority or remove an explicit restriction.
- Settings for other coding tools and primary-file front matter SHALL NOT become runtime controls.
- Portable commands SHALL accept optional raw text arguments. Existing argument substitution and owner-input append behavior SHALL remain unchanged. Neither operation SHALL execute shell syntax.
- Runtime exports and sealed definitions SHALL distinguish portable admission from explicit runtime settings. Inspection SHALL NOT report ignored settings as enforced behavior.
- The implementation SHALL preserve external facet versions, dependency pins, and authored `runtimeVersion: 1` semantics. This change SHALL NOT require upstream CLI, SDK, or package-format changes.

## Non-goals

This change SHALL NOT define agent configuration, startup activation, reusable sessions, provider tool names, or Docker execution.

It SHALL NOT select facets for agents, approve MCP servers, grant tools, or execute skill scripts.

It SHALL NOT reset runtime data, change production facet selections, deploy the runtime, or send live provider requests.

It SHALL NOT add a consumer-specific opt-in marker, a wrapper command, or automatic interpretation of other tools' settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Admit portable contributions without runtime declarations while preserving explicit requirements, restrictions, and safe refusals.
- `execution`: Preserve portable-command text and argument behavior without attributing undeclared prerequisites, restrictions, or authority to the command.

## Impact

Affected code includes the facet adapter, export validation, bundle sealing, installation validation, and command-definition normalization.

The adapter and runtime SHALL agree on the current admission representation. Exports and sealed bundles SHALL be regenerated from their configured sources, not edited to turn old refusals into ready definitions.

This change is item 01 in the [release roadmap](../ROADMAP.md). The original change retains its approval history and scope references. Capability selection and runtime execution belong to later changes.

Verification SHALL cover absent, null, empty, identity-only, explicit, and invalid metadata. It SHALL cover preserved restrictions, deterministic exports, sealed-definition validation, and unchanged portable-command rendering.

Verification SHALL also establish admission of the unchanged published `voice-to-text` facet through the independent runtime installation. Startup-context and live-behavior proof belong to later changes.

The root [README](../../../README.md#runtime-facets) and the [runtime installation guide](../../../deploy/runtime/facets/README.md#supported-subset) informed this proposal. Their mandatory runtime-declaration guidance SHALL be updated. The repository has no documentation under `docs/`.

External follow-ups SHALL remain assigned to this change: admission documentation, export and sealed-definition descriptions, installation guidance, and safe admission explanations in the console. This planning change SHALL NOT edit those implementation files.
