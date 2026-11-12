# Spec Delta

## ADDED Requirements

### Requirement: Portable commands preserve task input without adding authority

The owner SHALL be able to supply optional raw text to a ready portable command, subject to normal command-start checks.

Every literal `$ARGUMENTS` marker in the command instructions SHALL be replaced with the supplied text. Replacement syntax within supplied text SHALL remain literal.

Without that marker, nonblank supplied text SHALL follow the instructions under `## Owner input`, after trailing instruction whitespace is removed.

Without that marker and with blank supplied text, the instructions SHALL remain unchanged.

This text preparation SHALL NOT execute shell syntax, expand environment variables, read referenced files, or interpret another tool's positional markers.

An explicit command's required-argument rule SHALL remain effective. Credential screening and applicable content limits SHALL remain effective.

The system SHALL NOT attribute undeclared runtime prerequisites or restrictions to a portable command.

The run SHALL use its retained definitions and applicable permissions. Portable admission SHALL NOT add selections, delegation relationships, or grants.

#### Scenario: A portable command supplies task instructions
- **WHEN** the owner starts a run from an available portable command whose runtime settings are absent, null, or empty
- **THEN** its instructions and submitted text SHALL form the task under the documented command argument rules
- **AND** no runtime prerequisite or restriction SHALL be attributed to the absent, null, or empty settings
- **AND** the run SHALL use its retained definitions and applicable permissions
- **AND** the command SHALL NOT add selections, delegation relationships, or grants

#### Scenario: Start a portable command without owner text
- **WHEN** the owner supplies no text or blank text to a valid portable command without `$ARGUMENTS`
- **AND** the normal command-start checks pass
- **THEN** the task SHALL preserve the command instructions without adding an owner-input section

#### Scenario: Substitute raw text at every argument marker
- **WHEN** valid portable instructions contain two `$ARGUMENTS` markers
- **AND** the owner supplies text containing literal replacement characters
- **THEN** the task SHALL contain that exact text at both marker positions
- **AND** no owner-input section SHALL be appended

#### Scenario: Append nonblank owner text without an argument marker
- **WHEN** valid portable instructions contain no `$ARGUMENTS` marker and the owner supplies nonblank text
- **THEN** the task SHALL contain the instructions without trailing whitespace, followed by `## Owner input` and the exact supplied text

#### Scenario: Owner text contains shell syntax
- **WHEN** supplied text contains command substitution, environment-variable references, or pipes
- **THEN** text preparation SHALL preserve that syntax literally
- **AND** it SHALL NOT execute commands or expand values

#### Scenario: Portable instructions contain another tool's syntax
- **WHEN** portable instructions contain positional markers, embedded shell commands, or file references for another coding tool
- **THEN** text preparation SHALL leave that syntax literal
- **AND** it SHALL NOT execute commands, read referenced files, or expand positional markers

#### Scenario: Explicit commands still require declared arguments
- **WHEN** the owner supplies blank text to an explicit command that requires arguments
- **THEN** the start SHALL be refused before model or tool dispatch
- **AND** the explanation SHALL identify the missing required text

### Requirement: Admission-format upgrades preserve history without continuing incompatible runs

If an upgrade makes retained definitions incompatible because they do not record admission, the system SHALL refuse continuation before accepting an answer or dispatching work.

Confirmed incompatibility SHALL produce the existing "continuation unavailable" failed outcome. The unanswered question SHALL remain in history and SHALL no longer be answerable.

Temporary inability to verify compatibility SHALL NOT be reported as confirmed incompatibility or a recorded terminal transition.

The run's identity, goal, workspace, provider, recorded history, questions, accepted answers, and outcome SHALL remain inspectable.

Capability details that require incompatible retained definitions SHALL be reported as unavailable, including for completed runs. Independently recorded provenance SHALL remain visible where the history contains it.

Unavailable capability details SHALL NOT be presented as proof that the run had no capabilities.

The system SHALL NOT infer missing admission, substitute current installed definitions, convert retained records, or reset data.

An upgrade that makes retained definitions incompatible SHALL NOT count as an ordinary compatible restart.

For such definitions, the unavailable-details rule SHALL take precedence over guarantees that require readable retained definitions. Compatible restarts and facet removal alone SHALL retain their existing history and provenance guarantees.

An unreadable capability definition SHALL NOT prevent explicit owner cancellation of a still-waiting run. Existing cancellation, concurrency, and terminal-state rules SHALL remain effective.

#### Scenario: A waiting run has an incompatible earlier admission format
- **WHEN** the owner submits an answer after an upgrade makes the run's retained definitions incompatible because they do not record admission
- **THEN** the system SHALL refuse continuation without accepting the answer or dispatching work
- **AND** the run SHALL be shown as failed with category "continuation unavailable"
- **AND** its unanswered question SHALL remain in history but SHALL no longer be answerable
- **AND** the recorded question and history SHALL remain inspectable
- **AND** the system SHALL identify the unavailable capability details without reconstructing them

#### Scenario: A completed run has an incompatible earlier admission format
- **WHEN** the owner inspects a completed run whose retained definitions are incompatible because they do not record admission
- **THEN** the recorded history and outcome SHALL remain inspectable
- **AND** capability details that require those retained definitions SHALL be reported as unavailable
- **AND** unavailable details SHALL NOT be shown as an empty capability set
- **AND** independently recorded provenance SHALL remain visible where the history contains it
- **AND** inspection SHALL NOT execute work, convert records, or substitute currently installed definitions

#### Scenario: Cancel a waiting run before an incompatible continuation attempt
- **WHEN** the owner cancels a still-waiting run whose retained definitions do not record admission
- **AND** cancellation wins under the existing concurrency rules
- **THEN** the runtime SHALL record cancellation without decoding those definitions
- **AND** the question SHALL no longer be answerable
- **AND** the recorded history SHALL remain inspectable

#### Scenario: Compatible history remains available after facet removal
- **WHEN** the owner removes a used facet and restarts with compatible runtime behavior and preserved storage
- **THEN** the run's recorded provenance and outcome SHALL remain inspectable
- **AND** facet removal alone SHALL NOT invoke the incompatible-admission exception
