# ADR-016: Establish the T4 Hub collaboration foundation

- Status: accepted as a lightweight planning foundation; implementation and infrastructure choices remain flexible.

## The problem

T4 already connects to OMP on local and remote hosts. The next product step is a single workspace
that can coordinate sessions across several personal dev boxes, team machines, and managed worker
pools. Building that safely requires more than adding another remote-host screen:

- commands need a durable record before T4 sends them;
- one runtime must own a session at a time, even during a network split;
- a replacement runtime must recover only state that was durably recorded;
- client, Hub, Node, and OMP responsibilities must remain understandable;
- collaborators need separate code ownership so they can work without repeatedly editing the same
  files.

The current T4 Host and OMP authority bridge remain the released architecture from ADR-013. This ADR
does not remove that path. It defines the boundary for proving a Hub alongside it.

## Decision

T4 will explore a central Hub and lightweight Nodes behind two explicit contracts:

```text
T4 client
    |
    | Hub Wire: identity, sessions, commands, events, approvals
    v
T4 Hub
    |
    | Runtime Wire: ownership, dispatch, checkpoints, health
    v
T4 Node
    |
    v
official pinned OMP + workspace
```

The contracts are client-neutral and scheduler-neutral. A React, Flutter, web, or other T4 client
should see the same product behavior. A normal remote dev box can run a lightweight Node without
becoming a Kubernetes cluster. A managed worker pool may add Kubernetes after the runtime behavior
is proven.

### One official-OMP adapter for local Hosts and Nodes

The OMP runtime adapter is not Hub-only. The existing local T4 Host and a future T4 Node should use
the same adapter boundary so T4 does not maintain separate local and distributed integrations.

```text
local T4 Host ---------+
                       |
                       v
                OMP runtime adapter -> official pinned OMP + optional T4 plugin
                       ^
                       |
T4 Hub -> T4 Node -----+
```

The adapter starts and supervises official OMP, translates public RPC, SDK, and extension behavior,
and reports exactly which capabilities are available. An optional separately versioned T4 plugin
may supply host-wide metadata or operations that official OMP exposes through its public extension
surface. T4 clients continue to speak T4 protocols and do not depend on OMP terminal presentation.

The released Lycaon authority bridge remains a compatible implementation while this official-OMP
path is proven. It is not the desired permanent reason to maintain a second OMP product. If an
important operation is not available through public OMP seams, record it as unsupported, prefer a
small generic upstream API addition, and keep any temporary fork patch narrow and independently
tracked.

Command discovery must distinguish existence from executability. The adapter reports whether a
command works through a typed T4 action, a verified headless OMP handler, only the terminal UI, or
not at all. A recognized terminal-only command is rejected with a clear reason instead of silently
becoming ordinary model prompt text.

### Portable sessions with one active owner

A session is not permanently identified by one physical machine. Its durable parts may be restored
on another suitable Node. At any instant, however, exactly one runtime owns the session under an
`ownerEpoch`.

```text
epoch 17 on Node A -> revoke or fence -> epoch 18 on Node B -> restore -> continue
```

This is restart-and-recover portability, not live process migration. Shell processes, debugger
memory, and a tool call interrupted at an uncertain point do not move between machines.

The Hub may grant a new epoch only after it can prove that the old owner cannot continue making
authoritative changes. Expiring a database lease alone does not prove that a partitioned process has
lost direct write access to a shared filesystem. The storage or Node design must provide a hard
fence before automatic cross-machine recovery can ship.

### Authority boundaries

| Information | Authority |
|---|---|
| Users, permissions, project metadata, command ledger, and current owner epoch | Hub durable store |
| Prompt acceptance, transcript, tools, model behavior, and agent execution | OMP |
| Files and Git state | Workspace filesystem and Git, operated through the Node/runtime |
| Client views and caches | Disposable projections rebuilt from Hub events |
| Logs, traces, and metrics | Non-authoritative diagnostics |

The Node does not connect directly to the Hub database. It communicates through Runtime Wire. The
Hub records OMP-derived events with their source identity and does not invent transcript or tool
state that OMP did not report.

### Command outcomes

A command moves through explicit durable states:

