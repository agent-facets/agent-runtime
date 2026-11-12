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
- Per-agent availability and per-agent inspection.
- Changes to the `version` and `profile` fields of retained run snapshots.

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

The adapter MUST apply these checks in sequence. The first failed check MUST determine the refusal. Refusal field lists MUST be sorted.

| Order | Condition | Result |
|---|---|---|
| 1 | Metadata is absent or null | Portable |
| 2 | Metadata is not an object, or is an array | Refused: `runtime_metadata_missing`, no fields |
| 3 | No field remains after exclusion of `name` and `description` | Portable if the normalized description is valid; otherwise `invalid_field`, `description` |
| 4 | A behavioral field is present without `runtimeVersion` | Refused: `runtime_metadata_missing`, `runtimeVersion` |
| 5 | `runtimeVersion` is not `1` | Refused: `runtime_version_unsupported`, `runtimeVersion` |
| 6 | A field is unsupported for the contribution kind | Refused: `unsupported_field`, each unsupported field |
| 7 | The normalized `description`, `arguments`, `requires`, or `restrict` is malformed | Refused: `invalid_field`, each malformed field |
| 8 | An agent requires another agent, or permits one in `restrict.agents` | Refused: `nested_delegation_unsupported`, `requires` and/or `restrict` |
| 9 | No check failed | Explicit |

The existing description rule MUST remain: absent or null descriptions normalize to an empty string; other values MUST be strings.

Check 8 preserves the existing one-level rule. An empty `restrict.agents` list MUST remain valid. `resolve-agent-capability-plans` owns the later replacement of that rule.

This change MUST NOT add a refusal code. The refused export MUST record the code and fields of the failed check.

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

Ready and refused export records MUST NOT contain internal `format` or `profile` selectors. Validation MUST refuse records with either field.

Authored `runtimeVersion: 1` remains part of explicit settings, not an export-format version.

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

The current schemas for exports and sealed installations MUST reject unknown fields and unsupported variants.

The server export and sealed installation MUST have these top-level shapes:

```text
ServerExport = {
  servers: { [name: AssetName]: ServerDeclaration }
}

SealedInstallation = {
  toolchain: Toolchain,
  inputs: InstallationInputs,
  facets: LockedFacet[],
  items: InstallationItem[],
  servers: SealedServer[],
  omittedServers: OmittedServer[]
}
```

These documents MUST NOT contain a `format` or `profile` field. Validation MUST refuse documents with either field.

The six members of the sealed installation MUST keep their existing shapes, except for the definitions in `items`.

Server declarations, fingerprints, and materialization choices MUST retain their existing meaning.

An existing server export that fails the current schema MUST cause the adapter's existing `validation-failed` failure. The adapter MUST NOT use its declarations.

An export in an earlier shape MUST cause the sealer's `export_invalid` refusal. A bundle in an earlier shape MUST cause the runtime loader's `installation_invalid` refusal.

External manifest versions, lockfile versions, toolchain identities, and authored `runtimeVersion: 1` MUST remain unchanged by this format cleanup.

`inputs.manifestVersion`, `inputs.lockfileVersion`, and toolchain versions identify external inputs. They are not internal format selectors.

The sealer and runtime loader MUST enforce the same admission invariants. A corrupt or unverifiable bundle MUST remain unavailable as a whole.

A well-formed bundle MAY contain individual refused contributions. Those refusals MUST NOT make unrelated usable contributions unavailable.

The export digest MUST identify the exact canonical export bytes. Companion integrity MUST identify the exact companion bytes. Neither digest MUST be presented as the authored primary-file digest.

The sealed bundle MUST retain its canonical encoding and owner-pinned whole-file digest. The runtime MUST NOT repair or reseal a bundle during a read.

A run snapshot MUST preserve each sealed command, skill, and agent definition, including its admission record.

This change MUST NOT change, remove, or increment the snapshot's `version` and `profile` fields. `resolve-agent-capability-plans` and `configure-agent-workspaces-and-sandboxes` own those fields.

An earlier snapshot whose definitions lack admission records MUST receive the existing safe refusal:

| Use of the snapshot | Required result |
|---|---|
| Run capability inspection | `unavailable` with reason `snapshot_unreadable` |
| Continuation check for an owner answer | Incompatible result `definition_changed`; the answer MUST NOT be accepted |
| Further model or tool dispatch for that run | MUST NOT occur from the unreadable snapshot |

The runtime MUST NOT infer admission, decode an earlier shape, convert the snapshot, or delete it. The refusal MUST affect only that run.

Recorded run history MUST remain inspectable independently of the unavailable capability snapshot.

Snapshot refusal SHALL apply regardless of whether the run is waiting, completed, failed, or cancelled.

The unavailable capability view SHALL NOT prevent inspection of the run's identity, goal, workspace, provider, recorded activity, questions, accepted answers, or outcome.

Independently recorded provenance SHALL remain visible where the history already contains it. The runtime SHALL NOT reconstruct missing facet versions, permissions, or bound definitions from current installation data.

