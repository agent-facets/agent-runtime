# Spec Delta

## ADDED Requirements

### Requirement: Ordinary message content follows the common message-size policy

Ordinary message content SHALL include goals, command arguments, rendered goals, owner-question prompts, text answers, delegated tasks, discussion topics, and returned advice.

The system SHALL NOT apply an independent application size ceiling to that content.

The policy SHALL also apply to complete model messages, common tool outcomes, and HTTP bodies on routes that submit ordinary messages.

Aggregate retained-capability size SHALL NOT become a hidden replacement ceiling.

Authentication and administration routes SHALL retain their separate controls.

Valid encoding, storage validity, required nonblank values, strict objects, credential screening, and permissions SHALL remain enforced.

The system SHALL NOT silently truncate, summarize, or omit message content. It SHALL NOT compress a conversation automatically.

A question MAY declare an answer-length constraint for its requested response format. The console SHALL show that constraint with the question.

A hidden universal answer-size ceiling SHALL NOT supplement the declared constraint.

This policy SHALL preserve separate facet-content validation, startup-skill limits, identifier rules, approval-artifact limits, owner-evidence limits, execution budgets, deadlines, and sandbox resource limits.

Intentional paging of workspace reads, searches, and bundled skill references SHALL remain. Paging SHALL NOT conceal a limit on ordinary messages or returned advice.

#### Scenario: A large goal is accepted complete
- **WHEN** the owner submits a nonblank goal larger than 100 KiB with valid encoding and no runtime-managed credential
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** the system SHALL accept the goal without a size-limit refusal
- **AND** run history and the first model request SHALL contain the complete goal

#### Scenario: Large command arguments and delegate tasks stay complete
- **WHEN** a command run receives arguments larger than 100 KiB and its agent delegates a task larger than 100 KiB
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** the system SHALL NOT refuse the arguments, rendered goal, or delegated task because of size
- **AND** the delegate SHALL receive the complete task

#### Scenario: A large question and answer stay complete
- **WHEN** an agent asks a question with a prompt larger than 100 KiB and no answer-length constraint
- **AND** the owner submits a text answer larger than 100 KiB
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** the console SHALL show the complete prompt
- **AND** the system SHALL accept and deliver the complete answer

#### Scenario: A declared answer-length constraint applies
- **WHEN** a question declares an answer-length constraint and the owner submits a longer answer
- **THEN** the system SHALL refuse the answer and identify that constraint
- **AND** it SHALL NOT truncate the answer to make it fit

#### Scenario: Required checks still apply to large content
- **WHEN** large content is blank, has invalid encoding, includes an unknown field in a strict object, or contains a runtime-managed credential
- **THEN** the system SHALL refuse it for that cause rather than report a size limit
- **AND** it SHALL NOT echo or durably record the credential

#### Scenario: A long conversation is not compressed
- **WHEN** a run's recorded tool outcomes exceed 100 KiB in total and the agent makes another model request
- **THEN** the request SHALL contain the complete recorded conversation
- **AND** the system SHALL NOT automatically summarize, truncate, or remove earlier messages

#### Scenario: Unrelated limits remain effective
- **WHEN** startup instructions exceed their documented limit or a run exhausts its model-step budget
- **THEN** the system SHALL apply that limit under its existing rules
- **AND** it SHALL NOT report the result as a message-size refusal

### Requirement: The provider decides request capacity

The selected provider SHALL remain authoritative for request and context capacity.

Subscription adapters SHALL preserve authorization, endpoint checks, and faithful request adaptation. They SHALL NOT impose an independent inference-request size policy.

A local estimate SHALL NOT reject input as excessive context unless a verified provider contract supports that check.

Such a check SHALL examine the complete adapted request, including instructions, history, tool definitions, and the applicable output allowance.

After confirmed size or context rejection, the system SHALL NOT automatically resend an unchanged request.

