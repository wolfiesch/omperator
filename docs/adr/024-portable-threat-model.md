# ADR-024: Portable threat model fails closed at every trust boundary

- Status: accepted for Portable Agent Platform v1.
- Scope: contract-only trust boundaries, protected assets, STRIDE threats, security controls, executable negative-check requirements, and implementation boundaries.
- Non-goals: runtime implementation, deployment or NetworkPolicy changes, public OpenAPI or generated SDK changes, CRD changes, audit persistence, schema changes, a new wire protocol, or a claim that any Appendix B scenario currently passes.

## Context

ADRs 020 through 023 already assign authority and define the portable control, authorization, and lifecycle contracts. This ADR threat-models those contracts without changing them: ADR-020 retains one host-owned OMP RPC authority over stdio; ADR-021 retains backend-neutral shared-store tickets, routes, revisions, and tombstones; ADR-022 retains provider-neutral, server-derived, explicit-allow authorization; and ADR-023 retains positive writer fencing and the fail-closed `FenceUncertain` terminal outcome.

The source specification requires executable security-boundary checks in Appendix B.10. P0-08 additionally names ticket replay, sender identity, shell/path injection, credential exposure, cross-scope access, and duplicate writers. Appendix B.10 also requires audit-leakage and runtime-isolation coverage. This ADR makes each class an independently mutable machine-checker contract. It does not implement the later conformance scenarios.

## Decision

### Protected assets and authorities

The protected assets are:

- OMP session, prompt, approval, tool, job, artifact, transcript, and credential-bearing state;
- cmux terminal, workspace registry, VT, browser-pane, and durable runtime state;
- shared workspace files and controller-owned runtime-state roots;
- principal mappings, scope membership, policy, resource authority, and delegated edge authority;
- opaque route references, single-use tickets, generation credentials, revisions, tombstones, and idempotency records;
- provider/model credentials, browser profiles, CDP capability, and administrator configuration; and
- infrastructure-only discovery, status, lifecycle events, decision records, metrics, and traces.

Authority remains server-side. Authenticated transport evidence proves only an adapter subject. The server resolves the principal, membership, resource scope, current generations, role bindings, policy, capability intersection, route, and ticket authority. Client-supplied identifiers are request selectors, never authorization evidence.

### Trust boundaries

Every public and internal boundary below is in scope. A boundary not explicitly allowed is denied.

| Boundary | Untrusted side | Trusted receiver and permitted projection | Required gate |
| --- | --- | --- | --- |
| Public REST and SSE | automation or application client | lifecycle/discovery gateway; bounded resource DTOs and infrastructure invalidations only | authenticated adapter evidence, server-derived scope/resource authority, exact canonical action, current policy, explicit allow |
| Public `omp-app/1` WSS | mobile, web, or desktop client frames | application gateway and generation-bound runtime route; existing `omp-app/1` only | connection authorization plus authorization of every client frame against current authority |
| Public direct cmux WSS | cmux client byte stream | opaque generation-bound cmux protocol v10 stream | connection/direction authorization; no semantic frame translation or invented action wire |
| Public SSH/provider | SSH client, forced command, provider request, or stream ticket | OpenSSH forced-command dispatcher and exact `machine-provider-v1`/cmux v10 paths | authenticated SSH identity, exact command registry, no shell/forwarding, per-request authorization, single-use ticket consumption |
| Public discovery, status, errors, events, metrics, and traces | unauthenticated or authorized observer, monitoring consumer | bounded infrastructure truth only | capability/concealment filtering and strict data-class allowlists |
| Trusted ingress to identity adapter | proxy headers, OIDC evidence, SSH keys/certificates, or service identity | configured identity adapter | authenticated immediate peer where applicable; duplicate, ambiguous, unknown, or disabled evidence denies |
| Edge gateway to control plane | replicated gateway workload and delegated client authority | product-neutral authorization, driver, control-store, and journal interfaces | workload authorization and separately validated delegated authority bound to audience, purpose, principal, scope, resource, action, transport, and current generations |
| Driver to backend/control store | controller or gateway request | configured local, Kubernetes, or optional conforming backend | expected revision, authoritative compare-and-swap, scope-qualified key, bounded record, no process-local fail-open fallback |
| Backend/Kubernetes objects and storage to controller/runtime | untrusted or stale CR/resource data, PVCs, snapshots, and mounted paths | controller admission/reconciliation and the generation-bound runtime attachment | strict bounded allowlist decoding; server-derived scope and ownership; controller-generated roots/subpaths; authorized workspace mount; exclusive generation-bound runtime-state attachment |
| Controller/driver to runtime | desired state, generation credentials, routes, and lifecycle observations | exactly one generation-bound runtime process group | positive fence proof before generation advance/start/attach; full readiness before route or ticket publication |
| Internal runtime process boundary | host, OMP child, cmux, filesystem lock, Unix socket, browser | pod/process-local supervised authority tree | raw OMP RPC on stdio only; private cmux socket; exact existing application and cmux protocols |
| Runtime to credential/model gateway | runtime inference request | allowlisted credential plane | runtime holds no reusable provider credential; exact route/method/header policy, redirect rejection, bounded egress |
| Runtime to browser/CDP | owning host/cmux browser path | one runtime-owned browser profile and loopback CDP endpoint | generation fence, profile capability authorization, loopback-only CDP, no public descriptor or credential |
| Runtime network egress and peer traffic | potentially compromised runtime | DNS, bounded model/internal services, and explicitly allowlisted repository endpoints | default deny; no runtime-to-runtime, Kubernetes API, external CDP, or non-allowlisted egress |
| Components to observability sinks | errors, decisions, lifecycle data, and labels | bounded logs, metrics, status, events, discovery, and traces | allowlisted fields, byte bounds, pseudonymous references, mandatory exclusion before emission |

