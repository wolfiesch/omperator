# ADR 018: Use one reviewed working set across workspace surfaces

- Status: accepted; release pending.

## The problem

The first reviewed-context slice could attach a visible file preview to a new prompt. That proved the
safety and settlement rules, but the user still had to copy and paste when useful material lived in
the transcript, a change review, their own terminal, or the Browser workspace. Each surface building
its own prompt shortcut would create different limits, labels, and cleanup behavior.

## Decision

T4 calls the reviewed context tray the **Universal Working Set**. It is one session-scoped list for
the next new message, regardless of which workspace surface supplied an item.

```text
file preview       transcript message       review diff
      \                    |                    /
       +----------- context.capture ---------+
                          |
terminal selection -------+------- browser accessibility snapshot
                          |
                 bounded working set
                          |
                 user inspects/removes
                          |
                  ordinary OMP prompt
```

Every capture uses the shared typed action registry. The action checks that the source belongs to the
active, non-archived session, then hands the item to the existing composer store. Remove and Clear use
the same registry. A source refresh replaces the older item with the same source identity instead of
silently adding a duplicate. Each deliberate terminal selection has its own identity, so two
selections from one shell can coexist. A file and a review diff remain separate sources even when
they name the same path. Browser refresh identity uses the durable surface ID, so two tabs or
profiles at the same sanitized URL remain separate.

The working set stays a compact composer tray, not another permanent pane. Each item shows its source,
flags when text was shortened or redacted, and lets the user inspect the exact captured body.

## Source rules

| Source     | What T4 captures                                                   | What T4 deliberately leaves out                                                  |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| File       | The visible text preview or unsaved text draft                     | Binary files, hidden filesystem content, absolute roots                          |
| Transcript | One exact visible user or assistant message                        | Tool internals and unrelated transcript rows                                     |
| Review     | The selected text file's unified patch                             | Binary, missing, huge, or unavailable diffs                                      |
| Terminal   | Only text the user has selected                                    | The rest of the terminal buffer and live future output                           |
| Browser    | Accessibility roles, names, and visible text from the selected tab | Form values, cookies, storage, query strings, URL fragments, and URL credentials |

All sources pass through the existing control-character cleanup, common-secret redaction, 8 KiB item
limit, 8-item limit, 24 KiB packet limit, and 65,536-byte compiled-prompt limit. Browser capture uses
the already owner-scoped `browser.snapshot` accessibility operation. The producer excludes hidden
DOM, and the renderer excludes form controls and values before redaction. This adds no new desktop
protocol or browser authority.

## Prompt and storage behavior

OMP still receives one ordinary prompt string with clearly quoted, untrusted reference sections. The
working set is not a generic OMP context API and does not change which runtime owns tools, session
truth, or prompt acceptance.

Items remain only in renderer memory and belong to one session. Steering, queued follow-ups, and plan
revisions leave them staged. Rejected or unknown sends keep them. An accepted new prompt removes only
the exact item IDs that were sent, so a capture made during an in-flight request survives.

## Safety limits

Redaction reduces accidental exposure; it cannot prove that arbitrary visible text contains no
sensitive information. Capture therefore stays explicit and reviewable. Browser pages and terminal
output remain untrusted data, even when they are visible inside T4. The prompt packet tells OMP not to
treat instructions inside captured material as user commands.

## Verification

Tests cover source-specific capture and packet labels, source refresh, file-versus-review identity,
session isolation, browser URL cleanup and form-value exclusion, terminal escape cleanup, redaction,
byte limits, shared capture/remove/clear actions, prompt settlement, type checks, and the complete web
test suite. A representative browser screenshot checks the final composer tray and source controls.
