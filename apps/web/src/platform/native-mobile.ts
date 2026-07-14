import { deviceToken as validateDeviceToken } from "@t4-code/protocol";

export const MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backend:v1";

const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 128;

export type NativeMobilePlatform = "android" | "ios";

export interface StoredMobileBackend {
  readonly version: 1;
  readonly origin: string;
  readonly wsUrl: string;
  readonly label: string;
}

export interface NativeMobileBackendConfig {
  readonly wsUrl: string;
  readonly label: string;
  readonly deviceId?: string;
  readonly deviceToken?: string;
}

interface T4SecureStoragePlugin {
  getCredentials(): Promise<{
    readonly credentials: { readonly deviceId: string; readonly deviceToken: string } | null;
  }>;
  setCredentials(options: { readonly deviceId: string; readonly deviceToken: string }): Promise<void>;
  clearCredentials(): Promise<void>;
}

interface CapacitorBridge {
  readonly Plugins?: { readonly T4SecureStorage?: T4SecureStoragePlugin };
  readonly getPlatform?: () => string;
  readonly isNativePlatform?: () => boolean;
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
    __t4MobileBackend?: NativeMobileBackendConfig;
  }
}

export type MobileBootResult =
  | { readonly kind: "web" }
  | { readonly kind: "ready"; readonly backend: StoredMobileBackend }
  | { readonly kind: "setup"; readonly message?: string };

function secureStorage(): T4SecureStoragePlugin | null {
  return window.Capacitor?.Plugins?.T4SecureStorage ?? null;
}

export function nativeMobilePlatform(): NativeMobilePlatform | null {
  if (typeof window === "undefined") return null;
  const bridge = window.Capacitor;
  if (bridge?.isNativePlatform?.() !== true) return null;
  const platform = bridge.getPlatform?.();
  return platform === "android" || platform === "ios" ? platform : null;
}

function requiredLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    throw new Error("The saved host label is invalid.");
  }
  return value;
}

export function parseTailnetBackend(value: string): StoredMobileBackend {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Enter the HTTPS address shown by T4 Code on your computer.");
  if (trimmed.length > MAX_URL_LENGTH) throw new Error("That address is too long.");

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTPS Tailnet address.");
  }
  if (parsed.protocol !== "https:") throw new Error("Use the HTTPS Tailnet address, not HTTP.");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("The address cannot contain credentials.");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Enter the host address only, without a path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "ts.net" || !hostname.endsWith(".ts.net")) {
    throw new Error("Use the full Tailscale hostname ending in .ts.net.");
  }

  const origin = parsed.origin;
  const websocket = new URL(origin);
  websocket.protocol = "wss:";
  websocket.pathname = "/v1/ws";
  const deviceName = hostname.slice(0, hostname.indexOf("."));
  return {
    version: 1,
    origin,
    wsUrl: websocket.toString(),
    label: requiredLabel(`T4 on ${deviceName}`),
  };
}

export function readStoredMobileBackend(storage: Pick<Storage, "getItem"> = window.localStorage): StoredMobileBackend | null {
  const raw = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved host address is damaged. Enter it again.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved host address is damaged. Enter it again.");
  }
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.origin !== "string") {
    throw new Error("The saved host address is from an unsupported app version.");
  }
  const parsed = parseTailnetBackend(data.origin);
  if (data.wsUrl !== parsed.wsUrl || data.label !== parsed.label) {
    throw new Error("The saved host address is inconsistent. Enter it again.");
  }
  return parsed;
}

export function writeStoredMobileBackend(
  backend: StoredMobileBackend,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(backend));
}

export function currentNativeMobileBackend(): NativeMobileBackendConfig | null {
  if (typeof window === "undefined") return null;
  return window.__t4MobileBackend ?? null;
}

export async function prepareNativeMobileBackend(): Promise<MobileBootResult> {
  const platform = nativeMobilePlatform();
  if (platform === null) return { kind: "web" };
  document.documentElement.dataset.platform = platform;

  let backend: StoredMobileBackend | null;
  try {
    backend = readStoredMobileBackend();
  } catch (error) {
    return { kind: "setup", message: error instanceof Error ? error.message : "Enter the host address again." };
  }
  if (backend === null) return { kind: "setup" };

  const plugin = secureStorage();
  if (plugin === null) {
    return { kind: "setup", message: "The Android security bridge did not start. Close T4 Code and open it again." };
  }

  let credentials: { readonly deviceId: string; readonly deviceToken: string } | null = null;
  try {
    const result = await plugin.getCredentials();
    if (result.credentials !== null) {
      const deviceId = result.credentials.deviceId;
      if (deviceId.length === 0 || deviceId.length > 256) throw new Error("invalid device id");
      credentials = { deviceId, deviceToken: validateDeviceToken(result.credentials.deviceToken, "deviceToken") };
    }
  } catch {
    await plugin.clearCredentials().catch(() => undefined);
  }

  window.__t4MobileBackend = {
    wsUrl: backend.wsUrl,
    label: backend.label,
    ...(credentials === null ? {} : credentials),
  };
  return { kind: "ready", backend };
}

export async function persistNativeMobileCredentials(credentials: {
  readonly deviceId: string;
  readonly deviceToken: string;
}): Promise<void> {
  if (nativeMobilePlatform() === null) return;
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");
  await plugin.setCredentials({
    deviceId: credentials.deviceId,
    deviceToken: validateDeviceToken(credentials.deviceToken, "deviceToken"),
  });
}

export async function clearNativeMobileConnection(): Promise<void> {
  const plugin = secureStorage();
  if (plugin !== null) await plugin.clearCredentials();
  window.localStorage.removeItem(MOBILE_BACKEND_STORAGE_KEY);
  delete window.__t4MobileBackend;
}

export async function probeMobileBackend(
  backend: StoredMobileBackend,
  options: { readonly timeoutMs?: number; readonly WebSocketImpl?: typeof WebSocket } = {},
): Promise<void> {
  const WebSocketImpl = options.WebSocketImpl ?? window.WebSocket;
  const timeoutMs = options.timeoutMs ?? 8_000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocketImpl(backend.wsUrl);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = () => {
      finish();
      socket.close(1000, "T4 mobile connection check");
    };
    const onError = () => finish(new Error("T4 Code could not reach that host. Check Tailscale and the address."));
    const onClose = () => finish(new Error("The host closed the connection before T4 Code could start."));
    const timer = setTimeout(() => {
      socket.close();
      finish(new Error("The host did not answer. Check that Tailscale and the T4 gateway are running."));
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}