Complete snapshot-derived capability provenance is unavailable for an incompatible earlier snapshot. This limitation SHALL NOT weaken provenance guarantees for compatible snapshots after ordinary restarts or facet removal.

A confirmed `definition_changed` continuation check MUST use the existing failed outcome `continuation_unavailable`. The runtime MUST close the unanswered question without accepting the submitted answer.

Temporary verification failures MUST retain their existing nonterminal behavior.

Owner cancellation of a still-waiting run MUST remain available without decoding its capability snapshot. Existing cancellation receipts, concurrency checks, and terminal outcomes MUST remain authoritative.

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

Until the capability-plan change takes effect, portable contributions MUST use the existing command execution path and owner controls:

- A ready portable command MUST remain available for an owner start under the existing admission checks.
- Portable skills and agents MUST remain subject to the owner's current `allowSkills` and `allowAgents` lists when a new run starts.
- A prerequisite excluded by those lists MUST retain the existing start refusal: `prerequisite_not_granted`, with the prerequisite named.
- Accepted runs MUST retain their captured capabilities, subject to applicable permissions and current owner revocations.

This change MUST NOT add per-agent availability, entry-agent selection, or a per-agent availability display.

**Rationale:** Portable admission changes whether instructions can be used, not how owner text is interpreted.

**Rejected alternative:** Treating portable commands as shell templates would add execution behavior and authority that the author did not declare.

### 5. Show admission in the installed-capability view

The catalog view MUST identify admission within the availability of each ready contribution:

```text
ContributionAvailabilityView =
  { kind: "ready", admission: "portable" | "explicit", selectionRevision?: Digest }
  | { kind: "refused", reason: ReasonCode, subject?: PublicReference }
```

The ready variant MUST require `admission`, equal to the sealed definition's `admission.kind`. The refused variant MUST NOT contain it. Both variants MUST reject unknown fields.

This addition MUST NOT expose authored settings, `runtimeVersion`, or settings for other tools. The existing contribution fields, including `allowed`, MUST keep their meanings.

The route and its `/api/v1` prefix MUST remain unchanged. This change MUST NOT add admission fields to the run capability view.

The metadata line of a ready contribution row MUST show its admission after the ID and origin:

| Admission | Label |
|---|---|
| `portable` | `Portable: no runtime settings` |
| `explicit` | `Explicit runtime settings` |

The label MUST use the row's existing metadata text style. It MUST NOT change the status text or colour. Refused rows MUST NOT show an admission label.

The label MUST NOT imply selection, permission, startup supply, or actual use. Other console pages MUST remain unchanged by this display change.

Implementation MUST update the "Capabilities and connections" pattern in `DESIGN_SYSTEM.md` in the same change. It MUST use existing styles and components.

**Rationale:** One required field in the ready variant makes admission inspectable without assigning an admission value to refused contributions.

**Rejected alternatives:** A status badge could confuse admission with availability. Per-agent inspection belongs to `resolve-agent-capability-plans`.

## Verification

Verification MUST cover these boundaries:

| Boundary | Required evidence |
|---|---|
| Metadata classification | Absent, null, empty, and identity-only metadata produce portable admission. Valid behavioral settings remain explicit. Malformed values receive the codes and fields from Decision 1. |
| Portable fixtures | Process-level fixtures include a command, skill, and agent without a runtime block. Each seals as ready with portable admission. |
| Kind-specific settings | Commands, skills, and agents accept only their supported fields. Explicit defaults and empty restriction lists preserve their meaning. |
| Export records | Each ready variant validates. Refused records contain no usable definition. Unknown fields and contradictory variants fail validation. |
| Sealed definitions | Portable normalization matches Decision 3. Explicit prerequisites and restrictions remain intact. An explicit command can require a ready portable skill and a ready portable agent. |
| Current shapes | Text exports, server exports, and sealed installations reject `format` and `profile` fields. A stale server export causes `validation-failed`. |
| Retained snapshots | Earlier snapshots cause `snapshot_unreadable` in capability inspection. Waiting runs refuse continuation without accepting an answer or dispatching work. Completed outcomes and independently recorded history remain readable. Compatible snapshots retain provenance after restart and facet removal. |
| Inspection | Ready catalog entries expose portable or explicit admission; refused entries expose neither. Component tests cover both labels and a refused row. |
| Integrity | Export digests, companion bytes, source provenance, canonical bundle bytes, and the owner-pinned digest remain distinct and verifiable. |
| Command input | Repeated markers, literal replacement characters, blank optional input, owner-input append behavior, and explicit required arguments preserve their existing results. |
| Failure scope | A malformed or unverifiable bundle is unavailable. An individual contribution refusal leaves unrelated usable contributions available. |
| Side effects | Admission and installation do not start runs, contact MCP servers, execute scripts, or send model requests. |

Fast unit and service tests MUST cover classification, normalization, validation, resolution, and rendering.

Null and empty-object metadata MUST have unit-test coverage even if the pinned CLI cannot pass those values through installation.

Process-level installation tests MUST use disposable runtime and editor facet homes. They MUST verify that runtime installation does not alter editor materializations.

