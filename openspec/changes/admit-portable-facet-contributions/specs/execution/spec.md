# Spec Delta

## ADDED Requirements

### Requirement: Portable commands preserve task input without adding authority

A portable command's instructions and submitted text SHALL form the task under the documented command argument rules.

Portable commands SHALL accept optional raw text arguments. Literal argument substitution and the owner-input append behavior SHALL remain unchanged. Neither operation SHALL evaluate shell syntax.

The system SHALL NOT attribute undeclared runtime prerequisites or restrictions to a portable command.

The run SHALL use the consuming agent's configured capabilities and effective permissions. Portable admission SHALL NOT add selections, delegation relationships, or grants.

#### Scenario: A portable command supplies task instructions
- **WHEN** the owner starts a run from an available portable command whose runtime metadata is absent, null, or empty
- **THEN** its instructions and submitted text SHALL form the task under the documented command argument rules
- **AND** no runtime prerequisite or restriction SHALL be attributed to the absent, null, or empty metadata
- **AND** the run SHALL use the entry agent's configured capabilities and effective permissions
- **AND** the command SHALL NOT add selections, delegation relationships, or grants
