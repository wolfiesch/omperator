import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import type { SessionRef } from "@t4-code/protocol";
import {
  MOBILE_BACKEND_STORAGE_KEY,
  parseTailnetBackend,
} from "../apps/web/src/platform/native-mobile-backend.ts";
import type { ScenarioId } from "../packages/fixture-server/src/index.ts";
import { installColdMountObserver, readColdMountSamples } from "./cold-mount-observer.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIST = resolve(REPO_ROOT, "apps/web/dist");
const JITI = resolve(
  REPO_ROOT,
  "node_modules/.bin",
  process.platform === "win32" ? "jiti.cmd" : "jiti",
);
const FIXTURE_PROCESS = resolve(REPO_ROOT, "e2e/fixture-process.ts");
const SESSION_VIEW_ID = "host-stream/session-stream";
const SESSION_TITLE = "stream-v1 fixture";
// Chromium can report an exact 44 CSS px box a few floating-point ulps below 44.
const MIN_TOUCH_TARGET_PX = 43.99;
const CONNECTED_COPY =
  "This Tailnet connection is live. Choose a session from the list on the left to inspect it.";
const DEFAULT_MOBILE_BACKEND = parseTailnetBackend("https://fixture.tailnet.ts.net");
const PROFILE_MOBILE_BACKEND = parseTailnetBackend(
  "https://fixture.tailnet.ts.net",
  "fable-swarm",
);

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function injectBackend(html: string, wsUrl: string): string {
  const payload = JSON.stringify({ wsUrl, label: "Fixture backend" }).replaceAll("<", "\\u003c");
  const tag = `<script id="t4-backend" type="application/json">${payload}</script>`;
  if (!html.includes("</head>")) throw new Error("web dist index is missing </head>");
  return html.replace("</head>", `${tag}</head>`);
}

class BuiltWebServer {
  private readonly server: Server;
  private port = 0;

  constructor(private readonly wsUrl: string) {
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
    if (pathname === "/favicon.ico") {
      return { body: Buffer.alloc(0), contentType: "image/x-icon", status: 204 };
    }
    if (pathname === "/" || pathname === "/index.html") {
      const index = await readFile(resolve(WEB_DIST, "index.html"), "utf8");
      return {
        body: injectBackend(index, this.wsUrl),
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

class FixtureProcess {
  private child: ChildProcess | null = null;
  private controlUrl = "";
  wsUrl = "";

  constructor(private readonly scenario: ScenarioId = "stream-v1") {}

  async start(): Promise<void> {
    await access(JITI);
    const child = spawn(JITI, [FIXTURE_PROCESS], {
      cwd: REPO_ROOT,
      env: { ...process.env, T4_FIXTURE_SCENARIO: this.scenario },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null)
      throw new Error("fixture process pipes are unavailable");

    let output = "";
    let errors = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    await new Promise<void>((resolveStart, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`fixture process did not start\n${errors}`));
      }, 10_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new Error(`fixture process exited before ready (${code ?? signal})\n${errors}`));
      };
      child.once("error", fail);
      child.once("exit", onExit);
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        output += chunk;
        const line = output
          .split("\n")
          .find((candidate) => candidate.startsWith("T4_FIXTURE_READY "));
        if (line === undefined) return;
        try {
          const ready = JSON.parse(line.slice("T4_FIXTURE_READY ".length)) as {
            wsUrl: string;
            controlUrl: string;
          };
          this.wsUrl = ready.wsUrl;
          this.controlUrl = ready.controlUrl;
          clearTimeout(timeout);
          child.off("error", fail);
          child.off("exit", onExit);
          resolveStart();
        } catch (error) {
          fail(error instanceof Error ? error : new Error("invalid fixture ready line"));
        }
      });
    });
  }

  async advanceBy(ms: number): Promise<void> {
    const response = await fetch(`${this.controlUrl}/advance?ms=${ms}`, { method: "POST" });
    if (!response.ok) throw new Error(`fixture advance failed: ${response.status}`);
  }

  async state(): Promise<{
    readonly scenario: ScenarioId;
    readonly sessions: readonly SessionRef[];
    readonly clients: number;
    readonly connections: number;
  }> {
    const response = await fetch(`${this.controlUrl}/state`);
    if (!response.ok) throw new Error(`fixture state failed: ${response.status}`);
    return (await response.json()) as {
      readonly scenario: ScenarioId;
      readonly sessions: readonly SessionRef[];
      readonly clients: number;
      readonly connections: number;
    };
  }

  async disconnectClients(): Promise<void> {
    const response = await fetch(`${this.controlUrl}/disconnect`, { method: "POST" });
    if (!response.ok) throw new Error(`fixture disconnect failed: ${response.status}`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolveStop();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
    });
  }
}

let fixture: FixtureProcess;
let profileFixture: FixtureProcess | undefined;
let web: BuiltWebServer;

test.beforeAll(async () => {
  fixture = new FixtureProcess("stream-v1");
  await fixture.start();
  web = new BuiltWebServer(fixture.wsUrl);
  await web.start();
});

test.afterAll(async () => {
  await web?.stop();
  await Promise.all([fixture?.stop(), profileFixture?.stop()]);
});

async function installHeadlessAndroidProfiles(page: Page): Promise<FixtureProcess> {
  const selectedProfileFixture = new FixtureProcess("basic-v1");
  await selectedProfileFixture.start();
  profileFixture = selectedProfileFixture;
  await page.addInitScript(
    ({
      defaultBackend,
      defaultWsUrl,
      mobileBackendStorageKey,
      profileBackend,
      profileWsUrl,
    }) => {
      const NativeWebSocket = window.WebSocket;
      class RoutedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const requested = String(url);
          const routed =
            requested === defaultBackend.wsUrl
              ? defaultWsUrl
              : requested === profileBackend.wsUrl
                ? profileWsUrl
                : requested;
          super(routed, protocols);
        }
      }
      Object.defineProperty(RoutedWebSocket, "CONNECTING", { value: NativeWebSocket.CONNECTING });
      Object.defineProperty(RoutedWebSocket, "OPEN", { value: NativeWebSocket.OPEN });
      Object.defineProperty(RoutedWebSocket, "CLOSING", { value: NativeWebSocket.CLOSING });
      Object.defineProperty(RoutedWebSocket, "CLOSED", { value: NativeWebSocket.CLOSED });
      window.WebSocket = RoutedWebSocket;

      if (window.localStorage.getItem(mobileBackendStorageKey) === null) {
        window.localStorage.setItem(
          mobileBackendStorageKey,
          JSON.stringify({
            version: 3,
            activeEndpointKey: profileBackend.endpointKey,
            backends: [defaultBackend, profileBackend],
          }),
        );
      }
      Object.assign(window, {
        Capacitor: {
          getPlatform: () => "android",
          isNativePlatform: () => true,
          Plugins: {
            T4SecureStorage: {
              getCredentials: async () => ({ credentials: null }),
              setCredentials: async () => undefined,
              clearCredentials: async () => undefined,
            },
          },
        },
      });
    },
    {
      defaultBackend: DEFAULT_MOBILE_BACKEND,
      defaultWsUrl: fixture.wsUrl,
      mobileBackendStorageKey: MOBILE_BACKEND_STORAGE_KEY,
      profileBackend: PROFILE_MOBILE_BACKEND,
      profileWsUrl: selectedProfileFixture.wsUrl,
    },
  );
  return selectedProfileFixture;
}

