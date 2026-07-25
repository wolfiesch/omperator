#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ResultFrame, ServerFrame } from "@t4-code/protocol";
import { OfficialOmpProfileAuthority, profileSocketPath } from "@t4-code/host-service";
import { startDeterministicModel, verifyRuntime } from "../../host-service/bin/official-omp-gate0.ts";
import { RawUdsWebSocket } from "../../host-service/test/raw-uds-client.ts";

const TIMEOUT_MS = 20_000;
const SCENARIOS = new Set(["stream", "cancel", "reconnect", "lifecycle", "full"]);

type Scenario = "stream" | "cancel" | "reconnect" | "lifecycle" | "full";
type DogfoodSession = { sessionId: string; path?: string };
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
  for (;;) {
    const sessions = await next(client, `${label} sessions`);
    if (sessions.type === "sessions") return { client, welcome, sessions };
  }
}

async function waitForInventory(
  socketPath: string,
  sessionId: string,
  predicate: (session: SessionsFrame["sessions"][number] | undefined) => boolean,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const connection = await connectClient(socketPath, `dogfood-inventory-${attempt}`);
    const session = connection.sessions.sessions.find((item) => item.sessionId === sessionId);
    await connection.client.close();
    if (predicate(session)) return;
    attempt += 1;
    await Bun.sleep(50);
  }
  throw new Error("session inventory did not converge");
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

async function forkOwnedSession(
  connection: ConnectedClient,
  sourceSessionId: string,
  journal: ServerFrame[],
): Promise<DogfoodSession> {
  const requestId = `fork-${randomUUID()}`;
  sendCommand(connection, requestId, "session.fork", sourceSessionId, {});
  const response = await responseFor(connection.client, requestId, journal);
  requireSuccess(response, "session.fork");
  const result = response.result as { session?: { sessionId?: unknown; path?: unknown } } | undefined;
  if (typeof result?.session?.sessionId !== "string") throw new Error("session.fork omitted the owned session");
  return {
    sessionId: result.session.sessionId,
    ...(typeof result.session.path === "string" ? { path: result.session.path } : {}),
  };
}

async function promptWhenIdle(
  connection: ConnectedClient,
  sessionId: string,
  message: string,
  journal: ServerFrame[],
): Promise<ResultFrame> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const requestId = `prompt-${randomUUID()}`;
    sendCommand(connection, requestId, "session.prompt", sessionId, { message });
    const response = await responseFor(connection.client, requestId, journal);
    if (response.ok) return response;
    if (!response.error || !["session_busy", "session_locked"].includes(response.error.code)) {
      requireSuccess(response, "session.prompt");
    }
    await Bun.sleep(50);
  }
  throw new Error("session did not become writable before dogfood prompt");
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

function recordedDelta(
  journal: readonly ServerFrame[],
  start: number,
  sessionId: string,
  predicate: (frame: SessionDeltaFrame) => boolean,
): SessionDeltaFrame | undefined {
  return journal
    .slice(start)
    .find(
      (frame): frame is SessionDeltaFrame =>
        frame.type === "session.delta" && frame.sessionId === sessionId && predicate(frame),
    );
}

async function lifecycleCommand(
  connection: ConnectedClient,
  sessionId: string,
  name: "session.archive" | "session.restore",
  revision: string,
  args: Record<string, unknown>,
  journal: ServerFrame[],
): Promise<string> {
  let currentRevision = revision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestId = `${name}-${randomUUID()}`;
    sendCommand(connection, requestId, name, sessionId, args, currentRevision);
    const response = await responseFor(connection.client, requestId, journal);
    if (response.ok) return currentRevision;
    const actualRevision =
      response.error?.code === "stale_revision" &&
      response.error.details &&
      typeof response.error.details.actualRevision === "string"
        ? response.error.details.actualRevision
        : undefined;
    if (actualRevision === undefined) {
      requireSuccess(response, name);
      continue;
    }
    currentRevision = actualRevision;
  }
  throw new Error(`${name} could not acquire the current session revision`);
}

