/**
 * enclave — an omp extension: `/collab`, but with a control channel for the
 * Enclave iOS app (per-session model / thinking / slash / rewind) and, later,
 * push. It hosts a *superset* of the collab protocol itself, so omp core is
 * never touched.
 *
 * Self-contained on purpose: the installed omp is a compiled binary, so this
 * imports nothing from omp internals. The seal/link/envelope below are the same
 * scheme as omp's collab codec (verified against packages/collab-web/src/lib),
 * and the runtime (bun) provides crypto.subtle + WebSocket. The transcript comes
 * from ctx.sessionManager; control uses confirmed ctx methods.
 *
 *   Load for dev:   omp -e /home/alexis/dev/Enclave/plugin/enclave.ts
 *   Then in omp:    /enclave           (prints the link the app joins)
 *   Relay:          $ENCLAVE_RELAY (default wss://wickrunner.com:8443)
 *
 * Protocol (matches Sources/EngineBridge.swift + the mock host):
 *   host→guest  welcome / snapshot-chunk / entry / state / event / enclave-caps / enclave-result / ui-request
 *   guest→host  hello / prompt / abort / enclave-cmd / ui-response
 */

import { readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { arch, cpus, homedir, hostname, totalmem } from "node:os";

const COLLAB_PROTO = 3;
const ROOM_ID_BYTES = 16;
const WRITE_TOKEN_BYTES = 16;
const IV = 12;
const envRelay = process.env.ENCLAVE_RELAY;
const RELAY = typeof envRelay === "string" ? envRelay : "wss://wickrunner.com:8443";

// ── base64url / crypto / envelope (mirror of omp's collab codec) ──────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

const MOBILE_HIDE: Record<string, true> = {
  enclave: true,
  collab: true,
  vim: true,
  theme: true,
  keybindings: true,
  quit: true,
  exit: true,
  help: true,
};
function rand(n: number): Uint8Array { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function b64url(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
async function seal(key: CryptoKey, frame: unknown): Promise<Uint8Array> {
  const iv = rand(IV);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(frame))));
  const out = new Uint8Array(IV + ct.byteLength); out.set(iv, 0); out.set(ct, IV); return out;
}
async function open(key: CryptoKey, data: Uint8Array): Promise<unknown> {
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, IV) }, key, data.subarray(IV)));
  return JSON.parse(dec.decode(pt)) as unknown;
}
function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + sealed.byteLength); new DataView(out.buffer).setUint32(0, peerId, false); out.set(sealed, 4); return out;
}
function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < 4) return null;
  return { peerId: new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false), payload: data.subarray(4) };
}
function formatLink(roomId: string, key: Uint8Array, token: Uint8Array): string {
  const secret = new Uint8Array(key.byteLength + token.byteLength); secret.set(key, 0); secret.set(token, key.byteLength);
  const host = RELAY.replace(/^wss?:\/\//, "");
  return `${RELAY.startsWith("ws://") ? "ws://" : "wss://"}${host}/r/${roomId}.${b64url(secret)}`;
}

/** Constant-time string equality for secrets (length check + XOR accumulate). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read-only variant of the share link: bare room key, no write token. */
function formatViewLink(roomId: string, key: Uint8Array): string {
  const host = RELAY.replace(/^wss?:\/\//, "");
  return `${RELAY.startsWith("ws://") ? "ws://" : "wss://"}${host}/r/${roomId}.${b64url(key)}`;
}

// ── domain types for the omp runtime contract (no external type imports) ──────

interface Header {
  title?: string;
  cwd?: string;
  id?: string;
}

interface Snapshot {
  header: Header;
  entries: unknown[];
}

interface Models {
  current?: () => unknown;
  list?: () => unknown[];
  resolve?: (id: unknown) => unknown;
}

interface SessionManager {
  snapshotForReplication?: () => Snapshot;
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
  getCwd?: () => string;
  onEntryAppended?: unknown;
}

type ShowPlanReviewFn = (this: unknown, planContent: string, title: string, options: string[], dialogOptions?: unknown, extra?: unknown) => Promise<string | undefined>;
type SelectFn = (this: unknown, title: string, options: unknown[], dialogOptions?: Record<string, unknown>) => Promise<string | undefined>;
type EditorFn = (this: unknown, title: string, prefill?: string, dialogOptions?: Record<string, unknown>, editorOptions?: Record<string, unknown>) => Promise<string | undefined>;

interface Runtime {
  registerCommand?: (name: string, cmd: { description?: string; handler: (args: string, cmdCtx: unknown) => unknown }) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
  sendMessage?: (msg: { customType?: string; content?: string; display?: boolean; attribution?: string }) => void;
  sessionManager?: SessionManager;
  models?: Models;
  getThinkingLevel?: () => unknown;
  getContextUsage?: () => unknown;
  getCommands?: () => unknown[];
  setModel?: (model: unknown) => boolean | Promise<boolean>;
  setThinkingLevel?: (level: unknown) => unknown;
  abort?: () => unknown;
  sendUserMessage?: (content: unknown) => unknown;
  navigateTree?: (toEntryId: unknown) => unknown;
  cwd?: string;
  hostName?: string;
  isStreaming?: boolean;
  ui?: { write?: (msg: string) => void; select?: SelectFn; editor?: EditorFn };
  runtime?: { getAllTools?: () => string[] };
  pi?: {
    InteractiveMode?: {
      prototype?: {
        showPlanReview?: ShowPlanReviewFn;
      };
    };
  };
  [key: string]: unknown;
}

interface WebSocketWithBinary {
  binaryType: "blob" | "arraybuffer";
}

// ── the extension ─────────────────────────────────────────────────────────────

// One share per omp process. Re-running /enclave returns the existing share
// instead of opening a second relay socket + duplicate handlers (which crashed).
// The share is bound to one sessionId; session switches tear it down via
// stopShare() and start a fresh one.
let current: { link: string; token: string; send: (frame: unknown, peer?: number) => Promise<void>; peers: Map<number, string>; ws: WebSocket; sessionId: string; nodeId: string; stopped: boolean } | null = null;

let uiReqSeq = 0;
type GuestUiResult = { kind: "answered"; value: string | undefined } | { kind: "unavailable" };
const pendingUi = new Map<number, { resolve: (value: GuestUiResult) => void; request: Record<string, unknown>; onFeedbackChange?: (value: string) => void; onSliderChange?: (index: number) => void; }>();
let originalShowPlanReview: ShowPlanReviewFn | undefined;

// The activation api carries the runtime-bound ACTIONS (sendUserMessage, abort,
// setModel, on, …). The per-invocation ctx (command/hook) carries the session
// data (sessionManager, models, navigateTree) but NOT the actions. So we route
// actions through `api` and session data through `ctx`.
const uiOriginals = new WeakMap<object, { select?: SelectFn; editor?: EditorFn }>();
let api: Runtime | undefined;

// Return a bound caller for `name`, preferring ctx then the activation api.
// IMPORTANT: the returned closure invokes the method AS a member (obj.name(...))
// so `this` stays bound — extracting the fn and calling it standalone crashes
// omp with "undefined is not an object (evaluating 'this.extension')".
function bound(ctx: Runtime, name: string): ((...args: unknown[]) => unknown) | undefined {
  const fn = ctx[name];
  if (typeof fn === "function") return (...args: unknown[]) => fn.call(ctx, ...args) as unknown;
  if (api) {
    const afn = api[name];
    if (typeof afn === "function") return (...args: unknown[]) => afn.call(api, ...args) as unknown;
  }
  return undefined;
}

export default function activate(ctx: unknown): void {
  // omp passes the activation API as a stable runtime contract.
  const runtime = ctx as unknown as Runtime;
  api = runtime;
  runtime.registerCommand?.("enclave", {
    description: "Share this session to the Enclave app (collab + control channel)",
    handler: (_args: string, cmdCtx: unknown) => startShare(cmdCtx),
  });
  // Auto-sharing is ON by default so every session is visible to the native
  // apps with zero setup; ENCLAVE_SHARE=0 opts out. (~/.omp/enclave-share
  // used to be the opt-in marker; it is now redundant and ignored.)
  if (process.env.ENCLAVE_SHARE !== "0") {
    runtime.on?.("session_start", (_e: unknown, hookCtx: unknown) => startShare(hookCtx ?? ctx));
    runtime.on?.("session_switch", (_e: unknown, hookCtx: unknown) => {
      // A resume (/resume) or new (/new) session inside this process must
      // move the share: each room is bound to one sessionId, and a stale
      // registration keeps the previous session visible (or streams the new
      // session's entries into the old room).
      stopShare();
      startShare(hookCtx ?? ctx);
    });
  }
  installPlanReview();
  installAsk(runtime);
}

/** Find the session JSONL this process has open, via /proc/self/fd. Covers
 * harness-spawned runtimes whose extension ctx exposes neither getSessionFile
 * nor getSessionId. Linux-only; returns undefined elsewhere. */
function discoverSessionFileFromFds(): string | undefined {
  try {
    for (const fd of readdirSync("/proc/self/fd")) {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (target.endsWith(".jsonl") && target.includes("/sessions/")) return target;
    }
  } catch {}
  return undefined;
}

let currentPublish: (() => void) | undefined;
let shareHeartbeat: ReturnType<typeof setInterval> | undefined;

/** Tear down the live share: close its relay socket, deregister its room,
 * and clear pending guest dialogs. Safe to call when no share is live. */
function stopShare(): void {
  const share = current;
  if (!share) return;
  share.stopped = true;
  current = null;
  currentPublish = undefined;
  try {
    share.ws.close();
  } catch {}
  if (share.sessionId) {
    void gatewayCall(`/v1/nodes/${encodeURIComponent(share.nodeId)}/rooms/${encodeURIComponent(share.sessionId)}`, "DELETE");
  }
  for (const p of pendingUi.values()) p.resolve({ kind: "unavailable" });
  pendingUi.clear();
}

// ---- Gateway registration (push model) -------------------------------------
// The runtime tells the Tailscale gateway it is up: node announce + one room
// registration per shared session, refreshed every 30s. The gateway expires
// entries 90s after the last heartbeat — no session files are scanned.
const GATEWAY_BASE = process.env.ENCLAVE_GATEWAY_URL ?? "http://127.0.0.1:4194";
let gatewayToken = "";
function loadGatewayToken(): string {
  if (gatewayToken !== "") return gatewayToken;
  const fromEnv = process.env.ENCLAVE_GATEWAY_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") {
    gatewayToken = fromEnv;
    return fromEnv;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const candidates: string[] = [];
  if (runtimeDir !== undefined && runtimeDir !== "") candidates.push(join(runtimeDir, "omp", "enclave-token"));
  candidates.push(join(homedir(), ".omp", "enclave-token"));
  for (const candidate of candidates) {
    try {
      const token = readFileSync(candidate, "utf8").trim();
      if (token.length >= 16) {
        gatewayToken = token;
        return token;
      }
    } catch {
      // try the next candidate
    }
  }
  return "";
}
async function gatewayCall(path: string, method: "POST" | "DELETE", payload?: unknown): Promise<void> {
  const token = loadGatewayToken();
  if (token === "") return; // no gateway configured yet — the heartbeat retries
  try {
    await fetch(`${GATEWAY_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    try {
      process?.stderr?.write?.(`enclave: gateway ${method} ${path} failed: ${String(err)}
`);
    } catch {
      // stderr unavailable
    }
  }
}
function nodeAnnouncement(): Record<string, unknown> {
  return {
    nodeId: hostname(),
    hostname: hostname(),
    arch: arch(),
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    version: process.env.OMP_VERSION ?? "",
  };
}
/** Title from the session transcript's first line ({type:"title"|"session",title}). */
function sessionTitleFromFile(file: string | undefined): string {
  if (!file) return "";
  try {
    const firstLine = readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const parsed = JSON.parse(firstLine) as { type?: string; title?: unknown };
    if ((parsed.type === "title" || parsed.type === "session") && typeof parsed.title === "string") {
      return parsed.title;
    }
  } catch {
    // unreadable or not yet written — registration carries an empty title
  }
  return "";
}
/** Harness contexts (no sessionManager) still get a full transcript replay:
 * read the session jsonl directly and project wire entry types. */
function transcriptSnapshotFromFile(): { header: Record<string, unknown>; entries: unknown[] } | undefined {
  const file = discoverSessionFileFromFds();
  if (!file) return undefined;
  const header: Record<string, unknown> = { type: "session", id: "", title: "", cwd: "", timestamp: new Date().toISOString() };
  const entries: unknown[] = [];
  const wireTypes = new Set(["message", "custom_message", "compaction", "branch_summary", "model_change", "thinking_level_change", "session_created"]);
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (raw === null || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      if (rec.type === "title") {
        if (typeof rec.title === "string") header.title = rec.title;
        continue;
      }
      if (rec.type === "session") {
        if (typeof rec.id === "string") header.id = rec.id;
        if (typeof rec.title === "string") header.title = rec.title;
        if (typeof rec.cwd === "string") header.cwd = rec.cwd;
        continue;
      }
      if (typeof rec.type === "string" && wireTypes.has(rec.type)) entries.push(rec);
    }
    if (entries.length === 0 && header.title === "") return undefined;
    return { header, entries };
  } catch {
    return undefined;
  }
}

/** One per-process timer that re-registers with the gateway while a share is
 * live — the gateway expires entries 90s after the last heartbeat. The timer
 * calls whatever share is currently live (a session switch swaps the publish
 * closure without restarting the timer). */
function ensureShareHeartbeat(): void {
  if (shareHeartbeat) return;
  shareHeartbeat = setInterval(() => {
    if (current === null) return;
    currentPublish?.();
  }, 30_000);
}

async function startShare(rawCtx: unknown): Promise<string> {
  const ctx = rawCtx as unknown as Runtime; // omp command context is a stable runtime contract
  installAsk(ctx);
  if (current) return current.link;

  const roomId = b64url(rand(ROOM_ID_BYTES));
  const rawKey = rand(32);
  const writeToken = rand(WRITE_TOKEN_BYTES);
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  const link = formatLink(roomId, rawKey, writeToken);
  const shareToken = b64url(rand(32)); // guest auth token for this share (never embedded in the link)

  const peers = new Map<number, string>();
  let reconnectAttempt = 0;
  const connect = (): WebSocket => {
    const ws = new WebSocket(`${RELAY}/r/${roomId}?role=host`);
    const socket = ws as unknown as WebSocketWithBinary;
    socket.binaryType = "arraybuffer";
    return ws;
  };
  let ws = connect();

  const send = async (frame: unknown, peer = 0) => {
    try { ws.send(packEnvelope(peer, await seal(key, frame))); } catch { /* socket closed */ }
  };  const stateFrame = () => ({
    isStreaming: !!ctx.isStreaming,
    queuedMessageCount: 0,
    sessionName: snapHeader?.title,
    cwd: snapHeader?.cwd ?? ctx.cwd,
    model: ctx.models?.current?.(),
    thinkingLevel: ctx.getThinkingLevel?.(),
    contextUsage: ctx.getContextUsage?.(),
    participants: [{ name: ctx.hostName ?? "host", role: "host" }, ...[...peers.values()].map(name => ({ name, role: "guest" }))],
  });
  let snapHeader: Header | undefined;

  // Resolve the session identity before publishing: the share object carries
  // it so stopShare() deregisters the exact room on a session switch.
  const sessionFileForShare = ctx.sessionManager?.getSessionFile?.() ?? discoverSessionFileFromFds();
  const sessionIdForShare = ctx.sessionManager?.getSessionId?.()
    ?? (sessionFileForShare?.endsWith(".jsonl") ? sessionFileForShare.slice(0, -".jsonl".length).split("_").pop() ?? "" : "");
  const nodeId = hostname();

  current = { link, token: shareToken, send, peers, ws, sessionId: sessionIdForShare, nodeId, stopped: false };

  // Register with the Tailscale gateway (push model): node announce + room.
  // The gateway serves /v1/rooms from these registrations; nothing on disk is
  // scanned. The 30s heartbeat keeps both entries fresh; stopping the share
  // deregisters the room.
  const roomRegistration = () => ({
    sessionId: sessionIdForShare,
    title: sessionTitleFromFile(sessionFileForShare) ?? snapHeader?.title ?? "",
    roomId,
    link,
    token: shareToken,
  });
  const registerWithGateway = () => {
    void gatewayCall("/v1/nodes", "POST", nodeAnnouncement());
    if (sessionIdForShare) {
      void gatewayCall(`/v1/nodes/${encodeURIComponent(nodeId)}/rooms`, "POST", roomRegistration());
    }
  };
  currentPublish = registerWithGateway;
  registerWithGateway();
  ensureShareHeartbeat();
  // Diagnostics: what the harness ctx exposes (for debugging discovery gaps).
  try {
    writeFileSync(
      `/tmp/enclave-ctx-${process.pid}.json`,
      JSON.stringify({
        hasSessionManager: !!ctx.sessionManager,
        hasGetSessionFile: typeof ctx.sessionManager?.getSessionFile,
        hasGetSessionId: typeof ctx.sessionManager?.getSessionId,
        fdSessionFile: sessionFileForShare !== undefined,
        sessionId: sessionIdForShare,
      }),
      "utf8",
    );
  } catch {}

  const attachMessageHandlers = (socket: WebSocket): void => {
    socket.onmessage = async (ev: unknown) => {
      if (ev && typeof ev === "object" && "data" in ev) {
        const data = ev.data;
        if (typeof data === "string") {
          const msg = JSON.parse(data) as unknown;
          if (msg && typeof msg === "object" && "t" in msg && typeof msg.t === "string") {
            if (msg.t === "peer-left" && "peer" in msg && typeof msg.peer === "number") {
              peers.delete(msg.peer);
            }
          }
          return;
        }
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const env = unpackEnvelope(new Uint8Array(data));
          if (!env) return;
          let frame: unknown;
          try { frame = await open(key, env.payload); } catch { return; }
          await onGuestFrame(frame, env.peerId);
        }
      }
    };
    socket.onclose = () => {
      if (share.stopped) {
        // stopShare() already deregistered the room and cleared guests.
        return;
      }
      // Transient drop (relay restart, idle timeout): re-register the room
      // with the same id/key/token. Rooms are in-memory relay state — without
      // this a single blip kills the share until the runtime restarts.
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000) * (0.75 + Math.random() * 0.5);
      reconnectAttempt += 1;
      setTimeout(() => {
        if (share.stopped) return;
        try {
          ws = connect();
          share.ws = ws;
          attachMessageHandlers(ws);
          registerWithGateway();
        } catch {}
      }, delay);
    };
  };
  attachMessageHandlers(ws);

  /** Send the snapshot as a 512KB-chunk train like the upstream collab host.
   * One giant frame blows past the relay's frame cap and kills the guest
   * connection right after the welcome (the "drops shortly after join"
   * symptom on phones). */
  async function sendSnapshot(target: number | null, snap: Snapshot): Promise<void> {
    const CHUNK_BYTES = 512 * 1024;
    let chunk: unknown[] = [];
    let size = 0;
    for (const entry of snap.entries) {
      const enc = JSON.stringify(entry);
      if (size + enc.length > CHUNK_BYTES && chunk.length > 0) {
        await send({ t: "snapshot-chunk", entries: chunk, final: false }, target);
        chunk = [];
        size = 0;
      }
      chunk.push(entry);
      size += enc.length;
    }
    await send({ t: "snapshot-chunk", entries: chunk, final: true }, target);
  }

  async function onGuestFrame(frame: unknown, peer: number): Promise<void> {
    if (!frame || typeof frame !== "object") return;
    const f = frame;
    if (!("t" in f) || typeof f.t !== "string") return;
    switch (f.t) {
      case "hello": {
        const presented = "enclaveToken" in f && typeof f.enclaveToken === "string" ? f.enclaveToken : null;
        if (presented === null || !timingSafeEqual(presented, shareToken)) {
          await send({ t: "error", message: "not authorized" }, peer);
          return;
        }
        const name = "name" in f && typeof f.name === "string" ? f.name : "";
        peers.set(peer, (name || `guest-${peer}`).slice(0, 64));
        const snap = ctx.sessionManager?.snapshotForReplication?.() ?? transcriptSnapshotFromFile();
        if (!snap) return;
        snapHeader = snap.header;
        await send({ t: "welcome", proto: COLLAB_PROTO, header: snap.header, state: stateFrame(), agents: [], entryCount: snap.entries.length }, peer);
        await sendSnapshot(peer, snap);
        await send(buildCaps(ctx), peer);
        await send({ t: "state", state: stateFrame() }, peer);
        for (const pending of pendingUi.values()) {
          await send({ t: "ui-request", request: pending.request }, peer);
        }
        return;
      }
      case "prompt": {
        const text = "text" in f && typeof f.text === "string" ? f.text : "";
        const images: unknown[] = [];
        if ("images" in f && Array.isArray(f.images)) {
          for (const im of f.images) {
            if (im && typeof im === "object" && "type" in im && im.type === "image" && "data" in im && typeof im.data === "string" && "mimeType" in im && typeof im.mimeType === "string") {
              images.push({ type: "image", data: im.data, mimeType: im.mimeType });
            }
          }
        }
        const content = images.length ? [{ type: "text", text }, ...images] : text;
        bound(ctx, "sendUserMessage")?.(content);
        return;
      }
      case "abort":
        bound(ctx, "abort")?.();
        return;
      case "ui-response": {
        if (!("reqId" in f) || typeof f.reqId !== "number") return;
        const pending = pendingUi.get(f.reqId);
        if (!pending) return;
        pendingUi.delete(f.reqId);
        const value = "value" in f ? f.value : undefined;
        let choice: string | undefined;
        let feedback: string | undefined;
        let sliderIndex: number | undefined;
        if (typeof value === "string") {
          if (typeof pending.request.kind === "string" && pending.request.kind === "plan") {
            try {
              const parsed = JSON.parse(value) as unknown;
              if (parsed && typeof parsed === "object") {
                const d = parsed;
                if ("choice" in d && typeof d.choice === "string") choice = d.choice;
                if ("feedback" in d && typeof d.feedback === "string") feedback = d.feedback;
                if ("sliderIndex" in d && typeof d.sliderIndex === "number") sliderIndex = d.sliderIndex;
              } else {
                choice = value;
              }
            } catch {
              choice = value;
            }
          } else {
            choice = value;
          }
        }
        if (feedback !== undefined) pending.onFeedbackChange?.(feedback);
        if (sliderIndex !== undefined) pending.onSliderChange?.(sliderIndex);
        pending.resolve({ kind: "answered", value: choice });
        await send({ t: "ui-request-end", reqId: f.reqId });
        return;
      }
      case "enclave-cmd": {
        if (!("method" in f) || typeof f.method !== "string") return;
        const r = await handleControl(ctx, f.method, "params" in f ? f.params : undefined);
        const resFrame: Record<string, unknown> = { t: "enclave-result", ...r };
        if ("reqId" in f && typeof f.reqId === "number") resFrame.reqId = f.reqId;
        await send(resFrame, peer);
        if (f.method === "rewind" && r.ok && ctx.sessionManager) {
          const snap = ctx.sessionManager.snapshotForReplication();
          snapHeader = snap.header;
          await send({ t: "welcome", proto: COLLAB_PROTO, header: snap.header, state: stateFrame(), agents: [], entryCount: snap.entries.length });
          await sendSnapshot(null, snap);
        }
        return;
      }
    }
  }

  // Live stream to guests: new entries + agent events + state transitions.
  if (ctx.sessionManager) ctx.sessionManager.onEntryAppended = (entry: unknown) => { void send({ t: "entry", entry }); };
  const on = bound(ctx, "on");
  const fwd = (type: string) => (e: unknown) => {
    const event: Record<string, unknown> = { type };
    if (e && typeof e === "object") {
      for (const [k, v] of Object.entries(e)) {
        event[k] = v;
      }
    }
    void send({ t: "event", event });
  };
  for (const ev of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    on?.(ev, fwd(ev));
  }
  on?.("agent_start", () => { void send({ t: "event", event: { type: "agent_start" } }); void send({ t: "state", state: stateFrame() }); });
  on?.("agent_end", () => { void send({ t: "event", event: { type: "agent_end" } }); void send({ t: "state", state: stateFrame() }); });

  return link;
}

function buildCaps(rawCtx: unknown): Record<string, unknown> {
  const ctx = rawCtx as unknown as Runtime;
  const models = ctx.models ?? api?.models;
  const getCommands = bound(ctx, "getCommands");
  const getThinking = bound(ctx, "getThinkingLevel") ?? ctx.getThinkingLevel;
  const current = models?.current?.();
  const list = models?.list?.() ?? [];
  const seesImages = (m: unknown) => {
    if (m && typeof m === "object" && "input" in m) {
      const input = m.input;
      if (Array.isArray(input)) return input.includes("image");
    }
    return false;
  };
  const nativeVision = current ? seesImages(current) : false;
  const inspectImage = (api?.runtime?.getAllTools?.() ?? []).includes("inspect_image");
  const visionModelAvailable = Array.isArray(list) ? list.some((m: unknown) => seesImages(m)) : false;
  const vision = nativeVision || inspectImage;
  const raw = getCommands?.();
  const commands = Array.isArray(raw) ? raw : [];
  const commandList = commands
    .filter((c: unknown) => {
      if (!c || typeof c !== "object") return false;
      const name = "name" in c && typeof c.name === "string" ? c.name : "";
      return name && !(name in MOBILE_HIDE);
    })
    .map((c: unknown) => {
      const name = c && typeof c === "object" && "name" in c && typeof c.name === "string" ? c.name : "";
      const description = c && typeof c === "object" && "description" in c && typeof c.description === "string" ? c.description : "";
      return { name, summary: description };
    });
  const currentModelId = current && typeof current === "object" && "id" in current && typeof current.id === "string" ? current.id : undefined;
  const thinking = getThinking?.();
  const currentThinking = typeof thinking === "string" ? thinking : undefined;
  return {
    t: "enclave-caps",
    version: 1,
    vision,
    nativeVision,
    inspectImage,
    visionModelAvailable,
    thinking: ["minimal", "low", "medium", "high", "xhigh"],
    models: list.map((m: unknown) => {
      const id = m && typeof m === "object" && "id" in m ? m.id : undefined;
      const name = m && typeof m === "object" && "name" in m ? m.name : undefined;
      return { id: typeof id === "string" ? id : String(id), name: typeof name === "string" ? name : String(name), vision: seesImages(m) };
    }),
    commands: commandList,
    current: { model: currentModelId, thinking: currentThinking },
  };
}

async function handleControl(rawCtx: unknown, method: string, params: unknown): Promise<{ ok: boolean; message?: string; data?: string; mimeType?: string }> {
  const ctx = rawCtx as unknown as Runtime;
  try {
    switch (method) {
      case "set-model": {
        if (!params || typeof params !== "object") return { ok: false, message: "params required" };
        const p = params;
        if (!("model" in p) || typeof p.model !== "string") return { ok: false, message: "model required" };
        const models = ctx.models ?? api?.models;
        const model = models?.resolve?.(p.model);
        if (!model) return { ok: false, message: `unknown model ${p.model}` };
        const ok = await bound(ctx, "setModel")?.(model);
        return { ok: ok === true, message: ok === true ? `model → ${p.model}` : "no API key for that model" };
      }
      case "set-thinking": {
        if (!params || typeof params !== "object") return { ok: false, message: "params required" };
        const p = params;
        if (!("level" in p) || typeof p.level !== "string") return { ok: false, message: "level required" };
        await bound(ctx, "setThinkingLevel")?.(p.level);
        return { ok: true, message: `thinking → ${p.level}` };
      }
      case "rewind": {
        if (!params || typeof params !== "object") return { ok: false, message: "params required" };
        const p = params;
        if (!("toEntryId" in p)) return { ok: false, message: "toEntryId required" };
        const r = await bound(ctx, "navigateTree")?.(p.toEntryId);
        let cancelled = false;
        if (r && typeof r === "object" && "cancelled" in r && r.cancelled === true) cancelled = true;
        return { ok: !cancelled, message: cancelled ? "rewind cancelled" : "rewound" };
      }
      case "slash": {
        if (!params || typeof params !== "object") return { ok: false, message: "params required" };
        const p = params;
        if (!("name" in p) || typeof p.name !== "string") return { ok: false, message: "name required" };
        const name = p.name;
        if (name in MOBILE_HIDE) return { ok: false, message: `/${name} isn't available from the app` };
        const raw = bound(ctx, "getCommands")?.();
        const commands = Array.isArray(raw) ? raw : [];
        const cmd = commands.find((c: unknown) => c && typeof c === "object" && "name" in c && typeof c.name === "string" && c.name === name);
        if (!cmd || typeof cmd !== "object" || !("handler" in cmd) || typeof cmd.handler !== "function") {
          return { ok: false, message: `no such command /${name}` };
        }
        const handler = cmd.handler as unknown as (...args: unknown[]) => unknown;
        const args = "args" in p && typeof p.args === "string" ? p.args : "";
        await (handler.call(cmd, args, ctx) as unknown);
        return { ok: true, message: `ran /${name}` };
      }
      case "register-push":
        return { ok: true };
      case "fetch-image": {
        if (!params || typeof params !== "object") return { ok: false, message: "params required" };
        const p = params;
        if (!("path" in p)) return { ok: false, message: "path required" };
        const cwd = ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? ".";
        const path = String(p.path);
        const abs = resolve(cwd, path);
        const st = statSync(abs);
        const MAX = 20 * 1024 * 1024;
        if (st.size > MAX) return { ok: false, message: "image too large (>20MB)" };
        const data = readFileSync(abs);
        const ext = extname(abs).toLowerCase();
        const mimeMap: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        };
        const mimeType = "mimeType" in p && typeof p.mimeType === "string" ? p.mimeType : undefined;
        const mime = mimeType ? mimeType : (mimeMap[ext] ?? "image/png");
        return { ok: true, data: Buffer.from(data).toString("base64"), mimeType: mime };
      }
      default:
        return { ok: false, message: `unknown method ${method}` };
    }
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

// ── plan review wiring ────────────────────────────────────────────────────────

function installPlanReview(): void {
  const IM = api?.pi?.InteractiveMode;
  if (!IM || typeof IM.prototype?.showPlanReview !== "function") return;
  originalShowPlanReview = IM.prototype.showPlanReview;
  IM.prototype.showPlanReview = async function (this: unknown, planContent: string, title: string, options: string[], dialogOptions?: unknown, extra?: unknown): Promise<string | undefined> {
    const share = current;
    if (!share || share.peers.size === 0) {
      if (!originalShowPlanReview) return undefined;
      return originalShowPlanReview.call(this, planContent, title, options, dialogOptions, extra);
    }

    let onFeedbackChange: ((value: string) => void) | undefined;
    let onSliderChange: ((index: number) => void) | undefined;

    if (dialogOptions && typeof dialogOptions === "object") {
      const d = dialogOptions as Record<string, unknown>;
      if ("onFeedbackChange" in d && typeof d.onFeedbackChange === "function") {
        onFeedbackChange = d.onFeedbackChange as unknown as (value: string) => void;
      }
    }

    if (extra && typeof extra === "object") {
      const e = extra as Record<string, unknown>;
      if ("slider" in e && e.slider && typeof e.slider === "object") {
        const s = e.slider as Record<string, unknown>;
        if ("onChange" in s && typeof s.onChange === "function") {
          onSliderChange = s.onChange as unknown as (index: number) => void;
        }
      }
    }

    const request: Record<string, unknown> = {
      kind: "plan",
      title,
      options,
      helpText: planContent,
      selectionMarker: "radio",
    };

    let signal: AbortSignal | undefined;
    if (dialogOptions && typeof dialogOptions === "object") {
      const d = dialogOptions as Record<string, unknown>;
      if ("initialIndex" in d && typeof d.initialIndex === "number") {
        request.initialIndex = d.initialIndex;
      }
      if ("disabledIndices" in d && Array.isArray(d.disabledIndices)) {
        request.disabledIndices = d.disabledIndices.filter((i: unknown): i is number => typeof i === "number");
      }
      if ("signal" in d && d.signal instanceof AbortSignal) {
        signal = d.signal as AbortSignal;
      }
    }

    const result = await requestGuestUi(request, signal, { onFeedbackChange, onSliderChange });
    if (result.kind === "unavailable") {
      if (!originalShowPlanReview) return undefined;
      return originalShowPlanReview.call(this, planContent, title, options, dialogOptions, extra);
    }
    return result.value;
  };
}

// ── ask questionnaire wiring (ctx.ui.select / ctx.ui.editor) ──────────────────

async function requestGuestUi(
  request: Record<string, unknown>,
  signal?: AbortSignal,
  callbacks?: { onFeedbackChange?: (value: string) => void; onSliderChange?: (index: number) => void; },
): Promise<GuestUiResult> {
  const share = current;
  if (!share || share.peers.size === 0) return Promise.resolve({ kind: "unavailable" });
  if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });

  const reqId = ++uiReqSeq;
  request.reqId = reqId;
  const { promise, resolve } = Promise.withResolvers<GuestUiResult>();
  let settled = false;
  let cleanup = () => {};

  const settle = (result: GuestUiResult): void => {
    if (settled) return;
    settled = true;
    cleanup();
    pendingUi.delete(reqId);
    resolve(result);
  };

  if (signal) {
    const onAbort = (): void => {
      void share.send({ t: "ui-request-end", reqId });
      settle({ kind: "unavailable" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  }

  pendingUi.set(reqId, { resolve: settle, request, onFeedbackChange: callbacks?.onFeedbackChange, onSliderChange: callbacks?.onSliderChange });
  await share.send({ t: "ui-request", request });
  return promise;
}
async function raceDialogs(
  local: (signal: AbortSignal | undefined) => Promise<string | undefined>,
  remote: (signal: AbortSignal | undefined) => Promise<GuestUiResult>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const localAbort = new AbortController();
  const remoteAbort = new AbortController();
  const localSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
  const remoteSignal = signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal;

  const localWinner = local(localSignal).then((value): { source: "local"; value: string | undefined } => ({ source: "local", value }));
  const remoteWinner = remote(remoteSignal).then(result =>
    result.kind === "answered" ? { source: "remote" as const, value: result.value } : localWinner,
  );
  const winner = await Promise.race([localWinner, remoteWinner]);
  if (winner.source === "remote") localAbort.abort();
  else remoteAbort.abort();
  return winner.value;
}

const selectWrapper: SelectFn = async function (this: unknown, title, options, dialogOptions): Promise<string | undefined> {
  const original = this && typeof this === "object" ? uiOriginals.get(this as object)?.select : undefined;
  const baseSignal = dialogOptions?.signal instanceof AbortSignal ? (dialogOptions as Record<string, unknown>).signal as AbortSignal : undefined;

  const local = async (signal: AbortSignal | undefined): Promise<string | undefined> => {
    if (!original) return undefined;
    return original.call(this, title, options, { ...dialogOptions, signal });
  };

  const remote = async (signal: AbortSignal | undefined): Promise<GuestUiResult> => {
    const share = current;
    if (!share) return { kind: "unavailable" };
    const request: Record<string, unknown> = { kind: "select", title, options };
    if (dialogOptions && typeof dialogOptions === "object") {
      const d = dialogOptions as Record<string, unknown>;
      if (typeof d.initialIndex === "number") request.initialIndex = d.initialIndex;
      if (typeof d.selectionMarker === "string") request.selectionMarker = d.selectionMarker;
      if (Array.isArray(d.checkedIndices)) request.checkedIndices = d.checkedIndices.filter((i: unknown) => typeof i === "number");
      if (typeof d.markableCount === "number") request.markableCount = d.markableCount;
      if (typeof d.helpText === "string") request.helpText = d.helpText;
    }
    return requestGuestUi(request, signal);
  };

  return raceDialogs(local, remote, baseSignal);
};

const editorWrapper: EditorFn = async function (this: unknown, title, prefill, dialogOptions, editorOptions): Promise<string | undefined> {
  const original = this && typeof this === "object" ? uiOriginals.get(this as object)?.editor : undefined;
  const baseSignal = dialogOptions?.signal instanceof AbortSignal ? (dialogOptions as Record<string, unknown>).signal as AbortSignal : undefined;

  const local = async (signal: AbortSignal | undefined): Promise<string | undefined> => {
    if (!original) return undefined;
    return original.call(this, title, prefill, { ...dialogOptions, signal }, editorOptions);
  };

  const remote = async (signal: AbortSignal | undefined): Promise<GuestUiResult> => {
    const share = current;
    if (!share) return { kind: "unavailable" };
    const request: Record<string, unknown> = { kind: "editor", title, prefill };
    if (dialogOptions && typeof dialogOptions === "object") {
      const d = dialogOptions as Record<string, unknown>;
      if (typeof d.helpText === "string") request.helpText = d.helpText;
    }
    return requestGuestUi(request, signal);
  };

  return raceDialogs(local, remote, baseSignal);
};

function installAsk(runtime?: Runtime): void {
  const ui = runtime?.ui ?? api?.ui;
  if (!ui || typeof ui !== "object" || uiOriginals.has(ui)) return;
  uiOriginals.set(ui, { select: ui.select, editor: ui.editor });
  if (typeof ui.select === "function") ui.select = selectWrapper;
  if (typeof ui.editor === "function") ui.editor = editorWrapper;
}
