# Design

## Context

See [proposal.md](./proposal.md#why) for the reason for this change.

The adapter currently requires `runtimeVersion: 1` before it validates contribution settings. Ready exports also require runtime settings.

The installer supplies contribution identity fields beside authored settings. Those fields do not establish that an author declared runtime behavior.

This change extracts the portable-admission contract from Decision 2 of the original change. It is item 01 in the [release roadmap](../ROADMAP.md).

## Goals / Non-Goals

**Goals:**

- Distinguish portable instructions from explicit runtime settings.
- Preserve declared prerequisites and restrictions.
- Keep adapter exports and sealed definitions consistent.
- Preserve installation integrity and command text behavior.

**Non-Goals:**

- Agent selection, startup activation, and execution authorization.
- Session records, provider compatibility, and sandbox execution.
- Changes to upstream facet formats or dependency pins.
- Automatic conversion of old exports or runtime records.

## Decisions

### 1. Classify behavioral metadata before explicit-profile validation

The adapter MUST treat absent, null, and empty runtime metadata as portable.

Before classification, it MUST exclude installer-supplied `name` and `description` fields from behavioral settings. Metadata containing only those identity fields MUST therefore be portable.

Identity and content validation MUST remain effective. Excluding identity fields from behavioral classification MUST NOT bypass their normal validation.

The classification MUST follow these rules:

| Input | Classification |
|---|---|
| Absent metadata | Portable |
| Null metadata | Portable |
| Empty object | Portable |
| Object containing only installer identity fields | Portable |
| Object containing behavioral fields | Validate as explicit runtime settings |
| Another malformed value | Refused, not portable fallback |

Non-empty behavioral settings MUST declare `runtimeVersion: 1`.

The adapter MUST preserve the supported fields for each contribution kind:

| Kind | Supported behavioral fields |
|---|---|
| Command | `runtimeVersion`, `arguments`, `requires`, `restrict` |
| Skill | `runtimeVersion`, `requires` |
| Agent | `runtimeVersion`, `requires`, `restrict` |

Unknown fields, malformed values, unsupported versions, and unsupported declared execution behavior MUST cause refusal.

A block containing only `{ runtimeVersion: 1 }` MUST remain explicit. It MUST use the supported defaults without granting authority.

Settings for other coding tools and primary-file front matter MUST NOT become runtime controls.

The SDK's `unknown` input type MUST NOT justify discarding a malformed value.

This classification MUST NOT require an upstream CLI, SDK, or package-format change. Owner-configured nested delegation MUST NOT require a new author metadata marker.

**Rationale:** Installer identity does not declare behavior. Portable instructions need no consumer-specific opt-in, while explicit restrictions must remain effective.

**Rejected alternatives:** Requiring an empty runtime block would preserve the author-adaptation barrier. Discarding invalid settings could remove restrictions and expand authority.

### 2. Export portable and explicit contributions through a closed union

Text exports MUST use these record shapes:

```text
AssetKind = "command" | "skill" | "agent"

Companion = {
  path: string,
  byteLength: NonNegativeInteger,
  sha256: Digest,
  content: Base64
}

TextContent = {
  name: AssetName,
  description: string,
  body: string,
  companions: Companion[]
}

CommandSettings = {
  runtimeVersion: 1,
  requires: AuthoredRequirement[],
  arguments: { required: boolean },
  restrict?: AuthoredRestriction
}

SkillSettings = {
  runtimeVersion: 1,
  requires: AuthoredRequirement[]
}

AgentSettings = {
  runtimeVersion: 1,
  requires: AuthoredRequirement[],
  restrict?: AuthoredRestriction
}

PortableReady = TextContent & {
  state: "ready",
  kind: AssetKind,
  admission: { kind: "portable" }
}

ExplicitReady = TextContent & (
  {
    state: "ready",
    kind: "command",
    admission: { kind: "explicit", settings: CommandSettings }
  }
  | {
    state: "ready",
    kind: "skill",
    admission: { kind: "explicit", settings: SkillSettings }
  }
  | {
    state: "ready",
    kind: "agent",
    admission: { kind: "explicit", settings: AgentSettings }
  }
)

Refused = {
  state: "refused",
  kind: AssetKind,
  name: AssetName,
  reason: ReasonCode,
  fields: string[]
}

TextExport = PortableReady | ExplicitReady | Refused
```

All variants MUST reject unknown fields. A refused export MUST NOT contain a usable body, companions, or admission record.

`AuthoredRequirement` and `AuthoredRestriction` MUST retain their supported field shapes and reference spellings. Explicit empty restriction lists MUST remain distinct from omitted lists.

Explicit settings MUST retain their supported defaults. Missing prerequisites normalize to an empty array. A command's omitted argument setting normalizes to `{ required: false }`.

The export MUST retain the installed primary body without interpreting its front matter as runtime behavior. Skill companions MUST preserve their declared paths and exact bytes.

Companion validation MUST preserve path confinement, byte-length agreement, and SHA-256 integrity checks. Command and agent exports MUST retain empty companion arrays.

The export identity MUST remain the contribution kind and effective name within the runtime project. Its path MUST remain:

```text
.agent-runtime-export/assets/<kind>/<name>.json
```

The current export schema MUST NOT contain an internal format selector. Authored `runtimeVersion: 1` remains part of explicit settings, not an export-format version.

Export bytes MUST retain the adapter's canonical encoding: recursively sorted object keys, array order preserved, UTF-8, and one trailing newline.

The adapter MUST return file transitions to the installer rather than write exports directly. Each transition MUST preserve the installer's expected-file-state checks.

Equivalent inputs MUST produce equivalent export bytes and no unnecessary file transition. Portable admission MUST NOT alter the separate runtime and editor installation boundaries.

**Rationale:** The admission discriminator makes missing runtime settings valid without permitting malformed explicit settings. Kind-specific variants prevent command settings from appearing on skills or agents.

**Rejected alternative:** A nullable runtime object would not distinguish portable admission from an invalid or incomplete explicit record.

### 3. Preserve admission when normalizing sealed definitions

Every sealed ready command, skill, and agent definition MUST contain this closed admission union:

```text
Admission =
  { kind: "portable" }
  | { kind: "explicit", runtimeVersion: 1 }
```

The admission record MUST accompany the normalized definition fields. It MUST NOT replace prerequisite or restriction fields.

The definition shapes MUST retain these fields:

| Definition | Fields |
|---|---|
| Common | `id`, `name`, `description`, `origins`, `exportDigest`, `requires`, `admission` |
| Command | Common fields, `body`, `arguments`, optional `restrict` |
| Skill | Common fields, `instructions`, `resources` |
| Agent | Common fields, `instructions`, optional `restrict` |

Existing identifier, origin, resource, and content validation MUST remain effective. The effective name MUST agree with the definition ID.

Portable definitions MUST satisfy these additional constraints:

| Kind | Required normalized values |
|---|---|
| Command | `requires: []`, `arguments: { required: false }`, no `restrict` field |
| Skill | `requires: []` |
| Agent | `requires: []`, no `restrict` field |

A portable definition with explicit prerequisites or restrictions MUST fail validation. A portable command with required arguments MUST also fail validation.

Explicit definitions MUST retain their validated, resolved prerequisites and restrictions. An omitted restriction list MUST remain distinct from an explicit empty list that denies its category.

A ready portable contribution MUST participate in prerequisite resolution as an available definition. Missing explicit settings MUST NOT make it a refused prerequisite.

Authored references MUST continue to resolve through recorded facet identity, aliases, and omissions. Resolution MUST NOT infer dependencies from prose or select a target by installation order.

An explicit prerequisite that is missing, omitted, refused, or cyclic MUST retain its applicable refusal. Unrelated usable contributions MUST remain available.

The installation item states MUST remain distinct:

```text
Ready = {
  kind: "ready",
  definition: DefinitionForItemKind
}

Refused = {
  kind: "refused",
  reason: ReasonCode,
  subject?: string,
  fields: string[]
}

Omitted = {
  kind: "omitted"
}
```

A ready item's definition MUST match its contribution kind. Refused and omitted items MUST NOT contain usable definitions.

The current schemas for exports and sealed installations MUST reject unknown fields and unsupported variants. Internal `format` and `profile` selectors MUST NOT select an older representation.

The current server-export document MUST contain its `servers` collection without an internal format selector. Server declarations, fingerprints, and materialization choices MUST retain their existing meaning.

External manifest versions, lockfile versions, toolchain identities, and authored `runtimeVersion: 1` MUST remain unchanged by this format cleanup.

The sealer and runtime loader MUST enforce the same admission invariants. A corrupt or unverifiable bundle MUST remain unavailable as a whole.

A well-formed bundle MAY contain individual refused contributions. Those refusals MUST NOT make unrelated usable contributions unavailable.

The export digest MUST identify the exact canonical export bytes. Companion integrity MUST identify the exact companion bytes. Neither digest MUST be presented as the authored primary-file digest.

The sealed bundle MUST retain its canonical encoding and owner-pinned whole-file digest. The runtime MUST NOT repair or reseal a bundle during a read.

**Rationale:** Normalized fields support existing consumers while the admission tag records whether the author supplied runtime settings.

**Rejected alternatives:** Inferring admission from empty prerequisites would confuse portable content with valid explicit defaults. Accepting contradictory tags and fields could silently discard restrictions.

### 4. Render portable commands without interpreting their input

A portable command MUST normalize to optional raw text arguments.

If the body contains `$ARGUMENTS`, rendering MUST replace every literal occurrence with the submitted text. Replacement syntax inside that text MUST remain literal.

The runtime MUST NOT evaluate shell syntax, interpolate environment variables, or execute the resulting text as a command.

If the body has no `$ARGUMENTS` marker and the submitted text is nonblank, the rendered goal MUST use this form:

```text
<body with trailing whitespace removed>

## Owner input

<submitted text>
```

If the body has no marker and the submitted text is blank, rendering MUST preserve the body unchanged.

The rendered goal MUST remain nonblank and storable. Credential screening MUST remain effective before unsafe input reaches durable records or model context.

An explicit command with `arguments.required: true` MUST still refuse blank arguments. Portable admission MUST NOT alter that explicit command's behavior.

Rendering failures MUST retain the existing `command_arguments_invalid` error category and applicable reason. Refusal MUST NOT fall back to another command or a goal start.

This change MUST NOT remove message-size enforcement. The capacity change owns that removal and its requirement for operational monitoring first.

Rendering MUST NOT select another agent, add capabilities, create delegation relationships, or grant tool access.

**Rationale:** Portable admission changes whether instructions can be used, not how owner text is interpreted.

**Rejected alternative:** Treating portable commands as shell templates would add execution behavior and authority that the author did not declare.

## Verification

Verification MUST cover these boundaries:

| Boundary | Required evidence |
|---|---|
| Metadata classification | Absent, null, empty, and identity-only metadata produce portable admission. Non-empty valid settings remain explicit. Malformed values cannot become portable. |
| Kind-specific settings | Commands, skills, and agents accept only their supported fields. Explicit defaults and empty restriction lists preserve their meaning. |
| Export records | Each ready variant validates. Refused records contain no usable definition. Unknown fields and contradictory variants fail validation. |
| Sealed definitions | Portable normalization matches Decision 3. Explicit prerequisites and restrictions remain intact. Portable ready contributions can satisfy explicit prerequisites. |
| Integrity | Export digests, companion bytes, source provenance, canonical bundle bytes, and the owner-pinned digest remain distinct and verifiable. |
| Command input | Repeated markers, literal replacement characters, blank optional input, owner-input append behavior, and explicit required arguments preserve their existing results. |
| Failure scope | A malformed or unverifiable bundle is unavailable. An individual contribution refusal leaves unrelated usable contributions available. |
| Side effects | Admission and installation do not start runs, contact MCP servers, execute scripts, or send model requests. |

Fast unit and service tests MUST cover classification, normalization, validation, resolution, and rendering.

Process-level installation tests MUST use disposable runtime and editor facet homes. They MUST verify that runtime installation does not alter editor materializations.

The published `voice-to-text` facet MUST be tested without author modifications or a consumer-specific wrapper. Evidence MUST identify its actual resolved version and integrity.

That proof MUST use the runtime installation, not an editor's materialized skill copy. It MUST preserve the installed body and companion bytes.

This change's proof ends at valid installation and admission. Startup-context preparation belongs to `resolve-agent-capability-plans`. Durable startup and live behavior belong to `add-run-owned-agent-sessions`.

No additional version-pin test is required. Existing toolchain verification remains effective.

A failed verification MUST stop work. Repair or rerun requires owner approval.

## Risks / Trade-offs

- **Invalid settings appear portable:** Classify metadata explicitly and refuse malformed non-empty settings. Do not use failed validation as portable fallback.
- **Export and loader rules diverge:** Apply the same admission invariants at export, sealing, and runtime loading.
- **Restrictions disappear during normalization:** Preserve explicit restrictions, including empty lists. Reject portable records containing restrictions.
- **Admission appears to grant authority:** Keep installation, selection, activation, independent grants, and actual execution distinct.
- **New exports reach an old reader:** Regenerate and release compatible adapter, sealer, and runtime components together. Do not add an old-format decoder.
- **Installation is mistaken for the full proof:** Report admission evidence separately from startup-context and live-behavior evidence.

## Migration Plan

The adapter, export reader, sealer, and runtime loader MUST use the same current representation.

Runtime exports and sealed bundles MUST be regenerated from the configured facet sources. Existing refused records MUST NOT be edited into ready definitions.

The current representation MUST reject superseded internal format selectors. This change MUST NOT add compatibility decoders, format-version bumps, or conversion of retained runtime records.

External facet versions, dependency pins, manifest and lockfile versions, and explicit authored `runtimeVersion: 1` settings MUST retain their meaning.

Owner-managed installation paths, materialization choices, and independent grants MUST remain unchanged unless separately approved.

This change MUST NOT execute a database reset. `configure-agent-workspaces-and-sandboxes` owns the reset procedure and final inventory.

Deployment MUST follow the release roadmap. A completed admission change MUST NOT be presented as approval to deploy incomplete execution controls.

An older runtime MUST NOT read a bundle or database schema it cannot validate. Rollback MUST use compatible code and inputs. Any further reset or deployment change requires separate owner approval.

## External follow-ups

| Area | Required follow-up |
|---|---|
| Documentation | Update the root README's Runtime facets and deployment guidance. Explain portable admission, explicit settings, refusal behavior, and unchanged authority boundaries. |
| Installation guidance | Update `deploy/runtime/facets/README.md`. Remove mandatory runtime opt-in claims and document regeneration with the current adapter and sealer. |
| Data model | Document the admission discriminator in export and sealed-definition descriptions. Keep source-file integrity separate from export and bundle digests. |
| Runtime and deployment | Release compatible readers and writers. Preserve the independent runtime installation and separately approved production configuration. |
| Console | Show portable or explicit admission without implying selection, authorization, startup supply, or actual use. Reuse the admission data in the capability-inspection work. |

The repository has no files under `docs/`. These follow-ups belong to implementation work; this decomposition does not edit those external files.

## Dependencies and release boundary

This change has no predecessor in the release chain.

It supplies admitted definitions to `resolve-agent-capability-plans`. That change owns per-agent availability and capability-inspection integration.

The owner configuration and reset change owns operational regeneration and reset coordination. This change owns the admission representation and its validation.

Provider compatibility, workspace controls, sessions, and operational monitoring remain separate release prerequisites where applicable.

There are no unresolved admission decisions in this design. This does not establish implementation or deployment readiness for the complete release.
