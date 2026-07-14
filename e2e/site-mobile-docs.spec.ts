import { createServer, type Server } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE_DIST = resolve(REPO_ROOT, "apps/site/dist");
const TOPICS = [
  "install",
  "first-run",
  "local-sessions",
  "remote-pairing",
  "agents",
  "terminals-files-review",
  "session-controls",
  "settings-model-roles",
  "keyboard-shortcuts",
  "troubleshooting",
  "security",
  "build-from-source",
] as const;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class BuiltSiteServer {
  private readonly server: Server;
  private port = 0;

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? "/", request.method ?? "GET")
        .then(({ body, contentType, status }) => {
          response.writeHead(status, {
            "cache-control": "no-store",
            "content-type": contentType,
            "x-content-type-options": "nosniff",
          });
          response.end(request.method === "HEAD" ? undefined : body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : "site server failed");
        });
    });
  }

  get url(): string {
    if (this.port === 0) throw new Error("site server is not running");
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await access(resolve(SITE_DIST, "docs/index.html"));
    await new Promise<void>((resolveStart, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolveStart();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.port === 0) return;
    await new Promise<void>((resolveStop) => this.server.close(() => resolveStop()));
    this.port = 0;
  }

  private async handle(
    rawUrl: string,
    method: string,
  ): Promise<{ body: Buffer | string; contentType: string; status: number }> {
    if (method !== "GET" && method !== "HEAD") {
      return { body: "method not allowed", contentType: "text/plain; charset=utf-8", status: 405 };
    }

    const pathname = decodeURIComponent(new URL(rawUrl, "http://site.invalid").pathname);
    const relativePath =
      pathname === "/" || pathname === "/index.html"
        ? "index.html"
        : pathname === "/docs" || pathname === "/docs/"
          ? "docs/index.html"
          : pathname.replace(/^\/+/, "");
    const candidate = resolve(SITE_DIST, relativePath);
    if (candidate !== SITE_DIST && !candidate.startsWith(`${SITE_DIST}${sep}`)) {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }

    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file");
      return {
        body: await readFile(candidate),
        contentType: MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
        status: 200,
      };
    } catch {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }
  }
}

let site: BuiltSiteServer;

test.use({ viewport: { width: 320, height: 568 } });

test.beforeAll(async () => {
  site = new BuiltSiteServer();
  await site.start();
});

test.afterAll(async () => {
  await site?.stop();
});

test("offers the Android APK without hiding desktop downloads", async ({ page }) => {
  await page.goto(`${site.url}/`, { waitUntil: "networkidle" });

  const androidDownload = page.getByRole("link", { name: "Download Android APK" }).first();
  await expect(androidDownload).toBeVisible();
  await expect(androidDownload).toHaveAttribute(
    "href",
    "https://github.com/LycaonLLC/t4-code/releases/download/v0.1.12/T4-Code-0.1.12-android.apk",
  );
  await expect(page.getByRole("link", { name: "Download for Linux" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "macOS build" }).first()).toBeVisible();
  await expect(page.getByText("TestFlight coming soon", { exact: true }).first()).toBeVisible();

  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(geometry).toEqual({
    clientWidth: 320,
    documentScrollWidth: 320,
    bodyScrollWidth: 320,
  });
});

test("every docs topic stays inside a 320px viewport", async ({ page }) => {
  for (const topic of TOPICS) {
    await page.goto(`${site.url}/docs/#${topic}`, { waitUntil: "networkidle" });
    await expect(page.locator("#doc-article > article > h1")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(geometry, `horizontal overflow at #${topic}`).toEqual({
      clientWidth: 320,
      documentScrollWidth: 320,
      bodyScrollWidth: 320,
    });
  }
});

test("wide docs content scrolls inside its own container", async ({ page }) => {
  await page.goto(`${site.url}/docs/#install`, { waitUntil: "networkidle" });
  const codeBlocks = await page.locator("pre.code").evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    })),
  );
  expect(codeBlocks.length).toBeGreaterThan(0);
  expect(codeBlocks.every((block) => block.overflowX === "auto")).toBe(true);
  expect(codeBlocks.some((block) => block.scrollWidth > block.clientWidth)).toBe(true);

  await page.goto(`${site.url}/docs/#keyboard-shortcuts`, { waitUntil: "networkidle" });
  const tables = await page.locator(".table-scroll").evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    })),
  );
  expect(tables.length).toBeGreaterThan(0);
  expect(tables.every((table) => table.overflowX === "auto")).toBe(true);
  expect(tables.some((table) => table.scrollWidth > table.clientWidth)).toBe(true);
  const pageWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBe(pageWidth.client);
});
