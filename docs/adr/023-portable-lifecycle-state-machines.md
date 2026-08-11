# ADR-023: Portable lifecycle state machines fail closed at the writer fence

- Status: accepted for Portable Agent Platform v1.
- Scope: contract-only desired-state, runtime-generation, drain, fencing, replacement, deletion, finalizer, retention, snapshot, restore, storage-separation, readiness, and route/ticket invalidation semantics.
- Non-goals: runtime or controller implementation, public OpenAPI or generated SDK changes, CRD changes, deployment wiring, and conformance claims.

## Context

ADR-025 assigns infrastructure desired state and runtime-generation authority to the driver/control plane while preserving one OMP authority and at most one writer-capable runtime process group. ADR-021 makes resource revision, runtime generation, and event cursor distinct; binds routes and tickets to runtime generation; and requires a durable tombstone before backend deletion. This ADR preserves those authority boundaries and defines the lifecycle transitions that use them.

The existing OpenAPI contract supplies the complete public desired-state vocabulary `Running`, `Sleeping`, and `Stopped`, and the complete public phase vocabulary `Pending`, `Provisioning`, `Starting`, `Ready`, `Sleeping`, `Stopped`, `Deleting`, `Unavailable`, `Degraded`, and `Failed`. The lifecycle contract consumes those registries; it does not add a public schema value. Internal drain and fence states are control-plane facts and are projected through public phase and condition fields.

Current Kubernetes reconciliation, local runtime supervision, readiness, route projection, storage layout, and conformance fixtures do not implement these state machines. Their later implementation must satisfy this contract rather than being treated as evidence that it is already satisfied.

## Decision

### Authorities and distinct values

Desired state is authoritative resource input accepted under the current resource revision. Workload, Pod, process, OMP, cmux, route, ticket, readiness, and provider observations never infer or rewrite desired state.

The following values are distinct and MUST NOT be equated, ordered through one another, or derived from one another:

- opaque resource revision, used for mutation compare-and-swap;
- opaque portable runtime generation, used to fence writer authority, routes, and tickets;
- Kubernetes `metadata.generation` and `status.observedGeneration`, used only to observe Kubernetes spec reconciliation;
- opaque event cursor, used only for journal replay;
- opaque provider-control generation, used to bind one provider-control connection epoch;
- opaque route reference, used only by the edge/driver route resolver.

A Pod UID, Kubernetes `resourceVersion`, clock, process ID, route reference, provider-control generation, OMP identifier, or cmux identifier is never the portable runtime generation.

### Desired-state machine

| Desired state | Entry and convergence | Terminal contract |
| --- | --- | --- |
| `Running` | Create, authorized wake/start, replacement, or restore converges through `Pending` -> `Provisioning` -> `Starting` -> `Ready`. Before any potentially writer-capable start, the prior writer is `NoPriorWriter` or positively `FenceProven`, and a fresh runtime generation is committed by compare-and-swap. | Exactly one generation-bound process group may write runtime state. Routes and tickets exist only for the current generation after full readiness. |
| `Sleeping` | Authorized sleep or a later authorized idle policy converges from a live or unavailable phase through drain and fence. | No runtime process, writer, route, ticket, or generation credential remains. Durable state is retained. The runtime remains discoverable and may be explicitly or provider-policy woken. Sleep is not deletion. |
| `Stopped` | Authorized stop converges from any non-deleting state through the same drain and fence sequence. | No runtime process, writer, route, ticket, or generation credential remains. Durable state is retained. Only an explicit authorized transition to `Running` may start it; idle policy, provider recovery, and automatic wake do not. Stop is not deletion. |
| deleting | Authorized delete under the exact expected revision converges through `Deleting`, drain, revocation, quiescence, positive fence proof, durable tombstone, backend cleanup, and retention disposition. | The stable identifier remains permanently issued. Delete is neither sleep nor stop and never silently recreates the identity. |

Failure to obtain authoritative fence proof has exactly one terminal outcome for the current automatic attempt: internal `FenceUncertain`, publicly projected as phase `Degraded` with condition `Fenced=False`, reason `FenceUncertain`. It is not `Failed`, `Ready`, or a retry loop.

### Runtime-generation machine

