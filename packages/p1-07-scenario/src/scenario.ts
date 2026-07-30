import { createHash, type Hash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import {
  CmuxRuntimeError,
  startCmuxRuntime,
  verifyCmuxBinary,
} from "../../cmux-runtime/src/index.js";
import { spawnPty, type PtyProcess } from "../../host-service/src/operations/pty.js";
import { terminateProcessesHoldingPath } from "./process-containment.js";
import { SharedControlStore, SqliteControlStore, SqliteSharedControlLedgerStorage } from "../../portable-control-store/src/index.js";
import type { Capabilities, Generation, RuntimeId } from "../../portable-core/src/index.js";
import {
  LocalDriver,
  type CompleteReadiness,
  type LocalDriverOptions,
} from "../../portable-driver/src/index.js";
import {
  createProviderControlSession,
  MemoryProviderConnectionRegistry,
  runProviderStream,
  type CmuxRouteOpener,
  type DuplexByteStream,
  type ProviderIngressIdentity,
} from "../../provider-engine/src/index.js";

const ENDPOINT = "https://p1-07.local/provider";
const PROFILE = "local-p1-07";
const PRINCIPAL = "p1-07-client";
const SCOPE_ID = "scope-p1-07";
const WORKSPACE_ID = "workspace-p1-07";
const EFFECTIVE_CAPABILITIES = [
  "scope.read",
  "runtime.read",
  "runtime.create",
  "runtime.connect.cmux",
  "runtime.stop",
  "runtime.sleep",
  "runtime.wake",
] as const;

interface Args { readonly binary: string; readonly manifest: string; readonly artifact: string }
interface RuntimeStatus { readonly runtimeId: RuntimeId; readonly generation: Generation; readonly pid: number; readonly socketPath: string; readonly stateDirectory: string }
interface BoundaryRecord { readonly boundary: string; readonly connection: number; readonly mode: "control" | "stream"; readonly direction: string; readonly bytes: number; readonly sha256: string }
interface RequestRecord { readonly connection: number; readonly method: string; readonly id: string; readonly params: Record<string, unknown>; readonly sha256: string }

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !["--binary", "--manifest", "--artifact"].includes(flag))
      throw new Error("usage: scenario.ts --binary <pinned-cmux> --manifest <manifest> --artifact <evidence.json>");
    values.set(flag, resolve(value));
  }
  const binary = values.get("--binary");
  const manifest = values.get("--manifest");
  const artifact = values.get("--artifact");
  if (!binary || !manifest || !artifact) throw new Error("binary, manifest, and artifact are required");
  return { binary, manifest, artifact };
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

let activeWaitFailure: (() => string | undefined) | undefined;
let activeWaitContext: (() => string | undefined) | undefined;

async function waitFor(label: string, predicate: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    const failure = activeWaitFailure?.();
    if (failure) throw new Error(`client exited while waiting for ${label}: ${failure}`);
    if (Date.now() >= deadline) {
      const context = activeWaitContext?.();
      throw new Error(`timed out waiting for ${label}${context ? `: ${context}` : ""}`);
    }
    await delay(20);
  }
}
function renderTerminal(output: string, rows = 40, columns = 160): readonly string[] {
  const cells = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  let row = 0;
  let column = 0;
  let savedRow = 0;
  let savedColumn = 0;
  const clear = (): void => {
    for (const line of cells) line.fill(" ");
  };
  for (let index = 0; index < output.length;) {
    const character = output[index]!;
    if (character === "\x1b") {
      const next = output[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < output.length && !/[@-~]/u.test(output[end]!)) end += 1;
        if (end >= output.length) break;
        const final = output[end]!;
        const raw = output.slice(index + 2, end);
        const parameters = raw.replace(/^[?>!]/u, "").split(";").map(value => value === "" ? 0 : Number(value));
        const first = parameters[0] ?? 0;
        if (final === "H" || final === "f") {
          row = Math.max(0, Math.min(rows - 1, (first || 1) - 1));
          column = Math.max(0, Math.min(columns - 1, (parameters[1] || 1) - 1));
        } else if (final === "A") row = Math.max(0, row - (first || 1));
        else if (final === "B") row = Math.min(rows - 1, row + (first || 1));
        else if (final === "C") column = Math.min(columns - 1, column + (first || 1));
        else if (final === "D") column = Math.max(0, column - (first || 1));
        else if (final === "G") column = Math.max(0, Math.min(columns - 1, (first || 1) - 1));
        else if (final === "d") row = Math.max(0, Math.min(rows - 1, (first || 1) - 1));
        else if (final === "J" && (first === 2 || first === 3)) clear();
        else if (final === "K") {
          const start = first === 1 ? 0 : column;
          const finish = first === 0 ? columns : column + 1;
          cells[row]!.fill(" ", start, finish);
        } else if (final === "s") {
          savedRow = row;
          savedColumn = column;
        } else if (final === "u") {
          row = savedRow;
          column = savedColumn;
        } else if ((final === "h" || final === "l") && raw.includes("1049")) clear();
        index = end + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^") {
        let end = index + 2;
        while (end < output.length && output[end] !== "\x07" && !(output[end] === "\x1b" && output[end + 1] === "\\")) end += 1;
        index = end < output.length ? end + (output[end] === "\x1b" ? 2 : 1) : output.length;
        continue;
      }
      index += 2;
      continue;
    }
    if (character === "\r") column = 0;
    else if (character === "\n") row = Math.min(rows - 1, row + 1);
    else if (character === "\b") column = Math.max(0, column - 1);
    else if (character === "\t") column = Math.min(columns - 1, column + (8 - (column % 8)));
    else if (character >= " ") {
      cells[row]![column] = character;
      column = Math.min(columns - 1, column + 1);
    }
    index += 1;
  }
  return cells.map(line => line.join("").trimEnd());
}