#### Scenario: A large request goes to the provider
- **WHEN** a complete adapted request for either provider exceeds 10 MiB
- **AND** no verified provider contract supports a local capacity check
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** the system SHALL send the request to the selected provider
- **AND** it SHALL NOT refuse it because of an independent local size limit or estimate

#### Scenario: The provider refuses a request that is too large
- **WHEN** the provider rejects a request with reliable evidence of a request-size or context-capacity cause
- **THEN** the run failure SHALL identify that cause and the affected provider operation
- **AND** the system SHALL NOT automatically resend the unchanged request

### Requirement: Provider rejections are reported faithfully

The system SHALL classify request-size, context-capacity, and other invalid-request rejections only from reliable evidence.

Without that evidence, a provider rejection SHALL remain unclassified. An HTTP status alone SHALL NOT establish a context-capacity cause.

Failure handling SHALL support empty bodies, non-JSON bodies, connection failures, and unknown error codes.

Reports SHALL NOT expose credentials, message content, or raw provider error bodies.

Serialization and storage failures SHALL NOT be reported as provider rejection. Size alone SHALL NOT cause a failure to be reported as an internal invariant violation.

Specific causes SHALL remain within the existing primary failure categories.

#### Scenario: A provider gives reliable context evidence
- **WHEN** a provider rejection contains a documented error type identifying context capacity
- **THEN** the run SHALL fail with category "provider failure" and identify a context-capacity rejection
- **AND** the explanation SHALL NOT include message content or the raw error body

#### Scenario: An HTTP status alone is not a context cause
- **WHEN** the provider returns HTTP status 400 with an empty or non-JSON body
- **THEN** the system SHALL report an unclassified provider rejection with that status
- **AND** it SHALL NOT claim a context-capacity or request-size cause

#### Scenario: A network failure is not a provider rejection
- **WHEN** the provider connection fails before a response is received
- **THEN** the system SHALL report a network failure
- **AND** it SHALL NOT claim that the provider rejected the request for size or context

#### Scenario: A local failure is not a provider rejection
- **WHEN** the system cannot serialize or store a large request or result
- **THEN** the failure SHALL identify the serialization or storage cause
- **AND** size alone SHALL NOT cause it to be reported as provider rejection or an invariant violation

### Requirement: A failure keeps the accepted input

When failure stops work, previously accepted inputs SHALL remain recorded.

The system SHALL preserve uncertainty about acceptance and dispatch under the existing replay rules.

The console SHALL explain the failure safely and distinguish accepted input from failed subsequent work.

The system SHALL NOT report false success or imply that an accepted input was never accepted.

#### Scenario: A provider rejects a request after an accepted answer
- **WHEN** the provider rejects a request containing an accepted owner answer
- **THEN** the answer SHALL remain recorded as accepted
- **AND** the console SHALL explain the failure and show that the answer remains recorded
- **AND** the run SHALL NOT be shown as successfully completed

#### Scenario: Acceptance of a large submission is uncertain
- **WHEN** the system cannot confirm durable acceptance of a large goal or answer
- **THEN** it SHALL NOT confirm acceptance or report success
- **AND** retry with the same submission identity SHALL follow its existing retry rules
- **AND** the system SHALL NOT report a size limit as the cause

### Requirement: Size and resource monitors operate before limits are removed

Monitoring SHALL operate before the system stops enforcing an affected size limit.

It SHALL measure:

- Message sizes by type, with failure stage and reason.
- Complete adapted provider-request sizes, latency, status, normalized failures, and provider-reported token usage.
- Complete model-message and tool-outcome sizes.
- Serialized record and checkpoint sizes, write duration, and write failures.
- Host memory, concurrent work, process restarts, and out-of-memory terminations.

Missing provider token usage SHALL remain unknown, not zero.

Telemetry SHALL NOT duplicate message bodies, credentials, or raw provider error bodies.

Metric labels SHALL NOT contain message content or run identities.

The owner SHALL be able to inspect size distributions and correlate failures with their stage and reason.

Host evidence SHALL remain available after runtime termination. It SHALL NOT depend on a final write from the stopped process.

