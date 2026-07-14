import { URL, pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import type { BrowserWindow, Session, WebContents, WebFrameMain } from "electron";

export interface TrustedRenderer {
  readonly origin: string;
  readonly url: string;
}

function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function validateDevelopmentRendererUrl(value: string | undefined): URL | null {
  if (value === undefined || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHost(url.hostname) || url.username || url.password || url.search || url.hash) return null;
  return url;
}

export function rendererUrl(options: { readonly isPackaged: boolean; readonly devUrl?: string | undefined; readonly webRoot: string }): TrustedRenderer {
  if (!options.isPackaged) {
    const dev = validateDevelopmentRendererUrl(options.devUrl);
    if (dev !== null) return { origin: dev.origin, url: dev.toString() };
  }
  const index = join(options.webRoot, "index.html");
  const url = pathToFileURL(index).toString();
  return { origin: "file://", url };
}

const MAX_TRUSTED_HASH_LENGTH = 2048;

function canonicalDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hash.length > MAX_TRUSTED_HASH_LENGTH) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isTrustedDocument(value: string, trusted: TrustedRenderer): boolean {
  const current = canonicalDocumentUrl(value);
  const expected = canonicalDocumentUrl(trusted.url);
  return current !== null && expected !== null && current === expected;
}

export function trustedSender(contents: WebContents, window: BrowserWindow, trusted: TrustedRenderer, senderFrame?: WebFrameMain | null): boolean {
  if (contents !== window.webContents || senderFrame == null || senderFrame !== contents.mainFrame) return false;
  return isTrustedDocument(senderFrame.url, trusted);
}
export function websocketOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(trusted: TrustedRenderer, development: boolean): string {
  const script = development ? "'self' 'unsafe-inline'" : "'self'";
  const websocket = development ? websocketOrigin(trusted.origin) : null;
  const connect = development
    ? `connect-src ${[trusted.origin, websocket].filter((origin): origin is string => origin !== null).join(" ")}`
    : "connect-src 'none'";
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    connect,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function installSecurityPolicy(targetSession: Session, trusted: TrustedRenderer, development: boolean): void {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders, "Content-Security-Policy": [contentSecurityPolicy(trusted, development)] };
    callback({ responseHeaders: headers });
  });
}

export function installNavigationGuards(window: BrowserWindow, trusted: TrustedRenderer): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedNavigation(url, trusted)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.on("will-download", (event) => event.preventDefault());
}
export function isTrustedNavigation(value: string, trusted: TrustedRenderer): boolean {
  return isTrustedDocument(value, trusted);
}

export function assertSecureRuntimeDirectory(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error("runtime directory must be absolute");
  return value;
}

export function installSessionSecurity(targetSession: Session, trusted: TrustedRenderer, development: boolean): void {
  installSecurityPolicy(targetSession, trusted, development);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
}