1. Resource creation allocates an initial opaque runtime generation even when initial desired state is `Sleeping` or `Stopped`.
2. Before a potentially writer-capable start, the control plane proves `NoPriorWriter` or `FenceProven`, then atomically compare-and-swaps the authoritative resource from the current generation to a fresh generation before creating, attaching, or starting the process group.
3. Sleep, stop, and delete completion do not advance generation merely to report a no-writer terminal phase. The last generation remains visible so stale routes, credentials, and tickets remain detectably stale.
4. Once an attempt could have acquired writer authority, its generation is never reused. A retry first drains and fences that attempt, then commits another fresh generation.
5. Readiness requires the workload-reported runtime generation to equal the current authoritative runtime generation. Kubernetes `observedGeneration` remains a separate spec-observation field.
6. A compare-and-swap conflict aborts with no attach and no start. No generation advance, route, ticket, attachment, replacement, or writer-capable retry is allowed after `FenceUncertain` until fresh authoritative proof is obtained and an explicit manual recovery action is recorded under a new resource revision.

### Ordered drain machine

The exact drain sequence is:

1. `RouteDraining`: atomically stop route publication and ticket minting for the current runtime generation. New connection resolution returns a non-ready or fencing result.
2. `TicketsRevoked`: atomically revoke every applicable unconsumed ticket bound to the runtime generation and provider-control generation. Control-store uncertainty fails closed.
3. `CredentialsRevoked`: revoke generation-bound internal credentials so the old generation cannot authenticate even if network reachability remains.
4. `ConnectionsClosing`: close existing streams and clients within bounded grace. Reconnection cannot start or attach OMP.
5. `AuthorityQuiescing`: stop accepting mutations, request and acknowledge durable OMP/cmux/browser flush where reachable, and stop OMP child, cmux, browser, then host. Missing acknowledgement proceeds to external fencing and is never assumed successful.
6. `FenceVerifying`: obtain positive backend-specific proof that the process group and runtime-state writer/attachment can no longer mutate state.
7. exactly one result: `FenceProven` permits subsequent lifecycle progress; `FenceUncertain` fails closed for the current automatic attempt.

### Fence machine and proof

The exact internal fence states are `NoPriorWriter`, `DrainRequired`, `ShutdownRequested`, `FenceVerifying`, `FenceProven`, and `FenceUncertain`. Of these, `FenceUncertain` is the sole uncertain terminal.

Kubernetes positive proof is the conjunction of all of the following:

- the old Pod UID is authoritatively absent or terminated;
- generation credentials are revoked;
- old Service and endpoints cannot route;
- the runtime-state `VolumeAttachment` or mount is released, or storage/node fencing positively proves the old node cannot write; and
- the controller still owns the same resource revision and generation decision.

A Lease, deletion request, cached Pod miss, TCP failure, RWX annotation, or timeout alone is insufficient.

Local positive proof is the conjunction of all of the following:

- the supervised process group and every descendant are dead;
- generation credentials and socket routes are revoked;
- the supervisor has reacquired the exclusive runtime-state writer lease; and
- the old process no longer has write access.

PID absence or a filesystem lock alone is insufficient.

Timers may re-observe authoritative evidence but never convert uncertainty into success. Exiting `FenceUncertain` requires both fresh authoritative proof and an explicit manual recovery action recorded under a new resource revision. Until then the public projection remains `Degraded` plus `Fenced=False` reason `FenceUncertain`, with no generation advance, route, ticket, credential, attachment, replacement, finalizer progress, or writer-capable start.

### Replacement machine

The exact replacement sequence is:

1. record the replacement cause and set `Provisioning` or `Unavailable` as appropriate; set `RouteReady=False`; begin drain of generation G;
2. revoke tickets and generation credentials, close connections, and request graceful quiescence;
3. terminate the old process and obtain positive process-group plus runtime-state attachment proof;
4. only with `FenceProven` and `desiredState=Running` under the expected resource revision, compare-and-swap a fresh runtime generation; abort without starting on conflict;
5. attach separate runtime-state storage exclusively, mount shared workspace according to policy, and create exactly one process group carrying the fresh generation;
6. acquire the writer lease and start supervisor, host, the single OMP authority, cmux, and any profile-required browser;
7. satisfy the complete readiness conjunction, then set `Ready` and `RouteReady=True`, publish generation-bound routes, and only then mint tickets;
8. on readiness failure keep routes absent. A retryable attempt remains `Starting` or `Unavailable`; a non-safety failure may be `Failed`. If the attempt could have written, another attempt returns through drain and fence and uses another fresh generation.

Replacement causes include authorized wake/start, configuration or image change, failed or lost process, and restore. None bypasses the sequence.

### Deletion, finalizer, and retention machine

The exact deletion sequence is:

