# ADR-022: Portable identity and authorization are server-derived and fail closed

- Status: accepted for Portable Agent Platform v1.
- Scope: contract-only identity normalization, principal and scope authority, authorization decisions, capability evaluation, transport action registries, concealment, and bounded redacted decision logging.
- Non-goals: runtime implementation, public OpenAPI or generated SDK changes, deployment, cluster or host wiring, OMP changes, and the later threat-model and audit-persistence work.

## Context

The current repository has several useful but product-specific seams. The local remote listener obtains Tailscale peer evidence and the remote policy combines paired devices, capabilities, and an optional guard. The cluster gateway accepts a principal derived from explicitly trusted proxy headers. Its internal session-host path authenticates a Kubernetes service-account token and filters a negotiated capability set. Projection and mutation paths currently use owner strings to filter or reject access. These are source facts, not the portable design: none of the Tailscale, device-registry, Kubernetes TokenReview, owner-string, URL-routing, or capability-only mechanisms is endorsed as a complete authorization implementation.

The portable platform adds REST, SSE, `omp-app/1`, direct cmux WSS, machine-provider SSH, and internal edge-to-runtime routes. Authentication at any of those boundaries establishes only evidence about an adapter subject. It cannot establish portable principal identity, scope membership, roles, resource ownership, resource generation, or authority to perform an action.

## Decision

This ADR defines contracts only. P1-01 is the first work package that may introduce product-neutral types. Gateway, runtime, deployment, audit persistence, and executable threat checks remain later work packages.

### Distinct interfaces and authorities

The following interfaces remain distinct. An implementation may colocate them, but one result cannot be treated as another authority's result.

| Interface | Input | Authoritative output and limits |
| --- | --- | --- |
| `IdentityAdapter` | authenticated transport/provider evidence | One bounded, opaque `adapterSubject` plus adapter kind and authentication instant. It proves only the adapter subject. It never supplies a portable principal, scope, membership, role, policy, or resource authority. |
| `PrincipalResolver` | adapter kind and adapter-private `adapterSubject` | One current record containing opaque `principalId`, `kind`, `enabled`, and `principalRevision`, or a deny outcome. Missing, unknown, ambiguous, disabled, revoked, or unavailable mapping denies. |
| `ScopeMembershipSource` | `principalId` and `scopeId` | Current membership revision and policy-bound role identifiers for that principal in that scope. It does not infer membership from a client claim or resource identifier. |
| `ResourceScopeResolver` | resource kind and stable resource identifier | Current authoritative `scopeId`, resource state, profile, generation where applicable, and authority revision. It does not accept those values from the client as authority. |
| `PolicySource` | scope and current membership/policy revisions | Current policy revision and bindings from opaque role identifiers to explicit actions and constraints. |
| `AuthorizationChecker` | the normalized decision input below plus current server-derived authorities | One bounded decision containing exactly `allowed`, `reasonCode`, `policyRevision`, and `effectiveCapabilities`. Only `allowed: true` from an explicit allow authorizes; deny overrides allow. Unknown actions and missing, unknown, ambiguous, stale, revoked, or unavailable authorities deny. |
| `CapabilityEvaluator` | implementation support, resource profile, resource state, authorization result, and an optional client request | The exact intersection described below. It cannot turn a denied action into an advertised or usable capability. |

Required adapter categories are OIDC/OAuth 2.1, OpenSSH public key or certificate, Tailscale trusted ingress, and administrator mTLS or service identity. A production deployment enables at least one configured adapter and is never required to be Tailscale-only. Adapter header names and the stable provider subject remain private to the adapter; neither enters the portable principal or policy contract.

Roles are policy-bound opaque identifiers. The portable contract gives no role name special meaning and defines no implicit `owner`, `admin`, creator, operator, or adapter-subject grant. Ownership-like behavior exists only as an explicit current policy binding.

### Decision input and precedence

Every decision input contains exactly these semantic fields:

- `principalId`
- `scopeId`
- `resourceKind`
- `resourceId`
- `action`
- `transport`

The server derives `principalId`; membership and policy revisions; resource scope, generation, profile, and state; and role bindings from the authorities above. A client may select a stable resource identifier and request an action, but client-provided scope, role, generation, profile, state, or policy data is never authoritative.

