# ADR-021: Portable driver and control-store contracts are backend-neutral

- Status: accepted for Portable Agent Platform v1.
- Scope: portable resource drivers, internal route resolution, control-store records, and infrastructure event replay.
- Supersedes: the portable-platform specification's PostgreSQL-only prescription for the shared control store. PostgreSQL remains an optional conforming implementation; it is not required or privileged.

## Context

Portable lifecycle and connection gateways need one contract that can be implemented locally and on Kubernetes without exposing either backend's storage or routing model. Requiring PostgreSQL would make a database product part of the portability boundary even though local SQLite and reviewed Kubernetes API objects can provide the required atomicity, retention, and optimistic concurrency semantics.

The public `ConnectionDescriptor` is an edge DTO. It describes an authorized client connection after gateway policy and transport selection. It is not the driver's internal route object and must not become a carrier for Pod, Service, socket, process, database, or other backend coordinates.

## Decision

### Resource driver

A portable driver implements these resource operations:

| Resource | Required operations |
| --- | --- |
| scope | `get`, `list` |
| workspace | `create`, `get`, `list`, `update`, `delete` |
| runtime | `create`, `get`, `list`, `update`, `delete`, `setDesiredState` |
| capability | `get` |
| runtime route | `resolve` |
| infrastructure event | `list`, `watch` |

All operations use stable portable identifiers and portable desired or observed resource values. `get` capability reporting covers storage, browser, transport, and autoscaling support. Unsupported optional capabilities return the portable typed unsupported result and are not advertised. A driver never returns a Kubernetes object, SQLite row, PostgreSQL row, filesystem path, process identifier, Pod or Service identity, host, port, URL, socket, credential, or edge endpoint configuration.

`resolve` returns route descriptors containing only a route kind and an opaque route reference. The exact route kinds are `cmux-v10` and `omp-app-v1`; these names identify the internal semantic protocol and do not expose an edge transport or backend coordinate. Each reference is bound to one stable runtime identifier and one runtime generation. Consumers may pass the reference back to its issuing driver and test it for equality; they may not parse it, order it, derive backend coordinates from it, persist it as a public connection descriptor, or reuse it for another generation. A generation change invalidates every route reference from the prior generation.

The public `ConnectionDescriptor` remains an edge DTO assembled after route resolution. Driver route descriptors never contain public WSS, SSH, or HTTP endpoint fields. The `cmux-v10` and `omp-app-v1` route kinds remain internal and generation-bound.

### Revision

A resource revision is an opaque equality-only compare-and-swap token. It is distinct from runtime generation and from event-journal cursor. Revisions have no portable ordering, numeric interpretation, timestamp meaning, or derivation rule. A backend may use a Kubernetes `resourceVersion`, a SQLite value, or another concurrency token internally, but exposes only the opaque portable revision.

`expectedRevision` is required for workspace `update` and `delete`, and for runtime `update`, `delete`, and `setDesiredState`. Workspace retention changes use workspace `update` and therefore have the same precondition. A mismatch returns the typed `revisionMismatch` result carrying the current opaque revision and performs no side effect. Omitting the required precondition or losing revision authority fails closed; last-write-wins is never allowed.

### Replica-safe idempotency ledger

The idempotency surface is exactly `reserve` and `complete`. Its lookup key is exactly ordered as `principalId`, `scopeId`, `method`, `canonicalPath`, `idempotencyKey`; its compared request fingerprint is exactly `canonicalBodyDigest`. `reserve` atomically looks up the key and returns one of `new`, `pending`, `replay`, or `conflict`: a matching digest reaches `pending` or `replay`, while a differing digest reaches `conflict`. `new` includes an opaque reservation token; `pending` prevents another replica from rerunning an in-flight or indeterminate mutation; and `replay` includes the recorded outcome. `complete` conditionally publishes the outcome only when its reservation token matches the live reservation.

Reservation and later completion are deliberately not described as one atomic operation across the asynchronous mutation. If mutation success or completion publication is indeterminate, recovery fails closed: callers do not rerun the mutation, and subsequent `reserve` calls remain `pending` until authoritative reconciliation can conditionally `complete` it. Records live in an authoritative store shared by all replicas serving the scope and are retained for at least 86,400 seconds after the outcome becomes visible. Cleanup cannot shorten that minimum, and loss of shared-store authority fails closed rather than falling back to process memory.

### Connection tickets

The ticket surface is exactly `mint`, `consume`, and `revoke`. `mint` returns random bearer material only once to the authorized caller while persisting only its SHA-256 digest and bounded metadata in the authoritative shared compare-and-swap store. Every record and consumption request is bound to exactly `runtimeId`, `runtimeGeneration`, `providerControlGeneration`, and `purpose`. Ticket TTL is at most 60 seconds. `consume` is one atomic compare-and-delete operation. A ticket is single-use: concurrent, replayed, expired, wrong-purpose, wrong-runtime, wrong-runtime-generation, and wrong-provider-control-generation consumption fails. `revoke` invalidates an unconsumed digest record atomically.

