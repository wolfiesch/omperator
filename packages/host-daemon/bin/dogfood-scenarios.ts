#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultFrame, ServerFrame } from "@t4-code/protocol";
import { OfficialOmpProfileAuthority, profileSocketPath } from "@t4-code/host-service";
import { startDeterministicModel, verifyRuntime } from "../../host-service/bin/official-omp-gate0.ts";
import { RawUdsWebSocket } from "../../host-service/test/raw-uds-client.ts";

const TIMEOUT_MS = 20_000;
const SCENARIOS = new Set(["stream", "cancel", "reconnect", "lifecycle", "full"]);

type Scenario = "stream" | "cancel" | "reconnect" | "lifecycle" | "full";
type WelcomeFrame = Extract<ServerFrame, { type: "welcome" }>;
type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;
type SnapshotFrame = Extract<ServerFrame, { type: "snapshot" }>;
type SessionDeltaFrame = Extract<ServerFrame, { type: "session.delta" }>;
type EntryFrame = Extract<ServerFrame, { type: "entry" }>;

interface Options {
  readonly scenario: Scenario;
  readonly artifactRoot: string;
  readonly hostPath?: string;
  readonly runtimePath?: string;
}

interface ConnectedClient {
  readonly client: RawUdsWebSocket;
  readonly welcome: WelcomeFrame;
  readonly sessions: SessionsFrame;
}

function parseArguments(argv: readonly string[], repoRoot: string): Options {
  let scenario: Scenario = "full";
  let artifactRoot = resolve(repoRoot, "artifacts", "dogfood", `run-${Date.now()}`);
  let hostPath: string | undefined;
  let runtimePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[++index];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--scenario" && SCENARIOS.has(value)) scenario = value as Scenario;
    else if (argument === "--artifact-root") artifactRoot = resolve(value);
    else if (argument === "--host") hostPath = resolve(value);
    else if (argument === "--runtime") runtimePath = resolve(value);
    else throw new Error(`unknown dogfood option: ${argument}`);
  }
  return { scenario, artifactRoot, hostPath, runtimePath };
}

async function next(client: RawUdsWebSocket, label: string): Promise<ServerFrame> {
  return Promise.race([
    client.nextServer(),
    Bun.sleep(TIMEOUT_MS).then(() => {
      throw new Error(`${label} timed out`);
    }),
  ]);
}

async function waitForSocket(path: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {}
    const exited = await Promise.race([child.exited.then((code) => ({ code })), Bun.sleep(25).then(() => undefined)]);
    if (exited) throw new Error(`dogfood host exited before readiness (${exited.code})`);
  }
  throw new Error("dogfood host socket timed out");
}

async function connectClient(socketPath: string, label: string): Promise<ConnectedClient> {
  const client = await RawUdsWebSocket.connect(socketPath);
  client.sendJson({
    v: "omp-app/1",
    type: "hello",
    protocol: { min: "omp-app/1", max: "omp-app/1" },
    client: { name: label, version: "1", build: "dogfood", platform: process.platform },
    requestedFeatures: [],
    capabilities: {
      client: ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "catalog.read"],
    },
    savedCursors: [],
  });
  const welcome = await next(client, `${label} welcome`);
  if (welcome.type !== "welcome") throw new Error(`${label} did not receive Welcome`);
  const sessions = await next(client, `${label} sessions`);
  if (sessions.type !== "sessions") throw new Error(`${label} did not receive Sessions`);
  return { client, welcome, sessions };
}

let commandSequence = 0;
function sendCommand(
  connection: ConnectedClient,
  requestId: string,
  name: string,
  sessionId: string,
  args: Record<string, unknown>,
  expectedRevision?: string,
): string {
  commandSequence += 1;
  const commandId = `dogfood-command-${commandSequence}`;
  connection.client.sendJson({
    v: "omp-app/1",
    type: "command",
    requestId,
    commandId,
    hostId: connection.welcome.hostId,
    sessionId,
    command: name,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    args,
  });
  return commandId;
}

async function responseFor(client: RawUdsWebSocket, requestId: string, journal: ServerFrame[]): Promise<ResultFrame> {
  for (;;) {
    const frame = await next(client, `${requestId} response`);
    journal.push(frame);
    if (frame.type === "response" && frame.requestId === requestId) return frame;
  }
}