Only an explicit allow authorizes an action. Any applicable deny overrides every allow. Unknown or unmapped actions deny. Missing, unknown, ambiguous, stale, revoked, or unavailable identity, membership, resource-scope, role-binding, policy, or delegated-route authority denies. Authentication success alone never authorizes.
The decision output contains exactly `allowed`, bounded stable `reasonCode`, current `policyRevision`, and `effectiveCapabilities`. The boolean is not a role or capability shortcut: `allowed` is true only for the evaluated action, and the effective capabilities are the same intersection used by discovery and enforcement.


### Capability intersection

The effective capability set is exactly:

`implementation support ∩ resource profile ∩ resource state ∩ authorization`

An optional client-requested capability set may only narrow that result; it is intersected last. It can never widen any factor. Capability discovery and enforcement use the same result, and every use is still checked against current authorization. Implementation availability, profile selection, state readiness, authorization, and client preference are distinct factors and cannot substitute for one another.

### Exhaustive action registries

Every action entering through REST, SSE, `omp-app/1`, direct cmux WSS, machine-provider SSH, or an internal route has exactly one registry entry. Prefix matching, fallback actions, wildcard actions, inferred synonyms, and unmapped pass-through are forbidden. An unknown operation, command, frame, SSH command or mode, or internal route action denies.
The minimum canonical policy-action vocabulary is exact: `scope.read`, `scope.admin`, `workspace.read`, `workspace.create`, `workspace.update`, `workspace.delete`, `workspace.purge`, `runtime.read`, `runtime.create`, `runtime.wake`, `runtime.sleep`, `runtime.stop`, `runtime.delete`, `runtime.purge`, `runtime.connect.cmux`, `runtime.connect.omp-app/1`, `browser.read`, `browser.control`, `browser.input`, `settings.read`, `settings.write`, `config.read`, `config.write`, and `destructive.confirmation`. Finer protocol actions remain exhaustive and may be required in addition, but they map to these canonical actions wherever applicable; they never create aliases, prefix grants, or a free-form policy escape. A destructive confirmed operation requires both its original canonical action and `destructive.confirmation`.


#### REST and SSE

The registry covers all 18 current OpenAPI operation IDs. `getDiscovery` is the sole anonymous action. All other operations require a resolved principal and current authorization.

| Operation ID | Required action | Additional constraint |
| --- | --- | --- |
| `getDiscovery` | `discovery.read` | Sole anonymous action; returns no scoped data. |
| `getVersion` | `scope.read` | Authenticated deployment metadata. |
| `getCapabilities` | `scope.read` | Capability result is the exact intersection. |
| `listScopes` | `scope.read` | Authority query returns only authorized scopes. |
| `listWorkspaces` | `workspace.read` | Authority query is constrained before pagination. |
| `putWorkspace` | `workspace.create` | Target scope membership and policy are current. |
| `getWorkspace` | `workspace.read` | Resource scope is server-derived. |
| `patchWorkspace` | `workspace.update` | Current revision and authorization are both required. |
| `deleteWorkspace` | `workspace.delete` | Current revision and authorization are both required. |
| `listRuntimes` | `runtime.read` | Authority query is constrained before pagination. |
| `putRuntime` | `runtime.create` | Target workspace and scope are server-derived. |
| `getRuntime` | `runtime.read` | Resource scope is server-derived. |
| `patchRuntime` | field/value-sensitive union plus finer `runtime.update` | Current revision is required; the exact resolver below determines canonical actions. |
| `deleteRuntime` | `runtime.delete` | Current revision and authorization are both required. |
| `wakeRuntime` | `runtime.wake` | Rechecked at mutation time. |
| `sleepRuntime` | `runtime.sleep` | Rechecked at mutation time. |
| `getRuntimeConnections` | `runtime.read` | Each returned route additionally requires `runtime.connect.cmux` or `runtime.connect.omp-app/1`; unauthorized transport descriptors are omitted. |
| `getEvents` | `scope.read` | SSE selection is constrained at the authority query and on resumed delivery. |
`patchRuntime` authorizes the complete decoded patch, not only its endpoint. `desiredState: Running` adds `runtime.wake`, `desiredState: Sleeping` adds `runtime.sleep`, and `desiredState: Stopped` adds `runtime.stop`. Each present `displayName`, `browserPolicy`, or `idlePolicy` field adds `scope.admin`. Every patch also requires the finer `runtime.update` action. A multi-field patch requires the union of every applicable action; duplicate actions are evaluated once. An unknown field, an unknown desired-state value, an undecodable field, or a missing action mapping denies the whole patch before mutation.


