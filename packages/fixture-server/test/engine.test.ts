import { describe, expect, it } from "vite-plus/test";
import { decodeServerFrame, DESKTOP_CATALOG_COMMANDS } from "@t4-code/protocol";
import { FixtureEngine } from "../src/engine.ts";
import { fixtureCatalogItems } from "../src/fixture-catalog.ts";
import { loadScenario, type ScenarioSeed } from "../src/seeds.ts";

const hello = (savedCursors: unknown[] = []) => ({
  v: "omp-app/1",
  type: "hello",
  protocol: { min: "omp-app/1", max: "omp-app/1" },
  client: { name: "fixture-test", version: "1", build: "test", platform: "linux" },
  requestedFeatures: ["resume"],
  savedCursors,
});
const command = (
  seed: ScenarioSeed,
  commandName: string,
  commandId: string,
  requestId = commandId,
  providedArgs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => {
  const hostCommand = [
    "host.list",
    "session.list",
    "session.create",
    "project.reveal",
    "audit.read",
    "audit.tail",
    "config.write",
    "settings.read",
    "settings.write",
    "catalog.get",
    "host.watch",
  ].includes(commandName);
  const args =
    commandName === "session.prompt" && !("message" in providedArgs)
      ? { message: "fixture prompt", ...providedArgs }
      : providedArgs;
  return {
    v: "omp-app/1",
    type: "command",
    requestId,
    commandId,
    hostId: seed.hostId,
    ...(hostCommand ? {} : { sessionId: seed.sessionId }),
    command: commandName,
    args,
    ...extra,
  };
};

function ready(engine: FixtureEngine, id: string): void {
  engine.receive(id, hello());
  engine.receive(id, command(engine.seed, "session.attach", `attach-${id}`));
}

describe("deterministic fixture engine", () => {
  it("advertises exactly the desktop commands exported by the pinned OMP wire package", () => {
    const names = fixtureCatalogItems()
      .filter((item) => item.kind === "command")
      .map((item) => item.name)
      .sort();
    expect(names).toEqual([...DESKTOP_CATALOG_COMMANDS].sort());
    expect(names).toEqual([
      "broker.status",
      "project.reveal",
      "session.archive",
      "session.cancel",
      "session.close",
      "session.create",
      "session.delete",
      "session.fast.set",
      "session.model.set",
      "session.rename",
      "session.restore",
      "session.thinking.set",
      "usage.read",
    ]);
  });

  it("decodes every handshake, snapshot, list, and ping frame for all ten seeds", () => {
    for (const scenario of [
      "basic-v1",
      "stream-v1",
      "hierarchy-v1",
      "history-10k-v1",
      "faults-v1",
      "multi-client-v1",
      "remote-v1",
      "a11y-v1",
      "reconnect-v1",
      "preview-v1",
    ] as const) {
      const engine = new FixtureEngine(loadScenario(scenario));
      const client = engine.connect("a");
      const handshake = engine.receive(client.id, hello());
      expect(handshake).toHaveLength(6);
      for (const frame of handshake) expect(() => decodeServerFrame(frame)).not.toThrow();
      const ping = engine.receive(client.id, {
        v: "omp-app/1",
        type: "ping",
        nonce: "n-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(ping[0]?.type).toBe("pong");
      expect(() => decodeServerFrame(ping[0])).not.toThrow();
      const list = engine.receive(client.id, command(engine.seed, "session.list", "c-list"));
      expect(list[0]?.type).toBe("response");
      expect(() => decodeServerFrame(list[0])).not.toThrow();
    }
  });
  it("requires hello, enforces exact host, and rejects a second hello", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    expect(engine.receive(client.id, command(engine.seed, "host.list", "before"))[0]).toMatchObject(
      { type: "error", code: "HELLO_REQUIRED" },
    );
    engine.receive(client.id, hello());
    expect(engine.receive(client.id, hello())[0]).toMatchObject({
      type: "error",
      code: "INVALID_FRAME",
    });
    const wrongHost = {
      ...command(engine.seed, "session.list", "wrong-host"),
      hostId: "other-host",
    };
    expect(engine.receive(client.id, wrongHost)[0]).toMatchObject({
      type: "response",
      ok: false,
      error: { code: "not_found" },
    });
  });
  it("creates unique current sessions that converge and remain attachable and writable", () => {
    const engine = new FixtureEngine(loadScenario("stream-v1"));
    const manager = engine.connect("create-manager");
    const observer = engine.connect("create-observer");
    engine.receive(manager.id, hello());
    engine.receive(observer.id, hello());

    const first = engine.receive(
      manager.id,
      command(engine.seed, "session.create", "create-first-command", "create-first-request", {
        projectId: engine.seed.projectId,
        title: "First created session",
      }),
    );
    const firstResponse = first.find((frame) => frame.type === "response");
    if (firstResponse?.type !== "response" || !firstResponse.ok)
      throw new Error("fixture did not create the first session");
    const firstRef = (firstResponse.result as { session: { sessionId: string; revision: string } })
      .session;
    expect(firstRef).toMatchObject({
      project: { projectId: engine.seed.projectId },
      title: "First created session",
      status: "idle",
      liveState: { phase: "idle" },
    });
    expect(firstRef.sessionId).not.toBe(engine.seed.sessionId);
    expect(firstRef).not.toHaveProperty("archivedAt");
    expect(first).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        sessionId: firstRef.sessionId,
        upsert: expect.objectContaining({ sessionId: firstRef.sessionId }),
      }),
    );
    expect(engine.drain(observer.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        sessionId: firstRef.sessionId,
        upsert: expect.objectContaining({ sessionId: firstRef.sessionId }),
      }),
    );

    const replay = engine.receive(
      manager.id,
      command(engine.seed, "session.create", "create-first-command", "create-replay-request", {
        projectId: engine.seed.projectId,
        title: "First created session",
      }),
    );
    expect(replay).toEqual([firstResponse]);
    expect(engine.drain(observer.id)).toHaveLength(0);

    const second = engine.receive(
      manager.id,
      command(engine.seed, "session.create", "create-second-command", "create-second-request", {
        projectId: engine.seed.projectId,
      }),
    );
    const secondResponse = second.find((frame) => frame.type === "response");
    if (secondResponse?.type !== "response" || !secondResponse.ok)
      throw new Error("fixture did not create the second session");
    const secondRef = (secondResponse.result as { session: { sessionId: string } }).session;
    expect(secondRef.sessionId).not.toBe(firstRef.sessionId);
    expect(engine.drain(observer.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        upsert: expect.objectContaining({ sessionId: secondRef.sessionId }),
      }),
    );

    const listed = engine.receive(
      manager.id,
      command(engine.seed, "session.list", "list-created-command"),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({
        type: "sessions",
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: engine.seed.sessionId }),
          expect.objectContaining({ sessionId: firstRef.sessionId }),
          expect.objectContaining({ sessionId: secondRef.sessionId }),
        ]),
      }),
    );

    const attached = engine.receive(observer.id, {
      ...command(engine.seed, "session.attach", "attach-created-command"),
      sessionId: firstRef.sessionId,
    });
    expect(attached).toContainEqual(
      expect.objectContaining({
        type: "response",
        ok: true,
        result: { attached: true, cursor: { epoch: engine.seed.epoch, seq: 0 } },
      }),
    );
    expect(attached).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        sessionId: firstRef.sessionId,
        entries: [],
      }),
    );

    const prompted = engine.receive(observer.id, {
      ...command(
        engine.seed,
        "session.prompt",
        "prompt-created-command",
        "prompt-created-request",
        { message: "write in the created session" },
        { expectedRevision: firstRef.revision },
      ),
      sessionId: firstRef.sessionId,
    });
    expect(prompted).toContainEqual(
      expect.objectContaining({ type: "response", ok: true, result: { accepted: true } }),
    );
    engine.advanceBy(30);
    const createdJournal = engine
      .drain(observer.id)
      .filter((frame) => frame.type === "entry" || frame.type === "event");
    expect(createdJournal).toHaveLength(8);
    expect(createdJournal.every((frame) => frame.sessionId === firstRef.sessionId)).toBe(true);
    expect(
      createdJournal.map((frame) => (frame.type === "event" ? frame.event.type : frame.type)),
    ).toEqual([
      "agent.start",
      "turn.start",
      "message.update",
      "message.update",
      "message.settled",
      "entry",
      "turn.end",
      "agent.end",
    ]);
    for (const frame of [...first, ...second, ...listed, ...attached, ...createdJournal])
      expect(() => decodeServerFrame(frame)).not.toThrow();
  });
  it("broadcasts only to attached clients and keeps the stream contiguous", () => {
    const engine = new FixtureEngine(loadScenario("stream-v1"));
    const a = engine.connect("a");
    const b = engine.connect("b");
    engine.receive(a.id, hello());
    engine.receive(b.id, hello());
    engine.receive(a.id, command(engine.seed, "session.attach", "attach-a"));
    engine.receive(a.id, command(engine.seed, "session.prompt", "prompt-a"));
    engine.advanceBy(30);
    const aFrames = engine.drain(a.id);
    const bFrames = engine.drain(b.id);
    expect(aFrames.map((frame) => frame.type)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "event",
      "entry",
      "event",
      "event",
    ]);
    expect(bFrames).toHaveLength(0);
    expect(
      aFrames.map((frame) =>
        frame.type === "event" || frame.type === "entry" ? frame.cursor.seq : -1,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      aFrames.map((frame) => (frame.type === "event" ? frame.event.type : frame.type)),
    ).toEqual([
      "agent.start",
      "turn.start",
      "message.update",
      "message.update",
      "message.settled",
      "entry",
      "turn.end",
      "agent.end",
    ]);
    const first = aFrames[2];
    const second = aFrames[3];
    const settlement = aFrames[4];
    const settled = aFrames[5];
    expect(first).toMatchObject({
      type: "event",
      event: { type: "message.update", text: "Hello" },
    });
    expect(second).toMatchObject({
      type: "event",
      event: { type: "message.update", text: "Hello world" },
    });
    if (
      first?.type !== "event" ||
      second?.type !== "event" ||
      settlement?.type !== "event" ||
      settled?.type !== "entry"
    ) {
      throw new Error("stream fixture emitted an unexpected frame family");
    }
    expect(second.event.entryId).toBe(first.event.entryId);
    expect(settlement.event).toMatchObject({
      type: "message.settled",
      transientEntryId: first.event.entryId,
      entryId: settled.entry.id,
    });
    expect(settled.entry.id).not.toBe(first.event.entryId);
    expect(engine.currentRevision).not.toBe(engine.seed.revision);

    const reloaded = engine.connect("reloaded");
    const reloadFrames = engine.receive(reloaded.id, hello());
    const reloadSnapshot = reloadFrames.find((frame) => frame.type === "snapshot");
    if (reloadSnapshot?.type !== "snapshot") throw new Error("reload did not receive a snapshot");
    expect(reloadSnapshot.entries.filter((entry) => entry.id === settled.entry.id)).toEqual([
      settled.entry,
    ]);
  });
  it("replays exact retained frames and uses gap plus snapshot after epoch change", () => {
    const engine = new FixtureEngine(loadScenario("stream-v1"));
    const a = engine.connect("a");
    engine.receive(a.id, hello());
    engine.receive(a.id, command(engine.seed, "session.attach", "attach-a"));
    engine.receive(a.id, command(engine.seed, "session.prompt", "prompt-a"));
    engine.advanceBy(30);
    const original = engine.drain(a.id);
    const b = engine.connect("b");
    engine.receive(b.id, hello());
    const replay = engine.receive(
      b.id,
      command(engine.seed, "session.attach", "attach-b", "attach-b", {
        cursor: { epoch: engine.seed.epoch, seq: 0 },
      }),
    );
    const replayFrames = replay.filter((frame) => frame.type === "event" || frame.type === "entry");
    expect(replayFrames).toEqual(
      original.filter((frame) => frame.type === "event" || frame.type === "entry"),
    );
    engine.restart("epoch-stream-2");
    const c = engine.connect("c");
    engine.receive(c.id, hello());
    const recovered = engine.receive(
      c.id,
      command(engine.seed, "session.attach", "attach-c", "attach-c", {
        cursor: { epoch: engine.seed.epoch, seq: 3 },
      }),
    );
    expect(recovered.map((frame) => frame.type)).toContain("gap");
    expect(recovered.map((frame) => frame.type)).toContain("snapshot");
    for (const frame of recovered) expect(() => decodeServerFrame(frame)).not.toThrow();
  });
  it("makes command IDs idempotent and reports payload conflicts", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);
    const first = engine.receive(
      client.id,
      command(engine.seed, "session.prompt", "same", "first", { message: "one" }),
    );
    const second = engine.receive(
      client.id,
      command(engine.seed, "session.prompt", "same", "second", { message: "one" }),
    );
    expect(second[0]).toEqual(first[0]);
    expect(
      engine.receive(
        client.id,
        command(engine.seed, "session.prompt", "same", "third", { message: "two" }),
      )[0],
    ).toMatchObject({ type: "response", ok: false, error: { code: "idempotency_conflict" } });
  });
  it("challenges file writes before applying their side frame", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);
    const challenge = engine.receive(
      client.id,
      command(
        engine.seed,
        "files.write",
        "files-write-command",
        "files-write-request",
        { path: "README.md", content: "fixture edit" },
        { expectedRevision: engine.seed.revision },
      ),
    )[0];
    expect(challenge).toMatchObject({
      type: "confirmation",
      commandId: "files-write-command",
      summary: "files.write",
    });
  });
  it("mirrors OMP confirmation correlation for approve, deny, and invalid decisions", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);

    const cancel = command(engine.seed, "session.cancel", "cancel-command", "cancel-request");
    const challenge = engine.receive(client.id, cancel)[0];
    expect(challenge).toMatchObject({
      type: "confirmation",
      commandId: "cancel-command",
      summary: "session.cancel",
    });
    if (challenge?.type !== "confirmation") throw new Error("fixture did not challenge cancel");
    const approved = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "confirm-request",
      confirmationId: challenge.confirmationId,
      commandId: challenge.commandId,
      hostId: challenge.hostId,
      sessionId: challenge.sessionId,
      decision: "approve",
    })[0];
    expect(approved).toMatchObject({
      type: "response",
      requestId: "cancel-request",
      commandId: "cancel-command",
      command: "session.cancel",
      ok: true,
    });

    const deniedCommand = command(engine.seed, "session.cancel", "deny-command", "deny-request");
    const deniedChallenge = engine.receive(client.id, deniedCommand)[0];
    if (deniedChallenge?.type !== "confirmation") throw new Error("fixture did not challenge deny");
    const denied = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "deny-confirm-request",
      confirmationId: deniedChallenge.confirmationId,
      commandId: deniedChallenge.commandId,
      hostId: deniedChallenge.hostId,
      sessionId: deniedChallenge.sessionId,
      decision: "deny",
    })[0];
    expect(denied).toMatchObject({
      type: "response",
      requestId: "deny-request",
      ok: false,
      error: { code: "confirmation_denied" },
    });

    const invalid = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "replayed-confirm-request",
      confirmationId: deniedChallenge.confirmationId,
      commandId: deniedChallenge.commandId,
      hostId: deniedChallenge.hostId,
      sessionId: deniedChallenge.sessionId,
      decision: "approve",
    })[0];
    expect(invalid).toMatchObject({
      type: "response",
      requestId: "replayed-confirm-request",
      ok: false,
      error: { code: "confirmation_invalid" },
    });
  });
  it("applies confirmed settings edits, republishes state, and rejects stale revisions", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("settings");
    ready(engine, client.id);
    const expectedRevision = engine.currentRevision;
    const write = command(
      engine.seed,
      "settings.write",
      "settings-write",
      "settings-write-request",
      {
        edits: [{ path: "appearance.mode", scope: "global", value: "dark" }],
        expectedRevision,
      },
      { expectedRevision },
    );
    const challenge = engine.receive(client.id, write)[0];
    expect(challenge).toMatchObject({
      type: "confirmation",
      summary: "settings.write",
      revision: expectedRevision,
    });
    if (challenge?.type !== "confirmation")
      throw new Error("fixture did not challenge settings write");
    const applied = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "settings-confirm",
      confirmationId: challenge.confirmationId,
      commandId: challenge.commandId,
      hostId: challenge.hostId,
      decision: "approve",
    });
    expect(applied[0]).toMatchObject({
      type: "response",
      command: "settings.write",
      ok: true,
      result: { applied: true },
    });
    expect(applied[1]).toMatchObject({
      type: "settings",
      settings: {
        "appearance.mode": {
          effective: "dark",
          effectiveSource: "global",
          configured: true,
        },
        "provider.apiKey": { configured: true, sensitive: true },
      },
    });
    const published = applied[1];
    if (published?.type !== "settings") throw new Error("fixture did not republish settings");

    const stale = command(
      engine.seed,
      "settings.write",
      "settings-stale",
      "settings-stale-request",
      {
        edits: [{ path: "appearance.mode", scope: "global", reset: true }],
        expectedRevision,
      },
      { expectedRevision },
    );
    const staleChallenge = engine.receive(client.id, stale)[0];
    if (staleChallenge?.type !== "confirmation")
      throw new Error("fixture did not challenge stale settings write");
    expect(
      engine.receive(client.id, {
        v: "omp-app/1",
        type: "confirm",
        requestId: "settings-stale-confirm",
        confirmationId: staleChallenge.confirmationId,
        commandId: staleChallenge.commandId,
        hostId: staleChallenge.hostId,
        decision: "approve",
      })[0],
    ).toMatchObject({
      type: "response",
      ok: false,
      error: {
        code: "stale_revision",
        details: {
          expectedRevision,
          actualRevision: published.revision,
        },
      },
    });
  });
  it("converges rename, archive, restore, and challenged delete across clients", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const a = engine.connect("manager-a");
    const b = engine.connect("observer-b");
    engine.receive(a.id, hello());
    engine.receive(b.id, hello());
    expect(engine.currentCursor.seq).toBe(0);

    const renamed = engine.receive(
      a.id,
      command(
        engine.seed,
        "session.rename",
        "rename-command",
        "rename-request",
        { name: "Useful title" },
        { expectedRevision: engine.currentRevision },
      ),
    );
    expect(renamed).toContainEqual(
      expect.objectContaining({
        type: "response",
        ok: true,
        result: { renamed: true },
      }),
    );
    expect(renamed).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        cursor: { epoch: engine.seed.epoch, seq: 1 },
        upsert: expect.objectContaining({ title: "Useful title" }),
      }),
    );
    expect(engine.drain(b.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        upsert: expect.objectContaining({ title: "Useful title" }),
      }),
    );

    const archived = engine.receive(
      a.id,
      command(
        engine.seed,
        "session.archive",
        "archive-command",
        "archive-request",
        {},
        { expectedRevision: engine.currentRevision },
      ),
    );
    expect(archived).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.archive",
        ok: true,
        result: { archived: true },
      }),
    );
    const archiveDelta = archived.find((frame) => frame.type === "session.delta");
    expect(archiveDelta).toMatchObject({
      cursor: { epoch: engine.seed.epoch, seq: 2 },
      upsert: { archivedAt: engine.seed.baseTime },
    });
    expect(engine.currentCursor.seq).toBe(0);
    for (const frame of archived) expect(() => decodeServerFrame(frame)).not.toThrow();
    expect(engine.drain(b.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        upsert: expect.objectContaining({ archivedAt: engine.seed.baseTime }),
      }),
    );

    const restored = engine.receive(
      a.id,
      command(
        engine.seed,
        "session.restore",
        "restore-command",
        "restore-request",
        {},
        { expectedRevision: engine.currentRevision },
      ),
    );
    expect(restored).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.restore",
        ok: true,
        result: { restored: true },
      }),
    );
    expect(restored).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        cursor: { epoch: engine.seed.epoch, seq: 3 },
        upsert: expect.not.objectContaining({ archivedAt: expect.anything() }),
      }),
    );
    engine.drain(b.id);

    const expectedRevision = engine.currentRevision;
    const challenge = engine.receive(
      a.id,
      command(
        engine.seed,
        "session.delete",
        "delete-command",
        "delete-request",
        {},
        { expectedRevision },
      ),
    )[0];
    expect(challenge).toMatchObject({
      type: "confirmation",
      commandId: "delete-command",
      revision: expectedRevision,
      summary: "session.delete",
    });
    if (challenge?.type !== "confirmation") throw new Error("fixture did not challenge delete");
    expect(engine.drain(b.id)).toHaveLength(0);

    const deleted = engine.receive(a.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "delete-confirm-request",
      confirmationId: challenge.confirmationId,
      commandId: challenge.commandId,
      hostId: challenge.hostId,
      sessionId: challenge.sessionId,
      decision: "approve",
    });
    expect(deleted).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.delete",
        ok: true,
        result: { deleted: true },
      }),
    );
    expect(deleted).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        cursor: { epoch: engine.seed.epoch, seq: 4 },
        remove: engine.seed.sessionId,
      }),
    );
    expect(engine.drain(b.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        remove: engine.seed.sessionId,
      }),
    );
    const listed = engine.receive(a.id, command(engine.seed, "session.list", "list-after-delete"));
    expect(listed).toContainEqual(expect.objectContaining({ type: "sessions", sessions: [] }));
  });
  it("publishes the host-confirmed model after a session model switch", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const manager = engine.connect("model-manager");
    const observer = engine.connect("model-observer");
    engine.receive(manager.id, hello());
    engine.receive(observer.id, hello());

    const switched = engine.receive(
      manager.id,
      command(
        engine.seed,
        "session.model.set",
        "model-command",
        "model-request",
        { role: "cycle-12", persistence: "session" },
        { expectedRevision: engine.currentRevision },
      ),
    );

    expect(switched).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.model.set",
        ok: true,
        result: { accepted: true },
      }),
    );
    expect(switched).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        upsert: expect.objectContaining({ model: "fixture/model-012" }),
      }),
    );
    expect(engine.drain(observer.id)).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        upsert: expect.objectContaining({ model: "fixture/model-012" }),
      }),
    );
  });
  it("does not mutate session state when lifecycle commands fail revision checks", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const manager = engine.connect("manager");
    const observer = engine.connect("observer");
    engine.receive(manager.id, hello());
    engine.receive(observer.id, hello());

    const rejectedArchive = engine.receive(
      manager.id,
      command(
        engine.seed,
        "session.archive",
        "stale-archive-command",
        "stale-archive-request",
        {},
        { expectedRevision: "revision-stale" },
      ),
    );
    expect(rejectedArchive).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.archive",
        ok: false,
        error: { code: "stale_revision", message: expect.any(String), details: expect.any(Object) },
      }),
    );
    expect(rejectedArchive).not.toContainEqual(expect.objectContaining({ type: "session.delta" }));
    expect(engine.drain(observer.id)).toHaveLength(0);

    const revisionBeforeDelete = engine.currentRevision;
    const challenge = engine.receive(
      manager.id,
      command(
        engine.seed,
        "session.delete",
        "stale-delete-command",
        "stale-delete-request",
        {},
        { expectedRevision: revisionBeforeDelete },
      ),
    )[0];
    if (challenge?.type !== "confirmation") throw new Error("fixture did not challenge delete");

    engine.receive(
      manager.id,
      command(
        engine.seed,
        "session.rename",
        "intervening-rename-command",
        "intervening-rename-request",
        { name: "Changed after challenge" },
        { expectedRevision: revisionBeforeDelete },
      ),
    );
    engine.drain(observer.id);

    const rejectedDelete = engine.receive(manager.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "stale-delete-confirm-request",
      confirmationId: challenge.confirmationId,
      commandId: challenge.commandId,
      hostId: challenge.hostId,
      sessionId: challenge.sessionId,
      decision: "approve",
    });
    expect(rejectedDelete).toContainEqual(
      expect.objectContaining({
        type: "response",
        command: "session.delete",
        ok: false,
        error: { code: "stale_revision", message: expect.any(String), details: expect.any(Object) },
      }),
    );
    expect(rejectedDelete).not.toContainEqual(expect.objectContaining({ type: "session.delta" }));
    expect(engine.drain(observer.id)).toHaveLength(0);

    const listed = engine.receive(
      manager.id,
      command(engine.seed, "session.list", "list-after-rejections"),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({
        type: "sessions",
        sessions: [expect.objectContaining({ title: "Changed after challenge" })],
      }),
    );
  });
  it("closes a client at the bounded queue and deletes disconnected clients", () => {
    const base = loadScenario("basic-v1");
    const seed: ScenarioSeed = {
      ...base,
      scripts: {
        ...base.scripts,
        prompt: Array.from({ length: 200 }, (_, i) => ({
          atMs: 0,
          kind: "event" as const,
          text: `e-${i}`,
        })),
      },
    };
    const engine = new FixtureEngine(seed);
    const client = engine.connect("a");
    ready(engine, client.id);
    engine.receive(client.id, command(seed, "session.prompt", "flood"));
    engine.advanceBy(0);
    expect(engine.inspect(client.id).closed).toBe(true);
    engine.disconnect(client.id);
    expect(engine.clientCount).toBe(0);
  });
  it("emits decodable additive watch, lease, agent, file, audit, catalog, settings, preview, and terminal frames", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);
    const commands: Array<[string, Record<string, unknown>]> = [
      ["host.watch", {}],
      ["session.watch", {}],
      ["controller.lease.acquire", { ownerId: "fixture-device" }],
      ["prompt.lease.acquire", { ownerId: "fixture-device" }],
      ["agent.cancel", { agentId: "agent-fixture" }],
      ["files.list", {}],
      ["files.diff", { path: "src/file.ts" }],
      ["audit.tail", {}],
      ["catalog.get", {}],
      ["settings.read", {}],
      ["preview.launch", { url: "http://127.0.0.1/fixture" }],
      ["preview.state", {}],
      ["preview.policy.check", { action: "capture", previewId: "preview-fixture" }],
      ["preview.lease.acquire", { previewId: "preview-fixture", ttlMs: 30_000 }],
      [
        "preview.lease.renew",
        { previewId: "preview-fixture", leaseId: "lease-fixture", ttlMs: 30_000 },
      ],
      ["preview.lease.release", { previewId: "preview-fixture", leaseId: "lease-fixture" }],
      ["preview.navigate", { previewId: "preview-fixture", url: "http://127.0.0.1/fixture" }],
      ["preview.back", { previewId: "preview-fixture" }],
      ["preview.forward", { previewId: "preview-fixture" }],
      ["preview.reload", { previewId: "preview-fixture" }],
      ["preview.capture", { previewId: "preview-fixture" }],
      [
        "preview.capture.read",
        { previewId: "preview-fixture", captureId: "capture-fixture", offset: 0 },
      ],
      ["preview.click", { previewId: "preview-fixture", x: 1, y: 1 }],
      ["preview.activate", { previewId: "preview-fixture" }],
      ["preview.fill", { previewId: "preview-fixture", selector: "#input", text: "hello" }],
      ["preview.select", { previewId: "preview-fixture", selector: "#select", value: "one" }],
      ["preview.upload", { previewId: "preview-fixture", selector: "#file", path: "file.txt" }],
      ["preview.handoff", { previewId: "preview-fixture", message: "Continue manually" }],
      ["preview.scroll", { previewId: "preview-fixture", deltaX: 0, deltaY: 1 }],
      ["preview.type", { previewId: "preview-fixture", text: "hello" }],
      ["preview.press", { previewId: "preview-fixture", key: "Enter" }],
      ["preview.close", { previewId: "preview-fixture" }],
    ];
    for (const [name, args] of commands) {
      const frames = engine.receive(client.id, command(engine.seed, name, name, name, args));
      for (const frame of frames) expect(() => decodeServerFrame(frame)).not.toThrow();
    }
    const terminalOutput = engine.receive(client.id, {
      v: "omp-app/1",
      type: "terminal.input",
      hostId: engine.seed.hostId,
      sessionId: engine.seed.sessionId,
      terminalId: "terminal-fixture",
      data: "hi",
    });
    const terminalExit = engine.receive(client.id, {
      v: "omp-app/1",
      type: "terminal.close",
      hostId: engine.seed.hostId,
      sessionId: engine.seed.sessionId,
      terminalId: "terminal-fixture",
    });
    for (const frame of [...terminalOutput, ...terminalExit])
      expect(() => decodeServerFrame(frame)).not.toThrow();
  });
  it("is deterministic across two identical runs", () => {
    const run = () => {
      const engine = new FixtureEngine(loadScenario("stream-v1"));
      const client = engine.connect("a");
      ready(engine, client.id);
      engine.receive(client.id, command(engine.seed, "session.prompt", "prompt"));
      engine.advanceBy(30);
      engine.drain(client.id);
      return {
        hash: engine.stateHash,
        frames: engine.journalSize,
        revision: engine.currentRevision,
      };
    };
    expect(run()).toEqual(run());
  });
});