async function openConnectedRoot(page: Page): Promise<void> {
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  const injectedBackend = page.locator("#t4-backend");
  await expect(injectedBackend).toHaveCount(1);
  const payload = JSON.parse((await injectedBackend.textContent()) ?? "null") as Record<
    string,
    unknown
  >;
  expect(Object.keys(payload).sort()).toEqual(["label", "wsUrl"]);
  expect(payload.label).toBe("Fixture backend");
  expect(payload.wsUrl).toBe(fixture.wsUrl);
}

async function openSession(page: Page, mobile: boolean): Promise<void> {
  await openConnectedRoot(page);
  if (mobile) {
    const toggle = page.getByRole("button", { name: "Show session list", exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("dialog", { name: "Working folders and sessions" })).toBeVisible();
  }

  const session = page.locator(`[data-session-row="${SESSION_VIEW_ID}"]`);
  await expect(session).toBeVisible();
  await expect(session).toHaveAttribute(
    "aria-label",
    new RegExp(`^${SESSION_TITLE}, fixture(?:-model|/model-\\d{3}), Idle$`, "u"),
  );
  await session.click();

  await expect(page).toHaveURL(/#\/sessions\//u);
  await expect(page.getByRole("log", { name: "Transcript" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
  await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cached", { exact: true })).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });
test("routes mobile session creation to the selected profile and preserves both profiles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const selectedProfileFixture = await installHeadlessAndroidProfiles(page);

  const [defaultBefore, profileBefore] = await Promise.all([
    fixture.state(),
    selectedProfileFixture.state(),
  ]);
  expect(defaultBefore.scenario).toBe("stream-v1");
  expect(profileBefore.scenario).toBe("basic-v1");
  expect(defaultBefore.sessions).toHaveLength(1);
  expect(profileBefore.sessions).toHaveLength(1);

  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show session list", exact: true }).click();
  let rail = page.getByRole("dialog", { name: "Working folders and sessions" });
  await expect(rail.locator('[data-session-row="host-basic/session-basic"]')).toBeVisible();
  await expect(rail.locator(`[data-session-row="${SESSION_VIEW_ID}"]`)).toHaveCount(0);

  await rail.getByRole("button", { name: /^New session in /u }).click();
  await expect(page).toHaveURL(/#\/sessions\//u);
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
  const createdViewId = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/sessions\//u, ""));
  expect(createdViewId).not.toBe("host-basic/session-basic");

  await expect
    .poll(async () => (await selectedProfileFixture.state()).sessions.length)
    .toBe(profileBefore.sessions.length + 1);
  expect((await fixture.state()).sessions).toHaveLength(defaultBefore.sessions.length);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
  await page.getByRole("button", { name: "Show session list", exact: true }).click();
  rail = page.getByRole("dialog", { name: "Working folders and sessions" });
  await expect(rail.locator(`[data-session-row="${createdViewId}"]`)).toBeVisible();

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "T4 hosts", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "T4 hosts" });
  const profileItem = manager.getByRole("listitem").filter({ hasText: "Profile · fable-swarm" });
  await expect(profileItem.getByText("Current", { exact: true })).toBeVisible();
  const defaultItem = manager.getByRole("listitem").filter({ hasText: "Default profile" });
  await defaultItem.getByRole("button", { name: "Switch", exact: true }).click();

  await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show session list", exact: true }).click();
  rail = page.getByRole("dialog", { name: "Working folders and sessions" });
  await expect(rail.locator(`[data-session-row="${SESSION_VIEW_ID}"]`)).toBeVisible();
  await expect(rail.locator('[data-session-row="host-basic/session-basic"]')).toHaveCount(0);
  await expect(rail.locator(`[data-session-row="${createdViewId}"]`)).toHaveCount(0);

  const storedDirectory = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null
      ? null
      : (JSON.parse(raw) as { activeEndpointKey: string; backends: unknown[] });
  }, MOBILE_BACKEND_STORAGE_KEY);
  expect(storedDirectory?.activeEndpointKey).toBe(DEFAULT_MOBILE_BACKEND.endpointKey);
  expect(storedDirectory?.backends).toHaveLength(2);
  expect((await selectedProfileFixture.state()).sessions).toHaveLength(
    profileBefore.sessions.length + 1,
  );
});

test("@soak mounts the bounded tail of a 10k history on a phone viewport", async ({ page }) => {
  test.setTimeout(120_000);
  const mountStartedAt = performance.now();
  const historyFixture = new FixtureProcess("history-10k-v1");
  let historyWeb: BuiltWebServer | undefined;
  try {
    await historyFixture.start();
    historyWeb = new BuiltWebServer(historyFixture.wsUrl);
    await historyWeb.start();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(historyWeb.url, { waitUntil: "domcontentloaded" });
    const navigationTiming = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      return { domContentLoaded: navigation?.domContentLoadedEventEnd ?? 0 };
    });
    const connectedHandle = await page.waitForFunction(
      (copy) => {
        const isVisible = (element: Element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        };
        const connected = [...document.querySelectorAll("*")].some(
          (element) => element.textContent?.trim() === copy && isVisible(element),
        );
        return connected ? performance.now() : false;
      },
      CONNECTED_COPY,
      { polling: "raf" },
    );
    const connectedAt = await connectedHandle.jsonValue();
    await connectedHandle.dispose();
    await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    const rail = page.getByRole("dialog", { name: "Working folders and sessions" });
    await page.evaluate(() => {
      const phases: {
        transcriptVisibleAt?: number;
        tailAlignedAt?: number;
        realListVisibleAt?: number;
        tailPaintedAt?: number;
      } = {};
      Object.assign(window, { __t4BrowserPaintPhases: phases });
      let tailPaintScheduled = false;
      const isVisible = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && bounds.width > 0
          && bounds.height > 0;
      };
      const inspect = () => {
        const transcript = document.querySelector('[role="log"][aria-label="Transcript"]');
        if (phases.transcriptVisibleAt === undefined && isVisible(transcript)) {
          phases.transcriptVisibleAt = performance.now();
        }
        const realList = transcript?.querySelector(".legend-list-content-container") ?? null;
        const overlay = transcript?.querySelector("[data-cold-mount-overlay]") ?? null;
        if (phases.tailAlignedAt === undefined) {
          const scroller = [...(transcript?.querySelectorAll<HTMLElement>("div") ?? [])].find(
            (element) => {
              const { overflowY } = getComputedStyle(element);
              return overflowY === "auto" || overflowY === "scroll";
            },
          );
          const transcriptRect = transcript?.getBoundingClientRect();
          const rows = [...(transcript?.querySelectorAll<HTMLElement>("[data-transcript-row]") ?? [])];
          const rowsInView = transcriptRect !== undefined && rows.some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > transcriptRect.top && rect.top < transcriptRect.bottom;
          });
          if (scroller !== undefined && transcriptRect !== undefined) {
            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            const aligned = Math.abs(scroller.scrollTop - maxScroll) <= 1;
            if (aligned && rowsInView) {
              phases.tailAlignedAt = performance.now();
            }
          }
        }
        if (
          phases.realListVisibleAt === undefined
          && isVisible(transcript)
          && overlay === null
          && isVisible(realList)
        ) {
          phases.realListVisibleAt = performance.now();
        }
        const tail = [...(transcript?.querySelectorAll("p") ?? [])].find(
          (paragraph) => paragraph.textContent?.trim() === "message-10000" && isVisible(paragraph),
        );
        if (phases.realListVisibleAt !== undefined && tail !== undefined && !tailPaintScheduled) {
          tailPaintScheduled = true;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              phases.tailPaintedAt = performance.now();
            });
          });
        }
        if (phases.tailPaintedAt === undefined) requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    await rail.locator('[data-session-row="host-history/session-history"]').evaluate((element) => {
      element.addEventListener("click", () => {
        Object.assign(window, { __t4SessionDomClickAt: performance.now() });
      }, { capture: true, once: true });
    });
    const sessionClickStartedAt = await page.evaluate(() => performance.now());
    await rail.locator('[data-session-row="host-history/session-history"]').click();

    const transcript = page.getByRole("log", { name: "Transcript" });
    await expect(transcript).toBeVisible();
    await expect(transcript.locator("[data-cold-mount-overlay]")).toHaveCount(0);
    await expect(transcript.getByText("message-10000", { exact: true })).toBeVisible();
    expect(await transcript.locator("[data-transcript-row]").count()).toBeLessThan(100);
    const mountDuration = performance.now() - mountStartedAt;
    const phasesHandle = await page.waitForFunction(
      () => {
        const phases = (
          window as typeof window & {
            __t4BrowserPaintPhases?: {
              transcriptVisibleAt?: number;
              tailAlignedAt?: number;
              realListVisibleAt?: number;
              tailPaintedAt?: number;
            };
          }
        ).__t4BrowserPaintPhases;
        return phases !== undefined
          && Number.isFinite(phases.transcriptVisibleAt)
          && Number.isFinite(phases.tailAlignedAt)
          && Number.isFinite(phases.realListVisibleAt)
          && Number.isFinite(phases.tailPaintedAt)
          ? phases
          : false;
      },
      undefined,
      { polling: "raf" },
    );
    const phases = await phasesHandle.jsonValue();
    await phasesHandle.dispose();
    if (
      phases.transcriptVisibleAt === undefined
      || phases.tailAlignedAt === undefined
      || phases.realListVisibleAt === undefined
      || phases.tailPaintedAt === undefined
    ) {
      throw new Error("browser paint observer returned incomplete phases");
    }
    const sessionDomClickAt = await page.evaluate(() => (
      window as typeof window & { __t4SessionDomClickAt?: number }
    ).__t4SessionDomClickAt);
    if (sessionDomClickAt === undefined) throw new Error("session DOM click timestamp was not captured");
    const phaseOutput = process.env.T4_PERF_PHASE_OUTPUT;
    if (phaseOutput !== undefined) {
      await writeFile(
        phaseOutput,
        `${JSON.stringify({
          mountDuration,
          navigationDomContentLoaded: navigationTiming.domContentLoaded,
          connectedAfterDomContentLoaded: connectedAt - navigationTiming.domContentLoaded,
          sessionClickCommandToDomClick: sessionDomClickAt - sessionClickStartedAt,
          sessionDomClickToTranscriptVisible: phases.transcriptVisibleAt - sessionDomClickAt,
          sessionDomClickToTailAligned: phases.tailAlignedAt - sessionDomClickAt,
          sessionDomClickToRealListVisible: phases.realListVisibleAt - sessionDomClickAt,
          sessionDomClickToTailPainted: phases.tailPaintedAt - sessionDomClickAt,
          sessionClickToTranscriptVisible: phases.transcriptVisibleAt - sessionClickStartedAt,
          sessionClickToTailAligned: phases.tailAlignedAt - sessionClickStartedAt,
          tailAlignedToRealListVisible: phases.realListVisibleAt - phases.tailAlignedAt,
          sessionClickToRealListVisible: phases.realListVisibleAt - sessionClickStartedAt,
          sessionClickToTailPainted: phases.tailPaintedAt - sessionClickStartedAt,
        })}\n`,
      );
    }
  } finally {
    await historyWeb?.stop();
    await historyFixture.stop();
  }
});

