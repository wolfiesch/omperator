import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  isHostedBrowserRuntime,
  isIosInstallDevice,
  isStandaloneWebApp,
} from "../src/components/HostedAppAction.tsx";

describe("installable hosted app", () => {
  it("publishes a portable standalone manifest with phone-sized icons", () => {
    const manifestPath = join(import.meta.dirname, "../public/manifest.webmanifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      id: string;
      name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ sizes: string; src: string }>;
    };

    expect(manifest).toMatchObject({
      id: "./",
      name: "T4 Code",
      start_url: "./",
      scope: "./",
      display: "standalone",
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      const png = readFileSync(join(import.meta.dirname, "../public", icon.src));
      const expectedSize = Number.parseInt(icon.sizes, 10);
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(expectedSize);
      expect(png.readUInt32BE(20)).toBe(expectedSize);
    }
  });

  it("links the install metadata from the web entry point", () => {
    const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
    expect(html).toContain('rel="manifest" href="./manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="./icons/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
  });

  it("recognizes current iPhone and iPad browser identities", () => {
    expect(isIosInstallDevice("Mozilla/5.0 (iPhone)", "iPhone", 5)).toBe(true);
    expect(isIosInstallDevice("Mozilla/5.0 (Macintosh)", "MacIntel", 5)).toBe(true);
    expect(isIosInstallDevice("Mozilla/5.0 (Linux; Android 15)", "Linux armv8l", 5)).toBe(false);
  });

  it("only offers hosted actions in the browser-direct runtime", () => {
    expect(isHostedBrowserRuntime(true, false, true)).toBe(true);
    expect(isHostedBrowserRuntime(true, true, true)).toBe(false);
    expect(isHostedBrowserRuntime(false, false, true)).toBe(false);
    expect(isHostedBrowserRuntime(true, false, false)).toBe(false);
    expect(isStandaloneWebApp(false, false)).toBe(false);
    expect(isStandaloneWebApp(true, false)).toBe(true);
    expect(isStandaloneWebApp(false, true)).toBe(true);
  });
});