The contract is transport-, identity-provider-, deployment-driver-, control-store-, credential-provider-, browser-backend-, and observability-backend-neutral. Backend coordinates and adapter-private evidence never become portable contract fields.

### STRIDE threat and control mapping

| Threat class | STRIDE | Attack | Fail-closed control | Independent negative mutation |
| --- | --- | --- | --- | --- |
| Ticket replay | Spoofing, Elevation of privilege | reuse, wrong bearer, wrong audience/purpose/generation, expiry, or replay at another gateway replica | store SHA-256 digest only; bind mint/record/consume to `runtimeId`, current `runtimeGeneration`, current `providerControlGeneration`, `purpose`, `audience`, `principalId`, and `scopeId`; maximum TTL 60 seconds; atomic compare-and-delete; single use; atomic revocation on disconnect, generation replacement, or cancellation; control-store uncertainty denies | weaken any binding, TTL, digest-only storage, atomic single-use consumption, or invalidation and require checker failure |
| Sender identity | Spoofing, Repudiation, Elevation of privilege | forge trusted-proxy headers, principal/scope claims, workload identity, or delegated edge authority | adapter-private evidence; authenticated immediate peer; server-derived principal/scope/resource/generation/policy; workload and delegated authorities are distinct; explicit allow only and deny overrides | permit a client authority claim, ambiguous evidence, authority collapse, or non-explicit allow and require checker failure |
| Shell/path injection | Tampering, Elevation of privilege | arbitrary SSH command, shell metacharacters, forwarding, path traversal, absolute path, NUL, backslash ambiguity, image override, or raw Secret input | exact allowlisted argument vector; array-only execution through `execFile`/`posix_spawn` equivalent with shell disabled; no interpolation or command string; canonical controller-owned root; relative normalized path; reject `..`, leading slash, NUL, and backslash; reject unknown fields and raw secrets before side effects | enable a shell, command string/interpolation, non-exact argv, forwarding, or any forbidden path form and require checker failure |
| Credential exposure | Information disclosure | place credentials, tickets, adapter evidence, headers, cookies, bodies, prompts, transcripts, terminal bytes, browser data, file content/path, environment, backend coordinates, or route references into shared/user-visible surfaces | reusable provider credentials remain in the credential plane; portable outputs use bounded allowlisted fields and pseudonymous references; forbidden data is removed before emission | allow any forbidden data class on logs, metrics, status, events, discovery, traces, or connection descriptors and require checker failure |
| Cross-scope access | Spoofing, Information disclosure, Elevation of privilege | list/get/connect/mutate/watch with a client-supplied scope or guessed resource ID; collide replay/tombstone records across tenants | `ResourceScopeResolver` derives scope server-side; current membership/policy explicit allow; unauthorized existence is consistently not-found-shaped; idempotency and durable security records use principal/scope-qualified keys | trust client scope/resource authority, remove a scope-qualified key component, expose existence, or weaken explicit allow and require checker failure |
| Duplicate writers | Tampering, Denial of service, Elevation of privilege | controller race, failover, stale route/credential, dual attachment, generation reuse, or start while fencing is uncertain | at most one writer-capable runtime process group and one OMP authority; positive process-plus-attachment fence proof precedes fresh generation CAS/start/attach; lease alone is insufficient; routes/tickets wait for full readiness; every writer-capable activity is blocked on `FenceUncertain` | raise cardinality, reuse generation, accept lease-only proof, publish early, or unblock any writer-capable activity on `FenceUncertain` and require checker failure |
| Runtime isolation | Tampering, Information disclosure, Denial of service, Elevation of privilege | run as root, accept hostile backend/CR fields, attach another scope's workspace or runtime state, reach another runtime/Kubernetes API/public CDP/non-allowlisted network, expose raw RPC/socket/lock, share a browser profile writer, or access reusable provider credentials | non-root runtime; strict bounded backend-object admission; server-derived storage scope/ownership; controller-generated workspace/runtime roots; exclusive generation-bound runtime-state attachment; default-deny ingress/egress; runtime-to-runtime and Kubernetes API denied; egress allowlist only; raw RPC stdio-only; cmux socket/locks pod-local; CDP loopback-only and externally unreachable; one generation-fenced browser-profile writer; no reusable provider credential in runtime | weaken object admission, storage ownership/attachment, or any process/network/browser isolation dimension and require checker failure |
| Audit leakage | Repudiation, Information disclosure | emit user content or secrets, use unbounded labels/records, leak cross-scope existence, or let audit failure change authorization | allowlisted bounded schema, 16,384-byte record and 512-byte string maxima, pseudonymous references, same forbidden-data list on logs/metrics/status/events/discovery/traces, logging failure never allows or changes the decision | remove a bound/exclusion, use raw references, or permit logging failure to allow/change authorization and require checker failure |

