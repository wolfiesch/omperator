# Cross-session Attention Inbox

Status: the first vertical slice is implemented in T4 Code and the Lycaon OMP fork. The T4 UI
depends on the host contract in `lyc-aon/oh-my-pi#10` before live attention items can appear.

## Recommended outcome

Add a first-class **Inbox** route that collects the small set of events that deserve a person's
attention across every indexed session and connected host:

- approvals and plan reviews;
- questions that block an agent;
- failed turns that need inspection;
- the latest unseen completed turn for each session.

The navigation label should be **Inbox** because it is concrete and familiar. The internal feature
and data model should use **attention** because it describes why an item belongs there. The page
title can be **Attention inbox**.

This should be a full center route (`/inbox`), not a sixth right-hand pane and not a pop-up
notification center. A full route works on desktop, narrow windows, Android, and the Tailnet web
client without squeezing the session transcript or creating a permanent dashboard.

The important technical decision is to make OMP's appserver publish a small, bounded attention
summary as part of each session reference. A T4-only implementation would look convincing in the
sample UI but would not be complete or honest: T4 keeps full projections for only eight warm
sessions, and before this sprint live session references did not publish enough detail to identify all
questions, failures, or completions.

## Baseline before this sprint

| Area             | Exists today                                                                  | Missing for the inbox                                                    |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Session rail     | Status colors, unread dots, and approval counts                               | One cross-session place to review and act                                |
| Session UI       | Inline approval, question, plan, and turn-error panels                        | The panels only appear after opening and attaching to a session          |
| Session index    | Up to 1,000 lightweight session references, broadcast through `session.delta` | Reliable attention details and terminal outcome summaries                |
| Warm projections | Full events, confirmations, results, and transcript state                     | Limited to eight sessions and intentionally evicted by an LRU cache      |
| Sample data      | Approval, awaiting-input, plan-ready, completed, and error examples           | Some of those states are not currently produced by the live path         |
| Local view state | Per-session visit timestamps and unread-completion logic                      | Stable seen state for inbox outcome items                                |
| OMP appserver    | Translates `ask.request`, `approval.request`, `turn.error`, and `agent.end`   | It does not currently fold those events into the host-wide session index |

Two baseline fields needed special care:

- `SessionRef.pendingApproval`, `pendingUserInput`, and `proposedPlan` were understood by T4, but the
  baseline Lycaon appserver did not set them when RPC UI requests arrived.
- Security confirmation challenges are live-connection objects. They expire after 60 seconds and
  are bound to the WebSocket that caused them. They must never be restored from disk or presented as
  durable after reconnect.

## Product shape

### Entry point

Add an Inbox row above the working-folder tabs in the expanded rail. It shows a number for items
that need action or failure review. Unseen completions use a quiet dot and do not inflate the urgent
number. The collapsed rail gets the same icon and badge. `Cmd/Ctrl+Shift+I` may be added if it does
not collide with browser or Electron shortcuts; the command palette must always offer **Open Inbox**.

### Desktop layout

```text
+----------------------+------------------------------------------------------+
| Working folders      | Attention inbox                                      |
|                      |  Needs you 3    Problems 1    Done 2                 |
| Inbox             4  |------------------------------------------------------|
| Current 9  Archived  | Needs you                                            |
|                      | [Approval] Migrate settings store...      2m         |
| oh-my-pi             | Wants to run the migration              Deny Approve |
|   Trace stream...    |                                                      |
|   Migrate settings 2 | [Question] Pin protocol fixtures...       9m         |
|                      | Which scenario set should we keep?       Open / Answer|
| t4-code              |------------------------------------------------------|
|   Pin fixtures...    | Problems                                             |
|   Resize test        | [Failed] Bisect flaky terminal resize... 48m         |
|                      | Process exited with code 137              Open session|
|                      |------------------------------------------------------|
|                      | Done                                                 |
|                      | [Completed] Reduced-motion audit          31m         |
|                      | All 7 gallery checks pass                Open session|
+----------------------+------------------------------------------------------+
```

This is a work list, not a dashboard. Do not add charts, large metric cards, or an endless activity
feed. The existing Activity pane remains the detailed audit surface for one session.

### Narrow layout

On narrow screens, Inbox remains a normal full-width route. The rail sheet closes after Inbox is
selected. Item actions use touch-sized controls, and a long answer opens an inline editor or sheet
without leaving the route.

### Sections and ordering

