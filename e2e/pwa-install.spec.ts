import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIST = resolve(REPO_ROOT, "apps/web/dist");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function injectBackend(html: string): string {
  const payload = JSON.stringify({
    wsUrl: "ws://127.0.0.1:1/v1/ws",
    label: "PWA fixture backend",
  });
  const tag = `<script id="t4-backend" type="application/json">${payload}</script>`;
  if (!html.includes("</head>")) throw new Error("web dist index is missing </head>");
  return html.replace("</head>", `${tag}</head>`);
}

class BuiltPwaServer {
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
          response.end(error instanceof Error ? error.message : "fixture web server failed");
        });
    });
  }

  get url(): string {
    if (this.port === 0) throw new Error("fixture web server is not running");
    return `http://127.0.0.1:${this.port}/`;
  }

  async start(): Promise<void> {
    await access(resolve(WEB_DIST, "index.html"));
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolveStart();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
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
    const pathname = decodeURIComponent(new URL(rawUrl, "http://fixture.invalid").pathname);
    if (pathname === "/" || pathname === "/index.html") {
      return {
        body: injectBackend(await readFile(resolve(WEB_DIST, "index.html"), "utf8")),
        contentType: MIME_TYPES[".html"]!,
        status: 200,
      };
    }

    const candidate = resolve(WEB_DIST, `.${pathname}`);
    if (!candidate.startsWith(`${WEB_DIST}${sep}`)) {
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

let web: BuiltPwaServer;

test.beforeAll(async () => {
  web = new BuiltPwaServer();
  await web.start();
});

test.afterAll(async () => {
  await web?.stop();
});

test("installs from the hosted-client titlebar without overflowing a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(web.url, { waitUntil: "domcontentloaded" });

  const install = page.getByRole("button", { name: "Install T4 Code", exact: true });
  await expect(install).toBeVisible();
  await expect(install).toHaveCSS("width", "44px");
  const titlebarFits = await page.locator("header").evaluate((header) => {
    const bounds = header.getBoundingClientRect();
    return (
      header.scrollWidth <= header.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth
    );
  });
  expect(titlebarFits).toBe(true);

  await install.click();
  await expect(
    page.getByText("Open the browser menu, then choose Install app or Add to Home screen."),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const state = { promptCalls: 0 };
    Object.assign(globalThis, { __t4InstallPromptState: state });
    const promptEvent = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(promptEvent, {
      prompt: async () => {
        state.promptCalls += 1;
      },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(promptEvent);
  });
  await install.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __t4InstallPromptState: { promptCalls: number };
            }
          ).__t4InstallPromptState.promptCalls,
      ),
    )
    .toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByRole("button", { name: "Install T4 Code", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reload T4 Code", exact: true })).toHaveCount(0);
});

test("offers reload only from an installed standalone launch", async ({ page }) => {
  await page.addInitScript(() => {
    const browserMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)") return browserMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      } as MediaQueryList;
    };
  });
  await page.goto(web.url, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Reload T4 Code", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install T4 Code", exact: true })).toHaveCount(0);
});

test("serves a browser-readable standalone manifest", async ({ page }) => {
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  const manifestUrl = new URL("manifest.webmanifest", web.url).toString();
  const response = await page.request.get(manifestUrl);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("application/manifest+json; charset=utf-8");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "./manifest.webmanifest",
  );
  expect(await response.json()).toMatchObject({
    id: "./",
    name: "T4 Code",
    start_url: "./",
    scope: "./",
    display: "standalone",
  });
});
