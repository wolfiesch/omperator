# Codex Desktop rail parity

This checklist records the Codex Desktop sidebar behavior observed in the live macOS app on
2026-07-19 and the matching T4 Code behavior. It is deliberately limited to organizing and acting
on projects and sessions in the left rail.

| Codex Desktop behavior | T4 Code behavior | Verification |
| --- | --- | --- |
| Organize **By project** or **In one list** | Same two labels and layouts | Browser test and live DOM inspection |
| Sort by **Priority**, **Last updated**, or **Manual order** | Same three choices | Browser test and live DOM inspection |
| Drag projects in manual order | Project headers are real drag handles; move buttons remain as a keyboard and touch fallback | Browser drag test |
| Drag sessions in manual order | Session rows are real drag targets; move buttons remain as a keyboard and touch fallback | Browser drag test |
| Pinned projects and chats appear first | Pinned section and per-project/per-session pin controls | Store tests and browser test |
| Project groups initially show five chats | Five-row limit with **Show more** | Session-tree tests |
| Search and filter sessions | Search plus All, Needs attention, Running, Unread, and Errors filters | Existing rail tests |
| Rename a project label | Local T4 display alias; the disk folder is unchanged | Store and browser tests |
| Mark all chats in a project as read | One monotonic bulk read action | Store and browser tests |
| Archive chats in a project | Archives each currently supported live session and reports partial failure honestly | Focused management tests |
| Remove a project from the rail | Reversible local hide; no folder or session is deleted | Store and browser tests |
| Restore removed projects | **Hidden projects** section in the organize menu | Browser test |
| Reveal a local project in Finder | Negotiated local-only `project.reveal` host command; the renderer sends only an opaque project id and never receives the path | App-wire, appserver, fixture-engine, and client tests; browser presence check |
| Pin or archive a chat directly from its row | Direct hover/focus controls, with full touch targets on small screens | Browser test |

## Safety boundary

T4 does not send an absolute folder path to the web renderer. For **Reveal in Finder**, the local
OMP host resolves the opaque project id, checks that it still matches the canonical folder, and
asks macOS to reveal it. Remote clients are not granted this command and an unnegotiated call is
rejected.

## Deliberate T4 additions

T4 keeps its host and profile labels visible because a single rail can combine several OMP hosts.
It also keeps explicit move buttons beside drag ordering so the same workflow remains usable with a
keyboard or touch screen. These additions do not replace or rename the matching Codex controls.
