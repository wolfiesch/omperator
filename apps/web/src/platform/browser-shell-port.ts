// Browser-direct shell port: implements DesktopShellPort by wrapping a single
// OmpClient connected over a browser WebSocket to the OMP appserver. This is
// the browser counterpart to the Electron preload bridge — instead of
// ipcRenderer, it uses OmpClient directly.
//
// The browser counterpart connects to ONE preconfigured appserver endpoint.
// It exposes that endpoint as a single "remote" target; it never manages
// the local service lifecycle.
//
// Configuration comes from a validated JSON <script id="t4-backend"> payload
// or explicit query parameters. An ordinary page URL is never used as an
// implicit backend endpoint.
import {
  createOmpClient,
  isConfirmationDecisionConsumed,
  type OmpClient,
  type OmpClientOptions,
  type OmpTransport,
  type Unsubscribe,
} from "@t4-code/client";
import {
  ADDITIVE_FEATURES,
  DEVICE_CAPABILITIES,
  PROTOCOL_VERSION,
  deviceToken as validateDeviceToken,
  type WelcomeFrame,
} from "@t4-code/protocol";
import type {
  BootstrapResult,
  CommandRequest,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  ConnectionStateEvent,
  ConnectResult,
  DesktopTarget,
  DisconnectResult,
  PairRequest,
  PairResult,
  PairLinkEvent,
  PairLinksDrainResult,
  RendererServerFrameEvent,
  RuntimeErrorEvent,
  TargetAddRequest,
  TargetAddResult,
  TargetListResult,
  TargetRemoveResult,
  TargetRequest,
  TerminalCloseRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
import type { DesktopShellPort } from "@t4-code/client";

import { BrowserWebSocketTransport } from "./browser-transport.ts";

const TARGET_ID = "remote";

const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 128;
const MAX_DEVICE_ID_LENGTH = 256;

export interface BrowserBackendConfig {
  readonly wsUrl: string;
  readonly label: string;
  readonly deviceId?: string;
  readonly deviceToken?: string;
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`invalid browser backend ${name}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) throw new Error(`invalid browser backend ${name}`);
  }
  return value;
}

function validatedWsUrl(value: unknown): string {
  const text = boundedText(value, "wsUrl", MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("invalid browser backend wsUrl");
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.username !== "" || parsed.password !== "") {
    throw new Error("invalid browser backend wsUrl");
  }
  return parsed.toString();
}

function parseBackendPayload(value: unknown): BrowserBackendConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid browser backend payload");
  }
  const data = value as Record<string, unknown>;
  const wsUrl = validatedWsUrl(data.wsUrl);
  const label = data.label === undefined ? "OMP Appserver" : boundedText(data.label, "label", MAX_LABEL_LENGTH);
  const auth = data.auth;
  let deviceId = data.deviceId;
  let deviceToken = data.deviceToken ?? data.token;
  if (auth !== undefined) {
    if (auth === null || typeof auth !== "object" || Array.isArray(auth)) throw new Error("invalid browser backend auth");
    const authData = auth as Record<string, unknown>;
    if (deviceId === undefined) deviceId = authData.deviceId;
    if (deviceToken === undefined) deviceToken = authData.deviceToken ?? authData.token;
  }
  if ((deviceId === undefined) !== (deviceToken === undefined)) throw new Error("incomplete browser backend auth");
  return {
    wsUrl,
    label,
    ...(deviceId === undefined ? {} : { deviceId: boundedText(deviceId, "deviceId", MAX_DEVICE_ID_LENGTH) }),
    ...(deviceToken === undefined ? {} : { deviceToken: validateDeviceToken(deviceToken, "deviceToken") }),
  };
}

function hasExplicitQueryConfig(params: URLSearchParams): boolean {
  return ["wsUrl", "backend", "backendUrl", "t4-backend", "label"].some((key) => params.has(key));
}

export function detectBackend(): BrowserBackendConfig | null {
  if (typeof document !== "undefined") {
    const script = document.getElementById("t4-backend");
    if (script !== null) {
      if (script.textContent === null || script.textContent.trim() === "") throw new Error("invalid browser backend payload");
      let data: unknown;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        throw new Error("invalid browser backend payload");
      }
      return parseBackendPayload(data);
    }
  }
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (["deviceId", "deviceToken", "token"].some((key) => params.has(key))) throw new Error("browser auth must not be supplied in query parameters");
  if (!hasExplicitQueryConfig(params)) return null;
  const wsUrl = params.get("wsUrl") ?? params.get("backend") ?? params.get("backendUrl") ?? params.get("t4-backend");
  if (wsUrl === null) throw new Error("browser backend wsUrl is required");
  return parseBackendPayload({
    wsUrl,
    ...(params.get("label") === null ? {} : { label: params.get("label") }),
  });
}


// --------------------------------------------------------------------------- shell port

interface StateListener { (event: ConnectionStateEvent): void; }
interface FrameListener { (event: RendererServerFrameEvent): void; }
interface ErrorListener { (event: RuntimeErrorEvent): void; }
interface PairLinkListener { (event: PairLinkEvent): void; }

export interface BrowserShellPortOptions {
  readonly clientFactory?: (options: OmpClientOptions) => OmpClient;
}

export function createBrowserShellPort(options: BrowserShellPortOptions = {}): DesktopShellPort | null {

  const config = detectBackend();
  if (config === null) return null;
  const backendConfig = config;

  const platform: "linux" | "darwin" = (() => {
    if (typeof navigator !== "undefined" && /mac/i.test(navigator.platform)) return "darwin";
    return "linux";
  })();

  // We hold one OmpClient for one explicitly configured remote target.
  let client: OmpClient | undefined;
  let transport: BrowserWebSocketTransport | undefined;
  let welcome: WelcomeFrame | undefined;
  let connectionState: DesktopTarget["state"] = "disconnected";
  let authentication: { deviceId: string; deviceToken: string } | undefined =
    backendConfig.deviceId === undefined || backendConfig.deviceToken === undefined
      ? undefined
      : { deviceId: backendConfig.deviceId, deviceToken: backendConfig.deviceToken };
  const browserDeviceId = backendConfig.deviceId ?? `browser-${Date.now().toString(36)}`;

  const frameListeners = new Set<FrameListener>();
  const stateListeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  const pairLinkListeners = new Set<PairLinkListener>();

  function emitState(targetId: string, state: DesktopTarget["state"]): void {
    connectionState = state;
    const event: ConnectionStateEvent = { targetId, state };
    for (const listener of stateListeners) listener(event);
  }

  function emitError(targetId: string | undefined, code: RuntimeErrorEvent["code"], message: string): void {
    const event: RuntimeErrorEvent = { ...(targetId === undefined ? {} : { targetId }), code, message };
    for (const listener of errorListeners) listener(event);
  }

  function emitFrame(targetId: string, frame: RendererServerFrameEvent["frame"]): void {
    const event: RendererServerFrameEvent = { targetId, frame };
    for (const listener of frameListeners) listener(event);
  }

  function buildClient(): OmpClient {
    const transportFactory = async (): Promise<OmpTransport> => {
      transport = new BrowserWebSocketTransport({ url: backendConfig.wsUrl });
      await transport.open();
      return transport;
    };

    const c = (options.clientFactory ?? createOmpClient)({
      transport: transportFactory,
      capabilities: DEVICE_CAPABILITIES,
      requestedFeatures: ADDITIVE_FEATURES,
      authentication: () => authentication,
      privilegedPairResult: (result) => {
        authentication = { deviceId: result.deviceId, deviceToken: result.deviceToken };
      },
      client: {
        name: "T4 Code",
        version: "0.1.8",
        build: "browser",
        platform: platform === "darwin" ? "darwin" : "linux",
      },
      reconnect: { attemptCap: 12, baseMs: 250, maxMs: 10_000 },
    });

    c.onFrame((frame) => {
      if (frame.type === "welcome") welcome = frame;
      emitFrame(TARGET_ID, frame);
    });

    c.onState((snapshot) => {
      const stateMap: Record<string, DesktopTarget["state"]> = {
        idle: "disconnected",
        connecting: "connecting",
        handshaking: "connecting",
        pairing: "pairing-required",
        ready: "connected",
        "reconnect-wait": "connecting",
        closing: "disconnected",
        closed: "disconnected",
        fatal: "error",
      };
      const newState = stateMap[snapshot.state] ?? "disconnected";
      if (newState !== connectionState) emitState(TARGET_ID, newState);
    });

    c.onError((error) => {
      const code: RuntimeErrorEvent["code"] = error.code === "protocol" ? "protocol" : "transport";
      emitError(TARGET_ID, code, error.message);
    });

    return c;
  }


  // ------------------------------------------------------------------ shell port

  const shell: DesktopShellPort = {
    kind: "desktop" as const,
    platform,

    async bootstrap(): Promise<BootstrapResult> {
      // The desktop runtime controller owns the first connect call. Keeping
      // bootstrap side-effect free is important here: browser startup also
      // calls connectTarget, and two concurrent OmpClient.connect() calls can
      // race before the first transport has moved out of the idle state.
      if (client === undefined) {
        client = buildClient();
      }
      return {
        platform,
        version: PROTOCOL_VERSION,
        connected: false,
      };
    },

    async connect(_request: TargetRequest): Promise<ConnectResult> {
      if (client === undefined) {
        client = buildClient();
      }
      // connect() is idempotent — it calls connection.begin() if idle
      void client.connect().catch(() => { /* state callback handles errors */ });
      return { targetId: TARGET_ID, state: "connecting" };
    },

    async disconnect(_request: TargetRequest): Promise<DisconnectResult> {
      if (client !== undefined) {
        await client.close();
        client = undefined;
        transport = undefined;
        welcome = undefined;
      }
      emitState(TARGET_ID, "disconnected");
      return { targetId: TARGET_ID, state: "disconnected" };
    },

    async command(request: CommandRequest): Promise<CommandResult> {
      if (client === undefined || client.state !== "ready") {
        throw new Error("not connected");
      }
      const result = await client.command(request.intent);
      if (typeof result.commandId !== "string") throw new Error("invalid command response");
      return {
        targetId: request.targetId,
        requestId: String(result.requestId),
        commandId: result.commandId,
        accepted: result.ok,
        ...(result.result === undefined ? {} : { result: result.result }),
      };
    },

    async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
      if (client === undefined || client.state !== "ready") {
        throw new Error("not connected");
      }
      const result = await client.confirm({
        confirmationId: request.confirmationId,
        commandId: request.commandId,
        hostId: request.hostId,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        decision: request.decision,
      });
      return {
        targetId: request.targetId,
        requestId: String(result.requestId),
        confirmationId: request.confirmationId,
        commandId: request.commandId,
        accepted: isConfirmationDecisionConsumed(result),
      };
    },

    async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> {
      if (client === undefined || client.state !== "ready") {
        throw new Error("not connected");
      }
      client.terminalInput({
        hostId: request.hostId,
        sessionId: request.sessionId,
        terminalId: request.terminalId,
        data: request.data,
        ...(request.encoding === undefined ? {} : { encoding: request.encoding }),
      });
      return { targetId: request.targetId, accepted: true };
    },

    async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> {
      if (client === undefined || client.state !== "ready") {
        throw new Error("not connected");
      }
      client.terminalResize({
        hostId: request.hostId,
        sessionId: request.sessionId,
        terminalId: request.terminalId,
        cols: request.cols,
        rows: request.rows,
      });
      return { targetId: request.targetId, accepted: true };
    },

    async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> {
      if (client === undefined || client.state !== "ready") {
        throw new Error("not connected");
      }
      client.terminalClose({
        hostId: request.hostId,
        sessionId: request.sessionId,
        terminalId: request.terminalId,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      });
      return { targetId: request.targetId, accepted: true };
    },

    async pair(request: PairRequest): Promise<PairResult> {
      if (client === undefined || client.state !== "pairing") throw new Error("not ready to pair");
      const result = await client.pairStart({
        code: request.code,
        deviceId: browserDeviceId,
        deviceName: "T4 Browser",
        platform,
        requestedCapabilities: DEVICE_CAPABILITIES,
      });
      return { targetId: request.targetId, paired: result.type === "pair.ok" };
    },

    async drainPairLinks(): Promise<PairLinksDrainResult> {
      return { links: [] };
    },

    // Browser mode never exposes local service lifecycle controls.

    // Target management: browser mode has exactly one preconfigured remote target.
    async listTargets(): Promise<TargetListResult> {
      const targets: DesktopTarget[] = [{
        targetId: TARGET_ID,
        label: backendConfig.label,
        kind: "remote",
        state: connectionState,
        paired: authentication !== undefined || welcome?.authentication === "paired",
      }];
      return { targets };
    },

    async addTarget(_request: TargetAddRequest): Promise<TargetAddResult> {
      throw new Error("browser mode does not support adding targets");
    },

    async removeTarget(_request: TargetRequest): Promise<TargetRemoveResult> {
      throw new Error("browser mode does not support removing targets");
    },

    async connectTarget(request: TargetRequest): Promise<ConnectResult> {
      return this.connect(request);
    },

    async disconnectTarget(request: TargetRequest): Promise<DisconnectResult> {
      return this.disconnect(request);
    },

    onServerFrame(listener: FrameListener): Unsubscribe {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },

    onConnectionState(listener: StateListener): Unsubscribe {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    onRuntimeError(listener: ErrorListener): Unsubscribe {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },

    onPairLink(listener: PairLinkListener): Unsubscribe {
      pairLinkListeners.add(listener);
      return () => pairLinkListeners.delete(listener);
    },
  };

  return shell;
}
