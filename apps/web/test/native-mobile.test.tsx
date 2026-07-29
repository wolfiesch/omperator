import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MobileConnectionScreen } from "../src/components/MobileConnectionScreen.tsx";
import {
  MOBILE_BACKEND_STORAGE_KEY,
  parseTailnetBackend,
  persistNativeMobileCredentials,
  prepareNativeMobileBackend,
  probeMobileBackend,
  readStoredMobileBackend,
  readStoredMobileBackendDirectory,
  replaceStoredMobileBackend,
  removeNativeMobileBackend,
  selectStoredMobileBackend,
  type StoredMobileBackendDirectory,
  writeStoredMobileBackend,
} from "../src/platform/native-mobile.ts";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("native mobile connection", () => {
  it("normalizes a full Tailnet HTTPS origin and rejects unsafe addresses", () => {
    expect(parseTailnetBackend("workstation.example.ts.net:8445")).toEqual({
      version: 3,
      endpointKey: "https://workstation.example.ts.net:8445#profile=default",
      origin: "https://workstation.example.ts.net:8445",
      profileId: "default",
      wsUrl: "wss://workstation.example.ts.net:8445/v1/ws",
      label: "T4 on workstation",
    });
    expect(() => parseTailnetBackend("http://host.tailnet.ts.net")).toThrow(/HTTPS/u);
    expect(() => parseTailnetBackend("https://example.com")).toThrow(/\.ts\.net/u);
    expect(() => parseTailnetBackend("https://host.tailnet.ts.net/admin")).toThrow(/host address only/u);
    expect(() => parseTailnetBackend("https://user:pass@host.tailnet.ts.net")).toThrow(/credentials/u);
    expect(parseTailnetBackend("https://host.tailnet.ts.net", "  work  ")).toMatchObject({
      endpointKey: "https://host.tailnet.ts.net#profile=work",
      profileId: "work",
      wsUrl: "wss://host.tailnet.ts.net/v1/profiles/work/ws",
    });
  });
  it("replaces an existing endpoint at the saved-endpoint cap but rejects a distinct endpoint", () => {
    const storage = new MemoryStorage();
    const backends = Array.from({ length: 16 }, (_, index) =>
      parseTailnetBackend(`https://host-${index}.tailnet.ts.net:8445`, `profile-${index}`),
    );
    for (const backend of backends) writeStoredMobileBackend(backend, storage);

    expect(() => writeStoredMobileBackend(backends[0]!, storage)).not.toThrow();
    expect(readStoredMobileBackendDirectory(storage)?.backends).toHaveLength(16);
    expect(readStoredMobileBackendDirectory(storage)?.backends[0]).toEqual(backends[1]);
    expect(readStoredMobileBackendDirectory(storage)?.backends[15]).toEqual(backends[0]);

    const distinct = parseTailnetBackend("https://new-host.tailnet.ts.net:8445", "new-profile");
    expect(() => writeStoredMobileBackend(distinct, storage)).toThrow(/up to 16 T4 endpoints/u);
    expect(readStoredMobileBackendDirectory(storage)?.backends).toHaveLength(16);
  });

  it("migrates the legacy host, retains added hosts, and switches without deleting either", () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(bunker));

    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: bunker.endpointKey,
      backends: [bunker],
    });
    writeStoredMobileBackend(laptop, storage);
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: laptop.endpointKey,
      backends: [bunker, laptop],
    });

    selectStoredMobileBackend(bunker.endpointKey, storage);
    expect(readStoredMobileBackend(storage)).toEqual(bunker);
    expect(readStoredMobileBackendDirectory(storage)?.backends).toEqual([bunker, laptop]);

    storage.setItem(
      MOBILE_BACKEND_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activeEndpointKey: bunker.endpointKey,
        backends: [{ ...bunker, wsUrl: "wss://evil.example/v1/ws" }],
      }),
    );
    expect(() => readStoredMobileBackend(storage)).toThrow(/inconsistent/u);
    replaceStoredMobileBackend(laptop, storage);
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: laptop.endpointKey,
      backends: [laptop],
    });
  });

  it("loads only the active host credential from the keyed native bridge", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(backend));
    const reads: Array<{ readonly hostKey: string; readonly migrateLegacy?: boolean }> = [];
    const clears: string[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: (options: {
                readonly hostKey: string;
                readonly migrateLegacy?: boolean;
              }) => {
                reads.push(options);
                return Promise.resolve({
                  credentials: {
                    deviceId: "android-device",
                    deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                  },
                });
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });
    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toEqual([{ hostKey: backend.endpointKey, migrateLegacy: false }]);
    expect(window.__t4MobileBackend).toEqual({
      endpointKey: backend.endpointKey,
      origin: backend.origin,
      profileId: backend.profileId,
      wsUrl: backend.wsUrl,
      label: backend.label,
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(readStoredMobileBackendDirectory(storage)?.backends).toEqual([backend]);
  });

  it("migrates v2 origin-keyed credentials to the default profile endpoint", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    storage.setItem(
      "t4-code:mobile-backends:v2",
      JSON.stringify({
        version: 2,
        activeOrigin: backend.origin,
        backends: [{
          version: 1,
          origin: backend.origin,
          wsUrl: backend.wsUrl,
          label: backend.label,
        }],
      }),
    );
    const credentials = {
      deviceId: "legacy-android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const reads: Array<{ readonly hostKey: string; readonly migrateLegacy?: boolean }> = [];
    const writes: Array<{ readonly hostKey: string; readonly deviceId: string; readonly deviceToken: string }> = [];
    const clears: string[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: (options: { readonly hostKey: string; readonly migrateLegacy?: boolean }) => {
                reads.push(options);
                return Promise.resolve({
                  credentials: options.hostKey === backend.origin ? credentials : null,
                });
              },
              setCredentials: (options: {
                readonly hostKey: string;
                readonly deviceId: string;
                readonly deviceToken: string;
              }) => {
                writes.push(options);
                return Promise.resolve();
              },
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toEqual([
      { hostKey: backend.endpointKey, migrateLegacy: false },
      { hostKey: backend.origin, migrateLegacy: true },
    ]);
    expect(writes).toEqual([{ hostKey: backend.endpointKey, ...credentials }]);
    expect(clears).toEqual([backend.origin]);
    expect(window.__t4MobileBackend).toMatchObject(credentials);
    expect(storage.getItem("t4-code:mobile-backends:v2")).toBeNull();
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: backend.endpointKey,
      backends: [backend],
    });
  });

  it("does not rebind global legacy credentials after v2 host repair", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://repaired.tailnet.ts.net:8445");
    replaceStoredMobileBackend(backend, storage);
    const reads: Array<{ readonly hostKey: string; readonly migrateLegacy?: boolean }> = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: (options: {
                readonly hostKey: string;
                readonly migrateLegacy?: boolean;
              }) => {
                reads.push(options);
                return Promise.resolve({ credentials: null });
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => Promise.resolve(),
            },
          },
        },
      },
    });
    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toEqual([
      { hostKey: backend.endpointKey, migrateLegacy: false },
      { hostKey: backend.origin, migrateLegacy: false },
    ]);
  });

  it("retries a stranded secure-storage callback after a WebView reload", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://reload.tailnet.ts.net:8445", "proof");
    writeStoredMobileBackend(backend, storage);
    let reads = 0;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => {
                reads += 1;
                return reads === 1
                  ? new Promise<never>(() => undefined)
                  : Promise.resolve({ credentials: null });
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => Promise.resolve(),
            },
          },
        },
      },
    });

    const boot = prepareNativeMobileBackend();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(boot).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toBe(2);
    expect(window.__t4MobileBackend?.endpointKey).toBe(backend.endpointKey);
  });

  it("returns setup instead of hanging when secure storage never answers", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://silent.tailnet.ts.net:8445", "proof");
    writeStoredMobileBackend(backend, storage);
    let reads = 0;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => {
                reads += 1;
                return new Promise<never>(() => undefined);
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => Promise.resolve(),
            },
          },
        },
      },
    });

    const boot = prepareNativeMobileBackend();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(boot).resolves.toEqual({
      kind: "setup",
      message: "Android secure storage did not answer. Close T4 Code and open it again.",
    });
    expect(reads).toBe(2);
  });

  it("renders setup instead of rejecting when host storage is unavailable", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => {
            throw new Error("Host storage is unavailable.");
          },
        },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({
      kind: "setup",
      message: "Host storage is unavailable.",
    });
  });

  it("stores and removes credentials for exactly the selected host", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    selectStoredMobileBackend(bunker.endpointKey, storage);

    const writes: Array<{
      readonly hostKey: string;
      readonly deviceId: string;
      readonly deviceToken: string;
    }> = [];
    const clears: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { endpointKey: bunker.endpointKey, origin: bunker.origin, profileId: bunker.profileId, wsUrl: bunker.wsUrl, label: bunker.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: (value: {
                readonly hostKey: string;
                readonly deviceId: string;
                readonly deviceToken: string;
              }) => {
                writes.push(value);
                return Promise.resolve();
              },
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await persistNativeMobileCredentials(
      {
        deviceId: "bunker-device",
        deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      bunker.endpointKey,
    );
    expect(writes).toEqual([
      {
        hostKey: bunker.endpointKey,
        deviceId: "bunker-device",
        deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ]);

    await removeNativeMobileBackend(laptop.endpointKey, storage);
    expect(clears).toEqual([laptop.endpointKey, laptop.origin]);
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: bunker.endpointKey,
      backends: [bunker],
    });
    expect(window.__t4MobileBackend?.origin).toBe(bunker.origin);
  });

  it("restores the complete host directory when secure credential removal fails", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    let directoryDuringClear: StoredMobileBackendDirectory | null = null;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { endpointKey: laptop.endpointKey, origin: laptop.origin, profileId: laptop.profileId, wsUrl: laptop.wsUrl, label: laptop.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => {
                directoryDuringClear = readStoredMobileBackendDirectory(storage);
                return Promise.reject(new Error("secure storage failed"));
              },
            },
          },
        },
      },
    });

    await expect(removeNativeMobileBackend(laptop.endpointKey, storage)).rejects.toThrow(
      "secure storage failed",
    );
    expect(directoryDuringClear).toEqual({
      version: 3,
      activeEndpointKey: bunker.endpointKey,
      backends: [bunker],
    });
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 3,
      activeEndpointKey: laptop.endpointKey,
      backends: [bunker, laptop],
    });
    expect(window.__t4MobileBackend?.origin).toBe(laptop.origin);
  });

  it("removing the active host selects a retained host, then removing the last enters setup", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    const clears: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { endpointKey: laptop.endpointKey, origin: laptop.origin, profileId: laptop.profileId, wsUrl: laptop.wsUrl, label: laptop.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: () => Promise.resolve(),
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await removeNativeMobileBackend(laptop.endpointKey, storage);
    expect(readStoredMobileBackend(storage)).toEqual(bunker);
    expect(window.__t4MobileBackend).toBeUndefined();
    await removeNativeMobileBackend(bunker.endpointKey, storage);
    expect(readStoredMobileBackendDirectory(storage)).toBeNull();
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBeNull();
    expect(clears).toEqual([
      laptop.endpointKey,
      laptop.origin,
      bunker.endpointKey,
      bunker.origin,
    ]);
  });

  it("does not clear the active profile when removing another profile on the same origin", async () => {
    const storage = new MemoryStorage();
    const defaultBackend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    const fableBackend = parseTailnetBackend("https://host.tailnet.ts.net:8445", "fable");
    writeStoredMobileBackend(defaultBackend, storage);
    writeStoredMobileBackend(fableBackend, storage);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: {
          endpointKey: fableBackend.endpointKey,
          origin: fableBackend.origin,
          profileId: fableBackend.profileId,
          wsUrl: fableBackend.wsUrl,
          label: fableBackend.label,
        },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => Promise.resolve(),
            },
          },
        },
      },
    });
    await removeNativeMobileBackend(defaultBackend.endpointKey, storage);
    expect(window.__t4MobileBackend?.endpointKey).toBe(fableBackend.endpointKey);
  });

  it("probes the exact WSS endpoint before saving", async () => {
    class OpeningSocket {
      static url = "";
      readonly listeners = new Map<string, Set<() => void>>();
      constructor(url: string | URL) {
        OpeningSocket.url = String(url);
        queueMicrotask(() => this.emit("open"));
      }
      addEventListener(name: string, listener: () => void): void {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }
      removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
      close(): void {}
      private emit(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener(); }
    }
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    await expect(probeMobileBackend(backend, { WebSocketImpl: OpeningSocket as unknown as typeof WebSocket })).resolves.toBeUndefined();
    expect(OpeningSocket.url).toBe(backend.wsUrl);
  });

  it("aborts an in-flight probe and closes its socket", async () => {
    class HangingSocket {
      static instance: HangingSocket | undefined;
      readonly listeners = new Map<string, Set<() => void>>();
      closed = false;
      constructor() {
        HangingSocket.instance = this;
      }
      addEventListener(name: string, listener: () => void): void {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }
      removeEventListener(name: string, listener: () => void): void {
        this.listeners.get(name)?.delete(listener);
      }
      close(): void {
        this.closed = true;
      }
    }
    const controller = new AbortController();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    const probe = probeMobileBackend(backend, {
      signal: controller.signal,
      WebSocketImpl: HangingSocket as unknown as typeof WebSocket,
    });

    controller.abort();

    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
    expect(HangingSocket.instance?.closed).toBe(true);
  });

  it("renders focused first-run instructions instead of fixture sessions", () => {
    const markup = renderToStaticMarkup(<MobileConnectionScreen />);
    expect(markup).toContain("Connect to your T4 host");
    expect(markup).toContain("Open Tailscale on this phone");
    expect(markup).toContain("h-12 w-full");
    expect(markup).not.toContain("Sample data");
  });
});
