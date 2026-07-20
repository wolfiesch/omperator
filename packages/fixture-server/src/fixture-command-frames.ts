import {
  type CommandFrame,
  type HostId,
  type PreviewCaptureId,
  type PreviewId,
  type PreviewSnapshot,
  type Revision,
  type ServerFrame,
  type SessionId,
  type SessionRef,
} from "@t4-code/protocol";
import { fixtureSettings } from "./fixture-catalog.ts";
import { branded, type Cursor } from "./fixture-sessions.ts";
import type { ScenarioSeed } from "./seeds.ts";

const V = "omp-app/1" as const;

export interface CommandSideFrameIds {
  readonly v: typeof V;
  readonly hostId: HostId;
  readonly sessionId: SessionId;
  readonly cursor: Cursor;
  readonly revision: Revision;
}

export const FIXTURE_PREVIEW_CAPTURE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
export const FIXTURE_PREVIEW_CAPTURE_SHA256 =
  "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

const PREVIEW_EVENT_COMMANDS = new Set([
  "preview.activate",
  "preview.back",
  "preview.capture",
  "preview.click",
  "preview.close",
  "preview.fill",
  "preview.forward",
  "preview.handoff",
  "preview.launch",
  "preview.navigate",
  "preview.press",
  "preview.reload",
  "preview.scroll",
  "preview.select",
  "preview.state",
  "preview.type",
  "preview.upload",
]);

export function isPreviewEventCommand(command: string): boolean {
  return PREVIEW_EVENT_COMMANDS.has(command);
}

export function fixturePreviewSnapshot(
  ids: CommandSideFrameIds,
  seed: ScenarioSeed,
  options: {
    readonly capture?: boolean;
    readonly state?: PreviewSnapshot["state"];
    readonly url?: string;
  } = {},
): PreviewSnapshot {
  return {
    previewId: branded<PreviewId>("preview-fixture"),
    state: options.state ?? "ready",
    url: options.url ?? "http://127.0.0.1/fixture",
    revision: ids.revision,
    cursor: ids.cursor,
    title: "Fixture preview",
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    authority: {
      id: "omp-session",
      label: "OMP session",
      kind: "isolated-session",
      requiresExplicitOptIn: false,
    },
    availableActions: [
      "activate",
      "navigate",
      "back",
      "forward",
      "reload",
      "close",
      "capture",
      "click",
      "fill",
      "type",
      "press",
      "scroll",
      "select",
      "upload",
      "handoff",
    ],
    ...(options.capture
      ? {
          capture: {
            captureId: branded<PreviewCaptureId>("capture-fixture"),
            mimeType: "image/png",
            size: 68,
            width: 1,
            height: 1,
            capturedAt: Date.parse(seed.baseTime),
            sha256: FIXTURE_PREVIEW_CAPTURE_SHA256,
          },
        }
      : {}),
  };
}