### Executable negative-check contract

The compatibility manifest pins one independent mutation class for each row above. The baseline checker must reject each mutation with the corresponding named semantic-invariant diagnostic. A whole-object digest check is necessary but not sufficient: tests must mutate ticket replay, sender identity, shell/path injection, credential exposure, cross-scope access, duplicate writers, runtime isolation, and audit leakage independently.

The checker also verifies these cross-contract relationships:

1. ticket bindings include every ADR-021 record/consume binding plus current audience, principal, and scope; TTL, digest storage, atomic compare-and-delete, single use, replica safety, and invalidation remain at least as strict as ADR-021;
2. sender and cross-scope controls retain ADR-022 server-derived authorities, `ResourceScopeResolver`, explicit-allow/deny-overrides decisions, workload/delegated separation, concealment, and principal/scope-qualified idempotency;
3. ticket audience/purpose/generation binding is compatible with ADR-022 delegated internal-route authority and ADR-023 route/ticket invalidation;
4. duplicate-writer controls equal ADR-020 writer cardinality and retain ADR-023 positive fencing, readiness, and every `FenceUncertain` block;
5. credential and audit exclusions include the complete ADR-022 decision-log exclusion set, preserve its byte bounds and logging-failure behavior, and apply to every Appendix B.10 observability surface;
6. runtime isolation retains ADR-020 raw-RPC network prohibition and ADR-023 exclusive runtime-state storage; and
7. browser isolation retains ADR-023 fresh fenced restore generation, single-live-runtime snapshot attachment, and browser readiness in the full readiness conjunction.

No negative check invents a protocol message, public field, CRD value, deployment object, backend, provider, or runtime behavior. Later work packages implement and exercise these contracts against applicable local, single-host, and Kubernetes drivers.

## Security invariants

1. Authentication evidence never authorizes itself; principal, scope, resource, generation, policy, and capability authority are derived server-side and must be current.
2. Unknown, missing, ambiguous, unavailable, stale, mismatched, or unbounded authority denies without side effects.
3. Tickets are opaque, digest-only at rest, audience/purpose/bearer/scope/current-generation bound, at most 60 seconds old, atomically single-use, replica-safe, and revocable.
4. Executable commands are exact argument arrays with shell disabled. User content never becomes a shell string, executable path, controller-owned root, image reference, or unvalidated path segment.
5. Unauthorized cross-scope results conceal existence consistently across list, get, mutation, connect, watch, confirmation, and error paths.
6. One runtime-state root has at most one writer-capable process group, one cmux machine, one browser-profile writer, and one OMP authority. Workspace mounts require server-derived scope and ownership; runtime-state roots are controller-generated, generation-bound, and exclusively attached. `FenceUncertain` blocks all writer-capable activity.
7. Raw OMP RPC, cmux sockets, filesystem locks, CDP, generation credentials, and reusable provider credentials remain internal and are never advertised.
8. Logs, metrics, status, events, discovery, traces, and decision records contain bounded infrastructure truth and pseudonymous references only; credentials and user content are excluded before emission.
9. Failure to authorize, consume, revoke, fence, isolate, redact, or emit audit data never defaults to allow and never changes a deny into an allow.
10. Controls remain portable abstractions. Conforming implementations may choose mechanisms, but may not weaken outcomes based on transport, provider, driver, backend, or deployment mode.

## Implementation boundaries

This ADR completes only the P0-08 contract and checker mutation coverage. Product-neutral enforcement belongs to P1; local process, path, ticket, and runtime-isolation proof belongs to P1/P6; Kubernetes identity, fencing, NetworkPolicy, storage, and workload proof belongs to P2/P5; REST/WSS/SSH enforcement belongs to P4; runtime/browser/credential-plane integration belongs to P3/P5; and executable cross-driver Appendix B.10 scenarios belong to P7.

No implementation, deployment, schema, runtime, or conformance claim follows from accepting this ADR. ADRs 020 through 023 remain authoritative where this threat model references their invariants.

## Consequences

- P0-08 becomes reviewable as a fail-closed contract rather than prose-only threat enumeration.
- Every named P0-08 threat and both additional Appendix B.10 classes have an independent negative mutation.
- Implementations retain freedom of backend and provider choice but must prove the same outcomes.
- Audit persistence, retention policy, operational alerting, and real isolation tests remain later work; bounded redaction semantics are fixed here.