async function confirmedCommand(
  connection: ConnectedClient,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  journal: ServerFrame[],
  expectedRevision?: string,
): Promise<ResultFrame> {
  let currentRevision = expectedRevision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestId = `${name}-${randomUUID()}`;
    const commandId = sendCommand(connection, requestId, name, sessionId, args, currentRevision);
    let challenge: Extract<ServerFrame, { type: "confirmation" }> | undefined;
    let retryRevision: string | undefined;
    while (challenge === undefined) {
      const frame = await next(connection.client, `${name} confirmation`);
      journal.push(frame);
      if (frame.type === "confirmation" && frame.commandId === commandId) challenge = frame;
      if (frame.type === "response" && frame.requestId === requestId) {
        retryRevision =
          frame.error?.code === "stale_revision" &&
          frame.error.details &&
          typeof frame.error.details.actualRevision === "string"
            ? frame.error.details.actualRevision
            : undefined;
        if (retryRevision === undefined) {
          requireSuccess(frame, name);
          return frame;
        }
        break;
      }
    }
    if (retryRevision !== undefined) {
      currentRevision = retryRevision;
      continue;
    }
    connection.client.sendJson({
      v: "omp-app/1",
      type: "confirm",
      requestId: `confirm-${randomUUID()}`,
      confirmationId: challenge!.confirmationId,
      commandId,
      hostId: connection.welcome.hostId,
      sessionId,
      decision: "approve",
    });
    const confirmed = await responseFor(connection.client, requestId, journal);
    const confirmedRevision =
      confirmed.error?.code === "stale_revision" &&
      confirmed.error.details &&
      typeof confirmed.error.details.actualRevision === "string"
        ? confirmed.error.details.actualRevision
        : undefined;
    if (confirmedRevision !== undefined) {
      currentRevision = confirmedRevision;
      continue;
    }
    return confirmed;
  }
  throw new Error(`${name} could not acquire the current session revision`);
}

async function renameSession(
  connection: ConnectedClient,
  sessionId: string,
  revision: string,
  name: string,
  journal: ServerFrame[],
): Promise<string> {
  let currentRevision = revision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestId = `session.rename-${randomUUID()}`;
    sendCommand(connection, requestId, "session.rename", sessionId, { name }, currentRevision);
    const response = await responseFor(connection.client, requestId, journal);
    if (response.ok) return currentRevision;
    const actualRevision =
      response.error?.code === "stale_revision" &&
      response.error.details &&
      typeof response.error.details.actualRevision === "string"
        ? response.error.details.actualRevision
        : undefined;
    if (actualRevision === undefined) requireSuccess(response, "session.rename");
    else currentRevision = actualRevision;
  }
  throw new Error("session.rename could not acquire the current session revision");
}

async function waitForMissingFile(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("deleted session file still exists");
}

async function waitForFileText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readFile(path, "utf8")).includes(expected)) return;
    await Bun.sleep(25);
  }
  throw new Error("renamed session title was not durable");
}

async function deleteSession(
  connection: ConnectedClient,
  sessionId: string,
  revision: string,
  journal: ServerFrame[],
): Promise<void> {
  requireSuccess(
    await confirmedCommand(connection, sessionId, "session.delete", {}, journal, revision),
    "session.delete",
  );
}

