# T4 Hub development tracker

This is the shared map for the first T4 Hub development slice. It is designed to keep parallel work
from colliding, not to add approval steps. There are no live Hub users yet, so temporary breakage,
database resets, draft protocol changes, and incomplete capabilities are acceptable while the team
converges on the right design.

Start useful work whenever its assumptions are written down. The convergence map shows where lanes
eventually meet; it is not a rule that every earlier box must finish before later exploration begins.

## Status language

| Status | Meaning |
|---|---|
| Ready | Useful work can start with current assumptions or a test double. |
| Active | Work is underway; recording an owner or branch is helpful when others may overlap. |
| Waiting | Integration is waiting on another lane, although isolated work may continue. |
| Review | The implementation and evidence are in a pull request. |
| Done | The intended result is merged; link evidence when it materially helps later work. |

## Convergence map

```text
H1 official OMP proof
          |
          v
H2 contract draft
    /          |          \
   v           v           v
H3 Hub core  H4 Node     H5 client provider
    \          |          /
     \         |         /
      v        v        v
       H6 physical slice
               |
               v
       H7 fencing/recovery
          /             \
         v               v
H8 standard Node    H9 managed pool proof
         \               /
          v             v
          H10 product integrations
```

## Work items

| ID | Status | Scope | Useful finish signal | Converges with | Lead | Branch/PR |
|---|---|---|---|---|---|---|
| H1 | Ready | Explore unmodified official pinned OMP: prompt acceptance identity, replay, cancellation, checkpoints, restart, RPC/SDK/plugin coverage, slash-command execution surfaces, plan/goal controls, settings, provider auth, discovery, locks, and ambiguous disconnects. Classify current fork patches as adapter, optional plugin, small upstream seam, temporary compatibility patch, or removable. | Reproducible harness, protocol fixtures, a capability manifest, and a supported/unsupported report that names the public seam and fork disposition for each audited behavior. | H2, H4 | Unassigned | — |
| H2 | Ready | Draft the first Hub Wire and Runtime Wire contracts, command state machine, owner epoch rules, cursors, bounds, version negotiation, and normalized capability descriptions including typed, headless, terminal-only, and unavailable execution. | Executable draft decoders and representative frames that can evolve with H1 without presenting unavailable behavior as working. | H1, H3, H4, H5 | Unassigned | — |
| H3 | Ready | Prototype the Hub command ledger, dispatch queue, session/Node registry, event replay, authentication boundary, and fake runtime. | Focused state-machine tests for the paths implemented so far. | H2, H6 | Unassigned | — |
| H4 | Ready | Prototype the shared official-OMP runtime adapter so both the local T4 Host and a Node can reuse pinned OMP lifecycle, command dispatch, capability reporting, optional T4-plugin loading, checkpoints, workspace operations, epoch rejection, and a fake Hub. | Runtime tests prove the same adapter can serve local-Host and Node callers without private OMP source imports or a Hub database dependency. | H1, H2, H6 | Unassigned | — |
| H5 | Ready | Add a Hub target behind the T4 client provider boundary and consume normalized runtime capabilities without coupling UI code to Hub storage, Runtime Wire, or terminal presentation. | Fixture-driven client states show native, headless, terminal-handoff, and unavailable behaviors with a user-visible reason. | H2, H6 | Unassigned | — |
| H6 | Waiting | Join the smallest usable Hub, Node, and client pieces early; grow toward reconnecting one official OMP session. | Repeatable end-to-end command and reconnect path with redacted identifiers. | H3, H4, H5 | Unassigned | — |
| H7 | Ready | Build fault-injection tools for ambiguous failures, ownership transfer, write fencing, backups, and Git recovery as the relevant pieces appear. | Failure notes and regression tests for each implemented recovery behavior. | H3, H4, H6 | Unassigned | — |
| H8 | Ready | Package an early lightweight Node for an ordinary remote Mac or Linux dev box and iterate on install/update ergonomics. | A repeatable development install and safe stopped-session behavior. | H4, H6 | Unassigned | — |
| H9 | Ready | Spike managed scheduling, storage, artifact, and observability options without committing the whole product to one stack. | Comparative measurements and a clear next experiment or selection reason. | H4, H7 | Unassigned | — |
| H10 | Ready | Prototype typed CI, approval, deployment, and notification events with fake or narrowly scoped integrations. | One useful end-to-end event with credentials and failure behavior appropriate to its environment. | H3, H5, H6 | Unassigned | — |

