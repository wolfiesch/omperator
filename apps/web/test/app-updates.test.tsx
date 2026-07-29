import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UnavailableSettingsWorkspace } from "../src/features/settings/UnavailableSettingsWorkspace.tsx";
import {
  buildSettingsRailSections,
  UPDATE_SECTION_ID,
} from "../src/features/settings/SettingsWorkspace.tsx";
import { UpdateSettingsPanel } from "../src/features/updates/UpdateSettingsPanel.tsx";
import {
  actionForUpdate,
  defaultUpdateMessage,
  type AppUpdateState,
  updateIsAvailable,
} from "../src/features/updates/update-model.ts";
import {
  fromAndroidUpdateState,
  shouldAcceptAndroidRevision,
} from "../src/features/updates/update-store.ts";
import { subscribeNativeUpdateSettingsOpen } from "../src/features/updates/update-navigation.ts";
import { rendererPlatform } from "../src/state/store-instance.ts";

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    version: 1,
    currentVersion: "0.1.17",
    phase: "idle",
    delivery: "desktop",
    ...overrides,
  };
}

describe("application update view model", () => {
  it("subscribes before the renderer-ready handshake drains a pending menu request", async () => {
    const mutablePlatform = rendererPlatform as unknown as { shell: unknown };
    const originalShell = mutablePlatform.shell;
    const order: string[] = [];
    let nativeOpen: (() => void) | undefined;
    let resolveReady!: (result: { readonly openSettings: boolean }) => void;
    const ready = new Promise<{ readonly openSettings: boolean }>((resolve) => {
      resolveReady = resolve;
    });
    let opens = 0;
    let unsubscribed = false;
    mutablePlatform.shell = {
      onOpenUpdateSettings: (listener: () => void) => {
        order.push("subscribe");
        nativeOpen = listener;
        return () => {
          unsubscribed = true;
        };
      },
      updateRendererReady: () => {
        order.push("ready");
        return ready;
      },
    };

    try {
      const unsubscribe = subscribeNativeUpdateSettingsOpen(() => {
        opens += 1;
      });
      expect(order).toEqual(["subscribe", "ready"]);
      resolveReady({ openSettings: true });
      await ready;
      await Promise.resolve();
      expect(opens).toBe(1);
      nativeOpen?.();
      expect(opens).toBe(2);
      unsubscribe();
      expect(unsubscribed).toBe(true);
    } finally {
      mutablePlatform.shell = originalShell;
    }
  });

  it("offers exactly the phase-correct user action", () => {
    expect(actionForUpdate(state()).label).toBe("Check for updates");
    expect(actionForUpdate(state({ phase: "checking" }))).toEqual({
      label: "Checking…",
      busy: true,
      kind: "check",
    });
    expect(actionForUpdate(state({ phase: "available" })).kind).toBe("download");
    expect(actionForUpdate(state({ delivery: "android", phase: "downloading" }))).toEqual({
      label: "Downloading…",
      busy: true,
      kind: "download",
    });
    expect(
      actionForUpdate(state({ delivery: "android", phase: "manual", handoff: "installer" })),
    ).toEqual({
      label: "Check again",
      busy: false,
      kind: "check",
    });
    expect(actionForUpdate(state({ phase: "ready" })).kind).toBe("restart");
    expect(actionForUpdate(state({ phase: "error" })).label).toBe("Try again");
    expect(actionForUpdate(state({ delivery: "web", phase: "current" }))).toEqual({
      label: "Refresh T4 Code",
      busy: false,
      kind: "refresh",
    });
  });

  it("treats downloaded and manual releases as available without nagging on errors", () => {
    expect(updateIsAvailable("available")).toBe(true);
    expect(updateIsAvailable("manual")).toBe(true);
    expect(updateIsAvailable("downloading")).toBe(true);
    expect(updateIsAvailable("ready")).toBe(true);
    expect(updateIsAvailable("error")).toBe(false);
    expect(defaultUpdateMessage(state())).toMatch(/checks release metadata quietly/i);
  });

  it("maps native installer handoff and rejects stale Android bridge revisions", () => {
    const mapped = fromAndroidUpdateState({
      currentVersion: "0.1.17",
      latestVersion: "0.1.18",
      phase: "installer",
      revision: 7,
      message: "The verified APK is open in Android's installer.",
    });
    expect(mapped).toMatchObject({
      delivery: "android",
      phase: "manual",
      handoff: "installer",
      nativeRevision: 7,
    });
    expect(actionForUpdate(mapped).kind).toBe("check");
    expect(shouldAcceptAndroidRevision(7, 6)).toBe(false);
    expect(shouldAcceptAndroidRevision(7, 7)).toBe(true);
    expect(shouldAcceptAndroidRevision(7, 8)).toBe(true);
    expect(() =>
      fromAndroidUpdateState({
        currentVersion: "0.1.17",
        phase: "idle",
        revision: -1,
      }),
    ).toThrow(/revision/i);
  });

  it("inserts the app-owned Updates section directly before Diagnostics", () => {
    const sections = buildSettingsRailSections([
      { id: "appearance", label: "Appearance", summary: "Colors", rows: [] },
      { id: "diagnostics", label: "Diagnostics", summary: "Logs", rows: [] },
    ]);
    expect(sections.map(({ id }) => id)).toEqual(["appearance", UPDATE_SECTION_ID, "diagnostics"]);
  });
});

describe("application update settings UI", () => {
  it("shows installed and available versions, live status, progress, and one action", () => {
    const markup = renderToStaticMarkup(
      <UpdateSettingsPanel
        state={state({
          phase: "downloading",
          availableVersion: "0.1.18",
          checkedAt: Date.UTC(2026, 6, 15, 12, 30),
          progressPercent: 42,
        })}
      />,
    );
    expect(markup).toContain("Updates");
    expect(markup).toContain("v0.1.17");
    expect(markup).toContain("v0.1.18");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("github.com");
  });

  it("keeps Updates usable while host-owned settings are disconnected", () => {
    const markup = renderToStaticMarkup(
      <UnavailableSettingsWorkspace
        copy={{
          title: "No host is connected",
          detail: "Connect or pair one under Hosts.",
          spin: false,
          error: false,
        }}
        onBack={() => undefined}
        onOpenHosts={() => undefined}
        update={state({ delivery: "web", phase: "current" })}
      />,
    );
    expect(markup).toContain("Updates");
    expect(markup).toContain("Refresh T4 Code");
    expect(markup).toContain("Host settings");
    expect(markup).toContain("No host is connected");
  });

  it("uses a touch-sized Android APK action without exposing an asset URL", () => {
    const markup = renderToStaticMarkup(
      <UpdateSettingsPanel
        state={state({
          delivery: "android",
          phase: "manual",
          availableVersion: "0.1.18",
        })}
      />,
    );
    expect(markup).toContain("Download and verify");
    expect(markup).toContain("identity, version, and signer");
    expect(markup).toContain("min-h-11");
    expect(markup).not.toContain(".apk");
    expect(markup).not.toContain("href=");
  });
});