export function buildCommandSideFrames(
  frame: CommandFrame,
  ids: CommandSideFrameIds,
  session: SessionRef,
  seed: ScenarioSeed,
): ServerFrame[] {
  const previewUrl =
    typeof frame.args.url === "string" ? frame.args.url : "http://127.0.0.1/fixture";
  const preview = fixturePreviewSnapshot(ids, seed, {
    capture: frame.command === "preview.capture",
    state: frame.command === "preview.close" ? "stopped" : "ready",
    url: previewUrl,
  });
  let additive: unknown;
  if (frame.command === "host.watch")
    additive = { ...ids, type: "host.watch", watchId: "watch-fixture", state: "started" };
  else if (
    frame.command === "controller.lease.acquire" ||
    frame.command === "controller.lease.renew" ||
    frame.command === "controller.lease.release"
  )
    additive = {
      ...ids,
      type: "lease",
      leaseId: "lease-fixture",
      kind: "controller",
      state: frame.command.endsWith("release")
        ? "released"
        : frame.command.endsWith("renew")
          ? "renewed"
          : "acquired",
      owner: "fixture-device",
      expiresAt: new Date(Date.parse(seed.baseTime) + 60_000).toISOString(),
    };
  else if (
    frame.command === "prompt.lease.acquire" ||
    frame.command === "prompt.lease.renew" ||
    frame.command === "prompt.lease.release"
  )
    additive = {
      ...ids,
      type: "prompt.lease",
      leaseId: "lease-fixture",
      kind: "prompt",
      state: frame.command.endsWith("release")
        ? "released"
        : frame.command.endsWith("renew")
          ? "renewed"
          : "acquired",
      owner: "fixture-device",
      expiresAt: new Date(Date.parse(seed.baseTime) + 60_000).toISOString(),
    };
  else if (frame.command === "session.watch")
    additive = [
      { ...ids, type: "session.watch", watchId: "watch-fixture", state: "started" },
      { ...ids, type: "session.state", state: "ready" },
      { ...ids, type: "session.delta", upsert: session },
      { ...ids, type: "session.delta", remove: branded<SessionId>("session-removed") },
    ];
  else if (frame.command === "agent.cancel")
    additive = [
      { ...ids, type: "agent.lifecycle", agentId: "agent-fixture", lifecycle: "cancelled" },
      { ...ids, type: "agent.progress", agentId: "agent-fixture", progress: 1 },
      { ...ids, type: "agent.transcript", agentId: "agent-fixture", entries: [] },
    ];
  else if (frame.command === "files.list")
    additive = { ...ids, type: "files.list", path: "src", entries: [] };
  else if (frame.command === "files.diff")
    additive = { ...ids, type: "files.diff", path: "src/file.ts", diff: "" };
  else if (frame.command === "files.write")
    additive = {
      ...ids,
      type: "files.write",
      path: typeof frame.args.path === "string" ? frame.args.path : "README.md",
      content: typeof frame.args.content === "string" ? frame.args.content : "",
    };
  else if (frame.command === "review.read" || frame.command === "review.apply")
    additive = {
      v: V,
      type: "review",
      hostId: ids.hostId,
      sessionId: ids.sessionId,
      reviewId: typeof frame.args.reviewId === "string" ? frame.args.reviewId : "review-fixture",
      status: frame.command === "review.apply" ? "applied" : "pending",
      path: "src/fixture.ts",
      findings: [
        {
          severity: "warning",
          message: "Fixture review finding for the mobile application flow.",
          line: 12,
        },
      ],
    };
  else if (frame.command === "audit.tail")
    additive = [
      { v: V, type: "audit.tail", hostId: ids.hostId, cursor: ids.cursor, events: [] },
      {
        v: V,
        type: "audit.event",
        hostId: ids.hostId,
        cursor: ids.cursor,
        event: {
          eventId: "operation-fixture",
          hostId: ids.hostId,
          action: "fixture.read",
          actor: "fixture",
          timestamp: seed.baseTime,
        },
      },
    ];
  else if (frame.command === "settings.read")
    additive = {
      v: V,
      type: "settings",
      hostId: ids.hostId,
      revision: ids.revision,
      settings: fixtureSettings(),
    };
  else if (frame.command === "preview.launch")
    additive = { ...ids, ...preview, type: "preview.launch" };
  else if (frame.command === "preview.state")
    additive = { ...ids, ...preview, type: "preview.state" };
  else if (
    frame.command === "preview.navigate" ||
    frame.command === "preview.back" ||
    frame.command === "preview.forward" ||
    frame.command === "preview.reload"
  )
    additive = { ...ids, ...preview, type: "preview.navigation" };
  else if (frame.command === "preview.capture")
    additive = { ...ids, ...preview, type: "preview.capture" };
  else if (
    frame.command === "preview.activate" ||
    frame.command === "preview.close" ||
    frame.command === "preview.click" ||
    frame.command === "preview.fill" ||
    frame.command === "preview.handoff" ||
    frame.command === "preview.press" ||
    frame.command === "preview.scroll" ||
    frame.command === "preview.select" ||
    frame.command === "preview.type" ||
    frame.command === "preview.upload"
  )
    additive = { ...ids, ...preview, type: "preview.state" };

  if (Array.isArray(additive)) return additive as ServerFrame[];
  return additive === undefined ? [] : [additive as ServerFrame];
}