## Development lanes

| Lane | Owns | Does not own | Expected path boundary |
|---|---|---|---|
| Hub | Durable product state, Hub Wire server, commands, epochs, events, auth decisions | OMP internals, direct workspace writes, client UI | Future `apps/hub/**` and `packages/hub-*/**` |
| Node/runtime | Runtime Wire, the shared official OMP adapter used by local Hosts and Nodes, process lifecycle, capability reporting, optional T4-plugin loading, checkpoint reporting, workspace/Git operations | Hub database, product permissions, client UI, or a second OMP product | Future `apps/node/**`, `packages/runtime-wire/**`, and `packages/omp-runtime-adapter/**` |
| Client | Hub provider, disposable projections, connection and recovery presentation | Hub database, Runtime Wire, OMP reconstruction | Existing client app plus a narrow provider package selected in H2 |
| Infrastructure | Packaging, scheduler/operator, storage, backups, secrets, diagnostics | Product command semantics and runtime authority rules | Future `deploy/hub/**` or another path selected in H9 |
| Integration | Shared schemas, root manifests, lockfile, migration allocation, final wiring | Long-running feature implementation inside another lane | Small, reviewed edits across shared paths |

Paths labeled `Future` are reservations, not scaffolding requirements. H2 may reuse an existing
package when that produces a clearer boundary.

## Two-person starting split

The lowest-conflict starting split is:

| Developer | Primary work | Test double |
|---|---|---|
| Hub lead | Draft H2 command/ownership contracts while building H3 | Fake Runtime Wire peer |
| Runtime lead | Explore H1 while building H4 against the current draft | Fake Hub Wire peer |

H1 and H2 inform each other; neither needs to stop the other lane. Client-provider work can proceed
against changing fixtures as long as the draft version is explicit. Connect small pieces early and
fix the contract when reality disagrees with it.

## Shared-file coordination

When two active branches need the same shared paths, name a temporary coordinator or land the
smaller shared edit first:

- Hub Wire and Runtime Wire schemas and generated bindings;
- root `package.json`, workspace configuration, and `pnpm-lock.yaml`;
- database migration numbers;
- `docs/adr/**`, `PRODUCT_BRIEF.md`, and `docs/OWNERSHIP.md`;
- CI workflows and deployment manifests.

Fill in a lead and branch when it helps another developer avoid overlap; empty cells do not block
work. Prefer frequent merges into `main` with incomplete capabilities unavailable or clearly marked.
A cohesive vertical slice can cross lanes when that is faster than maintaining several artificial
PRs.

## First physical slice

The first integrated milestone is intentionally narrow:

1. A physical T4 client lists one registered Node.
2. The user creates one session and submits a unique harmless prompt.
3. The Hub records the command before dispatch.
4. The Node starts official pinned OMP and reports acceptance separately from completion.
5. The client receives the result, disconnects, reconnects, and rebuilds the same view.
6. Repeating the run with a crash immediately after dispatch produces `indeterminate` unless OMP can
   prove durable acceptance. T4 does not replay the command automatically.
7. The adapter executes one verified headless OMP command and clearly rejects one recognized
   terminal-only command without sending it to the model as ordinary prompt text.

## Not required for early progress

- live process migration;
- enabling automatic failover before hard write fencing is proven;
- mandatory Kubernetes or shared storage for a standard Node;
- committing the product to CephFS, MinIO, or a full observability stack before comparative spikes;
- coupling the Hub architecture to one client framework;
- complete plan, goal, plugin, and extension parity in the first physical slice; truthful capability
  reporting is required even when the capability itself is not yet implemented;
- production credentials or broad deployment authority for early CI/CD event prototypes.