| Section   | Includes                                                          | Ordering                            | Badge behavior                            |
| --------- | ----------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| Needs you | Agent approval, question, plan review, live security confirmation | Expiring first, then oldest waiting | Counts toward the urgent badge            |
| Problems  | Latest unseen failed or cancelled terminal outcome per session    | Newest first                        | Counts toward the urgent badge until seen |
| Done      | Latest unseen successful terminal outcome per session             | Newest first                        | Quiet dot only                            |

Within a section, each row shows the session title, project, host when remote or non-default, safe
summary, age, freshness, and available actions. Search and filters can wait until real usage proves
they are necessary; initial filters should be limited to **Open** and **Seen**.

### What earns an inbox item

| Event                                   | Inbox treatment                                               | Reason                                                         |
| --------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Agent asks a question                   | Blocking item with answer controls                            | Work cannot continue without the user                          |
| Agent asks for yes/no approval          | Blocking item with approve/deny                               | Work cannot continue without the user                          |
| Plan is ready for review                | Blocking item with approve/revise/reject                      | Existing T4 behavior already treats this as attention          |
| Risky T4 command asks for confirmation  | Ephemeral blocking item                                       | Safety boundary; valid only on its originating live connection |
| Root turn ends failed                   | Problem item                                                  | The user needs the failure and the session that owns it        |
| Root turn ends completed                | Done item                                                     | The user needs to know long-running work landed                |
| Root turn ends cancelled                | Problem item unless the current client initiated cancellation | Avoid telling the user about an action they just performed     |
| Subagent completes normally             | No standalone item                                            | Too noisy; the root turn remains the unit of user work         |
| Subagent fails but the root recovers    | Activity only                                                 | The failure was handled and is not asking for attention        |
| Tool call, retry, compaction, reconnect | Activity only                                                 | Operational detail, not an inbox by default                    |

The first release should use one latest outcome per session, not every historical turn. The
transcript and Activity pane remain the history. A newer successful retry replaces the previous
failure for that session because it represents the current result.

### Item behavior

Blocking items remain visible until the host reports them resolved. They cannot be manually hidden.
Failure and completion items become seen when the user opens that inbox item or its session. Add
**Mark seen** and **Mark all updates seen**, but never add bulk approval.

Inline actions are available only when all of the following are true:

1. the host is connected;
2. the session reference and item are fresh;
3. this T4 client has write control of the session;
4. the item has not expired or been replaced;
5. the host still advertises the required command and capability.

Otherwise, the row stays visible with plain copy such as **Reconnect to answer**, **Active in another
app**, **Expired**, or **Open session to refresh**. T4 must re-read the current host revision
immediately before sending an answer.

## Authority and data model

### Why the session index is the right carrier

Every connected T4 client already receives the bounded session index and host-wide `session.delta`
updates. Reusing it provides cross-session coverage without attaching to every transcript, increasing
the eight-session warm cache, or adding hundreds of live subscriptions.

Add an optional typed `attention` summary to `SessionRef` in Lycaon's `app-wire` package. Keep the
existing boolean fields during a compatibility window, but derive new T4 behavior from the typed
summary when it is present.

Conceptual shape:

```ts
interface SessionAttentionState {
  pending: PendingAttentionItem[];
  pendingCount: number;
  truncated: boolean;
  latestOutcome?: AttentionOutcome;
}

type PendingAttentionItem =
  | { kind: "approval"; id: string; title: string; summary: string; requestedAt: string }
  | {
      kind: "question";
      id: string;
      question: string;
      options: AttentionOption[];
      allowText: boolean;
      requestedAt: string;
    }
  | { kind: "plan"; id: string; title: string; summary: string; requestedAt: string };

interface AttentionOutcome {
  id: string;
  kind: "completed" | "failed" | "cancelled";
  at: string;
  summary: string;
}
```

The published contract must use strict decoders, fixed text and array limits, canonical timestamps,
secret-key rejection, and the existing redaction rules. Suggested bounds are eight pending items per
session, 32 options per question, 256 bytes for titles, and 2 KiB for summaries. The existing total
session-list byte and node budgets remain authoritative. If the host must omit details, it publishes
the exact `pendingCount` plus `truncated: true`, and T4 says **Open session to see more**.

### Durable and ephemeral state

