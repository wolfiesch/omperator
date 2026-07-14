import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, isTrustedNavigation, rendererUrl, trustedSender, validateDevelopmentRendererUrl } from "../src/security.ts";
import { contentSecurityPolicy as duplicateContentSecurityPolicy } from "../src/security-policy.ts";
import type { BrowserWindow, WebContents, WebFrameMain } from "electron";
import { localSocketPath } from "../src/socket-path.ts";
import { parsePairDeepLink } from "../src/deep-link.ts";
describe("desktop security boundaries", () => {
  it("only accepts validated loopback development origins", () => {
    expect(validateDevelopmentRendererUrl("http://127.0.0.1:5173/")?.origin).toBe("http://127.0.0.1:5173");
    expect(validateDevelopmentRendererUrl("https://evil.example/")).toBeNull();
    expect(validateDevelopmentRendererUrl("http://127.0.0.1:5173/?token=secret")).toBeNull();
  });
  it("adds only the exact dev websocket origin and never relaxes packaged CSP", () => {
    const trusted = rendererUrl({ isPackaged: false, devUrl: "http://127.0.0.1:5173/", webRoot: "/tmp/web" });
    const development = contentSecurityPolicy(trusted, true);
    expect(development).toContain("connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173");
    expect(development).not.toContain("*");
    expect(development).not.toContain("ws://127.0.0.1:5174");

    const secure = { origin: "https://127.0.0.1:5173", url: "https://127.0.0.1:5173/" };
    expect(contentSecurityPolicy(secure, true)).toContain("wss://127.0.0.1:5173");
    expect(contentSecurityPolicy(trusted, false)).toContain("connect-src 'none'");
    expect(contentSecurityPolicy(trusted, false)).not.toContain("ws://127.0.0.1:5173");
    for (const policy of [development, contentSecurityPolicy(trusted, false)]) {
      expect(policy).toContain("font-src 'self' data:");
      expect(policy).toContain("img-src 'self' data: blob:");
    }
    const production = contentSecurityPolicy(trusted, false);
    expect(production).toContain("script-src 'self'");
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(production).toContain("connect-src 'none'");

    const duplicateDevelopment = duplicateContentSecurityPolicy({ origin: trusted.origin, url: trusted.url }, true);
    const duplicateProduction = duplicateContentSecurityPolicy({ origin: trusted.origin, url: trusted.url }, false);
    expect(duplicateDevelopment).toContain("font-src 'self' data:");
    expect(duplicateProduction).toContain("font-src 'self' data:");
    expect(duplicateDevelopment).toContain("img-src 'self' data: blob:");
    expect(duplicateProduction).toContain("img-src 'self' data: blob:");
    expect(duplicateProduction).toContain("script-src 'self'");
    expect(duplicateProduction).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(duplicateProduction).toContain("connect-src 'none'");
    expect(isTrustedNavigation(trusted.url, trusted)).toBe(true);
    expect(isTrustedNavigation("http://127.0.0.1:5174/", trusted)).toBe(false);
  });

  it("allows bounded hash routes on the trusted document only", () => {
    const trusted = rendererUrl({ isPackaged: false, devUrl: "http://127.0.0.1:5173/", webRoot: "/tmp/web" });
    expect(isTrustedNavigation(`${trusted.url}#/sessions/abc`, trusted)).toBe(true);
    expect(isTrustedNavigation(`${trusted.url}#${"x".repeat(2047)}`, trusted)).toBe(true);
    expect(isTrustedNavigation(`${trusted.url}#${"x".repeat(2048)}`, trusted)).toBe(false);
    expect(isTrustedNavigation("http://127.0.0.1:5173/other#/sessions", trusted)).toBe(false);
    expect(isTrustedNavigation("http://127.0.0.1:5173/?other=1#/sessions", trusted)).toBe(false);
    expect(isTrustedNavigation("https://127.0.0.1:5173/#/sessions", trusted)).toBe(false);

    const frame = { url: `${trusted.url}#/sessions/abc` } as unknown as WebFrameMain;
    const contents = { mainFrame: frame } as unknown as WebContents;
    const window = { webContents: contents } as unknown as BrowserWindow;
    expect(trustedSender(contents, window, trusted, frame)).toBe(true);

    const changedFrame = { url: "http://127.0.0.1:5173/other#/sessions/abc" } as unknown as WebFrameMain;
    const changedContents = { mainFrame: changedFrame } as unknown as WebContents;
    const changedWindow = { webContents: changedContents } as unknown as BrowserWindow;
    expect(trustedSender(changedContents, changedWindow, trusted, changedFrame)).toBe(false);

    const packaged = rendererUrl({ isPackaged: true, webRoot: "/tmp/web" });
    expect(isTrustedNavigation(`${packaged.url}#/sessions/abc`, packaged)).toBe(true);
    expect(isTrustedNavigation(`${packaged.url}/other#/sessions`, packaged)).toBe(false);
  });
  it("uses only approved local socket locations and strips deep-link secrets", () => {
    expect(localSocketPath({ platform: "linux", runtimeDirectory: "/run/user/1000" })).toBe("/run/user/1000/omp/appserver.sock");
    expect(localSocketPath({ platform: "darwin", homeDirectory: "/Users/test" })).toBe("/Users/test/.omp/run/appserver.sock");
    const link = parsePairDeepLink("t4-code://pair/host-a/123456");
    expect(link === null ? null : { hostHint: link.hostHint, code: link.code }).toEqual({ hostHint: "host-a", code: "123456" });
    expect(link === null ? undefined : typeof link.issuedAt).toBe("number");
    expect(parsePairDeepLink("t4-code://pair/host-a/12345")).toBeNull();
  });
  it("rejects public, encoded, and credential-bearing deep links", () => {
    expect(parsePairDeepLink("t4-code://user:pass@pair/host-a/123456")).toBeNull();
    expect(parsePairDeepLink("t4-code://pair/host-a/123456?token=secret")).toBeNull();
    expect(parsePairDeepLink("t4-code://pair/host%00a/123456")).toBeNull();
  });
  it("rejects unsafe runtime socket fallbacks", () => {
    expect(() => localSocketPath({ platform: "linux", runtimeDirectory: "relative" })).toThrow();
    expect(() => localSocketPath({ platform: "win32" })).toThrow();
  });
});
