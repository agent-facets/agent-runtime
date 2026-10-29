# Proposal

## Why

Canonical names must reach the model, not only runtime history and console labels. Current adapter naming rules can replace those names with aliases, so local naming tests do not establish provider compatibility.

## What Changes

- Supported native and facet tools SHALL retain their approved canonical names in model-visible tool definitions.
- Provider adaptation SHALL preserve the relationship between offered names, returned tool calls, retained structured identities, and reviewed definitions.
- Canonical identity and provider wire spelling SHALL remain distinguishable wherever translation occurs.
- Aliased wire names SHALL NOT be reported as satisfying the canonical model-visible naming requirement.
- Current adapter validation rules SHALL NOT be treated as proof of actual subscription-service constraints.
- An unsupported naming condition SHALL cause an accurate refusal rather than silent truncation, another origin, or a naming exception.
- Provider compatibility SHALL be established before this part of the release is declared complete.
- Live provider checks SHALL require separate owner approval. Deterministic adapter tests SHALL remain the primary behavior tests.

## Non-goals

This change SHALL NOT redefine canonical prefixes, structured tool identity, classification, or collision handling. Those contracts belong to `manage-definition-bound-tool-policy`.

It SHALL NOT enable standalone MCP, change agent facet selections, grant tools, or alter operation approval.

It SHALL NOT add a new authentication journey, billed API fallback, automatic provider switching, or automatic dependency upgrades.

This proposal SHALL NOT select a provider-profile modification or approve a live compatibility experiment.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `execution`: Faithful provider carriage of canonical tool names and accurate compatibility evidence without loss of tool identity.

## Design work remaining

The design MUST resolve:

- The name formats and lengths accepted by each supported subscription service and profile.
- Required adapter or profile changes, based on evidence rather than current local validation alone.
- Refusal behavior for incompatible names without weakening the approved naming requirement.
- Consistent handling of offered tools, tool choice, prior tool calls, responses, and authorization-renewal retries.
- Request identity and continuation implications of any profile change.
- Deterministic verification and the scope of any separately approved live check.

No `design.md` or `tasks.md` SHALL be created during this decomposition.

## Impact

Affected areas include provider tool-name adaptation, subscription profiles, request preparation, response validation, and provider documentation.

This change is item 04 in the [release roadmap](../ROADMAP.md). It consumes canonical identities and names from item 02.

The root [README](../../../README.md#providers) documents current alias behavior and states that the naming rules have not been checked against the live services.

The Anthropic subscription package's documentation and provenance record also inform the compatibility investigation.

External follow-ups SHALL include the README Providers section, relevant subscription-package documentation, and accurate descriptions of captured versus wire names.

Provider authentication SHALL remain browser-only. Credentials and raw provider content SHALL remain outside public diagnostics.

The repository has no files under `docs/`. This decomposition SHALL NOT edit implementation files, change profiles, or send provider traffic.