Route-specific connection actions are exactly `runtime.connect.omp-app/1`, `runtime.connect.cmux`, and the finer SSH transport action `connection.ssh.connect`. Possessing `runtime.read` reveals no descriptor for a route whose connect action is denied.

#### `omp-app/1` WSS

Opening WSS requires current `runtime.connect.omp-app/1` authorization. Every frame is authorized again; an authenticated connection is not a frame bypass. Frame mappings are exact:

| Client frame type | Required action |
| --- | --- |
| `hello` | `connection.omp-app.open` |
| `command` | the one action `omp.command.<COMMAND_DESCRIPTORS key>` derived from its exact descriptor key |
| `confirm` | both `destructive.confirmation` and the original action bound to the confirmation |
| `pair.start` | `connection.omp-app.pair` |
| `ping` | `connection.omp-app.ping` |
| `terminal.input` | `omp.frame.terminal.input` |
| `terminal.resize` | `omp.frame.terminal.resize` |
| `terminal.close` | `omp.frame.terminal.close` |

`ping` is an authenticated connection action. The command registry is one-to-one with the authoritative `COMMAND_DESCRIPTORS` key block in `packages/host-wire/src/command.ts`; it is not an abbreviated capability list or prefix rule. Every command requires its exact finer-grained `omp.command.<key>` action, plus the exact canonical action recorded for that key when one applies. Catalog drift fails the baseline checker until this contract is reviewed. Confirmation material is single-use, expires within a bounded implementation-defined interval, and is bound to the original `principalId`, `scopeId`, `resourceKind`, `resourceId`, `action`, `transport`, resource generation, and policy/membership revisions. Consuming a confirmation requires `destructive.confirmation` and reauthorizes the original action against current authorities before any side effect.

WSS open authorization and every command or frame authorization are invalidated and reevaluated after principal revocation; membership or policy revision; resource state, profile, or generation change; or route generation change. A long-lived connection or negotiated grant does not freeze authority.

#### Direct cmux WSS

Direct cmux WSS requires `runtime.connect.cmux` and uses exact stream-direction checks for `cmux.stream.send` and `cmux.stream.receive`, plus current runtime generation. The gateway treats protocol-v10 bytes as opaque and performs no semantic command translation or per-frame action decoding. The send/receive checks authorize stream direction, not a new cmux action protocol. Framing validation does not replace authorization, and an unknown direction or translated semantic action denies.

#### Machine-provider SSH and direct command mode

The SSH forced-command dispatcher accepts two required exact original commands: `cmux provider control` and `cmux provider stream`. Both forbid PTY and map respectively to `connection.ssh.provider-control` and `connection.ssh.provider-stream`; each also requires `connection.ssh.connect` and the current route generation. The local direct-command equivalents are exact argv `omperatorctl provider -- control` and `omperatorctl provider -- stream`, with the same control/stream distinction and no shell evaluation.

Provider-control authorization is not a connection-time grant for the full lifecycle. Every request method is parsed from the pinned machine-provider-v1 registry and reauthorized against current authority. Inventory and snapshots require `runtime.read` or `workspace.read`; creation requires `runtime.create` or `workspace.create`; open requires `runtime.connect.cmux`; close requires `runtime.stop`; delete and purge require their respective canonical action plus `destructive.confirmation`; restore and rename require their exact registry mapping; and action invocation resolves an exact enabled target to `runtime.wake`, `runtime.sleep`, or `runtime.stop`. Unknown methods, targets, or mappings deny.

Three optional commands may be enabled only as individual exact registry entries: `cmux-tui relay --session <id>` with one bounded opaque session identifier, PTY forbidden, and `runtime.connect.cmux`; `omperator attach <runtime-id>` with one bounded opaque runtime identifier, PTY required, and `runtime.connect.omp-app/1`; and `omperator version` with no arguments, PTY forbidden, and `scope.read`. Disabled entries deny and are not advertised. Exact token count, literal positions, identifier decoding, PTY mode, current scope/resource/generation resolution, and current authorization are checked before dispatch.

