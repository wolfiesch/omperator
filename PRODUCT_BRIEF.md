# T4 Code Product Brief

## Product

T4 Code is a Flutter desktop, mobile, and web workspace for official Oh My Pi (OMP). It makes
projects, concurrent sessions, live streaming, tools, terminal activity, task agents, reviews, files,
settings, and local or remote execution easier to operate without reimplementing OMP behavior.

## Experience target

- Presentation and perceived performance are product-critical.
- Keyboard-first, dense when useful, calm by default.
- Fast project/session switching preserves scroll, composer, panel, and draft state.
- The center session stream remains the primary surface.
- Optional right-pane surfaces cover Agents, Activity, Review, Files, and Agent Terminals. The user
  terminal remains a bottom drawer; Context is a popover or dialog.
- Browser and app preview remains a focused workspace rather than a permanent sixth pane.
- Keyboard shortcuts, Quick Open, workspace menus, and transcript links use one action registry so
  availability and behavior do not diverge.
- Quick Open searches through bounded authorized operations. Flutter never receives or chooses an
  absolute path it does not already own.
- The Universal Working Set lets a user deliberately stage exact material from a file preview,
  transcript message, review diff, selected terminal text, or browser accessibility snapshot. The
  user can inspect and remove each item before it joins one ordinary OMP prompt; it does not become
  a second runtime authority.
- Light and dark themes use neutral surfaces with minimal semantic accent.
- OMP identity uses the existing pi/connector mark and Pi Pink `#e83174` accent.

## Product modes

T4 Code presents one client experience across four execution profiles:

- **T4 Local:** native execution on this macOS or Linux computer.
- **Personal Hub:** a managed installation on one Linux machine.
- **HA Hub:** a managed installation across tested Linux failure domains.
- **Workstation Runner:** native macOS or Linux execution registered with an existing Hub.

The client reports the selected profile and its capabilities truthfully. It never presents local
sessions as portable, terminal-only behavior as remotely executable, or unavailable features as
working.

## Runtime principle

OMP remains authoritative for prompt acceptance, transcript truth, models, tools, sessions, task
agents, memory, skills, settings, credentials, and execution. T4 operates through public OMP seams,
does not parse terminal pixels as its primary data source, and does not grow a permanent private OMP
distribution.

## Proof standard

Behavior is proven with executable contracts, deterministic failure scenarios, physical client
slices, measured latency and resource overhead, and platform-specific runtime proof. Product claims
follow observed behavior rather than compilation, healthy infrastructure, or optimistic capability
reporting.

## Canonical architecture

[`docs/T4_ARCHITECTURE.html`](docs/T4_ARCHITECTURE.html) is the sole specification for execution
profiles, authority, transport, storage, recovery, deployment, performance, and delivery gates.
