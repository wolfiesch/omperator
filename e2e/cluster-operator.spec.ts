import { mkdir, writeFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { decodeServerFrame } from "../packages/protocol/src/index.ts";
import WebSocket, { WebSocketServer } from "ws";

import { BuiltWebServer } from "./built-web-server.ts";

const PUBLIC_WSS = "wss://operator-fixture.tailnet.ts.net/v1/ws";
const HOST = "cluster-host";
const SESSION = "cluster-session";
const VIEW = `${HOST}/${SESSION}`;
const PROOF_ROOT = "artifacts/cluster-proof";
type ScenarioId =
  | "gui-auth-isolation"
  | "desktop-viewport"
  | "mobile-viewport"
  | "wire-reconnect-idempotency";

async function recordScenario(
  page: Page,
  id: ScenarioId,
  assertions: readonly string[],
  viewport: "desktop" | "mobile",
): Promise<void> {
  await mkdir(`${PROOF_ROOT}/scenarios`, { recursive: true });
  await mkdir(`${PROOF_ROOT}/screenshots`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `${PROOF_ROOT}/screenshots/${id}-${viewport}-redacted.png`,
  });
  await writeFile(
    `${PROOF_ROOT}/scenarios/${id}.json`,
    `${JSON.stringify({
      schemaVersion: "t4-cluster-scenario/1",
      id,
      status: "passed",
      observedAt: new Date().toISOString(),
      assertions,
    })}\n`,
  );
}
const WORKSPACE = {
  id: "workspace-a",
  displayName: "Release train",
  phase: "Ready",
  retentionPolicy: "Retain",
  storageClass: "t4-workspaces-rwx",
  capacity: "20Gi",
  accessMode: "ReadWriteMany",
  revision: "workspace-r2",
  condition: {
    type: "StorageReady",
    status: "True",
    reason: "Bound",
    message: "The RWX claim is bound.",
    observedGeneration: 2,
  },
} as const;

const GRANTED_CAPABILITIES = [
  "sessions.read",
  "sessions.manage",
  "sessions.prompt",
  "sessions.control",
  "preview.read",
  "preview.control",
  "preview.input",
  "ci.trigger",
] as const;
const GRANTED_FEATURES = ["resume", "host.watch", "cluster.operator", "preview.control"] as const;
const GUI_PREVIEW = {
  previewId: "preview-a",
  state: "ready",
  url: "https://127.0.0.1:4173/",
  revision: "preview-r1",
  cursor: { epoch: "preview-1", seq: 1 },
  title: "Session GUI",
  canGoBack: false,
  canGoForward: false,
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  availableActions: ["navigate", "capture", "click", "fill", "type", "press", "scroll"],
  authority: {
    id: "omp-session",
    label: "Session",
    kind: "isolated-session",
    requiresExplicitOptIn: false,
  },
} as const;
const DECOY_PREVIEW = {
  ...GUI_PREVIEW,
  previewId: "preview-0",
  url: "https://127.0.0.1:4173/decoy",
  revision: "preview-r2",
  cursor: { epoch: "preview-1", seq: 2 },
  title: "Unrelated preview",
} as const;

function sessionRef(ciStatus: "queued" | "running" | "success" = "running") {
  return {
    hostId: HOST,
    sessionId: SESSION,
    project: { projectId: "cluster/workspace-a", name: "Release train" },
    revision: "session-r3",
    title: "Ship release",
    status: "active",
    updatedAt: "2026-07-20T12:00:00.000Z",
    model: "gpt-proxy/gpt-5.6-sol",
    liveState: {
      phase: "running",
      cluster: {
        workspaceId: WORKSPACE.id,
        phase: "Running",
        gui: { state: "Ready", previewId: "preview-a" },
      },
      ci: {
        provider: "woodpecker",
        correlation: "exact",
        repositoryId: "repo-a",
        branch: "main",
        ref: "refs/heads/main",
        commit: "0123456789abcdef",
        pipelineNumber: 42,
        status: ciStatus,
        currentStage: ciStatus === "success" ? "complete" : "verify",
        startedAt: "2026-07-20T12:01:00.000Z",
        link: "https://ci.tailnet.ts.net/repos/repo-a/pipeline/42",
      },
    },
  };
}

function requestedPreviewId(frame: Record<string, unknown>): string {
  const args = frame.args;
  if (
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    !("previewId" in args) ||
    typeof args.previewId !== "string"
  ) {
    throw new Error("preview command requires a preview id");
  }
  return args.previewId;
}

class OperatorWireFixture {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly hellos: Array<Record<string, unknown>> = [];
  readonly welcomes: Array<{
    readonly grantedCapabilities: readonly string[];
    readonly grantedFeatures: readonly string[];
  }> = [];
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/v1/ws" });
  private workspaceSeq = 2;
  private ciStatus: "queued" | "running" | "success" = "running";