| State                                | Owner                                   | Persistence                                                |
| ------------------------------------ | --------------------------------------- | ---------------------------------------------------------- |
| Pending agent question/approval/plan | Live OMP RPC child and appserver        | Never restored after the child is gone                     |
| Risky-command confirmation           | Originating T4 connection and appserver | Never persisted; expires and disappears on reconnect       |
| Latest terminal outcome              | OMP appserver                           | Persist a redacted, bounded per-session summary atomically |
| Seen/unseen state                    | T4 client view state                    | Local per client; no claim of cross-device read sync       |
| Transcript and detailed activity     | OMP session/runtime                     | Existing authority and retention rules                     |

Persist latest outcomes in the appserver's existing per-profile private state area, using an atomic
versioned file with mode `0600`, a maximum of 1,000 session records, and cleanup on permanent session
deletion. Do not persist approval/question contents in this ledger. This lets T4 report work that
finished while the app was closed without turning T4's local cache into runtime truth.

### Data flow

```text
OMP RPC child
   | ask / approval / plan / lifecycle event
   v
Appserver transcript translator
   | safe, bounded event
   +--------------------> attached session transcript
   |
   v
Appserver attention projection ----> private latest-outcome ledger
   |
   | SessionRef + host-wide session.delta
   v
T4 protocol decoder
   |
   v
Cross-session attention projection  <---- live connection confirmations
   |
   +----> rail badge
   +----> /inbox
   +----> local seen-state comparison

User action
   |
   +---- question / agent approval / plan ---> session.ui.respond
   +---- security confirmation -------------> confirm frame
   +---- open item --------------------------> existing session route
```

There should be no second renderer-owned copy of runtime state. The T4 attention projection is a pure
view over the latest decoded host references plus connection-scoped confirmations and local seen
markers.

## Implementation plan

This requires two coordinated repository changes because OMP owns runtime truth and T4 owns the
client experience. They are two pull requests because they live in separate repositories, but they
form one release slice.

### Phase 0: establish the contract and fixture states

- Turn this document's conceptual shape into exact `app-wire` types and byte limits.
- Add golden frames for approval, question, plan, completed, failed, truncated, and legacy refs.
- Add deterministic T4 fixture data for empty, mixed, offline, expired, and multi-host inbox states.
- Decide the exact shortcut after checking Electron, browser, and macOS conflicts.

Exit gate: strict consumers decode new frames, legacy frames still decode, and the fixture produces
the intended item ordering without any live runtime.

### Phase 1: OMP host authority in `lyc-aon/oh-my-pi`

Likely files:

- `packages/app-wire/src/session-index.ts`
- `packages/app-wire/fixtures/v1/*`
- `packages/app-wire/test/*`
- `packages/appserver/src/transcript-events.ts`
- `packages/appserver/src/projection.ts`
- `packages/appserver/src/server.ts`
- `packages/appserver/src/types.ts`
- focused appserver contract, lifecycle, reconnect, and hardening tests

Work:

1. Add the strict additive `SessionRef.attention` contract.
2. Retain the safe details of pending RPC UI requests in the translator, not just their kind and ID.
3. Fold request/resolution events into the session attention projection and broadcast a
   `session.delta` for every real change.
4. Fold terminal `agent.end` and authoritative `turn.error` outcomes into `latestOutcome` without
   treating diagnostic-only or stale errors as terminal proof.
5. Persist only the latest redacted outcome per session and load it during session discovery.
6. Clear pending state on response, cancellation, child exit, session close, and appserver shutdown.
7. Preserve the exact session-list byte/node ceilings and expose truncation honestly.

Exit gate: a client that never attaches to the affected session still receives its pending item and
terminal outcome through the session index; restart restores the latest outcome but never restores a
dead approval or confirmation.

### Phase 2: T4 cross-session projection and action service

Likely files:

- vendored `vendor/app-wire` tarball, manifest, notice, provenance, and compatibility matrix
- `packages/protocol` distribution and strict-consumer tests
- `packages/client/src/attention-projection.ts` (new)
- desktop runtime snapshot/event handling
- `apps/web/src/platform/live-workspace.ts`
- `apps/web/src/lib/workspace-data.ts`
- a shared attention action adapter extracted from the live session runtime

Work:

1. Decode and normalize host attention summaries without warming transcript projections.
2. Keep live security confirmations in a separate, non-persisted map keyed by target, host, session,
   and confirmation ID.
3. Derive stable inbox item keys and freshness/actionability from the current desktop snapshot.
4. Extract approval/question/plan dispatch so the session composer and Inbox use the same revision,
   ownership, capability, and error rules.
