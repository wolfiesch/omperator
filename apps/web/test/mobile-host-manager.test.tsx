// Saved-host manager QOL guarantees: entering the manager mutates nothing,
// switching only re-points the active host, and a reload happens only after a
// successful switch or removal. The shared address form is side-effect free
// until its parse-and-probe submission succeeds.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MobileConnectionAction,
  performHostRemoval,
  performHostSwitch,
} from "../src/components/MobileConnectionAction.tsx";
import {
  probeAndSaveMobileBackend,
  GatewayAddressForm,
} from "../src/components/MobileConnectionScreen.tsx";
import {
  MOBILE_BACKEND_STORAGE_KEY,
  parseMobileBackend,
} from "../src/platform/native-mobile.ts";

const originalWindow = globalThis.window;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("mobile saved-host manager", () => {
  it("renders the T4 hosts entry point without touching saved-host state", () => {
    const storage = new MemoryStorage();
    const bunker = parseMobileBackend("https://bunker.example.com:8445");
    const laptop = parseMobileBackend("https://laptop.example.com:8445");
    const seeded = JSON.stringify({
      version: 2,
      activeOrigin: bunker.origin,
      backends: [bunker, laptop],
    });
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, seeded);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
        localStorage: storage,
      },
    });

    const markup = renderToStaticMarkup(<MobileConnectionAction />);

    expect(markup).toContain('aria-label="T4 hosts"');
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(seeded);
    expect([...storage.values.keys()]).toEqual([MOBILE_BACKEND_STORAGE_KEY]);
  });

  it("switches hosts without any removal and restarts at home only after the selection persists", () => {
    const calls: string[] = [];
    const failure = performHostSwitch("https://laptop.example.com:8445", {
      restartAtHome: () => calls.push("restart-home"),
      select: (origin) => calls.push(`select:${origin}`),
    });
    expect(failure).toBeNull();
    expect(calls).toEqual(["select:https://laptop.example.com:8445", "restart-home"]);

    const failedCalls: string[] = [];
    const message = performHostSwitch("https://gone.example.com:8445", {
      restartAtHome: () => failedCalls.push("restart-home"),
      select: () => {
        throw new Error("That saved host is no longer available.");
      },
    });
    expect(message).toBe("That saved host is no longer available.");
    expect(failedCalls).toEqual([]);
  });

  it("reloads after a successful removal and keeps state when removal fails", async () => {
    const calls: string[] = [];
    const failure = await performHostRemoval("https://laptop.example.com:8445", {
      reload: () => calls.push("reload"),
      remove: async (origin) => {
        calls.push(`remove:${origin}`);
      },
    });
    expect(failure).toBeNull();
    expect(calls).toEqual(["remove:https://laptop.example.com:8445", "reload"]);

    const failedCalls: string[] = [];
    const message = await performHostRemoval("https://laptop.example.com:8445", {
      reload: () => failedCalls.push("reload"),
      remove: async () => {
        throw new Error("Android secure storage is unavailable");
      },
    });
    expect(message).toBe("Android secure storage is unavailable");
    expect(failedCalls).toEqual([]);
  });

  it("drops a late successful probe after the Add view is cancelled", async () => {
    const backend = parseMobileBackend("https://later.example.com:8445");
    const controller = new AbortController();
    const calls: string[] = [];
    let finishProbe: (() => void) | undefined;
    const pendingProbe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });

    const result = probeAndSaveMobileBackend(backend, {
      signal: controller.signal,
      probe: () => pendingProbe,
      save: (candidate) => calls.push(`save:${candidate.origin}`),
      reload: () => calls.push("reload"),
    });
    controller.abort();
    finishProbe?.();

    await expect(result).resolves.toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("reuses one probing address form for startup and in-app add", () => {
    const saved: string[] = [];
    const markup = renderToStaticMarkup(
      <GatewayAddressForm save={(backend) => saved.push(backend.origin)} submitLabel="Check and add" />,
    );
    expect(markup).toContain("Host address");
    expect(markup).toContain("Check and add");
    expect(markup).toContain("Use the full HTTPS address shown by the T4 gateway on your computer.");
    // Rendering the form saves nothing: persistence happens only after a
    // successful probe on submit.
    expect(saved).toEqual([]);
  });
});