  get url(): string {
    const address = this.server.address() as AddressInfo | null;
    if (address === null) throw new Error("operator fixture is not listening");
    return `ws://127.0.0.1:${address.port}/v1/ws`;
  }

  async start(): Promise<void> {
    if (this.server.address() !== null) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.server.on("connection", (socket) => {
      socket.on("message", (data) => this.receive(socket, JSON.parse(data.toString()) as Record<string, unknown>));
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  disconnectClients(): void {
    for (const socket of this.server.clients) socket.close(1012, "fixture restart");
  }

  private send(socket: WebSocket, frame: unknown): void {
    const decoded = decodeServerFrame(frame);
    if (decoded.type === "welcome") this.welcomes.push(decoded);
    socket.send(JSON.stringify(decoded));
  }

  private response(socket: WebSocket, frame: Record<string, unknown>, result: unknown): void {
    this.send(socket, {
      v: "omp-app/1",
      type: "response",
      requestId: frame.requestId,
      commandId: frame.commandId,
      hostId: HOST,
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      command: frame.command,
      ok: true,
      result,
    });
  }

  private receive(socket: WebSocket, frame: Record<string, unknown>): void {
    if (frame.type === "hello") {
      this.hellos.push(frame);
      this.send(socket, {
        v: "omp-app/1",
        type: "welcome",
        selectedProtocol: "omp-app/1",
        hostId: HOST,
        ompVersion: "17.0.5",
        ompBuild: "8476f4451ed95c5d5401785d279a93d3c659fac4",
        appserverVersion: "cluster-fixture",
        appserverBuild: "redacted",
        epoch: "cluster-epoch-1",
        grantedCapabilities: GRANTED_CAPABILITIES,
        grantedFeatures: GRANTED_FEATURES,
        negotiatedLimits: {},
        authentication: "paired",
        resumed: this.hellos.length > 1,
      });
      return;
    }
    if (frame.type !== "command") return;
    this.commands.push(frame);
    switch (frame.command) {
      case "session.list":
        this.response(socket, frame, {
          cursor: { epoch: "session-index-1", seq: 3 },
          sessions: [sessionRef(this.ciStatus)],
          totalCount: 1,
          truncated: false,
        });
        return;
      case "host.watch":
        this.response(socket, frame, {
          watchId: "cluster-watch",
          cursor: { epoch: "session-index-1", seq: 3 },
        });
        return;
      case "workspace.list":
        this.response(socket, frame, {
          cursor: { epoch: "workspace-index-1", seq: this.workspaceSeq },
          workspaces: [WORKSPACE],
        });
        this.send(socket, {
          v: "omp-app/1",
          type: "workspace.state",
          hostId: HOST,
          workspaceId: WORKSPACE.id,
          cursor: { epoch: "workspace-index-1", seq: this.workspaceSeq },
          revision: WORKSPACE.revision,
          upsert: WORKSPACE,
        });
        return;
      case "session.attach":
        this.response(socket, frame, { attached: true, cursor: { epoch: "transcript-1", seq: 1 } });
        this.send(socket, {
          v: "omp-app/1",
          type: "snapshot",
          hostId: HOST,
          sessionId: SESSION,
          cursor: { epoch: "transcript-1", seq: 1 },
          revision: "session-r3",
          entries: [],
        });
        this.send(socket, {
          v: "omp-app/1",
          type: "agent",
          hostId: HOST,
          sessionId: SESSION,
          agentId: "Main",
          state: "running",
          progress: 0.4,
          detail: { kind: "main", title: "Main", startedAt: "2026-07-20T12:00:00.000Z" },
        });
        this.send(socket, {
          v: "omp-app/1",
          type: "agent",
          hostId: HOST,
          sessionId: SESSION,
          agentId: "WorkerA",
          state: "running",
          progress: 0.7,
          detail: {
            parentId: "Main",
            title: "WorkerA",
            description: "Verify CI and wait for peer reply",
            currentTool: "irc.wait",
            evidence: "Parked peer revived; owner-scoped job still running",
            startedAt: "2026-07-20T12:00:10.000Z",
          },
        });
        this.send(socket, {
          v: "omp-app/1",
          type: "preview.state",
          hostId: HOST,
          sessionId: SESSION,
          ...GUI_PREVIEW,
        });
        this.send(socket, {
          v: "omp-app/1",
          type: "preview.state",
          hostId: HOST,
          sessionId: SESSION,
          ...DECOY_PREVIEW,
        });
        return;
      case "session.steer":
      case "session.prompt":
        this.response(socket, frame, { accepted: true });
        return;
      case "preview.state":
        this.response(socket, frame, {
          previews: [structuredClone(GUI_PREVIEW), structuredClone(DECOY_PREVIEW)],
        });
        return;
      case "preview.policy.check":
        this.response(socket, frame, { allowed: true, confirmationRequired: false });
        return;
      case "preview.lease.acquire":
        this.response(socket, frame, {
          previewId: requestedPreviewId(frame),
          leaseId: "preview-lease-a",
          expiresAt: Date.now() + 30_000,
        });
        return;
      case "preview.lease.release":
        this.response(socket, frame, {
          previewId: requestedPreviewId(frame),
          released: true,
        });
        return;
      case "preview.type":
      case "preview.fill":
      case "preview.press":
      case "preview.scroll":
        this.response(socket, frame, {
          preview:
            requestedPreviewId(frame) === DECOY_PREVIEW.previewId
              ? DECOY_PREVIEW
              : GUI_PREVIEW,
        });
        return;
      case "ci.run":
        this.ciStatus = "queued";
        this.response(socket, frame, {
          triggered: true,
          pipelineNumber: 43,
          status: "queued",
        });
        return;
      default:
        this.response(socket, frame, {});
    }
  }
}

let wire: OperatorWireFixture;
let web: BuiltWebServer;

async function routeFixtureWss(page: Page): Promise<void> {
  await page.addInitScript(
    ({ publicUrl, routedUrl }) => {
      const NativeWebSocket = window.WebSocket;
      class RoutedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(String(url) === publicUrl ? routedUrl : url, protocols);
        }
      }
      Object.defineProperties(RoutedWebSocket, {
        CONNECTING: { value: NativeWebSocket.CONNECTING },
        OPEN: { value: NativeWebSocket.OPEN },
        CLOSING: { value: NativeWebSocket.CLOSING },
        CLOSED: { value: NativeWebSocket.CLOSED },
      });
      window.WebSocket = RoutedWebSocket;
    },
    { publicUrl: PUBLIC_WSS, routedUrl: wire.url },
  );
}

async function openSession(page: Page, mobile = false): Promise<void> {
  await routeFixtureWss(page);
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  if (mobile) await page.getByRole("button", { name: "Show session list" }).click();
  const row = page.locator(`[data-session-row="${VIEW}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/#\/sessions\/cluster-host%2Fcluster-session|#\/sessions\/cluster-host\/cluster-session/u);
}

test.describe("OMP/T4 cluster GUI boundaries", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    wire = new OperatorWireFixture();
    await wire.start();
    web = new BuiltWebServer({
      wsUrl: PUBLIC_WSS,
      label: "Redacted cluster fixture",
      clusterOperatorEnabled: true,
    });
    await web.start();
  });

  test.afterAll(async () => {
    await web?.stop();
    await wire?.stop();
  });

  test("desktop attach, steer, and reconnect preserve canonical cursors without duplicate rows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession(page);
    const composer = page.getByRole("textbox", { name: "Message the session" });
    await composer.fill("Keep the current approach");
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await expect.poll(() => wire.commands.some((frame) => frame.command === "session.steer")).toBe(true);

    const helloCount = wire.hellos.length;
    wire.disconnectClients();
    await expect.poll(() => wire.hellos.length).toBeGreaterThan(helloCount);
    await expect(page.locator(`[data-session-row="${VIEW}"]`)).toHaveCount(1);
    expect(wire.hellos.at(-1)?.requestedFeatures).toContain("cluster.operator");
    const latestHello = wire.hellos.at(-1);
    const requestedCapabilities = (
      latestHello?.capabilities as { readonly client?: readonly string[] } | undefined
    )?.client;
    expect(latestHello?.requestedFeatures).toEqual(
      expect.arrayContaining(["cluster.operator", "preview.control"]),
    );
    expect(requestedCapabilities).toEqual(
      expect.arrayContaining([
        "sessions.read",
        "sessions.manage",
        "ci.trigger",
        "preview.read",
        "preview.control",
        "preview.input",
      ]),
    );
    const latestWelcome = wire.welcomes.at(-1);
    expect(latestWelcome?.grantedFeatures).toEqual(
      expect.arrayContaining(["cluster.operator", "preview.control"]),
    );
    expect(latestWelcome?.grantedCapabilities).toEqual(
      expect.arrayContaining(["sessions.read", "sessions.manage", "ci.trigger", "preview.read", "preview.control", "preview.input"]),
    );
    await recordScenario(
      page,
      "wire-reconnect-idempotency",
      ["hello.feature-granted", "reconnect.completed", "session.row-unique"],
      "desktop",
    );
  });

  test("Agent View keeps exact OMP ids, parentage, attention, and progress alongside exact CI state", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(page);
    await page.goto(`${web.url}#/agents`);
    await expect(page.getByRole("heading", { name: "Agent View" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Main", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "WorkerA", exact: true })).toBeVisible();
    await expect(page.getByText("Parent: Main", { exact: false })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "70% done" })).toBeVisible();
    await expect(page.getByText("Parked peer revived; owner-scoped job still running", { exact: true })).toBeVisible();
    await expect(page.getByText("verify", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible();
    await recordScenario(
      page,
      "desktop-viewport",
      ["agent.parentage", "agent.progress", "ci.stage-exact"],
      "desktop",
    );
  });

  test("phone explicitly chooses a cluster host and keeps CI and GUI workflows reachable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await openSession(page, true);
    expect(wire.hellos.at(-1)?.requestedFeatures).toContain("cluster.operator");
    const helloCount = wire.hellos.length;
    wire.disconnectClients();
    await expect.poll(() => wire.hellos.length).toBeGreaterThan(helloCount);
    await page.getByRole("button", { name: "Show session list" }).click();
    await expect(page.locator(`[data-session-row="${VIEW}"]`)).toHaveCount(1);
    await page
      .getByRole("dialog", { name: "Working folders and sessions" })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.goto(`${web.url}#/hosts`);
    const workspaceRow = page.locator('[data-cluster-workspace-id="workspace-a"]');
    await expect(workspaceRow).toHaveCount(1);
    await expect(workspaceRow).toHaveAttribute("data-cluster-host-id", HOST);
    await expect(workspaceRow).toContainText("t4-workspaces-rwx");
    await expect(page.getByRole("heading", { name: "Cluster workspaces" })).toBeVisible();

    const creationHost = page.getByLabel("Creation host");
    const createWorkspace = page.getByRole("button", { name: "Create cluster workspace" });
    await expect(creationHost).toHaveValue("");
    await expect(createWorkspace).toBeDisabled();
    await creationHost.selectOption(HOST);
    await expect(creationHost).toHaveValue(HOST);
    await expect(createWorkspace).toBeEnabled();

    const ciLink = page.getByRole("link", { name: "Open CI pipeline" });
    await expect(ciLink).toHaveAttribute(
      "href",
      "https://ci.tailnet.ts.net/repos/repo-a/pipeline/42",
    );
    const openGui = page.getByRole("button", { name: "Open GUI" });
    const runCi = page.getByRole("button", { name: "Run CI" });
    await expect(openGui).toBeEnabled();
    await expect(runCi).toBeEnabled();
    for (const control of [creationHost, createWorkspace, openGui, runCi]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(43.99);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await runCi.click();
    await expect.poll(() => wire.commands.some((frame) => frame.command === "ci.run")).toBe(true);
    expect(wire.commands.findLast((frame) => frame.command === "ci.run")).toMatchObject({
      hostId: HOST,
      sessionId: SESSION,
      expectedRevision: "session-r3",
      args: {
        provider: "woodpecker",
        action: "run",
        repositoryId: "repo-a",
        ref: "refs/heads/main",
        commit: "0123456789abcdef",
      },
    });

    await openGui.click();
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Preview", exact: true }),
    ).toHaveValue("preview-a");
    await expect(page.getByRole("textbox", { name: "URL" })).toHaveValue(GUI_PREVIEW.url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(
      Number.parseFloat(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-fast").trim(),
        ),
      ),
    ).toBe(0);
    await recordScenario(
      page,
      "mobile-viewport",
      [
        "mobile.wss-only",
        "workspace.host-selected",
        "ci.route-qualified",
        "gui.preview-selected",
        "motion.reduced",
        "touch.target",
      ],
      "mobile",
    );
  });

  test("phone Browser Preview gates input through lease/revision and denies cross-session GUI routes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSession(page, true);
    await page.goto(`${web.url}#/hosts`);
    await page.getByRole("button", { name: "Open GUI" }).click();
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    await page.getByRole("textbox", { name: "Text" }).fill("hello from phone");
    await page.getByRole("button", { name: "Type", exact: true }).click();
    await expect.poll(() => wire.commands.some((frame) => frame.command === "preview.lease.acquire")).toBe(true);
    await expect.poll(() => wire.commands.some((frame) => frame.command === "preview.type")).toBe(true);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    await page.goto(`${web.url}#/sessions/${encodeURIComponent(`${HOST}/other-session`)}/preview`);
    await expect(page.getByRole("heading", { name: "Browser preview" })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Browser preview" })).toBeVisible();
    await recordScenario(
      page,
      "gui-auth-isolation",
      ["preview.lease-gated", "preview.input-forwarded", "cross-session.denied"],
      "mobile",
    );
  });
});
