# Spec Delta

## ADDED Requirements

### Requirement: Retained tool policies preserve reviewed identities

An accepted run SHALL retain each tool's structured identity, reviewed definition digest, and immutable classification revision.

For a deduplicated facet tool, retention SHALL preserve the installation-selected origin, facet identity, and installed version.

A later installation or classification edit SHALL NOT replace those retained bindings. A changed definition SHALL NOT inherit classification merely because its exposed name is unchanged.

Each exposed name SHALL reference its exact retained identity. Dispatch SHALL NOT reconstruct an origin by splitting a name at `__`.

Current independent owner revocations and continuation checks SHALL remain effective. A retained classification SHALL NOT restore revoked access.

Classification SHALL remain separate from server approval, tool grants, argument restrictions, and approval of an exact critical operation.

#### Scenario: A later installation selects another tool origin
- **WHEN** a run retains a deduplicated tool from one selected origin
- **AND** a later installation selects another origin
- **THEN** the accepted run SHALL retain its original origin, classification, and reviewed definition digest
- **AND** compatible continuation SHALL NOT substitute the new installation's classification
- **AND** current independent owner revocations SHALL continue to constrain dispatch