An empty command, interactive or login shell, arbitrary command, extra or reordered token, unregistered flag, environment assignment, quoting-based reinterpretation, forwarding, agent forwarding, X11 forwarding, tunnel, subsystem, or `exec` outside an enabled exact entry denies before dispatch. No shell parses accepted commands. Provider control, provider stream, optional relay/attach/version, direct cmux WSS, `omp-app/1`, REST, and internal-route authorities remain distinct.

#### Trusted ingress adapters

A trusted-proxy adapter is enabled only by explicit immediate-peer trust and authenticated transport. Missing, duplicate, conflicting, or ambiguous identity evidence headers deny, as does an unknown or disabled adapter. Adapter-specific header names remain private implementation data. Trusted ingress supplies identity evidence only and never scope, membership, role, policy, or portable principal authority.

#### Internal edge-to-runtime route

An internal route first requires authenticated workload authorization for `internal.route.open`. It then requires delegated edge authority for the exact original external action. Delegation is opaque, audience-bound, purpose-bound, principal-bound, scope-bound, resource-bound, action-bound, transport-bound, and bound to runtime and route generations. The runtime independently verifies both authorities and current generation. Workload identity alone never grants user action authority; delegated edge authority alone never grants workload route authority. Unknown internal actions deny.

### Reevaluation, revocation, query constraints, and concealment

Long-lived grants, tickets, connections, confirmations, watches, and delegated routes are invalidated or reauthorized on principal revocation; membership revision; policy revision; resource state or profile change; resource generation replacement; or route generation replacement. A cache may improve performance only if it cannot outlive or miss those invalidations. Authority unavailability denies rather than extending a cached grant.

REST list queries and SSE selections are constrained at the authoritative data query, not by filtering an unscoped result afterward. Resumed SSE delivery rechecks scope authority. Connection discovery omits unauthorized transport descriptors. Cross-scope existence concealment is consistent across get, mutate, connect, list, watch, confirmation, and error paths: a caller lacking scope visibility receives the same not-found-shaped outcome whether the stable identifier exists elsewhere or not. Authentication failures may remain distinguishable from concealed resource existence, but no transport exposes cross-scope existence through status, timing categories, descriptors, or error detail.

### Bounded redacted decision logging

Every authorization decision emits one bounded structured decision record with exactly: event kind, decision (`allow` or `deny`), stable reason code, action, transport, resource kind, pseudonymous principal reference, pseudonymous scope reference, pseudonymous resource reference, authority revision references, runtime/route generation references when applicable, and timestamp. Each string and the complete record have implementation-defined finite maximum byte sizes; overlong values are rejected or deterministically truncated only where the later logging contract permits, never copied unboundedly.

Decision records exclude credentials, bearer or connection tickets, adapter evidence, raw provider subjects, policy documents, role-binding documents, headers, cookies, query strings, request or response bodies, prompts, terminal bytes, transcripts, browser data, file contents or paths, environment values, backend coordinates, and opaque route references. Logging failure never turns deny into allow and never changes an authorization result. This P0 contract defines bounded emission and redaction semantics only; it does not require an audit database, retention period, durability level, or threat-check implementation. Those decisions remain later work.

## Fail-closed rules

- Authentication proves only an adapter subject. All portable identity and authorization authority is server-derived.
- No role has implicit grants, and no action is authorized by ownership strings, capability possession, transport authentication, or resource existence alone.
- Only explicit allow authorizes; deny overrides; unknown, missing, ambiguous, stale, revoked, or unavailable authority denies.
- Every operation, WSS frame, command descriptor, SSH mode, and internal action has one exact mapping; no fallback or prefix grant exists.
- Capability availability is the full intersection, and a client request only narrows it.
- Open connections, confirmations, delegated routes, and long-lived grants reauthorize against current revisions and generations.
- Lists, watches, connection descriptors, direct reads, and error paths preserve the same cross-scope concealment boundary.
- Identity, principal, membership, resource scope, policy, workload, delegated-edge, connection, and capability authorities remain distinct.

## Consequences

- Identity providers, policy engines, stores, drivers, and transports can vary without changing portable authorization meaning.
- Adding an OpenAPI operation, `COMMAND_DESCRIPTORS` key, or client frame requires an explicit contract review instead of inheriting a broad capability.
- Anonymous discovery remains possible without making platform, scope, resource, or connection data anonymous.
- Later implementations must enforce the same action at discovery, open, mutation, frame, resume, confirmation, and delegated-route boundaries.
- This decision makes no claim that the current runtime seams already conform.