All applicable unconsumed tickets are invalidated on `controlDisconnect`, `providerControlGenerationReplacement`, `runtimeGenerationReplacement`, and `explicitCancellation`. Plaintext ticket material is never logged, stored, placed in a resource status, or recoverable from the digest.

### Deletion tombstones

The tombstone surface is exactly `put` and `get`. Before deleting backend state for a stable external identifier, the driver atomically `put`s its tombstone in the authoritative store. If tombstone creation is uncertain or fails, backend deletion does not begin. A tombstone is retained for at least 86,400 seconds, at most 604,800 seconds, and the store holds at most 100,000 tombstones per scope. Capacity pressure rejects a new deletion before evicting a tombstone still inside its minimum retention window.

Tombstone expiry does not make an identifier reusable. The stable-ID allocator or registry separately records that the identifier was issued and silently reassigning it is permanently forbidden, including after backend cleanup, tombstone expiry, controller failover, or replica restart. The bounded tombstone supports idempotent deletion retries; the allocator/registry owns the longer non-reuse invariant.

### Infrastructure event journal

The journal surface is exactly `append`, `readAfter`, and `subscribe`. The control store maintains a replica-safe, monotonically ordered journal per authorization scope. Every entry contains exactly `eventId`, `resourceKind`, `resourceId`, `scopeId`, `revision`, `phase`, and `timestamp`, with each value bounded by the existing portable API schemas. Entries are infrastructure lifecycle invalidations only; they never contain prompts, terminal bytes, transcript content, browser data, credentials, paths, backend objects, or opaque route references.

The journal is retention-bounded. Cursors are opaque and are distinct from revisions and generations. Listing resources atomically returns high-water cursor `H`. `readAfter(H)` returns an ordered retained batch plus its tail/next cursor `T`; an empty batch returns `H` as `T`. `subscribe` starts strictly after `T` and replays from `T`, so events appended between list, read, and subscribe cannot be lost and there is no list/watch gap. Resume after a retained cursor preserves order without duplication by cursor.

A cursor older than the retained window produces the internal explicit `cursorExpired` outcome and requires a fresh list. The SSE edge maps that outcome to a ResetEvent containing exactly `event`, `eventId`, `reason`, and `timestamp`, with `event` equal to `reset` and `reason` equal to `cursor_expired`; `eventId` and `timestamp` are newly allocated values bounded by the journal's existing portable API schemas. It never silently resumes from the current tail.

## Ownership and implementation freedom

| Concern | Portable contract owner | Allowed implementation examples |
| --- | --- | --- |
| desired resources and revisions | resource driver | SQLite transactions; Kubernetes API objects and optimistic concurrency; PostgreSQL |
| idempotency, tickets, and tombstones | control store | SQLite; reviewed Kubernetes API objects with atomic update/delete; PostgreSQL |
| infrastructure event journal | control store | bounded SQLite journal; reviewed Kubernetes-backed journal; PostgreSQL |
| internal route resolution | resource driver | local process registry; Kubernetes reconciliation state |
| public connection DTO | edge gateway | authorized WSS, SSH, HTTP, or provider-facing descriptor |

An implementation choice is conforming only when it preserves the contract under concurrent replicas and failures. Kubernetes objects may be used by the Kubernetes backend and SQLite may be used by the local backend. Neither choice changes portable fields or leaks into gateway responses. PostgreSQL may be selected where operationally appropriate, but portable conformance cannot require it.

## Fail-closed rules

- Missing shared-store authority rejects mutations, ticket mint/consume/revoke, tombstone creation, and resumable watch decisions.
- An omitted, unknown, or stale required revision never falls back to last-write-wins; `revisionMismatch` has no side effect.
- A route reference with a mismatched or unprovable generation is rejected.
- Idempotency retention is never configured below 86,400 seconds, and an indeterminate reservation is never rerun without authoritative reconciliation.
- Ticket consumption is never implemented as a read followed by a separate delete; TTL, bindings, and invalidation triggers are mandatory.
- Backend deletion never precedes its durable tombstone; capacity never evicts a still-required tombstone to admit a deletion.
- Journal truncation never converts an expired cursor into an empty successful replay; the SSE edge emits the exact reset mapping.
- Drivers and control stores never return backend coordinates or public edge endpoint fields through their portable contracts. Internal `cmux-v10` and `omp-app-v1` route kinds are semantic identities, not leaked endpoints.

## Current implementation boundary

This ADR defines contracts only. It does not add runtime TypeScript interfaces, CRDs, deployment resources, public API schema, or generated SDK fields. P1-01 is the first code implementation of product-neutral portable types. Later local and Kubernetes work may choose different storage mechanisms, but both must pass the same contract and concurrency scenarios.

## Consequences

- Portable callers depend on semantic operations rather than Kubernetes, SQLite, or PostgreSQL representations.
- Runtime generation, resource revision, event cursor, route reference, idempotency key, and ticket remain distinct values with distinct authority.
- Gateway replicas can safely retry mutations, consume tickets, and resume lifecycle events without process affinity.
- Stable identifiers cannot be resurrected after deletion.
- Public connection discovery can evolve independently from internal driver routing without leaking infrastructure details.
