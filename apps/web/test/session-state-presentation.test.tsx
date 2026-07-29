import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { describeSessionState } from "../src/components/Rail.tsx";
import {
  resolveSessionActivity,
  SessionActivityBanner,
  SessionConnectionBadge,
  SessionStateBadge,
} from "../src/features/transcript/SessionMain.tsx";
import { presentSessionState } from "../src/features/session-runtime/session-state.ts";
import type { WorkspaceSession } from "../src/lib/workspace-data.ts";

const BASE_SESSION: WorkspaceSession = {
  id: "session-a",
  projectId: "project-a",
  title: "Session",
  model: "model",
  status: null,
  freshness: "live",
  pendingApprovals: 0,
  latestTurnCompletedAt: null,
  createdAt: "2026-07-20T10:00:00Z",
  updatedAt: "2026-07-20T10:00:00Z",
  lastActivity: "",
};

describe("truthful session state presentation", () => {
  it("keeps idle, stopped, and missing lifecycle signals distinct", () => {
    expect(describeSessionState({ ...BASE_SESSION, lifecycle: "idle" })).toBe("Idle");
    expect(describeSessionState({ ...BASE_SESSION, lifecycle: "closed" })).toBe("Stopped");
    expect(describeSessionState(BASE_SESSION)).toBe("Status unknown");
  });

  it("lets freshness and confirmed ownership override lifecycle copy", () => {
    expect(describeSessionState({ ...BASE_SESSION, freshness: "cached", lifecycle: "idle" })).toBe(
      "Cached",
    );
    expect(describeSessionState({ ...BASE_SESSION, control: "observer", lifecycle: "idle" })).toBe(
      "Active elsewhere",
    );
  });

  it("shows the same explicit lifecycle in the task header's stable state slot", () => {
    const idle = renderToStaticMarkup(
      <SessionStateBadge session={{ ...BASE_SESSION, lifecycle: "idle" }} />,
    );
    const stopped = renderToStaticMarkup(
      <SessionStateBadge session={{ ...BASE_SESSION, lifecycle: "closed" }} />,
    );
    const unknown = renderToStaticMarkup(<SessionStateBadge session={BASE_SESSION} />);

    expect(idle).toContain("Idle");
    expect(idle).toContain("bg-muted-foreground");
    expect(stopped).toContain("Stopped");
    expect(unknown).toContain("Status unknown");
    for (const markup of [idle, stopped, unknown]) {
      expect(markup).toContain("sm:w-32");
    }
  });

  it("keeps connection separate while collapsing activity and ownership into one signal", () => {
    const connected = renderToStaticMarkup(<SessionConnectionBadge state="connected" />);
    const observedWorking = renderToStaticMarkup(
      <SessionStateBadge
        session={{
          ...BASE_SESSION,
          control: "observer",
          lifecycle: "idle",
          status: "working",
        }}
      />,
    );

    expect(connected).toContain("Connected");
    expect(observedWorking).toContain("Working elsewhere");
    expect(observedWorking).not.toContain(">Idle<");
    expect(
      resolveSessionActivity({
        archived: false,
        catchingUp: false,
        controlled: false,
        contextMaintenance: false,
        link: "live",
        sessionActive: true,
      }),
    ).toBe("working");
    expect(
      resolveSessionActivity({
        archived: false,
        catchingUp: false,
        controlled: true,
        contextMaintenance: false,
        link: "live",
        sessionActive: true,
      }),
    ).toBeNull();
  });

  it("uses stable connection geometry and names reconnects without leaking them into activity", () => {
    const connected = renderToStaticMarkup(<SessionConnectionBadge state="connected" />);
    const reconnecting = renderToStaticMarkup(<SessionConnectionBadge state="connecting" />);

    for (const markup of [connected, reconnecting]) {
      expect(markup).toContain("sm:w-28");
    }
    expect(reconnecting).toContain("Reconnecting");
    expect(reconnecting).not.toContain(">Connecting<");
    expect(presentSessionState({ ...BASE_SESSION, status: "connecting" }).label).toBe(
      "Status unknown",
    );
  });

  it("keeps state priority truthful through takeover and reconnect transitions", () => {
    const sequence = [
      presentSessionState({ ...BASE_SESSION, lifecycle: "idle" }).label,
      presentSessionState({
        ...BASE_SESSION,
        lifecycle: "idle",
        control: "reconciling",
      }).label,
      presentSessionState({ ...BASE_SESSION, lifecycle: "active", status: "working" }).label,
      presentSessionState({ ...BASE_SESSION, freshness: "cached", status: "working" }).label,
      presentSessionState({ ...BASE_SESSION, freshness: "offline", status: "working" }).label,
      presentSessionState({ ...BASE_SESSION, lifecycle: "idle" }).label,
    ];

    expect(sequence).toEqual([
      "Idle",
      "Taking over",
      "Working",
      "Cached",
      "Offline",
      "Idle",
    ]);
  });

  it("renders a moving visual heartbeat only while work is confirmed", () => {
    const working = renderToStaticMarkup(
      <SessionActivityBanner activity="working" nowMs={0} startedAt={null} />,
    );
    expect(working).toContain('data-session-activity-banner="working"');
    expect(working).toContain('data-status="working"');
    expect(working).toContain("animate-ping");
    expect(working).toContain("Working");
    expect(
      renderToStaticMarkup(<SessionActivityBanner activity={null} nowMs={0} startedAt={null} />),
    ).toBe("");
  });

  it("starts the elapsed label from the runtime clock instead of the wall clock", () => {
    const working = renderToStaticMarkup(
      <SessionActivityBanner
        activity="working"
        nowMs={Date.parse("2026-07-20T10:00:05Z")}
        startedAt="2026-07-20T10:00:00Z"
      />,
    );

    expect(working).toContain("5s");
  });
});