function requireSuccess(response: ResultFrame, label: string): void {
  if (!response.ok) {
    const detail = response.error ? `${response.error.code}: ${response.error.message}` : "unknown error";
    throw new Error(`${label} failed: ${detail}`);
  }
}

async function attach(connection: ConnectedClient, sessionId: string, journal: ServerFrame[]): Promise<SnapshotFrame> {
  const requestId = `attach-${randomUUID()}`;
  sendCommand(connection, requestId, "session.attach", sessionId, {});
  requireSuccess(await responseFor(connection.client, requestId, journal), "session.attach");
  for (;;) {
    const frame = await next(connection.client, "session snapshot");
    journal.push(frame);
    if (frame.type === "snapshot" && frame.sessionId === sessionId) return frame;
  }
}

async function waitForAssistant(
  connection: ConnectedClient,
  sessionId: string,
  expectedText: string,
  journal: ServerFrame[],
): Promise<EntryFrame> {
  for (;;) {
    const frame = await next(connection.client, "assistant entry");
    journal.push(frame);
    if (
      frame.type === "entry" &&
      frame.sessionId === sessionId &&
      frame.entry.kind === "message" &&
      frame.entry.data.role === "assistant" &&
      frame.entry.data.text === expectedText
    ) return frame;
  }
}

async function waitForDelta(
  connection: ConnectedClient,
  sessionId: string,
  predicate: (frame: SessionDeltaFrame) => boolean,
  journal: ServerFrame[],
): Promise<SessionDeltaFrame> {
  for (;;) {
    const frame = await next(connection.client, "session delta");
    journal.push(frame);
    if (frame.type === "session.delta" && frame.sessionId === sessionId && predicate(frame)) return frame;
  }
}

async function lifecycleCommand(
  connection: ConnectedClient,
  sessionId: string,
  name: "session.rename" | "session.archive" | "session.restore",
  revision: string,
  args: Record<string, unknown>,
  predicate: (frame: SessionDeltaFrame) => boolean,
  journal: ServerFrame[],
): Promise<SessionDeltaFrame> {
  const requestId = `${name}-${randomUUID()}`;
  sendCommand(connection, requestId, name, sessionId, args, revision);
  requireSuccess(await responseFor(connection.client, requestId, journal), name);
  return waitForDelta(connection, sessionId, predicate, journal);
}

async function deleteSession(
  connection: ConnectedClient,
  sessionId: string,
  revision: string,
  journal: ServerFrame[],
): Promise<void> {
  const requestId = `delete-${randomUUID()}`;
  const commandId = sendCommand(connection, requestId, "session.delete", sessionId, {}, revision);
  let challenge: Extract<ServerFrame, { type: "confirmation" }> | undefined;
  while (challenge === undefined) {
    const frame = await next(connection.client, "delete confirmation");
    journal.push(frame);
    if (frame.type === "confirmation" && frame.commandId === commandId) challenge = frame;
  }
  connection.client.sendJson({
    v: "omp-app/1",
    type: "confirm",
    requestId: `confirm-${randomUUID()}`,
    confirmationId: challenge.confirmationId,
    commandId,
    hostId: connection.welcome.hostId,
    sessionId,
    decision: "approve",
  });
  requireSuccess(await responseFor(connection.client, requestId, journal), "session.delete");
  await waitForDelta(connection, sessionId, (frame) => frame.remove === sessionId, journal);
}