function processGroupDead(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1_000 });
  if (result.error || result.status !== 0) return false;
  return !result.stdout.split("\n").some(row => {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(row);
    return match && Number(match[1]) === pid && !match[2]!.startsWith("Z");
  });
}

function pidDead(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1_000 });
  return result.status !== 0 || result.stdout.trim().startsWith("Z") || result.stdout.trim() === "";
}

function socketWrite(socket: Socket, chunk: Uint8Array): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.write(chunk, error => error ? reject(error) : resolve());
  return promise;
}

function socketEnd(socket: Socket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.end(resolve);
  return promise;
}

function connectUnix(path: string, signal?: AbortSignal): Promise<Socket> {
  const socket = createConnection({ path, signal });
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  const connected = () => { socket.off("error", failed); resolve(socket); };
  const failed = (error: Error) => { socket.off("connect", connected); reject(error); };
  socket.once("connect", connected);
  socket.once("error", failed);
  return promise;
}

function listen(server: Server, path: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(path, () => { server.off("error", reject); resolve(); });
  return promise;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, timeoutMs);
  try {
    await Promise.race([Promise.allSettled(promises), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

class Digest {
  readonly #hash: Hash = createHash("sha256");
  #bytes = 0;
  #finished = false;
  readonly #logPath: string;
  readonly #record: Omit<BoundaryRecord, "bytes" | "sha256">;
  constructor(logPath: string, record: Omit<BoundaryRecord, "bytes" | "sha256">) {
    this.#logPath = logPath;
    this.#record = record;
  }
  update(chunk: Uint8Array): void { if (!this.#finished) { this.#hash.update(chunk); this.#bytes += chunk.byteLength; } }
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    appendFileSync(this.#logPath, `${JSON.stringify({ ...this.#record, bytes: this.#bytes, sha256: this.#hash.digest("hex") } satisfies BoundaryRecord)}\n`);
  }
}

class FrameCapture {
  #buffer = new Uint8Array();
  readonly #onFrame: (frame: Uint8Array) => void;
  constructor(onFrame: (frame: Uint8Array) => void) { this.#onFrame = onFrame; }
  accept(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.byteLength);
    let start = 0;
    for (let index = 0; index < joined.byteLength; index++) {
      if (joined[index] !== 10) continue;
      this.#onFrame(joined.subarray(start, index + 1));
      start = index + 1;
    }
    this.#buffer = joined.subarray(start);
  }
}

function readStatus(path: string): RuntimeStatus | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as RuntimeStatus; }
  catch { return undefined; }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await verifyCmuxBinary(args.binary, args.manifest);
  mkdirSync(dirname(args.artifact), { recursive: true });
  const boundaryLog = join(dirname(args.artifact), "p1-07-boundaries.ndjson");
  writeFileSync(boundaryLog, "", { mode: 0o600 });
  const root = mkdtempSync(join(tmpdir(), "p107-"));
  const socketRoot = join(root, "s");
  mkdirSync(socketRoot, { mode: 0o700 });
  const controlSocketPath = join(socketRoot, "c.sock");
  const streamSocketPath = join(socketRoot, "s.sock");
  const runtimeRoot = join(socketRoot, "r");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const store = new SqliteControlStore({ databasePath: join(root, "control.sqlite") });
  const admissionStorage = new SqliteSharedControlLedgerStorage(join(root, "admission.sqlite"));
  const admissionLedger = new SharedControlStore({ storage: admissionStorage });
  const connections = new MemoryProviderConnectionRegistry();
  const runtimeHost = fileURLToPath(new URL("./runtime-host.ts", import.meta.url));
  const adapterBin = fileURLToPath(new URL("../../provider-adapter/src/bin.ts", import.meta.url));
  const connectorModule = pathToFileURL(fileURLToPath(new URL("./connector.ts", import.meta.url))).href;
  const statuses = new Map<string, string>();
  const activeControlSockets = new Set<Socket>();
  const activeStreamSockets = new Set<Socket>();
  const requests: RequestRecord[] = [];
  const usedTickets: string[] = [];
  const usedTicketGenerations: string[] = [];
  let controlSequence = 0;
  let streamSequence = 0;
  let routeSequence = 0;
  const faultedConnections = new Set<string>();
  let ptyOutput = "";
  let client: PtyProcess | undefined;
  let ptyPump: ReturnType<typeof setInterval> | undefined;
  let lastContainmentProof: Readonly<Record<string, unknown>> | undefined;
  let driver: LocalDriver | undefined;
  const servers: Server[] = [];
  const tasks = new Set<Promise<unknown>>();
  const identity: ProviderIngressIdentity = { principalId: PRINCIPAL, transport: "direct", authority: { profile: PROFILE } };
  const capabilities: Capabilities = {
    apiVersion: "v1",
    protocols: { machineProvider: { versions: [1], capabilities: [] }, cmux: { versions: [10] }, ompApp: { versions: [1] } },
    limits: { maxActiveRuntimes: 4, maxRetainedRuntimes: 8, idempotencyRetentionSeconds: 3_600, eventRetentionSeconds: 3_600, maxPageSize: 100 },
    features: { restLifecycle: true, sshProvider: false, directCmuxWebSocket: false, browser: false, scaleToZero: true },
  };

  const track = (task: Promise<unknown>): void => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  try {
    const launch: LocalDriverOptions["launch"] = (_runtime, context) => {
      const statusPath = join(context.runtimeStatePath, `p1-07-${context.generation}.json`);
      statuses.set(`${context.runtimeId}\0${context.generation}`, statusPath);
      return {
        executable: process.execPath,
        arguments: [runtimeHost],
        environment: {
          P107_CMUX_BINARY: args.binary,
          P107_CMUX_MANIFEST: args.manifest,
          P107_CMUX_RUNTIME_ROOT: runtimeRoot,
        },
        routeKinds: ["cmux-v10"],
        readinessProbe: async () => {
          const status = readStatus(statusPath);
          if (!status || status.generation !== context.generation || pidDead(status.pid) || !existsSync(status.socketPath) || !existsSync(context.generationCredentialPath)) return undefined;
          return {
            runtimeGeneration: context.generation,
            storageReady: true,
            exclusiveWriterLeaseHeld: true,
            internalGenerationAuthenticationReady: true,
            hostReady: true,
            ompAuthorityReady: true,
            cmuxProtocol10Ready: true,
            requiredBrowserReady: true,
          } satisfies CompleteReadiness;
        },
        closeConnections: async () => { for (const socket of activeStreamSockets) socket.destroy(); },
        quiesce: async () => true,
        terminateAndProveFence: async (_launchContext, containment) => {
          const status = readStatus(statusPath);
          try { process.kill(-containment.processGroupId, "SIGTERM"); } catch {}
          let deadline = Date.now() + containment.graceMilliseconds;
          while (Date.now() <= deadline && (!processGroupDead(containment.processGroupId) || (status && !pidDead(status.pid)))) await delay(20);
          if (status && !pidDead(status.pid)) { try { process.kill(-status.pid, "SIGKILL"); } catch {} }
          if (!processGroupDead(containment.processGroupId)) { try { process.kill(-containment.processGroupId, "SIGKILL"); } catch {} }
          deadline = Date.now() + containment.killMilliseconds;
          while (Date.now() <= deadline && (!processGroupDead(containment.processGroupId) || (status && !pidDead(status.pid)))) await delay(20);
          const wrapperDead = processGroupDead(containment.processGroupId);
          const runtimeDead = !status || pidDead(status.pid);
          lastContainmentProof = { wrapperPid: containment.processGroupId, runtimePid: status?.pid, wrapperDead, runtimeDead };
          return wrapperDead && runtimeDead;
        },
      };
    };
    driver = new LocalDriver({
      root: join(root, "driver"),
      store,
      bootstrapScopes: [{ id: SCOPE_ID, displayName: "P1-07 Local", kind: "Personal" }],
      launch,
      capabilities,
      admissionLedger,
      admissionPolicy: {
        maxActiveRuntimes: 8,
        maxRetainedRuntimes: 32,
        maxWorkspaceCapacityBytes: 1_099_511_627_776,
        maxCpuMillis: 8_000,
        maxMemoryBytes: 17_179_869_184,
        maxGpuUnits: 0,
        browserEnabled: true,
        runtimeResources: { cpuMillis: 1_000, memoryBytes: 2_147_483_648, gpuUnits: 0 },
        creationRate: { windowSeconds: 60, burst: 100, maximumRetryAfterSeconds: 30 },
      },
      lsofExecutable: "/usr/sbin/lsof",
      readinessTimeoutMilliseconds: 15_000,
      shutdownGraceMilliseconds: 5_000,
      shutdownKillMilliseconds: 2_000,
    });
    const workspace = await driver.createWorkspace({ id: WORKSPACE_ID, scopeId: SCOPE_ID, displayName: "P1-07 Workspace", capacityBytes: 64 * 1024 * 1024, retention: "Delete" });
    if (workspace.outcome !== "created") throw new Error(`workspace setup failed: ${workspace.outcome}`);

    const routeOpener: CmuxRouteOpener = {
      open: async resolved => {
        const statusPath = statuses.get(`${resolved.runtimeId}\0${resolved.runtimeGeneration}`);
        const status = statusPath ? readStatus(statusPath) : undefined;
        if (!status || status.runtimeId !== resolved.runtimeId || status.generation !== resolved.runtimeGeneration)
          throw new Error("runtime status does not match resolved route");
        const socket = await connectUnix(status.socketPath);
        const connection = ++routeSequence;
        const relayUp = new Digest(boundaryLog, { boundary: "provider-relay", connection, mode: "stream", direction: "client-to-runtime" });
        const runtimeIn = new Digest(boundaryLog, { boundary: "runtime-ingress", connection, mode: "stream", direction: "client-to-runtime" });
        const relayDown = new Digest(boundaryLog, { boundary: "provider-relay", connection, mode: "stream", direction: "runtime-to-client" });
        const runtimeOut = new Digest(boundaryLog, { boundary: "runtime-egress", connection, mode: "stream", direction: "runtime-to-client" });
        const finish = () => { relayUp.finish(); runtimeIn.finish(); relayDown.finish(); runtimeOut.finish(); };
        return {
          readable: {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const chunk of socket) {
                  const bytes = chunk as Uint8Array;
                  runtimeOut.update(bytes);
                  relayDown.update(bytes);
                  yield bytes;
                }
              } finally { finish(); }
            },
          },
          async write(chunk) { relayUp.update(chunk); runtimeIn.update(chunk); await socketWrite(socket, chunk); },
          async end() { relayUp.finish(); runtimeIn.finish(); await socketEnd(socket); },
          async close(cause) { finish(); socket.destroy(cause instanceof Error ? cause : undefined); },
        } satisfies DuplexByteStream;
      },
    };

    const authorize = async () => ({ outcome: "allowed" as const, scopeIds: [SCOPE_ID], effectiveCapabilities: EFFECTIVE_CAPABILITIES, policyRevision: "p1-07-policy-1" });
    const controlServer = createServer(socket => {
      activeControlSockets.add(socket);
      const connection = ++controlSequence;
      socket.write(`P107-CONNECTION control ${connection}\n`);
      const ingress = new Digest(boundaryLog, { boundary: "provider-engine", connection, mode: "control", direction: "client-to-provider" });
      const egress = new Digest(boundaryLog, { boundary: "provider-engine", connection, mode: "control", direction: "provider-to-client" });
      const frameCapture = new FrameCapture(frame => {
        const envelope = JSON.parse(Buffer.from(frame.subarray(0, -1)).toString("utf8")) as { id: string; method?: string; params?: Record<string, unknown> };
        if (envelope.method) requests.push({ connection, method: envelope.method, id: envelope.id, params: envelope.params ?? {}, sha256: createHash("sha256").update(frame).digest("hex") });
      });
      const session = createProviderControlSession({
        providerId: "omperator-p1-07",
        providerName: "P1-07 Provider",
        driver: driver!,
        tickets: store,
        connections,
        authorize,
        creationPolicy: {
          runtime: async () => ({
            id: "runtime-p1-07",
            scopeId: SCOPE_ID,
            displayName: "P1-07 Runtime",
            workspaceId: WORKSPACE_ID,
            hostProfileId: "local-headless-cmux",
            desiredState: "Running",
            browserPolicy: "Disabled",
          }),
          workspace: async () => { throw new Error("workspace creation is not exposed"); },
        },
      }, identity);
      const task = (async () => {
        try {
          for await (const chunk of socket) {
            const bytes = chunk as Uint8Array;
            ingress.update(bytes);
            frameCapture.accept(bytes);
            for (const response of await session.receive(bytes)) { egress.update(response); await socketWrite(socket, response); }
          }
          await session.finish();
        } finally {
          await session.close();
          ingress.finish();
          egress.finish();
          activeControlSockets.delete(socket);
          socket.destroy();
        }
      })();
      track(task);
    });
    const streamServer = createServer(socket => {
      activeStreamSockets.add(socket);
      const connection = ++streamSequence;
      socket.write(`P107-CONNECTION stream ${connection}\n`);
      const ingress = new Digest(boundaryLog, { boundary: "provider-engine", connection, mode: "stream", direction: "client-to-provider" });
      const egress = new Digest(boundaryLog, { boundary: "provider-engine", connection, mode: "stream", direction: "provider-to-client" });
      let handshake = new Uint8Array();
      let handshakeSeen = false;
      let acceptedSeen = false;
      const transport: DuplexByteStream = {
        readable: {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const chunk of socket) {
                const bytes = chunk as Uint8Array;
                if (!handshakeSeen) {
                  const combined = new Uint8Array(handshake.byteLength + bytes.byteLength);
                  combined.set(handshake); combined.set(bytes, handshake.byteLength);
                  const newline = combined.indexOf(10);
                  if (newline >= 0) {
                    const parsed = JSON.parse(Buffer.from(combined.subarray(0, newline)).toString("utf8")) as { ticket: string; token: string };
                    usedTickets.push(parsed.ticket);
                    usedTicketGenerations.push(createHash("sha256").update(parsed.token).digest("hex"));
                    handshakeSeen = true;
                    if (newline + 1 < combined.byteLength) ingress.update(combined.subarray(newline + 1));
                  } else handshake = combined;
                } else ingress.update(bytes);
                yield bytes;
              }
            } finally { ingress.finish(); }
          },
        },
        async write(chunk) {
          if (!acceptedSeen) {
            acceptedSeen = true;
          } else egress.update(chunk);
          await socketWrite(socket, chunk);
        },
        async end() { ingress.finish(); egress.finish(); await socketEnd(socket); },
        async close(cause) { ingress.finish(); egress.finish(); socket.destroy(cause instanceof Error ? cause : undefined); },
      };
      const task = runProviderStream({ transport, identity, tickets: store, driver: driver!, authorize, routeOpener, connections })
        .finally(() => { ingress.finish(); egress.finish(); activeStreamSockets.delete(socket); socket.destroy(); });
      track(task);
    });
    servers.push(controlServer, streamServer);
    await Promise.all([listen(controlServer, controlSocketPath), listen(streamServer, streamSocketPath)]);

    const clientHome = join(root, "client-home");
    const clientTmp = join(root, "client-tmp");
    mkdirSync(clientHome, { mode: 0o700 });
    const clientEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: clientHome,
      TMPDIR: clientTmp,
      TERM: "xterm-256color",
      OMPERATORCTL_CONNECTOR_MODULE: connectorModule,
      P107_ENDPOINT: ENDPOINT,
      P107_PROFILE: PROFILE,
      P107_CONTROL_SOCKET: controlSocketPath,
      P107_STREAM_SOCKET: streamSocketPath,
      P107_PRINCIPAL: PRINCIPAL,
      P107_EVIDENCE_LOG: boundaryLog,
    };
    mkdirSync(clientTmp, { mode: 0o700 });
    client = spawnPty({
      argv: [
        args.binary,
        "--machine-provider-command", process.execPath, adapterBin,
        "provider", "--endpoint", ENDPOINT, "--profile", PROFILE, "--",
      ],
      cwd: clientHome,
      env: clientEnv,
      rows: 40,
      cols: 160,
    });
    ptyPump = setInterval(() => {
      client?.flushInput();
      ptyOutput = (ptyOutput + (client?.drain() ?? "")).slice(-2_000_000);
    }, 8);
    const send = async (...keys: readonly string[]): Promise<void> => {
      if (!client) throw new Error("PTY client is unavailable");
      for (const key of keys) {
        client.write(key);
        client.flushInput();
        await delay(25);
      }
    };
    const locate = (label: string): { x: number; y: number } | undefined => {
      const target = label.toLowerCase();
      for (const [row, line] of renderTerminal(ptyOutput).entries()) {
        const column = line.toLowerCase().indexOf(target);
        if (column >= 0) return { x: column + 1, y: row + 1 };
      }
      return undefined;
    };
    const click = async (label: string): Promise<void> => {
      await waitFor(`visible ${label} control`, () => locate(label) !== undefined, 10_000);
      const position = locate(label);
      if (!position) throw new Error(`${label} control disappeared`);
      await send(`\x1b[<0;${position.x};${position.y}M`, `\x1b[<0;${position.x};${position.y}m`);
    };
    const chooseAction = async (label: string): Promise<void> => {
      const actionsBefore = requests.filter(record => record.method === "invoke_action" && record.params.action_id === label).length;
      const deadline = Date.now() + 15_000;
      while (requests.filter(record => record.method === "invoke_action" && record.params.action_id === label).length <= actionsBefore) {
        if (locate(label)) await click(label);
        else await click("actions");
        await delay(250);
        if (Date.now() >= deadline) throw new Error(`action menu did not invoke ${label}: ${activeWaitContext?.() ?? ""}`);
      }
    };


    const escapeCharacter = String.fromCodePoint(27);
    const ansiEscape = new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "gu");
    activeWaitContext = () => {
      const bounded = ptyOutput
        .replace(ansiEscape, "")
        .replaceAll(root, "<scenario-root>")
        .replaceAll(args.binary, "<pinned-cmux>")
        .replaceAll(adapterBin, "<adapter>")
        .replace(/\/Users\/[^/\s]+/gu, "~")
        .replace(/("(?:token|ticket)"\s*:\s*")[^"]+/gu, "$1<redacted>")
        .replace(/[^\x20-\x7e\n]/gu, "")
        .slice(-4_000)
        .trim();
      const marker = ptyOutput.lastIndexOf("+ new machine");
      const coordinateProbe = marker < 0 ? "" : ptyOutput.slice(Math.max(0, marker - 300), marker + 50).replaceAll(escapeCharacter, "<ESC>").replace(/[^\x20-\x7e]/gu, "");
      const runtime = driver?.getRuntime("runtime-p1-07");
      const runtimeContext = runtime?.outcome === "found"
        ? JSON.stringify({ desiredState: runtime.resource.desiredState, phase: runtime.resource.phase, generation: runtime.resource.generation, conditions: runtime.resource.conditions })
        : runtime?.outcome;
      const startupFailures = [...statuses.values()]
        .map(path => `${path}.error`)
        .filter(existsSync)
        .map(path => readFileSync(path, "utf8").trim());
      const screen = renderTerminal(ptyOutput).filter(line => line.trim() !== "");
      return `runtime=${runtimeContext ?? "not-created"} startupFailures=${JSON.stringify(startupFailures)} screen=${JSON.stringify(screen)}${bounded ? ` output=${JSON.stringify(bounded)} coordinateProbe=${JSON.stringify(coordinateProbe)}` : ""}`;
    };
    activeWaitFailure = () => {
      const exited = client?.exited();
      return exited ? `exitCode=${String(exited.exitCode)} signal=${String(exited.signal)} ${activeWaitContext?.() ?? ""}` : undefined;
    };

    await waitFor("initial unmodified-client snapshot", () => requests.some(record => record.method === "snapshot"));
    await waitFor("visible provider scope", () => ptyOutput.includes("P1-07 Lo"));
    await send("\x1b[<0;10;40M", "\x1b[<0;10;40m");
    await waitFor("create_machine", () => requests.some(record => record.method === "create_machine"));
    await waitFor("first open_machine", () => requests.filter(record => record.method === "open_machine").length >= 1, 45_000);
    await waitFor("first accepted runtime stream", () => usedTickets.length >= 1 && routeSequence >= 1, 45_000);
    await waitFor("visible created machine", () => ptyOutput.includes("P1-07 Runtime"));
    const runtimeLookup = driver.getRuntime("runtime-p1-07");
    if (runtimeLookup.outcome !== "found") throw new Error("created runtime is missing");
    const firstGeneration = runtimeLookup.resource.generation;
    const firstRoute = driver.resolveRuntimeRoute(runtimeLookup.resource.id, "cmux-v10", firstGeneration);
    if (firstRoute.outcome !== "resolved") throw new Error(`first route is ${firstRoute.outcome}`);

    const ticketReuse = store.consumeTicketForTransport({ ticket: usedTickets[0]!, principalId: PRINCIPAL, audience: "cmux-machine-provider", providerControlGeneration: usedTicketGenerations[0]!, purpose: "runtime.connect.cmux" });
    if (ticketReuse.outcome === "consumed") throw new Error("real client stream ticket was consumable twice");

    const firstStatusPath = statuses.get(`${runtimeLookup.resource.id}\0${firstGeneration}`);
    const firstStatus = firstStatusPath ? readStatus(firstStatusPath) : undefined;
    if (!firstStatus) throw new Error("first runtime status is unavailable");
    let duplicateWriterRejected = false;
    try {
      const duplicate = await startCmuxRuntime({
        binaryPath: args.binary,
        buildManifestPath: args.manifest,
        runtimeId: runtimeLookup.resource.id,
        generation: firstGeneration,
        runtimeDirectory: runtimeRoot,
        stateDirectory: firstStatus.stateDirectory,
      });
      await duplicate.stop();
    } catch (error) {
      duplicateWriterRejected = error instanceof CmuxRuntimeError && error.code === "duplicateWriter";
    }
    if (!duplicateWriterRejected) throw new Error("second writer was not rejected by the real cmux runtime fixture");

    const opensBeforeLoss = requests.filter(record => record.method === "open_machine").length;
    const closesBeforeLoss = requests.filter(record => record.method === "close_machine").length;
    const faultedStream = [...activeStreamSockets].at(-1);
    if (!faultedStream) throw new Error("stream-loss fixture has no active provider stream");
    faultedConnections.add(`stream:${streamSequence}`);
    faultedStream.destroy();
    await waitFor("stream-loss open retry", () => requests.filter(record => record.method === "open_machine").length > opensBeforeLoss, 30_000);
    await waitFor("stream-loss replacement stream", () => routeSequence >= 2, 30_000);
    await waitFor("old connection close", () => requests.filter(record => record.method === "close_machine").length > closesBeforeLoss, 30_000);

    await chooseAction("sleep");
    await waitFor("sleep action", () => requests.some(record => record.method === "invoke_action" && record.params.action_id === "sleep"), 30_000);
    await waitFor("runtime sleep outcome", () => { const current = driver!.getRuntime("runtime-p1-07"); return current.outcome === "found" && current.resource.desiredState === "Sleeping" && (current.resource.phase === "Sleeping" || current.resource.phase === "Degraded"); }, 30_000);
    const sleepingState = driver.getRuntime("runtime-p1-07");
    if (sleepingState.outcome !== "found" || sleepingState.resource.phase !== "Sleeping") {
      const runtimeStatePath = firstStatusPath ? dirname(firstStatusPath) : root;
      const handles = spawnSync("/usr/sbin/lsof", ["-F", "pfn", "+D", runtimeStatePath], { encoding: "utf8", timeout: 2_000 });
      const handlePids = (handles.stdout.match(/^p\d+/gmu) ?? []).map(value => value.slice(1));
      const processes = handlePids.length === 0 ? "" : spawnSync("/bin/ps", ["-p", handlePids.join(","), "-o", "pid=,ppid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 1_000 }).stdout.trim();
      throw new Error(`sleep fence failed: phase=${sleepingState.outcome === "found" ? sleepingState.resource.phase : sleepingState.outcome} containment=${JSON.stringify(lastContainmentProof)} handles=${JSON.stringify(processes)} self=${process.pid}`);
    }
    const runtimeWoke = (): boolean => {
      const current = driver!.getRuntime("runtime-p1-07");
      return current.outcome === "found" && current.resource.desiredState === "Running" && current.resource.phase === "Ready" && current.resource.generation !== firstGeneration;
    };
    for (let attempt = 0; attempt < 3 && !runtimeWoke(); attempt++) {
      await chooseAction("wake");
      const wakeDeadline = Date.now() + 20_000;
      while (!runtimeWoke() && Date.now() < wakeDeadline) await delay(25);
    }
    if (!runtimeWoke()) throw new Error(`runtime did not wake with a fresh generation: ${activeWaitContext?.() ?? ""}`);
    const woken = driver.getRuntime("runtime-p1-07");
    if (woken.outcome !== "found") throw new Error("woken runtime is missing");
    const staleRoute = driver.resolveRuntimeRoute(woken.resource.id, "cmux-v10", firstGeneration);
    if (staleRoute.outcome !== "staleGeneration") throw new Error(`old route was not stale after wake: ${staleRoute.outcome}`);

    const hellosBeforeReconnect = requests.filter(record => record.method === "hello").length;
    const opensBeforeReconnect = requests.filter(record => record.method === "open_machine").length;
    const faultedControl = [...activeControlSockets].at(-1);
    if (!faultedControl) throw new Error("control-loss fixture has no active provider control");
    faultedConnections.add(`control:${controlSequence}`);
    faultedControl.destroy();
    await waitFor("fresh control generation", () => requests.filter(record => record.method === "hello").length > hellosBeforeReconnect, 45_000);
    await waitFor("post-wake reconnect open", () => requests.filter(record => record.method === "open_machine").length > opensBeforeReconnect, 45_000);
    await waitFor("post-wake runtime stream", () => routeSequence >= 3, 45_000);

    if (!requests.some(record => record.method === "close_machine"))
      throw new Error("unmodified client never closed a machine connection");
    activeWaitFailure = undefined;
    for (let attempt = 0; attempt < 3 && client.exited() === undefined; attempt++) {
      await send("\x02d");
      const detachDeadline = Date.now() + 10_000;
      while (client.exited() === undefined && Date.now() < detachDeadline) await delay(25);
    }
    if (client.exited() === undefined) throw new Error(`timed out waiting for clean cmux detach: ${activeWaitContext?.() ?? ""}`);
    const detachExit = client.exited();
    if (!detachExit || detachExit.exitCode !== 0 || detachExit.signal !== undefined)
      throw new Error(`cmux detach was not a clean exit: ${JSON.stringify(detachExit)}`);
    await waitFor("connector digest finalization", () => {
      try {
        const adapterRecords = readFileSync(boundaryLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as BoundaryRecord)
          .filter(record => record.boundary === "adapter");
        return (["control", "stream"] as const).every(mode =>
          Array.from({ length: mode === "control" ? controlSequence : streamSequence }, (_, index) => index + 1).every(connection =>
            faultedConnections.has(`${mode}:${connection}`) ||
            (["client-to-provider", "provider-to-client"] as const).every(direction =>
              adapterRecords.some(record => record.mode === mode && record.connection === connection && record.direction === direction),
            ),
          ),
        );
      } catch {
        return false;
      }
    }, 10_000);

    for (const listed of driver.listRuntimes(SCOPE_ID).items) {
      const current = driver.getRuntime(listed.id);
      if (current.outcome === "found" && current.resource.desiredState === "Running")
        await driver.setRuntimeDesiredState(current.resource.id, "Stopped", current.resource.revision);
    }
    for (const socket of [...activeControlSockets, ...activeStreamSockets]) socket.destroy();
    await settleWithin([...tasks], 2_000);

    const records = readFileSync(boundaryLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as BoundaryRecord);
    const digestPairs = [
      ["control client-to-provider", "control", records.filter(r => r.boundary === "adapter" && r.mode === "control" && r.direction === "client-to-provider"), records.filter(r => r.boundary === "provider-engine" && r.mode === "control" && r.direction === "client-to-provider")],
      ["control provider-to-client", "control", records.filter(r => r.boundary === "adapter" && r.mode === "control" && r.direction === "provider-to-client"), records.filter(r => r.boundary === "provider-engine" && r.mode === "control" && r.direction === "provider-to-client")],
      ["stream client-to-provider", "stream", records.filter(r => r.boundary === "adapter" && r.mode === "stream" && r.direction === "client-to-provider"), records.filter(r => r.boundary === "provider-engine" && r.mode === "stream" && r.direction === "client-to-provider")],
      ["stream provider-to-client", "stream", records.filter(r => r.boundary === "adapter" && r.mode === "stream" && r.direction === "provider-to-client"), records.filter(r => r.boundary === "provider-engine" && r.mode === "stream" && r.direction === "provider-to-client")],
      ["stream client-to-runtime", "stream", records.filter(r => r.boundary === "provider-relay" && r.direction === "client-to-runtime"), records.filter(r => r.boundary === "runtime-ingress" && r.direction === "client-to-runtime")],
      ["stream runtime-to-client", "stream", records.filter(r => r.boundary === "provider-relay" && r.direction === "runtime-to-client"), records.filter(r => r.boundary === "runtime-egress" && r.direction === "runtime-to-client")],
    ] as const;
    const digestAssertions = digestPairs.map(([name, mode, left, right]) => {
      const matchedValues: string[] = [];
      const faultedConnectionIds: number[] = [];
      const connectionIds = [...new Set([...left, ...right].map(record => record.connection))].sort((a, b) => a - b);
      for (const connection of connectionIds) {
        if (faultedConnections.has(`${mode}:${connection}`)) {
          faultedConnectionIds.push(connection);
          continue;
        }
        const leftRecords = left.filter(record => record.connection === connection);
        const rightRecords = right.filter(record => record.connection === connection);
        if (leftRecords.length !== 1 || rightRecords.length !== 1)
          throw new Error(`${name} connection ${connection} is not paired exactly once: left=${JSON.stringify(leftRecords)} right=${JSON.stringify(rightRecords)}`);
        const leftValue = `${leftRecords[0]!.bytes}:${leftRecords[0]!.sha256}`;
        const rightValue = `${rightRecords[0]!.bytes}:${rightRecords[0]!.sha256}`;
        if (leftValue !== rightValue)
          throw new Error(`${name} connection ${connection} changed bytes: left=${leftValue} right=${rightValue}`);
        matchedValues.push(leftValue);
      }
      if (matchedValues.length === 0) throw new Error(`${name} has no complete non-faulted connection`);
      return {
        name,
        equal: true,
        connections: matchedValues.length,
        values: matchedValues,
        faultedConnectionsExcluded: faultedConnectionIds.length,
        faultedConnectionIds,
      };
    });

    const artifact = {
      schemaVersion: 1,
      scenario: "P1-07-real-pinned-cmux-local",
      pinnedClient: {
        binaryFile: manifest.binaryFile,
        binarySha256: manifest.binarySha256,
        sourceCommit: manifest.sourceCommit,
        sourceTree: manifest.sourceTree,
        cmuxTuiSourceTree: manifest.cmuxTuiSourceTree,
        ghosttyCommit: manifest.ghosttyCommit,
        invocation: ["<pinned-cmux>", "--machine-provider-command", "<bun>", "packages/provider-adapter/src/bin.ts", "provider", "--endpoint", ENDPOINT, "--profile", PROFILE, "--"],
        unmodified: true,
        pty: "host-service spawnPty",
      },
      assertions: {
        visibleList: requests.some(record => record.method === "snapshot") && ptyOutput.includes("P1-07 Lo") && ptyOutput.includes("P1-07 Runtime"),
        methods: Object.fromEntries([...new Set(requests.map(record => record.method))].map(method => [method, requests.filter(record => record.method === method).length])),
        createOpenClose: ["create_machine", "open_machine", "close_machine"].every(method => requests.some(record => record.method === method)),
        sleepWake: ["sleep", "wake"].every(action => requests.some(record => record.method === "invoke_action" && record.params.action_id === action)),
        streamLossReconnect: requests.filter(record => record.method === "open_machine").length > opensBeforeLoss,
        controlReconnect: requests.filter(record => record.method === "hello").length > hellosBeforeReconnect,
        generationChanged: { before: firstGeneration, after: woken.resource.generation, changed: firstGeneration !== woken.resource.generation },
        staleRouteRejected: staleRoute.outcome,
        ticketOneUse: ticketReuse.outcome,
        duplicateWriterRejected,
        noTranslation: digestAssertions,
        workspaceCreateNotAdvertised: !EFFECTIVE_CAPABILITIES.includes("workspace.create" as never),
      },
      frames: requests.map(record => ({ method: record.method, sha256: record.sha256 })),
      boundaryEvidence: "p1-07-boundaries.ndjson",
    };
    writeFileSync(args.artifact, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  } finally {
    if (ptyPump) clearInterval(ptyPump);
    if (client?.pid) { try { process.kill(-client.pid, "SIGKILL"); } catch {} client.close(); }
    for (const socket of [...activeControlSockets, ...activeStreamSockets]) socket.destroy();
    for (const server of servers) server.unref();
    await settleWithin(servers.map(closeServer), 2_000);
    if (driver) {
      for (const listed of driver.listRuntimes(SCOPE_ID).items) {
        const current = driver.getRuntime(listed.id);
        if (current.outcome === "found" && current.resource.desiredState === "Running")
          await driver.setRuntimeDesiredState(current.resource.id, "Stopped", current.resource.revision).catch(() => undefined);
      }
      await settleWithin([driver.close()], 30_000);
    }
    store.close();
    admissionStorage.close();
    await terminateProcessesHoldingPath(root);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
