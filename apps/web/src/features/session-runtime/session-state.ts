import { STATUS_PILLS, type SessionStatus } from "@t4-code/ui";

import type { WorkspaceSession } from "../../lib/workspace-data.ts";
import { presentSessionControlKind } from "./session-observer.ts";

type ActivityStatus = Exclude<SessionStatus, "connecting">;

export interface SessionStatePresentation {
  /** Compact, stable label shared by the rail and active-session header. */
  readonly label: string;
  /** Longer explanation for tooltips and assistive text. */
  readonly detail: string;
  /** Semantic status styling when the state maps to the app-wide taxonomy. */
  readonly status: ActivityStatus | null;
  /** A confirmed in-progress signal, including work owned by another app. */
  readonly busy: boolean;
}

const STATUS_DETAIL: Record<ActivityStatus, string> = {
  working: "This session has a turn in progress.",
  pendingApproval: "This session is waiting for approval before it can continue.",
  awaitingInput: "This session is waiting for your answer.",
  planReady: "A plan is ready for review.",
  completed: "The latest turn completed.",
  error: "The latest turn stopped with an error.",
};

function lifecyclePresentation(session: WorkspaceSession): SessionStatePresentation {
  if (session.lifecycle === "idle") {
    return {
      label: "Idle",
      detail: "The runtime is connected and has no work in progress.",
      status: null,
      busy: false,
    };
  }
  if (session.lifecycle === "closed") {
    return {
      label: "Stopped",
      detail: "The runtime reports that this session has stopped.",
      status: null,
      busy: false,
    };
  }
  return {
    label: "Status unknown",
    detail:
      "T4 has saved history for this session, but the runtime did not report whether it is running, idle, or stopped.",
    status: null,
    busy: false,
  };
}

/**
 * One session-state contract for compact surfaces.
 *
 * Connection is deliberately absent: the active-session header owns that
 * independently, and a host reconnect must never turn every rail row into a
 * pulsing "Connecting" item or reorder the Running/Priority views.
 */
export function presentSessionState(session: WorkspaceSession): SessionStatePresentation {
  if (session.freshness === "offline") {
    return {
      label: "Offline",
      detail: "The host is unreachable. This is the last state T4 received.",
      status: null,
      busy: false,
    };
  }
  if (session.freshness === "cached") {
    return {
      label: "Cached",
      detail: "Showing the last synced copy. It refreshes when the connection returns.",
      status: null,
      busy: false,
    };
  }

  if (session.control !== undefined) {
    const control = presentSessionControlKind(session.control);
    if (session.control === "reconciling") {
      return {
        label: "Taking over",
        detail: control.composerReason,
        status: null,
        busy: true,
      };
    }
    if (session.control === "observer" && session.status === "working") {
      return {
        label: "Working elsewhere",
        detail: control.composerReason,
        status: null,
        busy: true,
      };
    }
    if (session.control === "observer") {
      return {
        label: "Active elsewhere",
        detail: control.composerReason,
        status: null,
        busy: false,
      };
    }
    if (session.control === "suspect") {
      return {
        label: "Waiting",
        detail: control.composerReason,
        status: null,
        busy: false,
      };
    }
    return {
      label: "Read-only",
      detail: control.composerReason,
      status: null,
      busy: false,
    };
  }

  // "connecting" is a legacy defensive case. New live projections never
  // publish connection state as session activity.
  if (session.status !== null && session.status !== "connecting") {
    return {
      label: STATUS_PILLS[session.status].label,
      detail: STATUS_DETAIL[session.status],
      status: session.status,
      busy: session.status === "working",
    };
  }

  return lifecyclePresentation(session);
}
