import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MobileConnectionScreen } from "../src/components/MobileConnectionScreen.tsx";
import {
  clearNativeMobileConnection,
  MOBILE_BACKEND_STORAGE_KEY,
  parseTailnetBackend,
  prepareNativeMobileBackend,
  probeMobileBackend,
  readStoredMobileBackend,
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
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("native mobile connection", () => {
  it("normalizes a full Tailnet HTTPS origin and rejects unsafe addresses", () => {
    expect(parseTailnetBackend("lycaon-bunker.tail9f9e1a.ts.net:8445")).toEqual({
      version: 1,
      origin: "https://lycaon-bunker.tail9f9e1a.ts.net:8445",
      wsUrl: "wss://lycaon-bunker.tail9f9e1a.ts.net:8445/v1/ws",
      label: "T4 on lycaon-bunker",
    });
    expect(() => parseTailnetBackend("http://host.tailnet.ts.net")).toThrow(/HTTPS/u);
    expect(() => parseTailnetBackend("https://example.com")).toThrow(/\.ts\.net/u);
    expect(() => parseTailnetBackend("https://host.tailnet.ts.net/admin")).toThrow(/host address only/u);
    expect(() => parseTailnetBackend("https://user:pass@host.tailnet.ts.net")).toThrow(/credentials/u);
  });

  it("round-trips only validated nonsecret host configuration", () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    writeStoredMobileBackend(backend, storage);
    expect(readStoredMobileBackend(storage)).toEqual(backend);

    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify({ ...backend, wsUrl: "wss://evil.example/v1/ws" }));
    expect(() => readStoredMobileBackend(storage)).toThrow(/inconsistent/u);
  });

  it("loads paired credentials from the native security bridge before app boot", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    writeStoredMobileBackend(backend, storage);
    const clearCredentials = () => Promise.resolve();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {} } } });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({
                credentials: {
                  deviceId: "android-device",
                  deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              }),
              setCredentials: () => Promise.resolve(),
              clearCredentials,
            },
          },
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(window.__t4MobileBackend).toEqual({
      wsUrl: backend.wsUrl,
      label: backend.label,
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    await clearNativeMobileConnection();
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBeNull();
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

  it("renders focused first-run instructions instead of fixture sessions", () => {
    const markup = renderToStaticMarkup(<MobileConnectionScreen />);
    expect(markup).toContain("Connect to your T4 host");
    expect(markup).toContain("Open Tailscale on this phone");
    expect(markup).toContain("h-12 w-full");
    expect(markup).not.toContain("Sample data");
  });
});
