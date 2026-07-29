import {
  deriveAttentionInbox,
  type AttentionInboxItem as ClientAttentionInboxItem,
} from "@t4-code/client";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { desktopRuntime, useDesktopRuntimeSnapshot } from "../../platform/desktop-runtime.ts";
import { sessionViewId } from "../../platform/live-workspace.ts";
import { useWorkspace, workspaceStore } from "../../state/store-instance.ts";
import { respondToAttentionItem } from "../session-runtime/attention-actions.ts";
import { AttentionInboxScreen } from "./AttentionInboxScreen.tsx";
import { ATTENTION_INBOX_FIXTURES } from "./fixtures.ts";
import type {
  AttentionInboxAction,
  AttentionInboxItem as UiAttentionInboxItem,
  AttentionInventoryState as UiAttentionInventoryState,
} from "./model.ts";

/** Keep expiry copy fresh, then remove a confirmation immediately after its deadline. */
export function nextAttentionRefreshDelay(
  items: readonly UiAttentionInboxItem[],
  nowMs: number,
): number | null {
  const nextExpiry = items.reduce<number | null>((nearest, item) => {
    if (item.kind !== "confirmation" || item.expiresAtMs <= nowMs) return nearest;
    return nearest === null ? item.expiresAtMs : Math.min(nearest, item.expiresAtMs);
  }, null);
  return nextExpiry === null ? null : Math.max(1, Math.min(1_000, nextExpiry - nowMs + 1));
}

function uiAttentionItem(
  item: ClientAttentionInboxItem,
  hostLabel: string | undefined,
): UiAttentionInboxItem {
  const session = {
    ...(item.session.targetId === undefined ? {} : { targetId: item.session.targetId }),
    hostId: item.session.hostId,
    sessionId: item.session.sessionId,
    title: item.session.title,
    project: item.session.project,
    ...(hostLabel === undefined ? {} : { hostLabel }),
  };
  const common = {
    key: item.key,
    session,
    title: item.title,
    summary: item.summary,
    occurredAtMs: item.occurredAtMs,
  };
  if ("outcomeId" in item) {
    if (item.kind === "completed") {
      return { ...common, kind: "completed", outcomeId: item.outcomeId, seen: item.seen };
    }
    if (item.kind === "failed") {
      return { ...common, kind: "failed", outcomeId: item.outcomeId, seen: item.seen };
    }
    return { ...common, kind: "cancelled", outcomeId: item.outcomeId, seen: item.seen };
  }
  const actionState = { status: item.actionState.status };
  if (item.kind === "question") {
    return {
      ...common,
      kind: "question",
      requestId: item.requestId,
      options: item.options,
      allowText: item.allowText,
      multiple: item.multiple,
      actionState,
    };
  }
  if (item.kind === "confirmation") {
    return {
      ...common,
      kind: "confirmation",
      requestId: item.requestId,
      expiresAtMs: item.expiresAtMs,
      actionState,
    };
  }
  return { ...common, kind: item.kind, requestId: item.requestId, actionState };
}

function attentionInventory(
  partial: boolean,
  offline: boolean,
  omittedPendingCount: number,
): UiAttentionInventoryState {
  if (offline) {
    return {
      status: "offline",
      message: "One or more hosts are offline. Their Inbox items may be out of date.",
    };
  }
  if (partial) {
    return {
      status: "partial",
      message:
        omittedPendingCount > 0
          ? `${omittedPendingCount} more request${omittedPendingCount === 1 ? " is" : "s are"} waiting. Open the affected session to see everything.`
          : "One or more hosts published only part of their session list. This Inbox may be incomplete.",
    };
  }
  return { status: "complete" };
}

