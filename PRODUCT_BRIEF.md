# T4 Code Product Brief

## Product

A desktop, web, and mobile workspace for OMP. Preserve OMP as the agent runtime; make projects, concurrent sessions, live streaming, tools, terminal activity, subagents, reviews, files, settings, and remote hosts easier to see and operate.

## Primary reference

T3 Code at `reference/t3code` is the primary presentation, interaction, desktop-shell, and implementation reference. Its MIT license permits copying and modification with attribution. Use direct adaptation where it accelerates quality; do not reimplement equivalent primitives without a reason.

## Experience target

- Presentation and perceived performance are product-critical.
- Keyboard-first, dense when useful, calm by default.
- Fast project/session switching with preserved scroll, composer, panel, and draft state.
- Center session stream remains the primary surface.
- Optional right pane extends the T3 pattern with five calm surface families: Agents, Activity (including events), Review, Files, and Agent Terminals. The user terminal remains a bottom drawer. Context is a popover/dialog, not a permanent tab.
- Browser/app preview is available through the focused host Preview and the separate native desktop Browser workspace rather than becoming a sixth permanent right-pane family.
- Keyboard shortcuts, Quick Open, the workspace menu, and transcript tool links use one shared action registry so the same operation has one availability rule and one implementation.
- Quick Open searches filenames across the active project through a bounded desktop-host operation. OMP supplies the trusted session root; the renderer never receives or chooses an absolute path. Older or limited hosts fall back honestly to files already loaded in the inspector.
- A visible text-file preview can be deliberately staged as bounded, reviewed context for the next new prompt. It is temporary renderer state compiled into ordinary prompt text; it does not create a second runtime authority.
- Light and dark themes use neutral surfaces. Accent use is minimal and semantic.
- OMP identity uses the existing pi/connector mark from the upstream Oh My Pi repository and the Pi Pink `#e83174` accent.
- No SVG turbulence, paper-grain, noise texture, or equivalent decorative overlay is imported from T3.

## Runtime boundary

- OMP remains authoritative for prompt acceptance, transcript truth, models, tools, sessions, task agents, memory, skills, settings, credentials, and execution.
- T4 clients consume the versioned T4 Host protocol. The T4 Host consumes the narrower OMP authority bridge; clients do not parse terminal pixels as their primary data source or reimplement OMP behavior.
- A persistent T4 Host runs beside OMP, speaks to the pinned OMP authority bridge, supports local desktop attachment, and supports authenticated remote attachment across the user's Tailscale tailnet.
- Remote control must preserve exact session identity, reconnect/replay semantics, capability authorization, and explicit destructive-action boundaries.

## Hub direction

T4 is preparing a central Hub for users who coordinate several personal dev boxes, team machines,
or managed worker pools. The Hub will coordinate identity, durable commands, ownership, and events;
OMP will continue to own prompt acceptance, transcript truth, tools, and agent execution. The
released local T4 Host path remains supported while the Hub matures through the development
checkpoints in [`ADR-016`](docs/adr/016-hub-collaboration-foundation.md). Shared work is tracked in
[`docs/T4_HUB_TRACKER.md`](docs/T4_HUB_TRACKER.md).

The Hub contracts are independent of the client framework and deployment scheduler. A normal remote
dev box does not require Kubernetes or shared cluster storage merely to participate.

The local T4 Host and future T4 Nodes should converge on one shared OMP runtime adapter that operates
official pinned OMP through public RPC, SDK, and extension seams. The currently released Lycaon
authority bridge remains supported while that path is proven, but T4 does not plan to grow separate
local and distributed OMP integrations. Capabilities unavailable through official OMP are reported
honestly, supplied by an optional narrow T4 plugin when public extension APIs allow it, or proposed
as small generic upstream seams.

## Planned package boundaries

- `apps/desktop`: Electron main/preload, packaging, updates, OS integration.
- `apps/web`: T3-derived React renderer and desktop/web client shell.
- `apps/mobile`: the current native Android wrapper around the web client.
- `packages/host-wire`: T4-owned, dependency-free `omp-app/1` wire schema.
- `packages/host-service`: persistent host service, projections, bounded indexes, workspaces, policy, replay, files, PTY, audit, and OMP authority-bridge supervision.
- `packages/host-daemon`: standalone T4 Host executable.
- `packages/protocol`: consumes the workspace-owned host wire schema and adds desktop-only IPC schemas.
- `packages/client`: connection, replay, cache, optimistic-state rules, host/session stores, and strictly decoded host-search coordinators.
- `packages/remote`: remote target discovery, identity pinning, pairing, and transport helpers.
- `packages/service-manager`: desktop-side T4 Host installation and lifecycle support.
- future `packages/omp-runtime-adapter`: shared official-OMP lifecycle, capability, and translation boundary for local T4 Hosts and T4 Nodes.
- `packages/ui`: T3-derived design primitives, tokens, icons, motion, virtualization.
- `packages/fixture-server`: deterministic seeded sessions, faults, and load scenarios.
- OMP authority bridge: versioned runtime boundary for session persistence, project roots, locks, workers, configuration, credentials, tools, and execution.

## Proof standard

Behavior is proven with deterministic contract tests, concurrency and reconnect stress, seeded visual states, screenshot comparison, interaction/motion checks, Linux runtime proof, macOS runtime proof, and a real two-host Tailscale smoke before remote functionality is called complete.
