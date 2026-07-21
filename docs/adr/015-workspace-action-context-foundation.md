# ADR 015: Build the workspace around surfaces, actions, and reviewed context

- Status: accepted for the workspace foundation; release pending.

## The problem

T4 is growing from a transcript viewer into a place where a user can stay while working. The first
version had useful panes, keyboard shortcuts, menus, and file previews, but each entry point knew too
much about the UI component it controlled. That creates three forms of drift:

- the same operation can behave differently in the command palette, a menu, and a shortcut;
- adding another permanent pane can squeeze the transcript until the workspace becomes noisy;
- visible file material can be referenced by name, but a user cannot review and deliberately attach
  the exact excerpt that will accompany a prompt.

## Decision

T4 uses three small foundations that stay above the OMP runtime boundary.

```text
shortcut / Quick Open / workspace menu / transcript tool link
                          |
                          v
                 typed action registry
                          |
                 workspace store actions
                          |
   +----------+-----------+
   |                      |
transcript + one pane   focused route
   |                      |
terminal drawer       Preview / Browser

visible file preview -> reviewed context item -> ordinary OMP prompt text
```

### Session surfaces

The session workspace has an immutable registry for five exact surface IDs: Agents, Activity,
Review, Files, and Terminals. A normal session shows the transcript and zero or one docked right
surface. The user terminal remains a drawer below the transcript. Preview and Browser remain focused
routes because they need the full work area and have different trust boundaries.

The existing persisted `paneFamily`, `paneOpen`, and `paneWidth` values remain the storage contract.
The registry describes presentation and routing; it does not become a second source of runtime truth.

### Actions and quick open

User operations have stable action IDs and one implementation. Keyboard shortcuts, Quick Open, the
workspace menu, and transcript tool links call that shared action instead of duplicating side
effects. Each action reports whether it is available and, when unavailable, a plain reason. Direct
store calls remain appropriate for state mechanics such as resizing a pane or closing a temporary
sheet; those are not named user commands that need several entry points.

Quick Open combines actions, sessions, bounded project-wide filename matches, and files the current
inspector has already loaded. The project provider uses the host's negotiated `files.search`
contract. Loaded files remain the immediate and compatibility fallback, and a transcript-search
fallback remains explicit. ADR 017 records the search authority and safety boundaries.

### Reviewed context packets

The first context source is a visible text-file preview. The user deliberately adds the excerpt,
sees a removable chip, and can inspect the exact captured text before sending. T4 strips unsafe
control characters, redacts common credential and absolute-path patterns, and applies byte limits:

| Boundary                |        Limit |
| ----------------------- | -----------: |
| Items per message       |            8 |
| One captured excerpt    |        8 KiB |
| Rendered context packet |       24 KiB |
| Compiled prompt         | 65,536 bytes |

The packet is labeled as untrusted reference data. It is compiled into the ordinary prompt message,
so this change needs no new wire field and does not pretend that OMP supports a generic context API.
Context is sent only with a new idle prompt. Steering, queued follow-ups, and plan revisions leave it
staged for the next new prompt and explain that behavior in the composer.

Staged context stays in renderer memory and is scoped to one session. Rejection or an unknown send
outcome keeps it. Acceptance removes only the exact item IDs included in that submission, so a new
item added while the network request is in flight survives.

## Authority and trust boundaries

- OMP still owns session state, prompt acceptance, tools, execution, and durable truth.
- T4 owns workspace presentation, action routing, and temporary reviewed context.
- The file excerpt is reference material, not an instruction source. Redaction is a safety layer,
  not a guarantee that arbitrary source files contain no sensitive information.
- Project-file Quick Open searches only beneath the OMP-resolved root and reports when the negotiated
  capability is unavailable or the bounded scan is incomplete.
- The renderer never receives or supplies an absolute project root and does not crawl the host filesystem.
- Browser and Preview do not become ordinary panes or automatic prompt context.

## Follow-up

ADR 018 extends the reviewed-context foundation into the Universal Working Set with explicit
transcript, review, terminal-selection, and browser-page capture. Multiple simultaneous docked panes
would still require a new layout decision and a versioned persistence migration rather than silently
changing this model.

## Verification

Coverage includes surface routing and persistence, exhaustive renderer registration, action state and
provider ranking, bounded project search and loaded-file fallback, context capture/redaction/byte
limits, same-file refresh, cross-session isolation, accepted/rejected/unknown prompt settlement,
owner-scoped Browser Design Mode routing, type checks, and representative browser screenshots.