The published `voice-to-text` facet MUST be tested without author modifications or a consumer-specific wrapper. Evidence MUST identify its actual resolved version and integrity.

That proof MUST use the runtime installation, not an editor's materialized skill copy. It MUST preserve the installed body and companion bytes.

The proof MUST pin the published version and its registry integrity before installation. Evidence MUST compare those pins with the resolved installation.

The proof MUST use a disposable runtime project and disposable facet homes. It MUST NOT change production facet configuration or the root editor installation.

The registry-backed proof MUST run separately from the default offline suites. Its execution MUST receive owner approval before the registry download.

This change's proof ends at valid installation and admission. Startup-context preparation belongs to `resolve-agent-capability-plans`. Durable startup and live behavior belong to `add-run-owned-agent-sessions`.

No additional version-pin test is required. Existing toolchain verification remains effective.

Fixtures that construct sealed installations or retained snapshots MUST use the current shapes. Integration and Docker suites MUST cover their affected fixtures.

Missing Docker coverage MUST NOT be reported as full verification.

Console verification MUST use the development deployment at desktop, phone, and short sizes, in light and dark modes. Browser checks MUST remain smoke and layout checks.

A failed verification MUST stop work. Repair or rerun requires owner approval.

## Risks / Trade-offs

- **Invalid settings appear portable:** Classify metadata explicitly and refuse malformed non-empty settings. Do not use failed validation as portable fallback.
- **Export and loader rules diverge:** Apply the same admission invariants at export, sealing, and runtime loading.
- **Restrictions disappear during normalization:** Preserve explicit restrictions, including empty lists. Reject portable records containing restrictions.
- **Admission appears to grant authority:** Keep installation, selection, activation, independent grants, and actual execution distinct.
- **New exports reach an old reader:** Regenerate and release compatible adapter, sealer, and runtime components together. Do not add an old-format decoder.
- **Installation is mistaken for the full proof:** Report admission evidence separately from startup-context and live-behavior evidence.
- **Earlier snapshots become unreadable:** Preserve their records and report the existing safe refusals. Do not infer admission, convert records, or reset data.
- **Stale exports block regeneration:** Refuse incompatible exports. Verify and document the regeneration procedure in a disposable project before operational use.

## Migration Plan

The adapter, export reader, sealer, and runtime loader MUST use the same current representation.

Runtime exports and sealed bundles MUST be regenerated from the configured facet sources. Existing refused records MUST NOT be edited into ready definitions.

The current representation MUST reject superseded internal format selectors. This change MUST NOT add compatibility decoders, format-version bumps, or conversion of retained runtime records.

Accepted command runs MUST keep their stored records. Decision 3 defines refusal of snapshots whose definitions lack admission records.

An export directory with an incompatible server export MUST fail closed. Installation guidance MUST give a verified regeneration procedure that respects the installer's state checks.

External facet versions, dependency pins, manifest and lockfile versions, and explicit authored `runtimeVersion: 1` settings MUST retain their meaning.

Owner-managed installation paths, materialization choices, and independent grants MUST remain unchanged unless separately approved.

This change MUST NOT execute a database reset. `configure-agent-workspaces-and-sandboxes` owns the reset procedure and final inventory.

Deployment MUST follow the release roadmap. A completed admission change MUST NOT be presented as approval to deploy incomplete execution controls.

An older runtime MUST NOT read a bundle or database schema it cannot validate. Rollback MUST use compatible code and inputs. Any further reset or deployment change requires separate owner approval.

## External follow-ups

| Area | Required follow-up |
|---|---|
| Documentation | Update the root README's Runtime facets and deployment guidance. Explain portable admission, explicit settings, refusal behavior, and unchanged authority boundaries. |
| Installation guidance | Update `deploy/runtime/facets/README.md`. Remove mandatory runtime opt-in claims. Document regeneration with current tools, including directories with incompatible server exports. |
| Data model | Document the admission discriminator in export and sealed-definition descriptions. Keep source-file integrity separate from export and bundle digests. |
| Runtime and deployment | Release compatible readers and writers. Preserve the independent runtime installation and separately approved production configuration. |
| Console | Implement Decision 5 and update the capabilities pattern in `DESIGN_SYSTEM.md`. Item 03 reuses the admission value for per-agent inspection. |

The repository has no files under `docs/`. These follow-ups belong to implementation work; this decomposition does not edit those external files.

## Dependencies and release boundary

The umbrella delta is historical and MUST NOT be applied alongside this change.

Later changes MUST preserve these added admission and incompatible-upgrade requirements when they synchronize their deltas. Any later MODIFIED requirement MUST be checked against the then-current main specification before synchronization.

This change has no predecessor in the release chain.

It supplies admitted definitions to `resolve-agent-capability-plans`. That change owns per-agent availability and per-agent inspection. This change owns the installation-level admission display in Decision 5.

The owner configuration and reset change owns operational regeneration and reset coordination. This change owns the admission representation and its validation.

Provider compatibility, workspace controls, sessions, and operational monitoring remain separate release prerequisites where applicable.

There are no unresolved admission decisions in this design. This does not establish implementation or deployment readiness for the complete release.