/** Live route adapter: host projection and commands in, reusable Inbox UI out. */
export function LiveAttentionInbox() {
  const navigate = useNavigate();
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const seenOutcomeIdsBySessionKey = useWorkspace(
    (state) => state.lastSeenAttentionOutcomeBySessionKey,
  );
  const [resolvingKeys, setResolvingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Readonly<Record<string, string>>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const projection = useMemo(
    () =>
      snapshot === null
        ? null
        : deriveAttentionInbox(snapshot, { now: nowMs, seenOutcomeIdsBySessionKey }),
    [nowMs, seenOutcomeIdsBySessionKey, snapshot],
  );
  const liveItems = useMemo(() => {
    if (snapshot === null || projection === null) return null;
    return projection.items.map((item) => {
      const target =
        item.session.targetId === undefined
          ? undefined
          : snapshot.targets.get(item.session.targetId);
      return uiAttentionItem(item, target?.label);
    });
  }, [projection, snapshot]);
  const sourceItems = liveItems ?? ATTENTION_INBOX_FIXTURES.sample.items;
  const itemKeys = useMemo(() => new Set(sourceItems.map((item) => item.key)), [sourceItems]);

  useEffect(() => {
    setResolvingKeys((current) => {
      const retained = new Set([...current].filter((key) => itemKeys.has(key)));
      return retained.size === current.size ? current : retained;
    });
    setActionErrors((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([key]) => itemKeys.has(key)),
      );
      return Object.keys(retained).length === Object.keys(current).length ? current : retained;
    });
  }, [itemKeys]);

  useEffect(() => {
    if (snapshot === null) return;
    const delay = nextAttentionRefreshDelay(sourceItems, nowMs);
    if (delay === null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nowMs, snapshot, sourceItems]);

  const items = useMemo(
    () =>
      sourceItems.map((item) => {
        if (!("actionState" in item)) return item;
        const error = actionErrors[item.key];
        if (error !== undefined) {
          return { ...item, actionState: { status: "error" as const, message: error } };
        }
        if (resolvingKeys.has(item.key)) {
          return { ...item, actionState: { status: "resolving" as const } };
        }
        return item;
      }),
    [actionErrors, resolvingKeys, sourceItems],
  );

  const inventory =
    snapshot === null || projection === null
      ? ATTENTION_INBOX_FIXTURES.sample.inventory
      : attentionInventory(
          projection.inventory.partial,
          [...snapshot.connections.values()].some((state) => state !== "connected"),
          projection.inventory.omittedPendingCount,
        );

  const openSession = (session: { readonly hostId: string; readonly sessionId: string }) => {
    void navigate({
      params: {
        sessionId:
          snapshot === null ? session.sessionId : sessionViewId(session.hostId, session.sessionId),
      },
      to: "/sessions/$sessionId",
    });
  };

  const runAction = async (action: AttentionInboxAction) => {
    const item = sourceItems.find((candidate) => candidate.key === action.itemKey);
    if (item === undefined || !("actionState" in item)) return;
    if (item.kind === "confirmation" && item.expiresAtMs <= Date.now()) {
      setNowMs(Date.now());
      setActionErrors((current) => ({
        ...current,
        [action.itemKey]:
          "This security confirmation expired. Open the session to request it again.",
      }));
      return;
    }
    if (action.kind === "plan" && action.decision === "revise") {
      openSession(item.session);
      return;
    }
    if (controller === null || item.session.targetId === undefined) {
      setActionErrors((current) => ({
        ...current,
        [action.itemKey]: "Open T4 Code on the connected desktop to respond.",
      }));
      return;
    }
    setActionErrors((current) => {
      const next = { ...current };
      delete next[action.itemKey];
      return next;
    });
    setResolvingKeys((current) => new Set(current).add(action.itemKey));
    const address = {
      targetId: item.session.targetId,
      hostId: item.session.hostId,
      sessionId: item.session.sessionId,
    };
    const response =
      action.kind === "question"
        ? await respondToAttentionItem(controller, address, {
            kind: "question",
            requestId: action.requestId,
            optionIds: action.optionIds,
            text: action.text,
          })
        : action.kind === "plan"
          ? await respondToAttentionItem(controller, address, {
              kind: "plan",
              requestId: action.requestId,
              decision: action.decision,
            })
          : await respondToAttentionItem(controller, address, {
              kind: action.kind,
              requestId: action.requestId,
              decision: action.decision,
            });
    if (response.kind !== "accepted") {
      setResolvingKeys((current) => {
        const next = new Set(current);
        next.delete(action.itemKey);
        return next;
      });
      setActionErrors((current) => ({ ...current, [action.itemKey]: response.reason }));
    }
  };

  const markSeen = (itemKey: string) => {
    const item = sourceItems.find((candidate) => candidate.key === itemKey);
    if (item === undefined || !("outcomeId" in item)) return;
    workspaceStore
      .getState()
      .markAttentionOutcomeSeen(
        `${item.session.hostId}\u0000${item.session.sessionId}`,
        item.outcomeId,
      );
  };

  return (
    <AttentionInboxScreen
      inventory={inventory}
      items={items}
      nowMs={snapshot === null ? ATTENTION_INBOX_FIXTURES.sample.nowMs : nowMs}
      onAction={(action) => void runAction(action)}
      onBack={() => void navigate({ to: "/" })}
      onMarkAllUpdatesSeen={() => {
        for (const item of sourceItems) {
          if ("outcomeId" in item && !item.seen) markSeen(item.key);
        }
      }}
      onMarkSeen={markSeen}
      onOpenSession={openSession}
    />
  );
}