function wireSummary(frame: ServerFrame): Record<string, unknown> {
  return {
    type: frame.type,
    ...(Object.hasOwn(frame, "sessionId") ? { sessionId: String(Reflect.get(frame, "sessionId")) } : {}),
    ...(Object.hasOwn(frame, "requestId") ? { requestId: String(Reflect.get(frame, "requestId")) } : {}),
    ...(Object.hasOwn(frame, "revision") ? { revision: String(Reflect.get(frame, "revision")) } : {}),
    ...(frame.type === "entry" ? { entryId: String(frame.entry.id), entryKind: frame.entry.kind } : {}),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const options = parseArguments(process.argv.slice(2), repoRoot);
  const verified = await verifyRuntime(repoRoot);
  const runtimePath = options.runtimePath ?? verified.path;
  const hostPath = options.hostPath ?? join(repoRoot, "packages", "host-daemon", "dist", "t4-host");
  if (!(await stat(hostPath)).isFile()) throw new Error("build the dogfood host before running scenarios");
  if (!(await stat(runtimePath)).isFile()) throw new Error("dogfood OMP runtime is missing");
  if ((await sha256(runtimePath)) !== verified.manifest.sha256) {
    throw new Error("dogfood OMP runtime does not match the recorded official artifact");
  }

  await mkdir(options.artifactRoot, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "omperator-dogfood-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const sessionsRoot = join(root, "sessions");
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "run");
  const profile = `dogfood-${randomUUID().slice(0, 12)}`;
  const agentDir = join(home, ".omp", "profiles", profile, "agent");
  const model = startDeterministicModel();
  const journal: ServerFrame[] = [];
  const scenarioResults: Record<string, unknown> = {};
  let child: Bun.Subprocess | undefined;
  let primary: ConnectedClient | undefined;
  let observer: ConnectedClient | undefined;
  let reconnect: ConnectedClient | undefined;
  let failure: unknown;

  try {
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(agentDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(join(project, "dogfood.txt"), "isolated dogfood fixture\n");
    await writeFile(
      join(agentDir, "models.yml"),
      `providers:\n  dogfood:\n    baseUrl: http://127.0.0.1:${model.server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Dogfood Deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`,
    );
    const seed = new OfficialOmpProfileAuthority({ sessionsRoot, metadataPath: join(root, "seed-metadata.json") });
    await seed.initialize();
    const session = await seed.create(project, "Omperator dogfood");
    await seed.close();

    const socketPath = profileSocketPath(profile, process.platform, home, runtimeRoot);
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_RUNTIME_DIR: runtimeRoot,
      PI_NOTIFICATIONS: "off",
      OMP_PROFILE: profile,
    };
    child = Bun.spawn([
      hostPath,
      "serve",
      "--omp",
      runtimePath,
      "--omp-authority",
      "official",
      "--omp-sessions-root",
      sessionsRoot,
      "--profile",
      profile,
      "--state-root",
      stateRoot,
    ], { env: environment, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    await waitForSocket(socketPath, child);

    primary = await connectClient(socketPath, "dogfood-primary");
    observer = await connectClient(socketPath, "dogfood-observer");
    const initial = primary.sessions.sessions.find((item) => item.sessionId === session.sessionId);
    if (!initial) throw new Error("seeded dogfood session was not discovered");
    await attach(primary, session.sessionId, journal);
    await attach(observer, session.sessionId, journal);

    if (options.scenario === "full" || options.scenario === "stream" || options.scenario === "reconnect") {
      const requestId = `prompt-${randomUUID()}`;
      sendCommand(primary, requestId, "session.prompt", session.sessionId, { message: "Dogfood stream prompt" });
      requireSuccess(await responseFor(primary.client, requestId, journal), "session.prompt");
      const [primaryEntry, observerEntry] = await Promise.all([
        waitForAssistant(primary, session.sessionId, "Gate 0 response 1", journal),
        waitForAssistant(observer, session.sessionId, "Gate 0 response 1", journal),
      ]);
      if (primaryEntry.entry.id !== observerEntry.entry.id) throw new Error("clients observed different assistant entries");
      const transcript = await readFile(session.path, "utf8");
      if (!transcript.includes("Dogfood stream prompt") || !transcript.includes("Gate 0 response 1")) {
        throw new Error("streamed dogfood prompt was not durable");
      }
      scenarioResults.stream = { durable: true, convergedEntryId: String(primaryEntry.entry.id) };
    }

    if (options.scenario === "full" || options.scenario === "cancel") {
      const gate = model.gateNextRequest();
      try {
        const promptId = `cancel-prompt-${randomUUID()}`;
        sendCommand(primary, promptId, "session.prompt", session.sessionId, { message: "Dogfood cancellation prompt" });
        requireSuccess(await responseFor(primary.client, promptId, journal), "cancellation prompt");
        await gate.started;
        const cancelId = `cancel-${randomUUID()}`;
        sendCommand(primary, cancelId, "session.cancel", session.sessionId, {});
        const cancelled = await responseFor(primary.client, cancelId, journal);
        requireSuccess(cancelled, "session.cancel");
        scenarioResults.cancel = { accepted: true, terminalResponse: cancelled.result };
      } finally {
        gate.release();
      }
    }

    if (options.scenario === "full" || options.scenario === "reconnect") {
      await primary.client.close();
      primary = undefined;
      reconnect = await connectClient(socketPath, "dogfood-reconnect");
      const snapshot = await attach(reconnect, session.sessionId, journal);
      const entryIds = snapshot.entries.map((entry) => String(entry.id));
      if (new Set(entryIds).size !== entryIds.length) throw new Error("reconnect snapshot duplicated transcript entries");
      if (!snapshot.entries.some((entry) => entry.kind === "message" && entry.data.role === "assistant" && entry.data.text === "Gate 0 response 1")) {
        throw new Error("reconnect snapshot lost the durable assistant response");
      }
      scenarioResults.reconnect = { uniqueEntries: entryIds.length, revision: String(snapshot.revision) };
    }

    if (options.scenario === "full" || options.scenario === "lifecycle") {
      const controller = reconnect ?? primary;
      if (!controller) throw new Error("lifecycle controller is unavailable");
      const current = controller.sessions.sessions.find((item) => item.sessionId === session.sessionId);
      let revision = reconnect
        ? String((await attach(reconnect, session.sessionId, journal)).revision)
        : String(current?.revision ?? initial.revision);
      const renamed = await lifecycleCommand(
        controller,
        session.sessionId,
        "session.rename",
        revision,
        { name: "Omperator dogfood renamed" },
        (frame) => frame.upsert?.title === "Omperator dogfood renamed",
        journal,
      );
      revision = String(renamed.revision);
      const observerRename = await waitForDelta(
        observer,
        session.sessionId,
        (frame) => frame.upsert?.title === "Omperator dogfood renamed",
        journal,
      );
      if (observerRename.revision !== renamed.revision) throw new Error("rename did not converge across clients");
      const archived = await lifecycleCommand(
        controller,
        session.sessionId,
        "session.archive",
        revision,
        {},
        (frame) => frame.upsert?.archivedAt !== undefined,
        journal,
      );
      revision = String(archived.revision);
      const archivedPromptId = `archived-prompt-${randomUUID()}`;
      sendCommand(controller, archivedPromptId, "session.prompt", session.sessionId, { message: "must not run" });
      const archivedPrompt = await responseFor(controller.client, archivedPromptId, journal);
      if (archivedPrompt.ok) throw new Error("archived session accepted a prompt");
      const restored = await lifecycleCommand(
        controller,
        session.sessionId,
        "session.restore",
        revision,
        {},
        (frame) => frame.upsert !== undefined && frame.upsert.archivedAt === undefined,
        journal,
      );
      revision = String(restored.revision);
      await deleteSession(controller, session.sessionId, revision, journal);
      scenarioResults.lifecycle = {
        renamed: true,
        archived: true,
        archivedWriteRejected: true,
        restored: true,
        deleted: true,
        observerConverged: true,
      };
    }

    const report = {
      schemaVersion: 1,
      scenario: options.scenario,
      source: { commit: Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"]).stdout.toString().trim() },
      runtime: {
        version: verified.version,
        tag: verified.matrix.officialRuntime.sourceTag,
        commit: verified.matrix.officialRuntime.sourceCommit,
        sha256: verified.manifest.sha256,
      },
      packagedInputs: {
        hostSha256: await sha256(hostPath),
        runtimeSha256: await sha256(runtimePath),
      },
      scenarios: scenarioResults,
      cleanup: { disposableRoot: true },
      passed: true,
    };
    await writeFile(join(options.artifactRoot, "wire-events.ndjson"), `${journal.map((frame) => JSON.stringify(wireSummary(frame))).join("\n")}\n`);
    await writeFile(join(options.artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    await primary?.client.close();
    primary = undefined;
    await observer.client.close();
    observer = undefined;
    await reconnect?.client.close();
    reconnect = undefined;
    child.kill("SIGTERM");
    if ((await child.exited) !== 0) throw new Error(`dogfood host failed: ${(await stderr).trim().slice(-4_096)}`);
    child = undefined;
    await stdout;
  } catch (error) {
    failure = error;
    await writeFile(join(options.artifactRoot, "report.json"), `${JSON.stringify({ schemaVersion: 1, scenario: options.scenario, scenarios: scenarioResults, passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  } finally {
    primary?.client.destroy();
    observer?.client.destroy();
    reconnect?.client.destroy();
    if (child) {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
    await model.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

await main();