function wireSummary(frame: ServerFrame): Record<string, unknown> {
  return {
    type: frame.type,
    ...(Object.hasOwn(frame, "sessionId") ? { sessionId: String(Reflect.get(frame, "sessionId")) } : {}),
    ...(Object.hasOwn(frame, "requestId") ? { requestId: String(Reflect.get(frame, "requestId")) } : {}),
    ...(Object.hasOwn(frame, "revision") ? { revision: String(Reflect.get(frame, "revision")) } : {}),
    ...(frame.type === "entry" ? { entryId: String(frame.entry.id), entryKind: frame.entry.kind } : {}),
    ...(frame.type === "error" ? { code: frame.code, message: frame.message } : {}),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const options = parseArguments(process.argv.slice(2), repoRoot);
  const verified = options.runtimePath === undefined ? await verifyRuntime(repoRoot) : undefined;
  const runtimePath = options.runtimePath ?? verified!.path;
  const hostPath = options.hostPath ?? join(repoRoot, "packages", "host-daemon", "dist", "t4-host");
  if (!(await stat(hostPath)).isFile()) throw new Error("build the dogfood host before running scenarios");
  if (!(await stat(runtimePath)).isFile()) throw new Error("dogfood OMP runtime is missing");
  const runtimeHash = await sha256(runtimePath);
  const runtimeEvidence =
    options.runtimePath === undefined
      ? {
          version: verified!.version,
          tag: verified!.matrix.officialRuntime.sourceTag,
          commit: verified!.matrix.officialRuntime.sourceCommit,
          sha256: verified!.manifest.sha256,
        }
      : await (async () => {
          const manifest = JSON.parse(await readFile(join(dirname(runtimePath), "manifest.json"), "utf8")) as Record<string, unknown>;
          if (typeof manifest.tag !== "string" || typeof manifest.sha256 !== "string" || manifest.sha256 !== runtimeHash) {
            throw new Error("packaged OMP runtime does not match its bundled manifest");
          }
          return { version: manifest.tag, tag: manifest.tag, commit: null, sha256: manifest.sha256 };
        })();
  if (runtimeHash !== runtimeEvidence.sha256) throw new Error("dogfood OMP runtime hash is not verified");

  await mkdir(options.artifactRoot, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "omperator-dogfood-"));
  const home = join(root, "home");
  const streamProject = join(root, "projects", "stream");
  const cancelProject = join(root, "projects", "cancel");
  const lifecycleProject = join(root, "projects", "lifecycle");
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "run");
  const profile = `dogfood-${randomUUID().slice(0, 12)}`;
  const agentDir = join(home, ".omp", "profiles", profile, "agent");
  const authorityMode = options.runtimePath === undefined ? "official" : "bridge";
  const sessionsRoot = authorityMode === "official" ? join(root, "sessions") : join(agentDir, "sessions");
  const model = startDeterministicModel();
  const journal: ServerFrame[] = [];
  const scenarioResults: Record<string, unknown> = {};
  let child: Bun.Subprocess | undefined;
  let primary: ConnectedClient | undefined;
  let observer: ConnectedClient | undefined;
  let reconnect: ConnectedClient | undefined;
  let failure: unknown;
  let hostStdout: Promise<string> | undefined;
  let hostStderr: Promise<string> | undefined;

  try {
    await Promise.all([
      mkdir(streamProject, { recursive: true }),
      mkdir(cancelProject, { recursive: true }),
      mkdir(lifecycleProject, { recursive: true }),
      mkdir(agentDir, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(join(streamProject, "dogfood.txt"), "isolated stream fixture\n"),
      writeFile(join(cancelProject, "dogfood.txt"), "isolated cancellation fixture\n"),
      writeFile(join(lifecycleProject, "dogfood.txt"), "isolated lifecycle fixture\n"),
    ]);
    await writeFile(
      join(agentDir, "models.yml"),
      `providers:\n  dogfood:\n    baseUrl: http://127.0.0.1:${model.server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Dogfood Deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`,
    );
    const seed = new OfficialOmpProfileAuthority({ sessionsRoot, metadataPath: join(root, "seed-metadata.json") });
    await seed.initialize();
    let streamSession: DogfoodSession = await seed.create(streamProject, "Omperator stream dogfood");
    let cancelSession: DogfoodSession = await seed.create(cancelProject, "Omperator cancellation dogfood");
    let lifecycleSession: DogfoodSession = await seed.create(lifecycleProject, "Omperator lifecycle dogfood");
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
    const hostArguments = [
      hostPath,
      "serve",
      "--omp",
      runtimePath,
      "--omp-authority",
      authorityMode,
      ...(authorityMode === "official" ? ["--omp-sessions-root", sessionsRoot] : []),
      "--profile",
      profile,
      "--state-root",
      stateRoot,
    ];
    child = Bun.spawn(hostArguments, { env: environment, stdout: "pipe", stderr: "pipe" });
    hostStdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    hostStderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    await waitForSocket(socketPath, child);

    primary = await connectClient(socketPath, "dogfood-primary");
    observer = await connectClient(socketPath, "dogfood-observer");
    for (const seeded of [streamSession, cancelSession, lifecycleSession]) {
      if (!primary.sessions.sessions.some((item) => item.sessionId === seeded.sessionId)) {
        throw new Error("a seeded dogfood session was not discovered");
      }
    }
    if (authorityMode === "bridge") {
      streamSession = await forkOwnedSession(primary, streamSession.sessionId, journal);
      cancelSession = await forkOwnedSession(primary, cancelSession.sessionId, journal);
      lifecycleSession = await forkOwnedSession(primary, lifecycleSession.sessionId, journal);
    }

    if (options.scenario === "full" || options.scenario === "stream" || options.scenario === "reconnect") {
      await attach(primary, streamSession.sessionId, journal);
      await attach(observer, streamSession.sessionId, journal);
      const requestId = `prompt-${randomUUID()}`;
      sendCommand(primary, requestId, "session.prompt", streamSession.sessionId, { message: "Dogfood stream prompt" });
      requireSuccess(await responseFor(primary.client, requestId, journal), "session.prompt");
      const [primaryEntry, observerEntry] = await Promise.all([
        waitForAssistant(primary, streamSession.sessionId, "Gate 0 response 1", journal),
        waitForAssistant(observer, streamSession.sessionId, "Gate 0 response 1", journal),
      ]);
      if (primaryEntry.entry.id !== observerEntry.entry.id) throw new Error("clients observed different assistant entries");
      if (streamSession.path !== undefined) {
        const transcript = await readFile(streamSession.path, "utf8");
        if (!transcript.includes("Dogfood stream prompt") || !transcript.includes("Gate 0 response 1")) {
          throw new Error("streamed dogfood prompt was not durable");
        }
      }
      scenarioResults.stream = {
        durable: streamSession.path !== undefined,
        convergedEntryId: String(primaryEntry.entry.id),
      };
      if (options.scenario === "full") {
        requireSuccess(
          await confirmedCommand(
            primary,
            streamSession.sessionId,
            "session.close",
            {},
            journal,
            String(primaryEntry.revision),
          ),
          "session.close",
        );
      }
    }

    if (options.scenario === "full" || options.scenario === "cancel") {
      await attach(primary, cancelSession.sessionId, journal);
      const gate = model.gateNextRequest();
      try {
        await promptWhenIdle(primary, cancelSession.sessionId, "Dogfood cancellation prompt", journal);
        await gate.started;
        const cancelled = await confirmedCommand(
          primary,
          cancelSession.sessionId,
          "session.cancel",
          {},
          journal,
        );
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
      const snapshot = await attach(reconnect, streamSession.sessionId, journal);
      const entryIds = snapshot.entries.map((entry) => String(entry.id));
      if (new Set(entryIds).size !== entryIds.length) throw new Error("reconnect snapshot duplicated transcript entries");
      if (!snapshot.entries.some((entry) => entry.kind === "message" && entry.data.role === "assistant" && entry.data.text === "Gate 0 response 1")) {
        throw new Error("reconnect snapshot lost the durable assistant response");
      }
      scenarioResults.stream = { ...(scenarioResults.stream as Record<string, unknown>), durable: true };
      scenarioResults.reconnect = { uniqueEntries: entryIds.length, revision: String(snapshot.revision) };
    }

    if (options.scenario === "full" || options.scenario === "lifecycle") {
      const controller = reconnect ?? primary;
      if (!controller) throw new Error("lifecycle controller is unavailable");
      const listedLifecycle = controller.sessions.sessions.find(
        (item) => item.sessionId === lifecycleSession.sessionId,
      );
      await attach(controller, lifecycleSession.sessionId, journal);
      await attach(observer, lifecycleSession.sessionId, journal);
      let revision =
        listedLifecycle?.liveState?.sessionControl === undefined
          ? String(listedLifecycle?.revision)
          : String(
              (
                await waitForDelta(
                  controller,
                  lifecycleSession.sessionId,
                  (frame) => frame.upsert !== undefined && frame.upsert.liveState?.sessionControl === undefined,
                  journal,
                )
              ).revision,
            );
      revision = await renameSession(
        controller,
        lifecycleSession.sessionId,
        revision,
        "Omperator dogfood renamed",
        journal,
      );
      if (lifecycleSession.path !== undefined) {
        await waitForFileText(lifecycleSession.path, "Omperator dogfood renamed");
      }
      const closeJournalStart = journal.length;
      requireSuccess(
        await confirmedCommand(
          controller,
          lifecycleSession.sessionId,
          "session.close",
          {},
          journal,
          revision,
        ),
        "session.close",
      );
      revision = String(
        recordedDelta(
          journal,
          closeJournalStart,
          lifecycleSession.sessionId,
          (frame) => frame.upsert !== undefined,
        )?.revision ?? revision,
      );
      revision = await lifecycleCommand(
        controller,
        lifecycleSession.sessionId,
        "session.archive",
        revision,
        {},
        journal,
      );
      await waitForInventory(
        socketPath,
        lifecycleSession.sessionId,
        (session) => session?.archivedAt !== undefined,
      );
      const archivedPromptId = `archived-prompt-${randomUUID()}`;
      sendCommand(controller, archivedPromptId, "session.prompt", lifecycleSession.sessionId, { message: "must not run" });
      const archivedPrompt = await responseFor(controller.client, archivedPromptId, journal);
      if (archivedPrompt.ok) throw new Error("archived session accepted a prompt");
      revision = await lifecycleCommand(
        controller,
        lifecycleSession.sessionId,
        "session.restore",
        revision,
        {},
        journal,
      );
      await waitForInventory(
        socketPath,
        lifecycleSession.sessionId,
        (session) => session !== undefined && session.archivedAt === undefined,
      );
      await deleteSession(controller, lifecycleSession.sessionId, revision, journal);
      await waitForInventory(socketPath, lifecycleSession.sessionId, (session) => session === undefined);
      if (lifecycleSession.path !== undefined) await waitForMissingFile(lifecycleSession.path);
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
      runtime: runtimeEvidence,
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
    if ((await child.exited) !== 0) throw new Error(`dogfood host failed: ${(await hostStderr).trim().slice(-4_096)}`);
    child = undefined;
    await hostStdout;
  } catch (error) {
    failure = error;
    await writeFile(join(options.artifactRoot, "wire-events.ndjson"), `${journal.map((frame) => JSON.stringify(wireSummary(frame))).join("\n")}\n`);
    await writeFile(join(options.artifactRoot, "report.json"), `${JSON.stringify({ schemaVersion: 1, scenario: options.scenario, scenarios: scenarioResults, passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  } finally {
    primary?.client.destroy();
    observer?.client.destroy();
    reconnect?.client.destroy();
    if (child) {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
    if (failure) {
      if (hostStdout) await writeFile(join(options.artifactRoot, "host-stdout.log"), await hostStdout);
      if (hostStderr) await writeFile(join(options.artifactRoot, "host-stderr.log"), await hostStderr);
    }
    await model.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

await main();
