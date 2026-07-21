import type {
  BrowserDownload,
  BrowserRuntimeError,
  BrowserSurfaceState,
  SurfaceId,
} from "@t4-code/protocol/browser-ipc";
import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_CONTEXT_CAPTURE_METHOD,
  captureBrowserPageResult,
  settleBrowserWorkspaceCall,
} from "../src/features/browser/BrowserWorkspace.tsx";

import {
  applyBrowserEvent,
  browserCall,
  browserProfileFromOption,
  initialBrowserWorkspaceModel,
  nativeBoundsFromRect,
  reconcileBrowserSurfaces,
  selectBrowserSurface,
  surfaceFromBrowserResult,
  surfacesFromBrowserResult,
} from "../src/features/browser/browser-model.ts";

const FIRST_SURFACE_ID = "12345678-1234-4abc-8def-1234567890ab" as SurfaceId;
const SECOND_SURFACE_ID = "87654321-4321-4cba-9fed-ba0987654321" as SurfaceId;

function surface(
  surfaceId: SurfaceId,
  patch: Partial<BrowserSurfaceState> = {},
): BrowserSurfaceState {
  return {
    surfaceId,
    handle: surfaceId === FIRST_SURFACE_ID ? "surface:1" : "surface:2",
    profile: { kind: "isolated-session", profileId: "isolated-session" },
    url: "https://example.test/",
    title: "Example",
    lifecycle: "ready",
    readyState: "complete",
    loading: false,
    progress: 1,
    canGoBack: false,
    canGoForward: false,
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    visible: false,
    muted: false,
    focused: "none",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("Browser workspace model", () => {
  it("binds every browser call to the active durable workspace session", () => {
    expect(browserCall("surface.list", {}, "workspace-session-a")).toEqual({
      version: 1,
      method: "surface.list",
      request: {},
      ownerSessionId: "workspace-session-a",
    });
  });

  it("stages visible accessibility text through the live browser snapshot method", () => {
    expect(BROWSER_CONTEXT_CAPTURE_METHOD).toBe("browser.snapshot");
    const item = captureBrowserPageResult("workspace-session-a", FIRST_SURFACE_ID, {
      snapshot: {
        url: "https://example.test/dashboard?account=private",
        title: "Dashboard",
        elements: [
          { role: "heading", name: "Visible account", visible: true },
          { role: "generic", name: "Hidden instructions", visible: false },
          { role: "textbox", name: "Password", value: "never-stage-this", visible: true },
        ],
      },
    });

    expect(item?.source).toEqual({
      kind: "browser",
      surfaceId: FIRST_SURFACE_ID,
      title: "Dashboard",
      url: "https://example.test/dashboard",
    });
    expect(item?.body).toContain("heading: Visible account");
    expect(item?.body).not.toContain("Hidden instructions");
    expect(item?.body).not.toContain("Password");
    expect(item?.body).not.toContain("never-stage-this");
    expect(item?.redacted).toBe(true);
  });

  it("keeps Browser surfaces distinct, stable, and limited to protocol-safe identifiers", () => {
    const first = surface(FIRST_SURFACE_ID, { visible: true, updatedAt: 10 });
    const second = surface(SECOND_SURFACE_ID, { updatedAt: 20 });
    const model = reconcileBrowserSurfaces(initialBrowserWorkspaceModel(), [first, second]);

    expect(model.surfaces.map((entry) => entry.surfaceId)).toEqual([FIRST_SURFACE_ID, SECOND_SURFACE_ID]);
    expect(selectBrowserSurface(model, "not-a-surface-id" as SurfaceId).activeSurfaceId).toBe(
      FIRST_SURFACE_ID,
    );
    expect(surfacesFromBrowserResult({ surfaces: [first, { ...second, surfaceId: "preview-a" }] })).toEqual([
      first,
    ]);
    expect(surfaceFromBrowserResult({ surface: { ...first, surfaceId: "preview-a" } })).toBeNull();
  });

  it("projects active native bounds and hides an unavailable native surface", () => {
    expect(
      nativeBoundsFromRect(
        { left: -4.2, top: 10.1, right: 100.9, bottom: 80.8 },
        { width: 90, height: 70 },
      ),
    ).toEqual({ x: 0, y: 11, width: 90, height: 59 });
    expect(
      nativeBoundsFromRect(
        { left: 100, top: 10, right: 120, bottom: 50 },
        { width: 100, height: 100 },
      ),
    ).toBeNull();

    const hidden = surface(FIRST_SURFACE_ID, { visible: false });
    const active = surface(SECOND_SURFACE_ID, { visible: true });
    const model = reconcileBrowserSurfaces(initialBrowserWorkspaceModel(), [hidden, active]);

    expect(selectBrowserSurface(model, "missing" as SurfaceId).activeSurfaceId).toBe(SECOND_SURFACE_ID);
  });

  it("requires exact explicit opt-in before using an authenticated profile", () => {
    const confirmed = browserProfileFromOption({
      profileId: "work-profile-a",
      label: "Work",
      kind: "authenticated-profile",
    });
    const isolated = browserProfileFromOption({
      profileId: "work-profile-a",
      label: "Work",
      kind: "isolated-session",
    });

    expect(confirmed).toEqual({
      kind: "authenticated-profile",
      profileId: "work-profile-a",
      explicitOptIn: true,
    });
    expect(isolated).toEqual({ kind: "isolated-session", profileId: "isolated-session" });
  });

  it("projects loading, download, and error events only for live Browser surfaces", () => {
    const loading = surface(FIRST_SURFACE_ID, {
      lifecycle: "loading",
      readyState: "loading",
      loading: true,
      progress: 0.4,
      visible: true,
      updatedAt: 2,
    });
    const download: BrowserDownload = {
      downloadId: "download-1",
      surfaceId: FIRST_SURFACE_ID,
      state: "progress",
      url: "https://example.test/report.csv",
      filename: "report.csv",
      totalBytes: 100,
      receivedBytes: 40,
    };
    const error: BrowserRuntimeError = {
      surfaceId: FIRST_SURFACE_ID,
      kind: "navigation",
      code: "ERR_FAILED",
      message: "navigation failed",
      fatal: false,
      timestamp: 3,
    };

    const withState = applyBrowserEvent(initialBrowserWorkspaceModel(), { type: "state", surface: loading });
    const withDownload = applyBrowserEvent(withState, { type: "download", download });
    const withError = applyBrowserEvent(withDownload, { type: "error", error });

    expect(withError.activeSurfaceId).toBe(FIRST_SURFACE_ID);
    expect(withError.surfaces).toEqual([loading]);
    expect(withError.downloads).toEqual([download]);
    expect(withError.runtimeErrors).toEqual([error]);
    expect(
      applyBrowserEvent(withError, {
        type: "download",
        download: { ...download, surfaceId: SECOND_SURFACE_ID },
      }),
    ).toBe(withError);
  });
});

describe("Browser workspace async lifecycle", () => {
  it("consumes rejected profile, list, metadata, and bounds calls after route exit and reload", async () => {
    const updates: string[] = [];
    const errors: string[] = [];
    const methods = [
      "browser.profiles.list",
      "surface.list",
      "surface.downloads",
      "browser.console.list",
      "browser.errors.list",
      "surface.setBounds",
    ];

    for (const nextGeneration of [0, 2]) {
      let generation = 1;
      const calls = methods.map((method) =>
        settleBrowserWorkspaceCall(
          Promise.reject<never>(new Error(`${method} failed`)),
          () => generation === 1,
          () => updates.push(method),
          (error) => errors.push((error as Error).message),
        ),
      );

      generation = nextGeneration;
      await Promise.all(calls);
    }

    expect(updates).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("retains rejected action errors while the browser workspace remains mounted", async () => {
    const errors: string[] = [];

    await settleBrowserWorkspaceCall(
      Promise.reject<never>(new Error("reload failed")),
      () => true,
      () => undefined,
      (error) => errors.push((error as Error).message),
    );

    expect(errors).toEqual(["reload failed"]);
  });
});