Instrument registration alone SHALL NOT establish operational monitoring.

Deployment verification SHALL establish successful collection, durable storage, owner inspection, and host evidence after runtime termination.

Collector reachability SHALL be verified for the actual deployment topology. A collector in another container SHALL NOT be assumed to share a loopback listener.

Host out-of-memory and restart evidence SHALL be verified for the selected platform and collector. A metric name alone SHALL NOT establish that evidence.

Measurements SHOULD use bytes already serialized at the relevant boundary rather than make another complete copy only for measurement.

Monitoring SHALL NOT automatically introduce a content limit.

#### Scenario: Monitors are available before removed limits stop
- **WHEN** a deployment changes to a version without the affected size limits
- **THEN** instrumentation, collection, owner inspection, and independent host monitoring SHALL operate before enforcement stops
- **AND** measurements SHALL become available as the corresponding operations occur

#### Scenario: The owner inspects size distributions
- **WHEN** runs with different message types and failures have occurred
- **THEN** the owner SHALL be able to inspect size distributions by message type
- **AND** failures SHALL be attributable to their stage and reason

#### Scenario: The provider reports no token usage
- **WHEN** a provider response does not report token usage
- **THEN** monitoring SHALL record usage as unknown
- **AND** it SHALL NOT record usage as zero

#### Scenario: Telemetry excludes content and credentials
- **WHEN** a monitored request contains a synthetic credential and known message text, and the provider returns an error body
- **THEN** telemetry SHALL contain no occurrence of that credential, message text, or raw error body
- **AND** metric labels SHALL contain neither message content nor a run identity

#### Scenario: Host data remains after a process termination
- **WHEN** the host stops the runtime process because memory is exhausted
- **THEN** the owner SHALL be able to inspect memory use, restart activity, and out-of-memory evidence for that period
- **AND** the evidence SHALL NOT depend on a final write from the stopped process

#### Scenario: Monitors do not add a limit
- **WHEN** a measured size exceeds all earlier measured sizes
- **THEN** that measurement alone SHALL NOT cause content refusal, truncation, or delay

### Requirement: A new size limit needs evidence and separate approval

A later application size limit SHALL have a documented provider or platform constraint, or measured operational evidence.

Its proposal SHALL identify the protected resource, measurement unit, enforcement boundary, and user-visible failure.

The owner SHALL approve that limit separately.

Runtime and deployment defaults SHALL NOT silently recreate a removed limit.

Documentation SHALL identify remaining platform-enforced limits on ordinary message content.

#### Scenario: Supplied defaults do not create a removed limit again
- **WHEN** the owner uses supplied runtime and deployment defaults and submits a goal larger than 100 KiB
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** no runtime or deployment default SHALL refuse the goal because of its size
- **AND** documentation SHALL identify remaining platform limits

#### Scenario: A proposed limit lacks evidence or approval
- **WHEN** a proposed application size limit lacks a documented constraint, supporting measurement, or separate owner approval
- **THEN** the system SHALL NOT enforce it

### Requirement: Capacity risk is stated without capacity claims

Documentation SHALL state that resource exhaustion can occur before a provider rejects a request.

Monitoring SHALL NOT be presented as a guarantee of recovery or unlimited capacity.

Documentation and test reports SHALL NOT claim a capacity or maximum safe size without supporting measurements.

Capacity experiments and live provider traffic SHALL require separate owner approval.

Automated policy tests SHALL use deterministic substitutes without live provider authorization.

#### Scenario: Documentation states the accepted risk
- **WHEN** the owner reads the message-size documentation
- **THEN** it SHALL explain that resource exhaustion can precede provider rejection
- **AND** it SHALL NOT claim a capacity or maximum safe size without supporting measurements
- **AND** it SHALL NOT present monitoring as a recovery guarantee

#### Scenario: Policy tests stay deterministic
- **WHEN** automated tests for this policy run
- **THEN** they SHALL use deterministic provider substitutes
- **AND** they SHALL NOT require live provider authorization