5. Make action settlement host-confirmed: cards do not disappear optimistically.
6. Add local seen markers keyed by stable outcome ID; bump and migrate the workspace-state version.

Exit gate: more than eight sessions can produce inbox rows without increasing the warm projection
limit, and stale/offline/observer actions fail closed with a useful reason.

### Phase 3: Inbox UI

Likely files:

- `apps/web/src/features/attention/*` (new model, screen, rows, action controls, tests)
- `apps/web/src/router.tsx`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/Rail.tsx`
- `apps/web/src/components/CollapsedRail.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/fixture/data.ts`
- focused browser and component tests

Work:

1. Add the `/inbox` route and rail entry.
2. Render Needs you, Problems, and Done with compact semantic rows.
3. Reuse the existing approval, question, and plan controls where their session assumptions can be
   removed; do not fork their behavior or keyboard rules.
4. Add empty, disconnected, partial-inventory, expired, resolving, rejected, and host-error states.
5. Restore focus after an item resolves and announce count changes to screen readers.
6. Make the narrow route touch-safe and keep the rail sheet behavior predictable.

Exit gate: every item is keyboard-operable, text explains every color/status, 200% text does not hide
actions, and Android-width behavior uses the same source data and commands.

### Phase 4: integration, proof, and release

- Pin the exact Lycaon fork commit, integration tag, app-wire tarball hash, and source-tree hash in
  T4's compatibility/provenance files.
- Run focused unit and contract tests during iteration, then the full relevant T4 and OMP gates once
  the complete slice is ready.
- Capture one representative desktop screenshot and one narrow screenshot after visual iteration.
- Verify a real three-session flow: leave session A waiting for approval, finish session B, fail session
  C, open Inbox without visiting any of them, resolve A, and confirm all three rows converge from host
  truth.
- Verify reconnect, appserver restart, multiple local profiles, paired remote host, and partial
  inventory behavior.
- Update release notes and user docs only after the tagged runtime and client proof pass.

Exit gate: the shipped claim can honestly say that Inbox covers every session in each complete host
index. When a host reports a truncated index, the UI explicitly says the inbox may be incomplete.

## Verification matrix

| Risk                                             | Required proof                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Cold sessions are missed                         | Create more than eight sessions; attention from an evicted session still appears        |
| Duplicate replay creates duplicate items         | Replay the same index delta and transcript event; stable item count remains one         |
| Stale item is actionable                         | Resolve on another client, then click the old action; current revision check refuses it |
| Connection confirmation is restored incorrectly  | Reconnect/restart; the expired confirmation is gone                                     |
| Failure is reported from a diagnostic-only error | Emit stale `turn.error` without terminal lifecycle; no Problem item appears             |
| Successful retry leaves a stale failure          | Fail then retry successfully; latest item becomes Done                                  |
| Offline client pretends to act                   | Disconnect host; controls disable with a reason and the item remains visible            |
| Observer session bypasses ownership              | Open a session active in another app; answer controls remain unavailable                |
| Same raw session ID exists on two hosts          | Items remain distinct by target + host + session identity                               |
| Session inventory is partial                     | Inbox shows an incompleteness banner and does not claim all caught up                   |
| Sensitive text leaks                             | Decoder/redaction tests cover tokens, credentials, URLs, and absolute paths             |
| Layout becomes noisy                             | Desktop and narrow screenshots show compact rows and no dashboard cards                 |
| Accessibility regresses                          | Keyboard flow, focus restoration, live-region, contrast, and 200% text checks pass      |

## Deliberate non-goals for the first release

- OS notifications, email, Slack, or push notifications.
- Cross-device synchronization of seen/unseen state.
- Bulk approve, approve-all, or automatic approval rules.
- A permanent right pane or an auto-opening modal.
- A historical event archive; Activity and the transcript already own that job.
- A separate cloud notification service.
- Attaching to every session or raising the eight-session warm cache limit.

## Recommended sprint boundary

Build one complete vertical slice across the Lycaon OMP fork and T4 client: host-owned attention
summary, client projection, inline actions, Inbox route, tests, and release provenance. Do not ship a
T4-only mock backed by fixture statuses because it would miss exactly the long-running, cold-session
work this feature is meant to surface.

The current local `codex/approval-center` branch points at the unmerged session transport-health work
from PR #58. Start implementation from a fresh authoritative `origin/main` after that PR lands, or
rebase the attention branch after its resolution, so the Inbox change remains one coherent review.