1. `DeleteAccepted`: authorize against the exact expected revision and compare-and-swap phase `Deleting` plus durable deletion intent.
2. `Draining/Fencing`: remove routes, stop ticket minting, revoke tickets and generation credentials, quiesce, and wait for positive writer and attachment fence proof. `FenceUncertain` stops deletion before tombstone creation or backend cleanup.
3. `Tombstoned`: after `FenceProven`, successfully put the authoritative durable tombstone under ADR-021 capacity and retention rules, immediately before backend cleanup. Backend deletion has no side effect if the put is uncertain or fails.
4. `BackendCleanup`: only with `FenceProven` and the tombstone durable, remove owned Pod/process, Service/socket, credential, route, and ticket resources. Apply shared-workspace `Retain`/`Delete` independently from runtime-state retain/purge disposition.
5. `DeletedRetained`: when explicit policy retains runtime state, no live route is discoverable; retained state may be the source of a later explicit restore.
6. `Purged`: only an explicit authorized purge under a current revision and `FenceProven` destroys runtime state. The tombstone remains under ADR-021 and the stable ID remains non-reusable.
7. `FinalizerComplete`: remove the finalizer only after the retained tombstone is durable, writer and attachment are fenced, owned workload cleanup is complete, routes/tickets/credentials are absent, and retention disposition is complete.

Ownership conflict, authority uncertainty, cleanup uncertainty, retention uncertainty, or `FenceUncertain` retains the finalizer. Drain and positive fence proof precede tombstone creation; the tombstone is written immediately before backend cleanup and remains retained after every retention disposition.

### Snapshot and restore machine

A consistent snapshot requires first reaching `Sleeping` or entering an OMP-and-cmux-confirmed quiesced checkpoint while routes and tickets are drained. An unquiesced storage snapshot is explicitly crash-consistent and is never represented as consistent or quiesced.

Restore is authorized under the expected revision and a current identity decision. The target must have no live writer; the source snapshot must not be attached to another live runtime; and storage and control authorities must be available. The implementation prepares isolated state, records restore provenance, and follows the replacement machine using a fresh fenced runtime generation. Restore never reuses the source generation and never attaches one snapshot to two live runtimes.

Restoring a deleted stable identity is an explicit authorized compare-and-swap against deletion/tombstone history, not allocator reuse. Old delete retries with the old revision fail `revisionMismatch`. The tombstone and history remain. If source or target attachment might still have a live writer, or detach cannot be proven, the outcome is `FenceUncertain`/`Degraded`, with no attach and no writer. Restore publishes routes only after the same full readiness checks as every other replacement.

### Storage authority separation

Shared workspace storage and runtime-state storage are separate authorities:

- workspace storage contains project files and may be RWX-mounted by multiple authorized runtimes according to workspace policy;
- runtime-state storage contains OMP, cmux, browser, and supervisor state and has exactly one writer-capable runtime attachment;
- a workspace RWX mount, workspace ownership annotation, or workspace retention decision is never proof that runtime-state storage is fenced;
- runtime-state attachment proof is required independently before generation advance, replacement, restore, purge, or finalizer completion.

A later additive CRD implementation defaults a missing desired state to `Running` and keeps new fields optional/default-safe so legacy persisted objects remain valid. This ADR does not add those fields.

### Readiness and publication

`Ready` and `RouteReady=True` require the conjunction of:

- `desiredState=Running` and public phase `Ready`;
- current authoritative runtime generation equals workload-reported generation;
- `Fenced=True` for every older generation;
- runtime-state storage attached and `StorageReady=True`;
- exclusive writer lease held by the current supervisor;
- cmux `identify` protocol 10 ready;
- the pinned single OMP authority ready;
- internal generation authentication ready; and
- every profile-required browser ready.

TCP reachability, Pod readiness, process existence, or any proper subset is insufficient. Until the conjunction holds, routes remain absent and no ticket is minted.

Routes and tickets are bound to current runtime generation. On any invalidation trigger the control plane removes driver route references and edge descriptors, stops minting, and atomically revokes applicable unconsumed tickets. The exact triggers are drain initiation, desired state leaving `Running`, runtime-generation replacement, provider-control-generation replacement, control disconnect, explicit cancellation, deletion, restore start, and resource scope/profile/authorization change. Ticket consumption continues to check runtime generation, provider-control generation, purpose, and the digest-only authoritative record defined by ADR-021.

### Status and journal boundary

Public lifecycle status and infrastructure journal entries contain bounded infrastructure truth only. They never contain prompts, transcripts, terminal bytes, credentials, browser pixels, backend addresses, filesystem paths, private route references, or provider-specific attachment coordinates.

## Consequences

- `FenceUncertain` is explicit, terminal for the automatic attempt, and operationally visible without adding a public phase enum.
- Runtime revision, writer generation, Kubernetes reconciliation generation, provider-control connection generation, route reference, and event cursor cannot substitute for one another.
- Sleep, stop, delete, replacement, and restore share one drain/fence safety boundary while retaining distinct product semantics.
- Later local and Kubernetes implementations must prove these transitions with real processes and attachments; this accepted contract makes no runtime implementation claim.