test("@soak recovers one live phone session across 20 network drops", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page, true);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const composer = page.getByRole("textbox", { name: "Message the session" });

  for (let cycle = 1; cycle <= 20; cycle += 1) {
    const before = await fixture.state();
    await fixture.disconnectClients();
    await expect(
      page.getByText("Connecting", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await page.clock.fastForward(10_000);
    await expect
      .poll(async () => (await fixture.state()).connections, {
        message: `fixture did not accept reconnect ${cycle}`,
      })
      .toBeGreaterThan(before.connections);
    await expect.poll(async () => (await fixture.state()).clients).toBe(1);
    await expect(transcript).toBeVisible();
    await expect(
      transcript.getByText("Hello world", { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(composer).toBeEnabled();
    await expect(page.getByText("Connecting", { exact: true })).toHaveCount(0);
  }
});

test("settles a typed incompatible desktop inspection and recovers without a stale retry", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const inspection = { definition: "current", service: "running", diagnostics: "" } as const;
    const control: {
      inspectCalls: number;
      mode: "issue" | "pending" | "resolve";
      resolvePending?: (value: typeof inspection) => void;
    } = { inspectCalls: 0, mode: "issue" };
    Object.assign(globalThis, { __t4ServiceInspectControl: control });
    Object.assign(window, {
      ompShell: {
        kind: "desktop",
        platform: "darwin",
        bootstrap: async () => ({ platform: "darwin", version: "omp-app/1", connected: false }),
        listTargets: async () => ({
          targets: [
            {
              targetId: "local",
              label: "This machine",
              kind: "local",
              state: "disconnected",
              paired: true,
            },
          ],
        }),
        connectTarget: async () => ({ targetId: "local", state: "error" }),
        serviceInspect: async () => {
          control.inspectCalls += 1;
          if (control.mode === "issue")
            return {
              definition: "missing",
              service: "unknown",
              diagnostics: "",
              issue: { code: "omp_incompatible", message: "Update OMP, then choose Check again." },
            };
          if (control.mode === "pending") {
            return new Promise<typeof inspection>((resolveInspection) => {
              control.resolvePending = resolveInspection;
            });
          }
          return inspection;
        },
        onServerEvent: () => () => undefined,
        onConnectionState: () => () => undefined,
        onRuntimeError: () => () => undefined,
      },
    });
  });

  const inspectCalls = () =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __t4ServiceInspectControl: { inspectCalls: number };
          }
        ).__t4ServiceInspectControl.inspectCalls,
    );
  await page.goto(web.url, { waitUntil: "domcontentloaded" });

  await expect(page.getByText("OMP update required", { exact: true })).toBeVisible();
  await expect(page.getByText("Checking", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
  await expect.poll(inspectCalls).toBe(1);
  await page.clock.fastForward(60_000);
  expect(await inspectCalls()).toBe(1);

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        __t4ServiceInspectControl: { mode: "issue" | "pending" | "resolve" };
      }
    ).__t4ServiceInspectControl.mode = "pending";
  });
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(inspectCalls).toBe(2);
  await page.clock.fastForward(5_000);
  expect(await inspectCalls()).toBe(2);

  await page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __t4ServiceInspectControl: {
          mode: "reject" | "pending" | "resolve";
          resolvePending?: (inspection: {
            definition: "current";
            service: "running";
            diagnostics: "";
          }) => void;
        };
      }
    ).__t4ServiceInspectControl;
    control.mode = "resolve";
    control.resolvePending?.({ definition: "current", service: "running", diagnostics: "" });
  });
  await expect(page.getByRole("main").getByText("Running", { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(await inspectCalls()).toBe(2);
});

test("caps generic desktop inspection retries and clears timers on manual work and service-state exit", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const control: {
      inspectCalls: number;
      mode: "reject" | "pending";
      rejectPending?: (error: Error) => void;
      stateListener?: (event: { targetId: string; state: "connected" }) => void;
    } = { inspectCalls: 0, mode: "reject" };
    Object.assign(globalThis, { __t4GenericInspectControl: control });
    Object.assign(window, {
      ompShell: {
        kind: "desktop",
        platform: "darwin",
        bootstrap: async () => ({ platform: "darwin", version: "omp-app/1", connected: false }),
        listTargets: async () => ({
          targets: [
            {
              targetId: "local",
              label: "This machine",
              kind: "local",
              state: "disconnected",
              paired: true,
            },
          ],
        }),
        connectTarget: async () => ({ targetId: "local", state: "error" }),
        serviceInspect: async () => {
          control.inspectCalls += 1;
          if (control.mode === "pending") {
            return new Promise<never>((_resolve, reject) => {
              control.rejectPending = reject;
            });
          }
          throw new Error("temporary IPC failure");
        },
        onServerEvent: () => () => undefined,
        onConnectionState: (
          listener: (event: { targetId: string; state: "connected" }) => void,
        ) => {
          control.stateListener = listener;
          return () => {
            if (control.stateListener === listener) control.stateListener = undefined;
          };
        },
        onRuntimeError: () => () => undefined,
      },
    });
  });

  const inspectCalls = () =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __t4GenericInspectControl: { inspectCalls: number };
          }
        ).__t4GenericInspectControl.inspectCalls,
    );
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Check failed", { exact: true })).toBeVisible();
  await expect.poll(inspectCalls).toBe(1);

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        __t4GenericInspectControl: { mode: "reject" | "pending" };
      }
    ).__t4GenericInspectControl.mode = "pending";
  });
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(inspectCalls).toBe(2);
  await page.clock.fastForward(5_000);
  expect(await inspectCalls()).toBe(2);
  await page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __t4GenericInspectControl: {
          mode: "reject" | "pending";
          rejectPending?: (error: Error) => void;
        };
      }
    ).__t4GenericInspectControl;
    control.mode = "reject";
    control.rejectPending?.(new Error("temporary IPC failure"));
  });
  await expect(page.getByText("Check failed", { exact: true })).toBeVisible();

  for (const [delay, count] of [
    [5_000, 3],
    [15_000, 4],
    [30_000, 5],
    [60_000, 6],
  ] as const) {
    await page.clock.fastForward(delay);
    await expect.poll(inspectCalls).toBe(count);
  }
  await page.clock.fastForward(120_000);
  expect(await inspectCalls()).toBe(6);

  // A manual check after the cap starts a fresh finite budget. Leaving the
  // service state unmounts its card/effect and must cancel that new timer.
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(inspectCalls).toBe(7);
  await page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __t4GenericInspectControl: {
          stateListener?: (event: { targetId: string; state: "connected" }) => void;
        };
      }
    ).__t4GenericInspectControl;
    control.stateListener?.({ targetId: "local", state: "connected" });
  });
  await expect(page.getByText("No sessions yet", { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(await inspectCalls()).toBe(7);
});

test("uses an injected backend, streams once, settles durably, and reloads history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openSession(page, false);

  const rows = page.locator("[data-transcript-row]");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Hello world");

  const composer = page.getByRole("textbox", { name: "Message the session" });
  await composer.fill("browser e2e prompt");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer).toHaveValue("");

  await fixture.advanceBy(0);
  await expect(page.getByRole("button", { name: "Stop the running turn" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello");
  const streamingCopy = rows.nth(1).getByRole("button", { name: "Copy response" });
  await expect(streamingCopy).toBeHidden();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello world");
  await expect(streamingCopy).toBeHidden();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello world");
  await expect(rows.nth(1).getByRole("button", { name: "Copy response" })).toBeVisible();

  await installColdMountObserver(page, "Hello world");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("log", { name: "Transcript" })).toBeVisible();
  const reloadedRows = page.locator("[data-transcript-row]");
  await expect(reloadedRows).toHaveCount(2);
  await expect(reloadedRows.nth(0)).toContainText("Hello world");
  await expect(reloadedRows.nth(1)).toContainText("Hello world");
  await expect
    .poll(async () => (await readColdMountSamples(page)).length)
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("log", { name: "Transcript" }).locator("[data-cold-mount-overlay]"),
  ).toHaveCount(0);
  const coldMountSamples = await readColdMountSamples(page);
  expect(coldMountSamples.some((sample) => sample.overlayCopies > 0)).toBe(true);
  expect(
    coldMountSamples.some(
      (sample) => sample.overlayCopies > 0 && sample.visibleCopies === sample.overlayCopies,
    ),
  ).toBe(true);
  expect(
    coldMountSamples.every((sample) => sample.visibleCopies <= sample.overlayCopies),
  ).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("keeps the mobile rail controls separate and the configured model cycle scrollable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openConnectedRoot(page);

  await page.getByRole("button", { name: "Show session list", exact: true }).click();
  const rail = page.getByRole("dialog", { name: "Working folders and sessions" });
  await expect(rail).toBeVisible();
  const close = rail.getByRole("button", { name: "Close", exact: true });
  const create = rail.getByRole("button", { name: /^New session in /u });
  await expect(close).toBeVisible();
  await expect(create).toBeVisible();
  const [closeBox, createBox] = await Promise.all([close.boundingBox(), create.boundingBox()]);
  expect(closeBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  const overlapWidth = Math.max(
    0,
    Math.min(closeBox!.x + closeBox!.width, createBox!.x + createBox!.width) -
      Math.max(closeBox!.x, createBox!.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(closeBox!.y + closeBox!.height, createBox!.y + createBox!.height) -
      Math.max(closeBox!.y, createBox!.y),
  );
  expect(overlapWidth * overlapHeight).toBe(0);
  await close.click({ trial: true });
  await create.click({ trial: true });

  const session = page.locator(`[data-session-row="${SESSION_VIEW_ID}"]`);
  await session.click();
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();

  await page.getByRole("button", { name: "Run options", exact: true }).click();
  const modelTrigger = page.getByRole("button", { name: /^Model — this session:/u });
  await expect(modelTrigger).toBeEnabled();
  await modelTrigger.click();
  const modelList = page.getByRole("listbox", { name: "Model — this session" });
  const modelPopup = page.getByRole("dialog").filter({ has: modelList });
  await expect(modelList).toBeVisible();
  await expect(modelPopup).toHaveCount(1);
  const options = modelList.getByRole("option");
  await expect(options).toHaveCount(12);

  const before = await modelList.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  const listBox = await modelList.boundingBox();
  const popupBox = await modelPopup.boundingBox();
  const viewport = page.viewportSize();
  expect(listBox).not.toBeNull();
  expect(popupBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(popupBox!.x).toBeGreaterThanOrEqual(-0.5);
  expect(popupBox!.y).toBeGreaterThanOrEqual(-0.5);
  expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(viewport!.width + 0.5);
  expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(viewport!.height + 0.5);

  const x = listBox!.x + listBox!.width / 2;
  const startY = listBox!.y + listBox!.height - 24;
  const endY = listBox!.y + 24;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY, id: 0, radiusX: 1, radiusY: 1, force: 1 }],
    });
    for (let step = 1; step <= 8; step += 1) {
      const y = startY + ((endY - startY) * step) / 8;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y, id: 0, radiusX: 1, radiusY: 1, force: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await expect.poll(() => modelList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const last = options.last();
  await expect(last).toBeVisible();
  await last.click();
  await expect(modelList).toBeHidden();
  // The composer does not optimistically echo a click. This label changes
  // only after the fixture host accepts session.model.set and publishes the
  // reconciled session ref, so the touch path proves command receipt too.
  await expect(modelTrigger).toHaveAccessibleName(/^Model — this session: Fixture 12/u);
});

test("keeps an empty Archived filter selected on the home route", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openConnectedRoot(page);

  const rail = page.getByRole("navigation", { name: "Working folders and sessions" });
  const archived = rail.getByRole("button", { name: "Archived · 0", exact: true });
  await archived.click();

  await expect(page).toHaveURL(
    (url) => url.pathname === "/" && (url.hash === "" || url.hash === "#/"),
  );
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByText("No archived sessions.", { exact: true })).toBeVisible();
  await expect(rail.locator("[data-session-row]")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Working folders and sessions" })
      .getByRole("button", { name: "Archived · 0", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("opens supporting tools from one workspace menu and toggles the terminal shortcut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSession(page, false);

  const workspace = page.getByRole("button", { name: "Workspace tools", exact: true });
  await expect(workspace).toBeVisible();
  await workspace.click();
  await expect(page.getByText("Open on the right", { exact: true })).toBeVisible();
  await expect(page.getByText("Open below", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Agent terminals panel" })).toBeVisible();

  await page.getByRole("button", { name: "Open Activity panel", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Activity", exact: true })).toBeVisible();
  await expect(workspace).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Control+j");
  await expect(page.getByRole("button", { name: "Close terminal drawer", exact: true })).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(
    page.getByRole("button", { name: "Close terminal drawer", exact: true }),
  ).toBeHidden();
});

test("temporarily hides workspace chrome in focus mode and restores it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSession(page, false);

  const workspace = page.getByRole("button", { name: "Workspace tools", exact: true });
  await workspace.click();
  await page.getByRole("button", { name: "Open Activity panel", exact: true }).click();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("complementary", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close terminal drawer", exact: true })).toBeVisible();

  await workspace.click();
  await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Working folders and sessions" })).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Activity", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Close terminal drawer", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Workspace tools", exact: true })).toBeHidden();

  const exitFocus = page.getByRole("button", { name: "Exit focus mode", exact: true });
  await expect(exitFocus).toBeVisible();
  await exitFocus.click();
  await expect(page.getByRole("navigation", { name: "Working folders and sessions" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close terminal drawer", exact: true })).toBeVisible();

  await page.keyboard.press("Control+Shift+f");
  await expect(exitFocus).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exitFocus).toBeHidden();
  await page.getByRole("button", { name: "Close Activity", exact: true }).click();
  await page.getByRole("button", { name: "Close terminal drawer", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+Shift+f");
  await expect(exitFocus).toBeVisible();
  const exitBox = await exitFocus.boundingBox();
  expect(exitBox).not.toBeNull();
  expect(exitBox!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(exitBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  await exitFocus.click();
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeVisible();
});

test("shows verified session context and groups command-palette actions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSession(page, false);

  const context = page.getByRole("button", { name: /^Session context:/u });
  await expect(context).toBeVisible();
  await context.click();
  await expect(page.getByText("Host", { exact: true })).toBeVisible();
  await expect(page.getByText("Model", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection", { exact: true })).toBeVisible();
  await expect(page.getByText("Live connection", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View host health", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", {
    name: "Search files, sessions, transcripts, and commands",
  });
  await expect(palette.getByText("Recent work", { exact: true })).toBeVisible();
  await expect(palette.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(palette.getByText("Navigate", { exact: true })).toBeVisible();
  await expect(palette.getByText("App", { exact: true })).toBeVisible();
  await expect(palette.getByLabel("Command menu keyboard help")).toContainText(
    /Navigate.*Open.*Esc.*Close/u,
  );

  const search = palette.getByRole("combobox");
  await search.fill("CommandPalette");
  await expect(
    palette.getByRole("option", { name: /apps\/web\/src\/components\/CommandPalette\.tsx.*Current project/u }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Files", exact: true })).toBeVisible();

  await page.keyboard.press("Control+k");
  await search.fill("open terminal");
  await expect(palette.getByText("Workspace", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close terminal drawer", exact: true })).toBeVisible();
});

test("builds one reviewed working set from transcript and file sources", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const appUrl = new URL(web.url);
    if (requestUrl.origin === appUrl.origin && requestUrl.pathname === "/") {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<script id="t4-backend" type="application\/json">.*?<\/script>/u,
        "",
      );
      await route.fulfill({ body, response });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await page.getByText("Pin protocol fixtures for desktop CI", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeVisible();
  await page.getByRole("button", { name: "Add response to working set" }).first().click();

  await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
  await page.getByRole("button", { name: "Open Files panel", exact: true }).click();
  const files = page.getByRole("complementary", { name: "Files", exact: true });
  await expect(files.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", {
    name: "Search files, sessions, transcripts, and commands",
  });
  await palette.getByRole("combobox").fill("README");
  await expect(
    palette.getByRole("option", { name: /README\.md.*Current session · loaded file/u }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await files.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await files.getByRole("button", { name: "Add context", exact: true }).click();
  const stagedContext = page.getByLabel("Working set for the next new message");
  await expect(stagedContext).toContainText("README.md");
  await expect(stagedContext.locator("li")).toHaveCount(2);
  await stagedContext.locator("summary", { hasText: "README.md" }).click();
  const contextPreview = stagedContext.locator("li", { hasText: "README.md" }).locator("pre");
  await expect(contextPreview).toBeVisible();
  const previewBounds = await contextPreview.boundingBox();
  expect(previewBounds).not.toBeNull();
  expect(previewBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((previewBounds?.y ?? 0) + (previewBounds?.height ?? 0)).toBeLessThanOrEqual(900);
  await expect(files.getByRole("button", { name: "Refresh context", exact: true })).toBeVisible();
});

test("groups sample settings on desktop and in the mobile category picker", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const appUrl = new URL(web.url);
    if (requestUrl.origin === appUrl.origin && requestUrl.pathname === "/") {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<script id="t4-backend" type="application\/json">.*?<\/script>/u,
        "",
      );
      await route.fulfill({ body, response });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${web.url}#/settings`, { waitUntil: "domcontentloaded" });

  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(sections.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sections.getByText("AI & agents", { exact: true })).toBeVisible();
  await expect(sections.getByText("Tools", { exact: true })).toBeVisible();
  await expect(sections.getByText("Integrations", { exact: true })).toBeVisible();
  await expect(sections.getByText("System", { exact: true })).toBeVisible();
  await sections.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const picker = page.getByLabel("Settings category");
  await expect(picker).toBeVisible();
  await expect(picker.locator('optgroup[label="Personal"] option')).toHaveCount(5);
  await expect(picker.locator('optgroup[label="AI & agents"] option')).toHaveCount(4);
  await expect(picker.locator('optgroup[label="System"] option')).toHaveCount(2);
  await picker.selectOption("general");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 390, height: 500 },
  { width: 360, height: 800 },
  { width: 320, height: 568 },
] as const) {
  test(`keeps navigation and send reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openSession(page, true);

    const composer = page.getByRole("textbox", { name: "Message the session" });
    await composer.fill(`reachable at ${viewport.width}x${viewport.height}`);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    const geometry = await send.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      };
    });

    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);
    expect(geometry.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(geometry.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth);

    const textareaBox = await composer.boundingBox();
    expect(textareaBox).not.toBeNull();
    expect(textareaBox!.x).toBeGreaterThanOrEqual(0);
    expect(textareaBox!.x + textareaBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);

    // Send for real, hold virtual time at the canonical turn.start boundary,
    // and prove all three active-turn actions are visible, tappable, and at
    // least the 44px mobile target size at the smallest supported viewport.
    await send.click();
    await fixture.advanceBy(0);
    await composer.fill("active turn action");
    for (const name of ["Stop", "Queue", "Steer"] as const) {
      const action = page.getByRole("button", { name, exact: true });
      await expect(action).toBeVisible();
      await expect(action).toBeEnabled();
      await action.click({ trial: true });
      const actionGeometry = await action.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
      expect(actionGeometry.left, name).toBeGreaterThanOrEqual(0);
      expect(actionGeometry.top, name).toBeGreaterThanOrEqual(0);
      expect(actionGeometry.right, name).toBeLessThanOrEqual(actionGeometry.viewportWidth + 0.5);
      expect(actionGeometry.bottom, name).toBeLessThanOrEqual(actionGeometry.viewportHeight + 0.5);
      expect(actionGeometry.width, name).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(actionGeometry.height, name).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    // Stop is a challenged command in real OMP. Exercise the actual
    // request -> confirmation -> confirm -> original-request response
    // correlation, rather than letting the fixture grant it immediately.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Approval needed", { exact: true })).toBeVisible();
    await expect(page.getByText("session.cancel", { exact: true })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();
    const approvalGeometry = await approve.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(approvalGeometry.left).toBeGreaterThanOrEqual(0);
    expect(approvalGeometry.top).toBeGreaterThanOrEqual(0);
    expect(approvalGeometry.right).toBeLessThanOrEqual(approvalGeometry.viewportWidth + 0.5);
    expect(approvalGeometry.bottom).toBeLessThanOrEqual(approvalGeometry.viewportHeight + 0.5);
    expect(approvalGeometry.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(approvalGeometry.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await approve.click();
    await expect(page.getByText("Approval needed", { exact: true })).toBeHidden();
    await fixture.advanceBy(30);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  });
}

test("manages a session from a phone and converges another live client", async ({
  browser,
  page,
}) => {
  const managedTitle = "Managed from phone";
  await page.setViewportSize({ width: 390, height: 844 });
  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const observer = await observerContext.newPage();
  try {
    await Promise.all([openSession(page, true), openSession(observer, false)]);

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    const rail = page.getByRole("dialog", { name: "Working folders and sessions" });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Open attention inbox", exact: true }),
    ).toBeVisible();
    await expect(rail.getByRole("button", { name: "Current · 1", exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Archived · 0", exact: true })).toBeVisible();

    const initialActions = rail.getByRole("button", { name: `Actions for ${SESSION_TITLE}` });
    const initialActionsBox = await initialActions.boundingBox();
    expect(initialActionsBox).not.toBeNull();
    expect(initialActionsBox!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(initialActionsBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await initialActions.click();
    const renameAction = page.getByRole("button", { name: "Rename", exact: true });
    await expect(renameAction).toBeVisible();
    const renameActionBox = await renameAction.boundingBox();
    expect(renameActionBox).not.toBeNull();
    expect(renameActionBox!.x).toBeGreaterThanOrEqual(0);
    expect(renameActionBox!.y).toBeGreaterThanOrEqual(0);
    expect(renameActionBox!.x + renameActionBox!.width).toBeLessThanOrEqual(390.5);
    expect(renameActionBox!.y + renameActionBox!.height).toBeLessThanOrEqual(844.5);
    await renameAction.click();

    const renameDialog = page.getByRole("dialog", { name: "Rename session", exact: true });
    await expect(renameDialog).toBeVisible();
    const renameInput = renameDialog.getByRole("textbox", { name: "Session name" });
    await renameInput.fill(managedTitle);
    await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(renameDialog).toBeHidden();
    await expect(page.getByText(managedTitle, { exact: true }).first()).toBeVisible();
    await expect(observer.getByText(managedTitle, { exact: true }).first()).toBeVisible();

    await expect(rail).toBeVisible();
    const managedRow = page.locator(`[data-session-row="${SESSION_VIEW_ID}"]`);
    await expect(managedRow).toContainText(managedTitle);

    await rail.getByRole("button", { name: `Actions for ${managedTitle}` }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page).toHaveURL(/#\/$/u);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    await expect(rail.getByText("No current sessions.", { exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Current · 0", exact: true })).toBeVisible();
    const createAfterArchivingLastSession = rail.getByRole("button", {
      name: /^New session in /u,
    });
    await expect(createAfterArchivingLastSession).toBeVisible();
    await expect(createAfterArchivingLastSession).toBeEnabled();
    const archivedFilter = rail.getByRole("button", { name: "Archived · 1", exact: true });
    const archivedFilterBox = await archivedFilter.boundingBox();
    expect(archivedFilterBox).not.toBeNull();
    expect(archivedFilterBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await expect(observer.getByText(/Archived · read-only/u).first()).toBeVisible();
    await expect(observer.getByRole("textbox", { name: "Message the session" })).toHaveCount(0);
    await expect(observer.getByRole("button", { name: "Run options", exact: true })).toHaveCount(0);
    await expect(
      observer
        .getByRole("navigation", { name: "Working folders and sessions" })
        .getByRole("button", { name: "Archived · 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    // Create for real after the only previous session is archived. The host
    // must allocate a distinct id, publish it to both clients, and expose a
    // writable empty session rather than returning the archived seed again.
    await createAfterArchivingLastSession.click();
    await expect(rail).toBeHidden();
    await expect(page).toHaveURL((url) => {
      const route = decodeURIComponent(url.hash.replace(/^#\/sessions\//u, ""));
      return url.hash.startsWith("#/sessions/") && route !== SESSION_VIEW_ID;
    });
    const createdViewId = decodeURIComponent(
      new URL(page.url()).hash.replace(/^#\/sessions\//u, ""),
    );
    expect(createdViewId).not.toBe(SESSION_VIEW_ID);
    await expect(
      page.getByText("Nothing here yet. Say what you need and the work lands in this transcript.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
    await expect(page.getByText(/Archived · read-only/u)).toHaveCount(0);

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("button", { name: "Current · 1", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rail.getByRole("button", { name: "Archived · 1", exact: true })).toBeVisible();
    const createdRow = rail.locator(`[data-session-row="${createdViewId}"]`);
    await expect(createdRow).toBeVisible();
    await expect(createdRow).toContainText("New session 1");

    const observerRail = observer.getByRole("navigation", {
      name: "Working folders and sessions",
    });
    const observerCurrent = observerRail.getByRole("button", {
      name: "Current · 1",
      exact: true,
    });
    await expect(observerCurrent).toBeVisible();
    await observerCurrent.click();
    await expect(observer).toHaveURL((url) => {
      const route = decodeURIComponent(url.hash.replace(/^#\/sessions\//u, ""));
      return route === createdViewId;
    });
    await expect(observer.locator(`[data-session-row="${createdViewId}"]`)).toBeVisible();
    await expect(observer.getByRole("textbox", { name: "Message the session" })).toBeEnabled();

    await rail.getByRole("button", { name: "Archived · 1", exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page.getByText(/Archived · read-only/u).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message the session" })).toHaveCount(0);

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    await rail.getByRole("button", { name: `Actions for ${managedTitle}` }).click();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
    await expect(observer.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
    await expect(
      observerRail.getByRole("button", { name: "Current · 2", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("button", { name: "Current · 2", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await rail.getByRole("button", { name: `Actions for ${managedTitle}` }).click();
    await page.getByRole("button", { name: "Permanently delete", exact: true }).click();

    const deleteDialog = page.getByRole("dialog", {
      name: `Permanently delete “${managedTitle}”?`,
      exact: true,
    });
    await expect(
      deleteDialog.getByRole("heading", {
        name: `Permanently delete “${managedTitle}”?`,
      }),
    ).toBeVisible();
    const deleteButton = deleteDialog.getByRole("button", {
      name: "Permanently delete",
      exact: true,
    });
    const deleteInput = deleteDialog.getByRole("textbox", {
      name: "Type the exact session title to confirm",
    });
    await deleteInput.fill(`${managedTitle}!`);
    await expect(deleteButton).toBeDisabled();
    await deleteInput.fill(managedTitle);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    await expect(deleteDialog).toBeHidden();
    await expect(page).toHaveURL((url) => {
      const route = decodeURIComponent(url.hash.replace(/^#\/sessions\//u, ""));
      return route === createdViewId;
    });
    await expect(page.locator(`[data-session-row="${SESSION_VIEW_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-session-row="${createdViewId}"]`)).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
    await expect(observer).toHaveURL((url) => {
      const route = decodeURIComponent(url.hash.replace(/^#\/sessions\//u, ""));
      return route === createdViewId;
    });
    await expect(
      observerRail.getByRole("button", { name: "Current · 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    // Once the remaining current session is archived, the empty project can
    // be removed from Current without deleting its archived history. The
    // dismissal is local view state and must survive a reload.
    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    await rail.getByRole("button", { name: "Actions for New session 1", exact: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page).toHaveURL(/#\/$/u);

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(rail).toBeVisible();
    const projectMenuTrigger = rail.getByRole("button", { name: /^Actions for /u });
    await expect(projectMenuTrigger).toHaveCount(1);
    const projectActionName = await projectMenuTrigger.getAttribute("aria-label");
    expect(projectActionName).not.toBeNull();
    if (projectActionName === null) throw new Error("project action label is missing");
    const projectTriggerBox = await projectMenuTrigger.boundingBox();
    expect(projectTriggerBox).not.toBeNull();
    expect(projectTriggerBox!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(projectTriggerBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await projectMenuTrigger.click();
    const removeEmptyProject = page.getByRole("button", {
      name: /^Remove shortcut\b/u,
    });
    const removeBox = await removeEmptyProject.boundingBox();
    expect(removeBox).not.toBeNull();
    expect(removeBox!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(removeBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(removeBox!.x).toBeGreaterThanOrEqual(0);
    expect(removeBox!.y).toBeGreaterThanOrEqual(0);
    expect(removeBox!.x + removeBox!.width).toBeLessThanOrEqual(320.5);
    expect(removeBox!.y + removeBox!.height).toBeLessThanOrEqual(568.5);
    await removeEmptyProject.click();
    await expect(removeEmptyProject).toHaveCount(0);
    await expect(
      rail.getByRole("navigation", { name: "Working folders and sessions" }),
    ).toBeFocused();
    await expect(rail.getByRole("button", { name: /^New session in /u })).toHaveCount(0);
    await expect(rail.getByRole("button", { name: "Archived · 1", exact: true })).toBeVisible();
    await observerRail.getByRole("button", { name: "Current · 0", exact: true }).click();
    await expect(observerRail.getByRole("button", { name: /^New session in /u })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    const reloadedRail = page.getByRole("dialog", { name: "Working folders and sessions" });
    await expect(reloadedRail).toBeVisible();
    await expect(reloadedRail.getByRole("button", { name: projectActionName })).toHaveCount(0);
    await expect(reloadedRail.getByRole("button", { name: /^New session in /u })).toHaveCount(0);
    await reloadedRail.getByRole("button", { name: "Archived · 1", exact: true }).click();
    await expect(page).toHaveURL((url) => {
      const route = decodeURIComponent(url.hash.replace(/^#\/sessions\//u, ""));
      return route === createdViewId;
    });
    await expect(page.getByText(/Archived · read-only/u).first()).toBeVisible();

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(reloadedRail).toBeVisible();
    await reloadedRail.getByRole("button", { name: projectActionName }).click();
    await page.getByRole("button", { name: /^Show shortcut\b/u }).click();
    await expect(reloadedRail.locator("[data-project-disclosure]").first()).toBeFocused();
    await reloadedRail.getByRole("button", { name: "Current · 0", exact: true }).click();
    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    await expect(reloadedRail).toBeVisible();
    await expect(reloadedRail.getByRole("button", { name: projectActionName })).toBeVisible();
    await expect(reloadedRail.getByRole("button", { name: /^New session in /u })).toBeVisible();
  } finally {
    await observerContext.close();
  }
});

test("opens a session-linked browser preview, captures a snapshot, and keeps controls mobile-safe", async ({
  page,
}) => {
  const previewFixture = new FixtureProcess("preview-v1");
  let previewWeb: BuiltWebServer | undefined;
  try {
    await previewFixture.start();
    previewWeb = new BuiltWebServer(previewFixture.wsUrl);
    await previewWeb.start();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(previewWeb.url, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
    const session = page.locator('[data-session-row="host-preview/session-preview"]');
    await expect(session).toBeVisible();
    await session.click();

    const openPreview = page.getByRole("button", {
      name: "Open browser preview for this session",
    });
    await expect(openPreview).toBeVisible();
    await openPreview.click();
    await expect(page).toHaveURL(/#\/sessions\/[^/]+\/preview$/u);
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    await expect(page.locator(".surface-subheader").getByText("Ready", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Recapture" }).click();
    const snapshot = page.getByRole("img", { name: "Browser preview snapshot: Fixture preview" });
    await expect(snapshot).toBeVisible();
    await expect(snapshot).toHaveAttribute("src", /^blob:/u);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    const recaptureBox = await page.getByRole("button", { name: "Recapture" }).boundingBox();
    expect(recaptureBox).not.toBeNull();
    expect(recaptureBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await previewWeb?.stop();
    await previewFixture.stop();
  }
});
