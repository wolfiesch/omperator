#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { projectId, sessionId } from "@t4-code/host-wire";
import { BunRpcChildFactory, RpcChildSupervisor } from "../src/rpc-child.ts";
import type { SessionRecord } from "../src/types.ts";

const FRAME_TIMEOUT_MS = 10_000;
const STALE_LOCK_RECOVERY_MS = 20_500;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES_PER_TURN = 1_000;
const MAX_SESSION_ENTRIES = 10_000;
const LARGE_RPC_PROBE = "T4 large RPC payload probe";
const LARGE_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const LARGE_RPC_RESPONSE_SHA256 = "6932fd31e5daf4739b9fa78ff777b2831b0995cc1d0b0093cac80601902013bc";

type JsonMap = Record<string, unknown>;

interface RuntimeArtifact {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

interface RuntimeMatrix {
  readonly officialRuntime: {
    readonly version: string;
    readonly sourceTag: string;
    readonly sourceCommit: string;
    readonly artifacts: Readonly<Record<string, RuntimeArtifact>>;
  };
}

interface RuntimeManifest {
  readonly version: number;
  readonly tag: string;
  readonly platform: string;
  readonly arch: string;
  readonly executable: string;
  readonly size: number;
  readonly sha256: string;
}

interface VerifiedRuntime {
  readonly path: string;
  readonly matrix: RuntimeMatrix;
  readonly manifest: RuntimeManifest;
  readonly version: string;
}

interface TranscriptWatermark {
  readonly lastEntryId: string | null;
  readonly entryCount: number;
}

export interface DeterministicModel {
  readonly server: Bun.Server<undefined>;
  readonly requests: string[][];
  readonly gateNextRequest: () => ModelGate;
}

interface ModelGate {
  readonly started: Promise<string[]>;
  readonly release: () => void;
}

interface RpcHarness {
  readonly child: Bun.PipedSubprocess;
  readonly stderr: Promise<string>;
  readonly waitFor: (predicate: (frame: JsonMap) => boolean, label: string) => Promise<JsonMap[]>;
  readonly send: (frame: JsonMap) => void;
}

interface LaunchOptions {
  readonly extensionPath?: string;
}

function map(value: unknown, label: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonMap;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function decodeArtifact(value: unknown, label: string): RuntimeArtifact {
  const raw = map(value, label);
  const name = text(raw.name, `${label}.name`);
  const size = integer(raw.size, `${label}.size`);
  const digest = text(raw.sha256, `${label}.sha256`);
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/u.test(name)) throw new Error(`${label}.name is invalid`);
  if (size === 0) throw new Error(`${label}.size must be positive`);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}.sha256 is invalid`);
  return { name, size, sha256: digest };
}

function decodeRuntimeMatrix(value: unknown): RuntimeMatrix {
  const root = map(value, "compatibility matrix");
  const runtime = map(root.officialRuntime, "compatibility matrix.officialRuntime");
  const rawArtifacts = map(runtime.artifacts, "compatibility matrix.officialRuntime.artifacts");
  const artifacts: Record<string, RuntimeArtifact> = {};
  for (const [key, artifact] of Object.entries(rawArtifacts))
    artifacts[key] = decodeArtifact(artifact, `compatibility matrix.officialRuntime.artifacts.${key}`);
  const version = text(runtime.version, "compatibility matrix.officialRuntime.version");
  const sourceTag = text(runtime.sourceTag, "compatibility matrix.officialRuntime.sourceTag");
  const sourceCommit = text(runtime.sourceCommit, "compatibility matrix.officialRuntime.sourceCommit");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("official runtime version is invalid");
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("official runtime source commit is invalid");
  return { officialRuntime: { version, sourceTag, sourceCommit, artifacts } };
}

function decodeRuntimeManifest(value: unknown): RuntimeManifest {
  const raw = map(value, "runtime manifest");
  const executable = text(raw.executable, "runtime manifest.executable");
  const digest = text(raw.sha256, "runtime manifest.sha256");
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/u.test(executable)) throw new Error("runtime manifest executable is invalid");
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("runtime manifest SHA-256 is invalid");
  return {
    version: integer(raw.version, "runtime manifest.version"),
    tag: text(raw.tag, "runtime manifest.tag"),
    platform: text(raw.platform, "runtime manifest.platform"),
    arch: text(raw.arch, "runtime manifest.arch"),
    executable,
    size: integer(raw.size, "runtime manifest.size"),
    sha256: digest,
  };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function decodeWatermark(frame: JsonMap, label: string): TranscriptWatermark | null {
  if (frame.transcriptWatermark === undefined) return null;
  const watermark = map(frame.transcriptWatermark, `${label}.transcriptWatermark`);
  const lastEntryId = watermark.lastEntryId;
  if (lastEntryId !== null && typeof lastEntryId !== "string")
    throw new Error(`${label}.transcriptWatermark.lastEntryId must be a string or null`);
  return {
    lastEntryId,
    entryCount: integer(watermark.entryCount, `${label}.transcriptWatermark.entryCount`),
  };
}

function messageText(message: JsonMap): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const value = part as JsonMap;
      return typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

async function readSession(path: string): Promise<JsonMap[]> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length > MAX_SESSION_ENTRIES) throw new Error("session entry limit exceeded");
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error(`session line ${index} exceeds 4 MiB`);
    return map(JSON.parse(line), `session[${index}]`);
  });
}

function durableEntries(entries: readonly JsonMap[]): JsonMap[] {
  return entries.filter(
    (entry) => entry.type !== "title" && entry.type !== "session" && typeof entry.id === "string",
  );
}

function transcriptMessages(entries: readonly JsonMap[]): Array<{ role: string; text: string; id: string }> {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || typeof entry.id !== "string") return [];
    const message = map(entry.message, `session message ${entry.id}`);
    if (typeof message.role !== "string") throw new Error(`session message ${entry.id} role is missing`);
    return [{ role: message.role, text: messageText(message), id: entry.id }];
  });
}

function assertWatermark(label: string, watermark: TranscriptWatermark, entries: readonly JsonMap[]): void {
  const durable = durableEntries(entries);
  const lastEntryId = durable.length === 0 ? null : text(durable.at(-1)?.id, `${label}.lastEntryId`);
  if (watermark.entryCount !== durable.length || watermark.lastEntryId !== lastEntryId)
    throw new Error(
      `${label} does not match durable session: ${JSON.stringify({ watermark, durableCount: durable.length, lastEntryId })}`,
    );
}

async function waitForMessages(path: string, count: number): Promise<JsonMap[]> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const entries = await readSession(path);
      if (transcriptMessages(entries).length >= count) return entries;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`durable session did not reach ${count} messages`, { cause: lastError });
}

function requestMessages(body: JsonMap): string[] {
  if (!Array.isArray(body.messages)) throw new Error("model request messages are missing");
  return body.messages.map((raw, index) => {
    const message = map(raw, `model request message ${index}`);
    return `${String(message.role)}:${messageText(message)}`;
  });
}

export function startDeterministicModel(): DeterministicModel {
  const requests: string[][] = [];
  let nextGate:
    | {
        readonly started: ReturnType<typeof Promise.withResolvers<string[]>>;
        readonly released: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 });
      const body = map(await request.json(), "model request");
      const messages = requestMessages(body);
      requests.push(messages);
      const gate = nextGate;
      nextGate = undefined;
      gate?.started.resolve(messages);
      if (gate) await gate.released.promise;
      const ordinal = requests.length;
      const model = typeof body.model === "string" ? body.model : "deterministic";
      const id = `chatcmpl-t4-gate0-${ordinal}`;
      const responseText = messages.some((message) => message.includes(LARGE_RPC_PROBE))
        ? "x".repeat(LARGE_RPC_RESPONSE_BYTES)
        : `Gate 0 response ${ordinal}`;
      const events: unknown[] = [
        {
          id,
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: responseText },
              finish_reason: null,
            },
          ],
        },
        {
          id,
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        },
        "[DONE]",
      ];
      const payload = events
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    server,
    requests,
    gateNextRequest: () => {
      if (nextGate) throw new Error("a deterministic model request is already gated");
      const started = Promise.withResolvers<string[]>();
      const released = Promise.withResolvers<void>();
      nextGate = { started, released };
      return { started: started.promise, release: released.resolve };
    },
  };
}

function launchRpc(
  runtimePath: string,
  sessionPath: string,
  workspace: string,
  profile: string,
  options: LaunchOptions = {},
): RpcHarness {
  const extensionArgs = options.extensionPath
    ? ["--extension", options.extensionPath]
    : ["--no-extensions"];
  const child = Bun.spawn(
    [
      runtimePath,
      "--mode",
      "rpc",
      "--session",
      sessionPath,
      "--cwd",
      workspace,
      "--model",
      "gate0/deterministic",
      "--no-tools",
      ...extensionArgs,
      "--no-skills",
      "--no-rules",
      "--no-title",
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: profile,
        PI_NOTIFICATIONS: "off",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameCount = 0;
  const stderr = new Response(child.stderr).text();

  const nextFrame = async (deadline: number): Promise<JsonMap> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("OMP frame exceeds 4 MiB");
        frameCount++;
        if (frameCount > MAX_FRAMES_PER_TURN) throw new Error("OMP frame count limit exceeded");
        return map(JSON.parse(line), "OMP frame");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("OMP frame timeout");
      const part = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => {
          throw new Error("OMP frame timeout");
        }),
      ]);
      if (part.done) throw new Error("OMP stdout ended before the expected frame");
      buffer += decoder.decode(part.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) throw new Error("OMP partial frame exceeds 4 MiB");
    }
  };

  const waitFor = async (predicate: (frame: JsonMap) => boolean, label: string): Promise<JsonMap[]> => {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    const frames: JsonMap[] = [];
    try {
      for (;;) {
        const frame = await nextFrame(deadline);
        frames.push(frame);
        if (predicate(frame)) return frames;
        if (Date.now() >= deadline) throw new Error("deadline reached");
      }
    } catch (error) {
      throw new Error(
        `timed out waiting for ${label}; observed ${JSON.stringify(frames.map((frame) => frame.type))}`,
        { cause: error },
      );
    }
  };

  const send = (frame: JsonMap): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  return { child, stderr, waitFor, send };
}

function assertPromptTurn(frames: readonly JsonMap[], requestId: string): string[] {
  const response = frames.find((frame) => frame.type === "response" && frame.id === requestId);
  if (!response || response.command !== "prompt" || response.success !== true)
    throw new Error(`prompt ${requestId} was not accepted`);
  if (!frames.some((frame) => frame.type === "agent_end")) throw new Error(`prompt ${requestId} did not finish`);
  return frames.flatMap((frame) => {
    if (frame.type !== "session_entry") return [];
    const entry = map(frame.entry, "session_entry.entry");
    return typeof entry.id === "string" ? [entry.id] : [];
  });
}

function assertAccepted(frames: readonly JsonMap[], requestId: string, command: string): void {
  const response = frames.find((frame) => frame.type === "response" && frame.id === requestId);
  if (!response || response.command !== command || response.success !== true)
    throw new Error(`${command} ${requestId} was not accepted`);
}

async function waitForModelMessage(model: DeterministicModel, expected: string): Promise<string[]> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const request = model.requests.find((messages) => messages.some((message) => message.includes(expected)));
    if (request) return request;
    await Bun.sleep(10);
  }
  throw new Error(`model did not receive ${JSON.stringify(expected)}`);
}

async function stopRpc(rpc: RpcHarness): Promise<void> {
  rpc.child.kill("SIGTERM");
  await rpc.child.exited;
}

async function runQueuedMessageScenario(input: {
  readonly behavior: "steer" | "follow_up";
  readonly runtimePath: string;
  readonly root: string;
  readonly workspace: string;
  readonly profile: string;
  readonly model: DeterministicModel;
}): Promise<{ requestObserved: boolean; accepted: boolean }> {
  const label = input.behavior === "steer" ? "Steering correction" : "Follow-up request";
  const sessionPath = join(input.root, `${input.behavior}.jsonl`);
  const rpc = launchRpc(input.runtimePath, sessionPath, input.workspace, input.profile);
  let stopped = false;
  const gate = input.model.gateNextRequest();
  try {
    await rpc.waitFor((frame) => frame.type === "ready", `${input.behavior} ready`);
    rpc.send({ type: "prompt", id: `${input.behavior}-base`, message: `${input.behavior} base prompt` });
    const promptAck = await rpc.waitFor(
      (frame) => frame.type === "response" && frame.id === `${input.behavior}-base`,
      `${input.behavior} base prompt acceptance`,
    );
    assertAccepted(promptAck, `${input.behavior}-base`, "prompt");
    await gate.started;
    rpc.send({ type: input.behavior, id: `${input.behavior}-queued`, message: label });
    const queueAck = await rpc.waitFor(
      (frame) => frame.type === "response" && frame.id === `${input.behavior}-queued`,
      `${input.behavior} acceptance`,
    );
    assertAccepted(queueAck, `${input.behavior}-queued`, input.behavior);
    gate.release();
    await waitForModelMessage(input.model, label);
    const entries = await waitForMessages(sessionPath, 4);
    if (!transcriptMessages(entries).some((message) => message.text.includes(label)))
      throw new Error(`${input.behavior} message was not durable`);
    await stopRpc(rpc);
    stopped = true;
    return { requestObserved: true, accepted: true };
  } finally {
    gate.release();
    if (!stopped) {
      rpc.child.kill("SIGKILL");
      await rpc.child.exited.catch(() => undefined);
    }
  }
}

async function runCancellationScenario(input: {
  readonly runtimePath: string;
  readonly root: string;
  readonly workspace: string;
  readonly profile: string;
  readonly model: DeterministicModel;
}): Promise<{ accepted: boolean; agentSettled: boolean }> {
  const rpc = launchRpc(input.runtimePath, join(input.root, "cancel.jsonl"), input.workspace, input.profile);
  let stopped = false;
  const gate = input.model.gateNextRequest();
  try {
    await rpc.waitFor((frame) => frame.type === "ready", "cancellation ready");
    rpc.send({ type: "prompt", id: "cancel-base", message: "Cancellation base prompt" });
    const promptAck = await rpc.waitFor(
      (frame) => frame.type === "response" && frame.id === "cancel-base",
      "cancellation prompt acceptance",
    );
    assertAccepted(promptAck, "cancel-base", "prompt");
    await gate.started;
    rpc.send({ type: "abort", id: "cancel-abort" });
    const abortFrames = await rpc.waitFor(
      (frame) => frame.type === "response" && frame.id === "cancel-abort",
      "abort acceptance",
    );
    assertAccepted(abortFrames, "cancel-abort", "abort");
    const agentSettled = abortFrames.some((frame) => frame.type === "agent_end");
    if (!agentSettled) throw new Error("abort acknowledgment arrived before agent settlement");
    gate.release();
    await stopRpc(rpc);
    stopped = true;
    return { accepted: true, agentSettled };
  } finally {
    gate.release();
    if (!stopped) {
      rpc.child.kill("SIGKILL");
      await rpc.child.exited.catch(() => undefined);
    }
  }
}

async function runApprovalScenario(input: {
  readonly runtimePath: string;
  readonly root: string;
  readonly workspace: string;
  readonly profile: string;
}): Promise<{ requestObserved: boolean; approvedValueReturned: boolean }> {
  const extensionPath = join(input.root, "gate0-approval.ts");
  await writeFile(
    extensionPath,
    `export default function (pi) {\n  pi.registerCommand("gate0-confirm", {\n    description: "Gate 0 confirmation proof",\n    handler: async (_args, ctx) => {\n      const confirmed = await ctx.ui.confirm("Gate 0 approval", "Approve this deterministic request?");\n      ctx.ui.notify(\`gate0-confirmed=\${confirmed}\`, "info");\n    },\n  });\n}\n`,
  );
  const rpc = launchRpc(
    input.runtimePath,
    join(input.root, "approval.jsonl"),
    input.workspace,
    input.profile,
    { extensionPath },
  );
  let stopped = false;
  try {
    await rpc.waitFor((frame) => frame.type === "ready", "approval ready");
    rpc.send({ type: "prompt", id: "approval-prompt", message: "/gate0-confirm" });
    const requestFrames = await rpc.waitFor(
      (frame) => frame.type === "extension_ui_request" && frame.method === "confirm",
      "extension confirmation request",
    );
    const request = requestFrames.at(-1)!;
    const requestId = text(request.id, "extension confirmation request id");
    rpc.send({ type: "extension_ui_response", id: requestId, confirmed: true });
    const notifyFrames = await rpc.waitFor(
      (frame) =>
        frame.type === "extension_ui_request" &&
        frame.method === "notify" &&
        frame.message === "gate0-confirmed=true",
      "extension confirmation result",
    );
    await stopRpc(rpc);
    stopped = true;
    return {
      requestObserved: request.method === "confirm",
      approvedValueReturned: notifyFrames.at(-1)?.message === "gate0-confirmed=true",
    };
  } finally {
    if (!stopped) {
      rpc.child.kill("SIGKILL");
      await rpc.child.exited.catch(() => undefined);
    }
  }
}

async function runLargeRpcPayloadScenario(input: {
  readonly runtime: VerifiedRuntime;
  readonly root: string;
  readonly workspace: string;
  readonly profile: string;
}): Promise<{ responseBytes: number; responseSha256: string }> {
  const path = join(input.root, "large-rpc-payload.jsonl");
  const record: SessionRecord = {
    sessionId: sessionId("official-large-rpc-payload"),
    path,
    cwd: input.workspace,
    projectId: projectId("official-large-rpc-project"),
    title: "Large RPC payload",
    updatedAt: new Date().toISOString(),
    status: "idle",
    entries: [],
  };
  const factory = new BunRpcChildFactory(
    { executable: input.runtime.path, prefixArgv: [] },
    undefined,
    { PI_CODING_AGENT_DIR: input.profile, PI_NOTIFICATIONS: "off" },
  );
  const completion = Promise.withResolvers<
    { readonly kind: "agent_end" } | { readonly kind: "crashed"; readonly error: Error }
  >();
  const supervisor = new RpcChildSupervisor(
    factory,
    record,
    {
      entry: () => {},
      event: (frame) => {
        if (frame.type === "agent_end") completion.resolve({ kind: "agent_end" });
      },
      crashed: (error) => completion.resolve({ kind: "crashed", error }),
    },
    [
      input.runtime.path,
      "--mode",
      "rpc",
      "--session",
      path,
      "--cwd",
      input.workspace,
      "--model",
      "gate0/deterministic",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-title",
    ],
    undefined,
    input.runtime.matrix.officialRuntime.version,
  );
  try {
    await supervisor.start();
    const prompt = await supervisor.call({ type: "prompt", message: LARGE_RPC_PROBE }, "large-rpc-prompt");
    if (!prompt.success) throw new Error(`large RPC probe prompt failed: ${prompt.error}`);
    const outcome = await Promise.race([
      completion.promise,
      Bun.sleep(FRAME_TIMEOUT_MS).then(() => {
        throw new Error("large RPC probe timed out");
      }),
    ]);
    if (outcome.kind === "crashed") throw outcome.error;
    const messages: JsonMap[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let totalMessages: number | undefined;
    do {
      const page = await supervisor.call(
        { type: "get_messages_page", limit: 10, ...(cursor ? { cursor } : {}) },
        `large-rpc-page-${messages.length}`,
      );
      if (!page.success) throw new Error(`large RPC page failed: ${page.error}`);
      const data = map(page.data, "large RPC page data");
      if (!Array.isArray(data.messages)) throw new Error("large RPC page messages are missing");
      if (!Number.isSafeInteger(data.totalMessages) || (data.totalMessages as number) < 0)
        throw new Error("large RPC page total is invalid");
      if (totalMessages !== undefined && data.totalMessages !== totalMessages)
        throw new Error("large RPC page total changed");
      totalMessages = data.totalMessages as number;
      messages.push(
        ...data.messages.map((message, index) =>
          map(message, `large RPC page message ${messages.length + index}`),
        ),
      );
      cursor = data.nextCursor === undefined ? undefined : text(data.nextCursor, "large RPC page cursor");
      if (cursor && seenCursors.has(cursor)) throw new Error("large RPC page repeated a cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (messages.length !== totalMessages) throw new Error("large RPC pagination ended early");
    const response = messages.find(
      (message) => message.role === "assistant" && messageText(message).length === LARGE_RPC_RESPONSE_BYTES,
    );
    if (!response) throw new Error("large RPC response was not reassembled losslessly");
    const responseBytes = Buffer.byteLength(messageText(response), "utf8");
    if (responseBytes !== LARGE_RPC_RESPONSE_BYTES)
      throw new Error(`large RPC response has ${responseBytes} bytes`);
    const responseSha256 = createHash("sha256").update(messageText(response), "utf8").digest("hex");
    if (responseSha256 !== LARGE_RPC_RESPONSE_SHA256)
      throw new Error(`large RPC response digest is ${responseSha256}`);
    return { responseBytes, responseSha256 };
  } finally {
    const child = supervisor.child();
    supervisor.stop();
    await child?.exited.catch(() => undefined);
  }
}

export async function verifyRuntime(repoRoot: string): Promise<VerifiedRuntime> {
  const matrix = decodeRuntimeMatrix(await readJson(join(repoRoot, "compat", "omp-app-matrix.json")));
  const manifestPath = join(repoRoot, ".artifacts", "omp-runtime-official", "manifest.json");
  const manifest = decodeRuntimeManifest(await readJson(manifestPath));
  const key = `${process.platform}-${process.arch}`;
  const artifact = matrix.officialRuntime.artifacts[key];
  if (!artifact) throw new Error(`verified OMP runtime has no ${key} artifact`);
  const runtimePath = join(repoRoot, ".artifacts", "omp-runtime-official", manifest.executable);
  const runtimeStat = await stat(runtimePath);
  const digest = await sha256(runtimePath);
  if (
    manifest.version !== 1 ||
    manifest.tag !== matrix.officialRuntime.sourceTag ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    basename(runtimePath) !== manifest.executable ||
    manifest.size !== artifact.size ||
    manifest.sha256 !== artifact.sha256 ||
    runtimeStat.size !== artifact.size ||
    digest !== artifact.sha256
  )
    throw new Error("staged OMP runtime does not match the verified compatibility matrix");
  const versionProcess = Bun.spawn([runtimePath, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [version, versionError, versionExit] = await Promise.all([
    new Response(versionProcess.stdout).text(),
    new Response(versionProcess.stderr).text(),
    versionProcess.exited,
  ]);
  if (versionExit !== 0) throw new Error(`OMP version check failed: ${versionError.trim()}`);
  if (!version.includes(matrix.officialRuntime.version))
    throw new Error(`OMP version ${JSON.stringify(version.trim())} does not match ${matrix.officialRuntime.version}`);
  return { path: runtimePath, matrix, manifest, version: version.trim() };
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const runtime = await verifyRuntime(repoRoot);
  const root = await mkdtemp(join(tmpdir(), "t4-official-omp-gate0-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  const sessionPath = join(root, "session.jsonl");
  const model = startDeterministicModel();
  let active: RpcHarness | undefined;

  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, "models.yml"),
      `providers:\n  gate0:\n    baseUrl: http://127.0.0.1:${model.server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Gate 0 Deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`,
    );

    active = launchRpc(runtime.path, sessionPath, workspace, profile);
    const initialFrames = await active.waitFor((frame) => frame.type === "ready", "initial ready watermark");
    const initialWatermark = decodeWatermark(initialFrames.at(-1)!, "initial ready");
    if (initialWatermark) assertWatermark("initial ready watermark", initialWatermark, await readSession(sessionPath));
    active.send({ type: "prompt", id: "gate0-prompt-1", message: "First prompt" });
    const firstFrames = await active.waitFor((frame) => frame.type === "agent_end", "first prompt completion");
    const firstLiveEntryIds = assertPromptTurn(firstFrames, "gate0-prompt-1");
    const firstEntries = await waitForMessages(sessionPath, 2);
    const firstDurableIds = new Set(durableEntries(firstEntries).map((entry) => entry.id));
    if (firstLiveEntryIds.some((id) => !firstDurableIds.has(id)))
      throw new Error("first turn published a session entry before it became durable");
    active.child.kill("SIGKILL");
    await active.child.exited;
    active = undefined;
    const lockRecoveryStartedAt = Date.now();
    await Bun.sleep(STALE_LOCK_RECOVERY_MS);
    const lockRecoveryWaitMs = Date.now() - lockRecoveryStartedAt;

    const restartEntries = await readSession(sessionPath);
    active = launchRpc(runtime.path, sessionPath, workspace, profile);
    const restartFrames = await active.waitFor((frame) => frame.type === "ready", "restart ready watermark");
    const restartWatermark = decodeWatermark(restartFrames.at(-1)!, "restart ready");
    if (restartWatermark) assertWatermark("restart ready watermark", restartWatermark, restartEntries);
    active.send({ type: "prompt", id: "gate0-prompt-2", message: "Second prompt" });
    const secondFrames = await active.waitFor((frame) => frame.type === "agent_end", "second prompt completion");
    const secondLiveEntryIds = assertPromptTurn(secondFrames, "gate0-prompt-2");
    const finalEntries = await waitForMessages(sessionPath, 4);
    const finalDurableIds = new Set(durableEntries(finalEntries).map((entry) => entry.id));
    if (secondLiveEntryIds.some((id) => !finalDurableIds.has(id)))
      throw new Error("second turn published a session entry before it became durable");

    const messages = transcriptMessages(finalEntries);
    const expectedMessages = [
      { role: "user", text: "First prompt" },
      { role: "assistant", text: "Gate 0 response 1" },
      { role: "user", text: "Second prompt" },
      { role: "assistant", text: "Gate 0 response 2" },
    ];
    if (JSON.stringify(messages.map(({ role, text: value }) => ({ role, text: value }))) !== JSON.stringify(expectedMessages))
      throw new Error(`durable transcript order is wrong: ${JSON.stringify(messages)}`);
    if (model.requests.length !== 2) throw new Error(`expected two model requests, received ${model.requests.length}`);
    if (!model.requests[1]?.some((message) => message.includes("First prompt")))
      throw new Error("restarted model context omitted the first user message");
    if (!model.requests[1]?.some((message) => message.includes("Gate 0 response 1")))
      throw new Error("restarted model context omitted the first assistant response");

    active.child.kill("SIGTERM");
    await active.child.exited;
    active = undefined;
    const steer = await runQueuedMessageScenario({
      behavior: "steer",
      runtimePath: runtime.path,
      root,
      workspace,
      profile,
      model,
    });
    const followUp = await runQueuedMessageScenario({
      behavior: "follow_up",
      runtimePath: runtime.path,
      root,
      workspace,
      profile,
      model,
    });
    const approval = await runApprovalScenario({ runtimePath: runtime.path, root, workspace, profile });
    const cancellation = await runCancellationScenario({
      runtimePath: runtime.path,
      root,
      workspace,
      profile,
      model,
    });
    const largeRpcPayload = await runLargeRpcPayloadScenario({ runtime, root, workspace, profile });
    const result = {
      schemaVersion: 1,
      runtime: {
        version: runtime.version,
        tag: runtime.matrix.officialRuntime.sourceTag,
        commit: runtime.matrix.officialRuntime.sourceCommit,
        sha256: runtime.manifest.sha256,
      },
      platform: { os: process.platform, arch: process.arch },
      scenarios: {
        lifecycle: {
          durableMessages: messages.length,
          crashSignal: "SIGKILL",
          lockRecoveryWaitMs,
          resumedSameSession: true,
        },
        steer,
        followUp,
        approval,
        cancellation,
        largeRpcPayload,
      },
      observedStockSeams: {
        readyTranscriptWatermark: initialWatermark !== null && restartWatermark !== null,
        liveSessionEntries: firstLiveEntryIds.length + secondLiveEntryIds.length > 0,
        durableCommandKey: false,
      },
      modelRequestCount: model.requests.length,
      passed: true,
    };
    const evidenceRoot = join(repoRoot, "artifacts", "official-omp-gate0");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, `${process.platform}-${process.arch}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (active) {
      active.child.kill("SIGKILL");
      await active.child.exited.catch(() => undefined);
      const stderr = (await active.stderr.catch(() => "")).trim();
      if (stderr) console.error(stderr.slice(-4_096));
    }
    await model.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
