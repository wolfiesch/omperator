import { join } from "node:path";
import { URL, pathToFileURL } from "node:url";

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
  if (url.protocol !== "http:" || !loopbackHost(url.hostname) || url.username || url.password || url.search || url.hash) return null;
  return url;
}

export function rendererUrl(options: { readonly isPackaged: boolean; readonly devUrl?: string | undefined; readonly webRoot: string }): TrustedRenderer {
  if (!options.isPackaged) {
    const dev = validateDevelopmentRendererUrl(options.devUrl);
    if (dev !== null) return { origin: dev.origin, url: dev.toString() };
  }
  const url = pathToFileURL(join(options.webRoot, "index.html")).toString();
  return { origin: "file://", url };
}

export function contentSecurityPolicy(trusted: TrustedRenderer, development: boolean): string {
  const script = development ? "'self' 'unsafe-inline'" : "'self'";
  const connect = development ? `connect-src ${trusted.origin}` : "connect-src 'none'";
  return ["default-src 'self'", `script-src ${script}`, "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "img-src 'self' data: blob:", connect, "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'"].join("; ");
}

export function isTrustedNavigation(value: string, trusted: TrustedRenderer): boolean {
  if (trusted.origin === "file://") return value === trusted.url;
  try {
    const url = new URL(value);
    return url.origin === trusted.origin && url.href === trusted.url;
  } catch {
    return false;
  }
}