```text
recorded -> claimed(ownerEpoch) -> dispatched -> accepted by OMP -> completed
                                      |
                                      +-> indeterminate after an ambiguous failure
```

T4 does not automatically replay an indeterminate command. An at-most-once execution promise
requires a durable command identity that official OMP recognizes. Early prototypes can expose and
reset internal state freely, but an enabled user-facing flow reports uncertainty rather than
silently replaying work.

### Deployment profiles

The same Hub-facing product model may support two execution profiles:

| Profile | Behavior |
|---|---|
| Standard Node | Session normally stays on one Mac or Linux dev box and uses fast machine-local storage. If the box is unavailable, the session stops safely. |
| Managed pool | A scheduler may restart a portable session on another Node after ownership and storage fencing are proven. |

High availability is a capability of a deployment, not a claim made by every installation. A
single-machine setup remains useful but cannot recover while its only machine is offline.

## Development checkpoints, not approval gates

There are no live Hub users yet, so fast experiments, temporary breakage, schema resets, and
incomplete code behind unavailable capabilities are expected. Workstreams can proceed in parallel
with written assumptions and fakes. These checkpoints tell the team when separate experiments are
ready to converge or when a behavior is ready to be enabled; they do not require everyone to stop
until the previous item is complete.

1. **Official OMP seam:** learn the real acceptance identity, event replay, cancellation, checkpoint
   contents, restart behavior, command execution surfaces, extension/plugin reach, plan and goal
   controls, settings, provider authentication, session discovery, and lock behavior of an
   unmodified pinned OMP release. Identify what the shared adapter can provide directly, what needs
   an optional T4 plugin, what needs a small generic upstream seam, and which current fork patches
   can be retired.
2. **Contract draft:** keep bounded Hub Wire and Runtime Wire messages, command states, epochs,
   cursors, and failure results in a versioned draft that can change as the OMP evidence arrives.
3. **Physical vertical slice:** connect the smallest useful pieces early, then grow it until one
   command travels from a real T4 client through a real Hub and Node to official OMP and survives a
   reconnect.
4. **Ambiguous failure:** exercise crashes before and after dispatch while implementation is still
   cheap to change. Do not enable automatic replay of unknown outcomes.
5. **Hard fencing:** prototype failover freely, but do not enable automatic cross-machine takeover
   until a partitioned old owner is proven unable to keep writing.
6. **Recovery and restore:** add Node, Hub, storage, backup, and Git-integrity fault cases as each
   subsystem becomes real rather than waiting for one final certification phase.

Kubernetes, CephFS, MinIO, and a full observability stack remain candidates for managed deployments.
They are not selected for the standard Node profile by this ADR. Client framework migration is also
a separate decision.

## Collaborative ownership

Work is divided by authority rather than by screen. These are coordination defaults, not exclusive
file locks:

- the Hub lane owns durable product state, command and ownership state machines, and Hub Wire;
- the Node/runtime lane owns the shared official OMP adapter, process lifecycle, workspaces,
  checkpoints, and Runtime Wire; the adapter is reusable by the local T4 Host and future Nodes;
- the client lane consumes Hub Wire through a provider boundary and does not reach into Hub storage
  or Runtime Wire;
- the infrastructure lane packages proven behavior and does not define command or ownership
  semantics through deployment manifests.

When active branches overlap on contract schemas, root manifests, dependency lockfiles, database
migrations, or final wiring, the developers name a temporary integration owner or land the smaller
shared change first. The shared work tracker is
[`docs/T4_HUB_TRACKER.md`](../T4_HUB_TRACKER.md).

## Consequences

- Multi-machine coordination becomes a first-class direction without breaking the released local
  Host path before the Hub is proven.
- Ordinary remote dev boxes stay lightweight; managed pools can add stronger scheduling and storage
  when users need them.
- Local and distributed T4 installations converge on one official-OMP adapter instead of growing
  separate runtime integrations.
- The hardest uncertainties are tested early while Hub, Node, client, and infrastructure prototypes
  continue in parallel.
- Portable recovery requires explicit storage fencing and honest treatment of in-flight work.
- Hub and Node developers can work against fakes and contract tests with a small shared edit surface.
