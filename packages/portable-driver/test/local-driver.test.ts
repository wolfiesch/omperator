import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SharedControlStore, SqliteControlStore, SqliteSharedControlLedgerStorage, type InfrastructureEvent, type PortableControlStore } from "@t4-code/portable-control-store";
import type { Capabilities, Scope, Timestamp } from "@t4-code/portable-core";
import { LocalDriver, type CompleteReadiness, type LocalDriverOptions } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/runtime-child.mjs", import.meta.url));
const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
const capabilities: Capabilities = {
  apiVersion: "v1",
  protocols: { machineProvider: { versions: [1], capabilities: [] }, cmux: { versions: [10] }, ompApp: { versions: [1] } },
  limits: { maxActiveRuntimes: 8, maxRetainedRuntimes: 32, idempotencyRetentionSeconds: 86_400, eventRetentionSeconds: 86_400, maxPageSize: 200 },
  features: { restLifecycle: true, sshProvider: false, directCmuxWebSocket: false, browser: true, scaleToZero: true },
  storage: {
    workspaceReadWriteMany: { state: "Unsupported", reason: "LocalFilesystem" },
    runtimeStateAccessModes: ["ReadWriteOncePod"],
    runtimeStateReattach: { state: "Supported", reason: "ProcessFenceAndRemount" },
    onlineExpansion: { state: "Unsupported", reason: "LocalFilesystem" },
    volumeSnapshots: { state: "Unsupported", reason: "NoSnapshotBackend" },
    snapshotDataSource: { state: "Unsupported", reason: "NoSnapshotBackend" },
    observedAt: "2026-07-30T00:00:00.000Z" as Timestamp,
  },
};
const admissionPolicy: LocalDriverOptions["admissionPolicy"] = {
  maxActiveRuntimes: 8,
  maxRetainedRuntimes: 32,
  maxWorkspaceCapacityBytes: 1_099_511_627_776,
  maxCpuMillis: 8_000,
  maxMemoryBytes: 17_179_869_184,
  maxGpuUnits: 0,
  browserEnabled: true,
  runtimeResources: { cpuMillis: 1_000, memoryBytes: 2_147_483_648, gpuUnits: 0 },
  creationRate: { windowSeconds: 60, burst: 1_000, maximumRetryAfterSeconds: 30 },
};
const roots: string[] = [];
const drivers: LocalDriver[] = [];
const stores: SqliteControlStore[] = [];
const admissionStorages: SqliteSharedControlLedgerStorage[] = [];
afterEach(async () => {
  const currentDrivers = drivers.splice(0);
  for (const driver of currentDrivers) {
    for (const listed of driver.listRuntimes("scope-a").items) {
      const deadline = Date.now() + 8_000;
      while (Date.now() <= deadline) {
        const current = driver.getRuntime(listed.id);
        if (current.outcome !== "found" || current.resource.desiredState !== "Running" || current.resource.phase === "Degraded" || current.resource.phase === "Deleting") break;
        try {
          const stopped = await driver.setRuntimeDesiredState(listed.id, "Stopped", current.resource.revision);
          if (stopped.outcome === "updated") break;
        } catch { /* fixture cleanup remains best effort */ }
        await yieldTurn();
      }
    }
  }
  await Promise.allSettled(currentDrivers.map((driver) => driver.close()));
  for (const store of stores.splice(0)) store.close();
  for (const storage of admissionStorages.splice(0)) storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function yieldTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function setup(overrides: Partial<LocalDriverOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "portable-driver-")); roots.push(root);
  const store = new SqliteControlStore({ databasePath: join(root, "control.sqlite") });
  stores.push(store);
  const admissionStorage = new SqliteSharedControlLedgerStorage(join(root, "admission.sqlite"));
  admissionStorages.push(admissionStorage);
  const admissionLedger = new SharedControlStore({ storage: admissionStorage });
  const launch: LocalDriverOptions["launch"] = (_runtime, context) => ({
    executable: process.execPath,
    arguments: [fixture],
    routeKinds: ["cmux-v10", "omp-app-v1"],
    readinessProbe: async () => {
      try {
        const marker = JSON.parse(readFileSync(join(context.runtimeStatePath, "ready.json"), "utf8")) as { generation: string };
        if (marker.generation !== context.generation) return undefined;
        return { runtimeGeneration: marker.generation, storageReady: true, exclusiveWriterLeaseHeld: true, internalGenerationAuthenticationReady: true, hostReady: true, ompAuthorityReady: true, cmuxProtocol10Ready: true, requiredBrowserReady: true } as CompleteReadiness;
      } catch { return undefined; }
    },
    terminateAndProveFence: async (_context, containment) => {
      try { process.kill(-containment.processGroupId, "SIGTERM"); } catch { /* observed below */ }
      let deadline = Date.now() + containment.graceMilliseconds;
      while (Date.now() <= deadline && !processGroupDead(containment.processGroupId)) await yieldTurn();
      try { process.kill(-containment.processGroupId, "SIGKILL"); } catch { /* observed below */ }
      deadline = Date.now() + containment.killMilliseconds;
      while (Date.now() <= deadline && !processGroupDead(containment.processGroupId)) await yieldTurn();
      try {
        const marker = JSON.parse(readFileSync(join(context.runtimeStatePath, "ready.json"), "utf8")) as { descendantPid?: number };
        return processGroupDead(containment.processGroupId) && (marker.descendantPid === undefined || pidDead(marker.descendantPid));
      } catch {
        return processGroupDead(containment.processGroupId);
      }
    },
  });
  const options: LocalDriverOptions = {
    root: join(root, "owned"), store,
    // Scope bootstrap is explicit and carries no creator/principal authority.
    bootstrapScopes: [{ id: "scope-a", displayName: "Scope A", kind: "Personal" }],
    launch, capabilities, admissionLedger, admissionPolicy, lsofExecutable: lsof, readinessTimeoutMilliseconds: 3_000, shutdownGraceMilliseconds: 1_000, shutdownKillMilliseconds: 1_000,
    ...overrides,
  };
  const driver = new LocalDriver(options);
  drivers.push(driver);
  return { root, store, options, driver };
}

async function workspace(driver: LocalDriver) {
  const result = await driver.createWorkspace({ id: "workspace-client-visible-id", scopeId: "scope-a", displayName: "Workspace", capacityBytes: 1_048_576, retention: "Delete" });
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.resource;
}
async function runtime(driver: LocalDriver, workspaceId: string, desiredState: "Running" | "Sleeping" | "Stopped" = "Running") {
  const result = await driver.createRuntime({ id: "runtime-client-visible-id", scopeId: "scope-a", displayName: "Runtime", workspaceId, hostProfileId: "host-default", desiredState, browserPolicy: "Disabled" });
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.resource;
}

function pidDead(pid: number) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
  return result.status === 1 || result.stdout.trim() === "" || result.stdout.trim().startsWith("Z");
}

function processGroupDead(processGroupId: number) {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1000 });
  if (result.error || result.status !== 0) return false;
  return !result.stdout.split("\n").some((row) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(row);
    return match && Number(match[1]) === processGroupId && !match[2]!.startsWith("Z");
  });
}

describe("LocalDriver real SQLite and process lifecycle", () => {
  test("surfaces bounded storage capability observations", () => {
    const { driver } = setup();
    expect(driver.getStorageCapabilities()).toEqual(capabilities.storage);
    expect(driver.getCapabilities().storage?.runtimeStateAccessModes).toEqual(["ReadWriteOncePod"]);
  });

  test("denies local capacity before creating workspace state", async () => {
    const { driver, options } = setup({ admissionPolicy: { ...admissionPolicy, maxWorkspaceCapacityBytes: 0 } });
    expect(await driver.createWorkspace({ id: "denied-workspace", scopeId: "scope-a", displayName: "Denied", capacityBytes: 1, retention: "Delete" }))
      .toEqual({ outcome: "admissionDenied", reason: "workspace_capacity_limit" });
    expect(driver.getWorkspace("denied-workspace")).toEqual({ outcome: "notFound" });
    expect(readdirSync(join(options.root, "workspaces"))).toHaveLength(0);
  });
  test("denies enabling browser access under a disabled scope policy", async () => {
    const { driver } = setup({ admissionPolicy: { ...admissionPolicy, browserEnabled: false } });
    const ws = await workspace(driver);
    const stopped = await runtime(driver, ws.id, "Stopped");
    expect(await driver.updateRuntime(stopped.id, { browserPolicy: "Allowed" }, stopped.revision))
      .toEqual({ outcome: "admissionDenied", reason: "browser_disabled" });
  });

  test("retires browser admission when browser access is disabled", async () => {
    const { driver } = setup({ admissionPolicy: { ...admissionPolicy, browserEnabled: true } });
    const ws = await workspace(driver);
    const stopped = await runtime(driver, ws.id, "Stopped");
    const enabled = await driver.updateRuntime(stopped.id, { browserPolicy: "Allowed" }, stopped.revision);
    expect(enabled.outcome).toBe("updated");
    if (enabled.outcome !== "updated") return;
    const disabled = await driver.updateRuntime(enabled.resource.id, { browserPolicy: "Disabled" }, enabled.resource.revision);
    expect(disabled.outcome).toBe("updated");
    if (disabled.outcome !== "updated") return;
    expect((await driver.updateRuntime(disabled.resource.id, { browserPolicy: "Allowed" }, disabled.resource.revision)).outcome).toBe("updated");
  });


  test("creates, gets, lists, updates, sleeps, wakes, stops and watches without stale routes", async () => {
    const { driver } = setup({ admissionPolicy: { ...admissionPolicy, browserEnabled: true } });
    expect(driver.listScopes().items.map((item: Scope) => item.id)).toEqual(["scope-a"]);
    const ws = await workspace(driver);
    const renamed = driver.updateWorkspace(ws.id, { displayName: "Renamed" }, ws.revision);
    expect(renamed.outcome).toBe("updated");
    if (renamed.outcome !== "updated") return;
    expect(driver.updateWorkspace(ws.id, { displayName: "Lost race" }, ws.revision)).toMatchObject({ outcome: "revisionMismatch", currentRevision: renamed.resource.revision });

    const running = await runtime(driver, ws.id);
    expect(running.phase).toBe("Ready");
    const oldGeneration = running.generation;
    const oldRoute = driver.resolveRuntimeRoute(running.id, "omp-app-v1", oldGeneration);
    expect(oldRoute.outcome).toBe("resolved");
    const runtimeUpdated = await driver.updateRuntime(running.id, { displayName: "Runtime Renamed", browserPolicy: "Allowed" }, running.revision);
    expect(runtimeUpdated.outcome).toBe("updated");
    if (runtimeUpdated.outcome !== "updated") return;
    expect(await driver.updateRuntime(running.id, { displayName: "Lost runtime race" }, running.revision)).toMatchObject({ outcome: "revisionMismatch", currentRevision: runtimeUpdated.resource.revision });
    expect(runtimeUpdated.resource.generation).not.toBe(oldGeneration);
    expect(driver.resolveRuntimeRoute(running.id, "omp-app-v1", oldGeneration).outcome).toBe("staleGeneration");
    const cursor = driver.listRuntimes("scope-a").highWaterCursor;
    const slept = await driver.setRuntimeDesiredState(running.id, "Sleeping", runtimeUpdated.resource.revision);
    expect(slept.outcome).toBe("updated");
    if (slept.outcome !== "updated") return;
    expect(slept.resource.phase).toBe("Sleeping");
    expect(driver.resolveRuntimeRoute(running.id, "omp-app-v1", oldGeneration).outcome).toBe("staleGeneration");
    const wake = await driver.setRuntimeDesiredState(running.id, "Running", slept.resource.revision);
    expect(wake.outcome).toBe("updated");
    if (wake.outcome !== "updated") return;
    expect(wake.resource.generation).not.toBe(oldGeneration);
    expect(driver.resolveRuntimeRoute(running.id, "omp-app-v1", oldGeneration).outcome).toBe("staleGeneration");
    const stopped = await driver.setRuntimeDesiredState(running.id, "Stopped", wake.resource.revision);
    expect(stopped).toMatchObject({ outcome: "updated", resource: { phase: "Stopped", desiredState: "Stopped" } });
    const events = driver.listInfrastructureEvents("scope-a", cursor);
    expect(events.outcome).toBe("events");
    if (events.outcome !== "events") return;
    expect(events.events.map((event: InfrastructureEvent) => event.phase)).toContain("Sleeping");
    const abort = new AbortController();
    const iterator = driver.watchInfrastructureEvents("scope-a", events.cursor, abort.signal)[Symbol.asyncIterator]();
    abort.abort();
    await iterator.return?.();
  });

  test("watch resumes from a list high-water cursor without a list-to-watch event gap", async () => {
    const { driver } = setup();
    const ws = await workspace(driver);
    const highWaterCursor = driver.listWorkspaces("scope-a").highWaterCursor;
    const abort = new AbortController();
    const iterator = driver.watchInfrastructureEvents("scope-a", highWaterCursor, abort.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    const updated = driver.updateWorkspace(ws.id, { displayName: "After Snapshot" }, ws.revision);
    expect(updated.outcome).toBe("updated");
    if (updated.outcome !== "updated") return;
    const observed = await next;
    expect(observed.value).toMatchObject({ outcome: "events", events: [expect.objectContaining({ resourceKind: "workspace", resourceId: ws.id, revision: updated.resource.revision })] });
    abort.abort();
    await iterator.return?.();
  });

  test("generation CAS admits exactly one wake and old revision has no process side effect", async () => {
    const { driver } = setup();
    const ws = await workspace(driver);
    const sleeping = await runtime(driver, ws.id, "Sleeping");
    const [first, second] = await Promise.all([
      driver.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision),
      driver.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["revisionMismatch", "updated"]);
    const current = driver.getRuntime(sleeping.id);
    expect(current).toMatchObject({ outcome: "found", resource: { phase: "Ready" } });
    if (current.outcome !== "found") return;
    await driver.setRuntimeDesiredState(current.resource.id, "Stopped", current.resource.revision);
  });
  test("independent controllers reserve one durable start attempt before launch", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const sleeping = await runtime(base.driver, ws.id, "Sleeping");
    let launches = 0;
    const countedLaunch: LocalDriverOptions["launch"] = (resource, context) => {
      launches += 1;
      return base.options.launch(resource, context);
    };
    const firstController = new LocalDriver({ ...base.options, launch: countedLaunch });
    const secondController = new LocalDriver({ ...base.options, launch: countedLaunch });
    drivers.push(firstController, secondController);
    const [first, second] = await Promise.all([
      firstController.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision),
      secondController.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["admissionDenied", "updated"]);
    expect(launches).toBe(1);
    expect(base.store.getRuntimeStartAttempt(sleeping.id)).toBeUndefined();
    const current = base.driver.getRuntime(sleeping.id);
    if (current.outcome === "found") await firstController.setRuntimeDesiredState(current.resource.id, "Stopped", current.resource.revision);
  });
  test("two replicas reserve one incremental wake slot before either process launch", async () => {
    const base = setup({ admissionPolicy: { ...admissionPolicy, maxActiveRuntimes: 1 } });
    const ws = await workspace(base.driver);
    const createStopped = async (id: string) => {
      const result = await base.driver.createRuntime({ id, scopeId: "scope-a", displayName: id, workspaceId: ws.id, hostProfileId: "host-default", desiredState: "Stopped", browserPolicy: "Disabled" });
      if (result.outcome !== "created") throw new Error(`runtime create failed: ${result.outcome}`);
      return result.resource;
    };
    const firstRuntime = await createStopped("wake-limit-one");
    const secondRuntime = await createStopped("wake-limit-two");
    const firstController = new LocalDriver(base.options);
    const secondController = new LocalDriver(base.options);
    drivers.push(firstController, secondController);
    const outcomes = await Promise.all([
      firstController.setRuntimeDesiredState(firstRuntime.id, "Running", firstRuntime.revision),
      secondController.setRuntimeDesiredState(secondRuntime.id, "Running", secondRuntime.revision),
    ]);
    expect(outcomes.filter(result => result.outcome === "updated")).toHaveLength(1);
    expect(outcomes.filter(result => result.outcome === "admissionDenied")).toEqual([
      expect.objectContaining({ reason: "active_runtime_limit" }),
    ]);
    for (const runtimeId of [firstRuntime.id, secondRuntime.id]) {
      const current = base.driver.getRuntime(runtimeId);
      if (current.outcome === "found" && current.resource.desiredState === "Running")
        await firstController.setRuntimeDesiredState(runtimeId, "Stopped", current.resource.revision);
    }
  });
  test("two controllers cannot both drain the same Unavailable revision", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const sleeping = await runtime(base.driver, ws.id, "Sleeping");
    const unavailable = base.store.compareAndSwapResourceWithEvent({
      kind: "runtime",
      id: sleeping.id,
      expectedRevision: sleeping.revision,
      value: { ...sleeping, desiredState: "Running", phase: "Unavailable", updatedAt: sleeping.updatedAt },
      event: { eventId: "evt_unavailable_race", phase: "Unavailable", timestamp: sleeping.updatedAt },
    });
    if (unavailable.outcome !== "updated") throw new Error(unavailable.outcome);
    let launches = 0;
    const launch: LocalDriverOptions["launch"] = (resource, context) => { launches += 1; return base.options.launch(resource, context); };
    const first = new LocalDriver({ ...base.options, launch });
    const second = new LocalDriver({ ...base.options, launch });
    drivers.push(first, second);
    const outcomes = await Promise.all([
      first.setRuntimeDesiredState(sleeping.id, "Running", unavailable.resource.revision),
      second.setRuntimeDesiredState(sleeping.id, "Running", unavailable.resource.revision),
    ]);
    expect(outcomes.map((item) => item.outcome).sort()).toEqual(["revisionMismatch", "updated"]);
    expect(launches).toBe(1);
    const ready = base.driver.getRuntime(sleeping.id);
    if (ready.outcome === "found") await first.setRuntimeDesiredState(sleeping.id, "Stopped", ready.resource.revision);
  });

  test("a foreign live start authority cannot adopt or release its controller's generation", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const sleeping = await runtime(base.driver, ws.id, "Sleeping");
    const readinessGate = Promise.withResolvers<void>();
    const gatedLaunch: LocalDriverOptions["launch"] = (resource, context) => {
      const spec = base.options.launch(resource, context);
      return { ...spec, readinessProbe: async (probeContext) => { await readinessGate.promise; return spec.readinessProbe(probeContext); } };
    };
    const owner = new LocalDriver({ ...base.options, launch: gatedLaunch });
    const contender = new LocalDriver({ ...base.options, launch: gatedLaunch });
    drivers.push(owner, contender);
    const ownerWake = owner.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision);
    let starting = base.driver.getRuntime(sleeping.id);
    const deadline = Date.now() + 5_000;
    while (starting.outcome === "found" && starting.resource.phase !== "Starting" && Date.now() <= deadline) {
      await yieldTurn();
      starting = base.driver.getRuntime(sleeping.id);
    }
    if (starting.outcome !== "found" || starting.resource.phase !== "Starting") {
      readinessGate.resolve();
      await ownerWake;
      throw new Error("runtime never entered Starting");
    }
    expect(starting).toMatchObject({ outcome: "found", resource: { phase: "Starting" } });
    expect(await contender.setRuntimeDesiredState(sleeping.id, "Running", starting.resource.revision)).toMatchObject({ outcome: "invalidState", reason: "StartAttemptInProgress" });
    expect(base.store.getRuntimeStartAttempt(sleeping.id)).toBeDefined();
    readinessGate.resolve();
    const ready = await ownerWake;
    expect(ready).toMatchObject({ outcome: "updated", resource: { phase: "Ready" } });
    expect(base.store.getRuntimeStartAttempt(sleeping.id)).toBeUndefined();
    if (ready.outcome === "updated") await owner.setRuntimeDesiredState(sleeping.id, "Stopped", ready.resource.revision);
  });
  test("a stale drainer never revokes a later controller's start attempt", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const backendPath = join(base.options.root, "runtime-state", readdirSync(join(base.options.root, "runtime-state"))[0]!, "supervisor-state.json");
    const backend = JSON.parse(readFileSync(backendPath, "utf8")) as { pid: number };
    const revokedGenerations: string[] = [];
    const racingStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        if (property === "getRuntimeStartAttempt") return () => ({ runtimeId: running.id, revision: "rev_later_attempt", generation: "gen_later_attempt", token: "attempt_later" });
        if (property === "revokeTickets") return (request: Parameters<PortableControlStore["revokeTickets"]>[0]) => {
          if ("runtimeGeneration" in request) revokedGenerations.push(request.runtimeGeneration);
          return target.revokeTickets(request);
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const stale = new LocalDriver({ ...base.options, store: racingStore });
    drivers.push(stale);
    const failed = await stale.setRuntimeDesiredState(running.id, "Sleeping", running.revision);
    expect(failed).toMatchObject({ outcome: "fenceUncertain", resource: { phase: "Degraded" } });
    expect(revokedGenerations).toEqual([]);
    expect(processGroupDead(backend.pid)).toBe(false);
    try { process.kill(-backend.pid, "SIGKILL"); } catch { /* already dead */ }
    const deadline = Date.now() + 5_000;
    while (!processGroupDead(backend.pid) && Date.now() <= deadline) await yieldTurn();
    if (failed.outcome === "fenceUncertain") {
      const recovered = await base.driver.recoverRuntimeFence(running.id, failed.resource.revision);
      expect(recovered).toMatchObject({ outcome: "updated", resource: { phase: "Sleeping" } });
    }
  });




  test("concurrent same-ID losers never remove winner directories and attached workspaces cannot be deleted", async () => {
    const { driver, options } = setup();
    const firstWorkspace = await workspace(driver);
    expect(await driver.createWorkspace({ id: firstWorkspace.id, scopeId: "scope-a", displayName: "Loser", capacityBytes: 1_048_576, retention: "Delete" })).toEqual({ outcome: "alreadyIssued" });
    expect(readdirSync(join(options.root, "workspaces"))).toHaveLength(1);
    const [firstRuntime, secondRuntime] = await Promise.all([
      driver.createRuntime({ id: "runtime-race", scopeId: "scope-a", displayName: "Winner", workspaceId: firstWorkspace.id, hostProfileId: "host-default", desiredState: "Stopped", browserPolicy: "Disabled" }),
      driver.createRuntime({ id: "runtime-race", scopeId: "scope-a", displayName: "Loser", workspaceId: firstWorkspace.id, hostProfileId: "host-default", desiredState: "Stopped", browserPolicy: "Disabled" }),
    ]);
    expect([firstRuntime.outcome, secondRuntime.outcome].sort()).toEqual(["alreadyIssued", "created"]);
    expect(readdirSync(join(options.root, "runtime-state"))).toHaveLength(1);
    const currentWorkspace = driver.getWorkspace(firstWorkspace.id);
    if (currentWorkspace.outcome !== "found") throw new Error("workspace missing");
    expect(currentWorkspace.resource.attachmentCount).toBe(1);
    expect(await driver.deleteWorkspace(firstWorkspace.id, currentWorkspace.resource.revision)).toMatchObject({ outcome: "invalidState", reason: "WorkspaceAttached" });
    const currentRuntime = driver.getRuntime("runtime-race");
    if (currentRuntime.outcome !== "found") throw new Error("runtime missing");
    expect(await driver.deleteRuntime("runtime-race", currentRuntime.resource.revision)).toMatchObject({ outcome: "deleted" });
  });

  test("private hashed bounded paths survive driver restart without metadata rewrite and descendant cleanup is positive", async () => {
    const { driver, options } = setup();
    const ws = await workspace(driver);
    const running = await runtime(driver, ws.id);
    const owned = options.root;
    const workspaceEntries = readdirSync(join(owned, "workspaces"));
    const runtimeEntries = readdirSync(join(owned, "runtime-state"));
    expect(workspaceEntries).toHaveLength(1);
    expect(runtimeEntries).toHaveLength(1);
    const workspaceDirectoryName = workspaceEntries[0];
    const runtimeDirectoryName = runtimeEntries[0];
    if (!workspaceDirectoryName || !runtimeDirectoryName) throw new Error("derived directories missing");
    expect(workspaceDirectoryName).not.toContain(ws.id);
    expect(runtimeDirectoryName).not.toContain(running.id);
    expect(join(owned, "runtime-state", runtimeDirectoryName).length).toBeLessThan(3000 + 80);
    expect(statSync(join(owned, "workspaces")).mode & 0o077).toBe(0);
    expect(statSync(join(owned, "runtime-state")).mode & 0o077).toBe(0);
    const backendPath = join(owned, "runtime-state", runtimeDirectoryName, "supervisor-state.json");
    const before = statSync(backendPath).mtimeMs;
    const backend = JSON.parse(readFileSync(backendPath, "utf8")) as { pid: number };
    const marker = JSON.parse(readFileSync(join(dirname(backendPath), "ready.json"), "utf8")) as { descendantPid: number };
    const restarted = new LocalDriver(options);
    drivers.push(restarted);
    expect(restarted.getRuntime(running.id)).toMatchObject({ outcome: "found", resource: { revision: running.revision } });
    expect(restarted.resolveRuntimeRoute(running.id, "cmux-v10", running.generation).outcome).toBe("notReady");
    expect(statSync(backendPath).mtimeMs).toBe(before);
    const adopted = await restarted.setRuntimeDesiredState(running.id, "Running", running.revision);
    expect(adopted).toMatchObject({ outcome: "updated", resource: { revision: running.revision } });
    expect(restarted.resolveRuntimeRoute(running.id, "cmux-v10", running.generation).outcome).toBe("resolved");
    expect(statSync(backendPath).mtimeMs).toBe(before);
    const stopped = await restarted.setRuntimeDesiredState(running.id, "Stopped", adopted.outcome === "updated" ? adopted.resource.revision : running.revision);
    expect(stopped.outcome).toBe("updated");
    expect(pidDead(backend.pid)).toBe(true);
    expect(pidDead(marker.descendantPid)).toBe(true);
  });
  test("unexpected writer-group loss drains and fences before automatically replacing a Running generation", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const backendPath = join(base.options.root, "runtime-state", runtimeDirectoryName, "supervisor-state.json");
    const backend = JSON.parse(readFileSync(backendPath, "utf8")) as { pid: number };
    process.kill(-backend.pid, "SIGKILL");
    let recovered = base.driver.getRuntime(running.id);
    const deadline = Date.now() + 8_000;
    while (recovered.outcome === "found" && (recovered.resource.phase !== "Ready" || recovered.resource.generation === running.generation) && !recovered.resource.conditions.some((item) => item.reason === "FenceUncertain") && Date.now() <= deadline) {
      await yieldTurn();
      recovered = base.driver.getRuntime(running.id);
    }
    expect(recovered).toMatchObject({ outcome: "found", resource: { phase: "Ready" } });
    if (recovered.outcome !== "found") return;
    expect(recovered.resource.generation).not.toBe(running.generation);
    expect(base.driver.resolveRuntimeRoute(running.id, "cmux-v10", running.generation).outcome).toBe("staleGeneration");
    expect(base.driver.resolveRuntimeRoute(running.id, "cmux-v10", recovered.resource.generation).outcome).toBe("resolved");
    await base.driver.setRuntimeDesiredState(running.id, "Stopped", recovered.resource.revision);
  });

  test("restart completes a durable configuration intent without rewriting resource authority", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const created = await base.driver.createRuntime({ id: "runtime-config-recovery", scopeId: "scope-a", displayName: "Config Recovery", workspaceId: ws.id, hostProfileId: "host-default", desiredState: "Stopped", browserPolicy: "Disabled" });
    if (created.outcome !== "created") throw new Error("runtime create failed");
    const directoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!directoryName) throw new Error("runtime directory missing");
    const configurationPath = join(base.options.root, "runtime-state", directoryName, "runtime-config.json");
    const operationId = "op_recovery";
    writeFileSync(`${configurationPath}.${operationId}`, JSON.stringify({ browserPolicy: "Allowed" }), { mode: 0o600, flag: "wx" });
    const intent = base.store.compareAndSwapRuntimeWithConfigurationIntent({
      id: created.resource.id,
      expectedRevision: created.resource.revision,
      value: { ...created.resource, phase: "Unavailable", updatedAt: created.resource.updatedAt },
      event: { eventId: "evt_config_recovery", phase: "Unavailable", timestamp: created.resource.updatedAt },
      intent: { runtimeId: created.resource.id, operationId, browserPolicy: "Allowed" },
    });
    expect(intent.outcome).toBe("updated");
    if (intent.outcome !== "updated") return;
    const restarted = new LocalDriver(base.options);
    drivers.push(restarted);
    let recovered = restarted.getRuntime(created.resource.id);
    const deadline = Date.now() + 5_000;
    while (recovered.outcome === "found" && recovered.resource.phase === "Unavailable" && Date.now() <= deadline) {
      await yieldTurn();
      recovered = restarted.getRuntime(created.resource.id);
    }
    expect(recovered).toMatchObject({ outcome: "found", resource: { phase: "Stopped" } });
    expect(JSON.parse(readFileSync(configurationPath, "utf8"))).toEqual({ browserPolicy: "Allowed" });
    expect(base.store.getRuntimeConfigurationIntent(created.resource.id)).toBeUndefined();
  });
  test("restart completes a running configuration intent through a fresh fenced generation", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const directoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!directoryName) throw new Error("runtime directory missing");
    const configurationPath = join(base.options.root, "runtime-state", directoryName, "runtime-config.json");
    const operationId = "op_running_recovery";
    writeFileSync(`${configurationPath}.${operationId}`, JSON.stringify({ browserPolicy: "Allowed" }), { mode: 0o600, flag: "wx" });
    const intent = base.store.compareAndSwapRuntimeWithConfigurationIntent({
      id: running.id,
      expectedRevision: running.revision,
      value: { ...running, phase: "Unavailable", updatedAt: running.updatedAt },
      event: { eventId: "evt_running_config_recovery", phase: "Unavailable", timestamp: running.updatedAt },
      intent: { runtimeId: running.id, operationId, browserPolicy: "Allowed" },
    });
    expect(intent.outcome).toBe("updated");
    if (intent.outcome !== "updated") return;
    const restarted = new LocalDriver(base.options);
    drivers.push(restarted);
    let recovered = restarted.getRuntime(running.id);
    const deadline = Date.now() + 8_000;
    while (recovered.outcome === "found" && recovered.resource.phase !== "Ready" && !recovered.resource.conditions.some((item) => item.reason === "FenceUncertain") && Date.now() <= deadline) {
      await yieldTurn();
      recovered = restarted.getRuntime(running.id);
    }
    expect(recovered).toMatchObject({ outcome: "found", resource: { phase: "Ready" } });
    if (recovered.outcome !== "found") return;
    expect(recovered.resource.generation).not.toBe(running.generation);
    expect(restarted.resolveRuntimeRoute(running.id, "cmux-v10", recovered.resource.generation).outcome).toBe("resolved");
    expect(JSON.parse(readFileSync(configurationPath, "utf8"))).toEqual({ browserPolicy: "Allowed" });
    expect(base.store.getRuntimeConfigurationIntent(running.id)).toBeUndefined();
    await restarted.setRuntimeDesiredState(running.id, "Stopped", recovered.resource.revision);
  });
  test("restart fences an orphaned durable start attempt before launching its replacement", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const sleeping = await runtime(base.driver, ws.id, "Sleeping");
    const timestamp = sleeping.updatedAt;
    const orphaned = base.store.compareAndSwapRuntimeWithStartAttempt({
      id: sleeping.id,
      expectedRevision: sleeping.revision,
      value: { ...sleeping, desiredState: "Running", phase: "Starting", generation: "gen_orphaned", updatedAt: timestamp },
      event: { eventId: "evt_orphaned_start", phase: "Starting", timestamp },
      generation: "gen_orphaned",
      token: "attempt_orphaned",
    });
    expect(orphaned.outcome).toBe("updated");
    if (orphaned.outcome !== "updated") return;
    const restarted = new LocalDriver(base.options);
    drivers.push(restarted);
    const recovered = await restarted.setRuntimeDesiredState(sleeping.id, "Running", orphaned.resource.revision);
    expect(recovered).toMatchObject({ outcome: "updated", resource: { phase: "Ready" } });
    expect(base.store.getRuntimeStartAttempt(sleeping.id)).toBeUndefined();
    if (recovered.outcome === "updated") await restarted.setRuntimeDesiredState(sleeping.id, "Stopped", recovered.resource.revision);
  });
  test("orphan attempt cleanup precedes an exact stale-backend fence", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const runtimeDirectory = join(base.options.root, "runtime-state", runtimeDirectoryName);
    const attemptGeneration = "gen_prewrite_crash";
    const credentialName = `generation-${createHash("sha256").update(attemptGeneration).digest("hex").slice(0, 20)}.credential`;
    const attemptCredential = join(runtimeDirectory, credentialName);
    writeFileSync(attemptCredential, "orphaned", { mode: 0o600, flag: "wx" });
    const starting = base.store.compareAndSwapRuntimeWithStartAttempt({
      id: running.id,
      expectedRevision: running.revision,
      value: {
        ...running,
        phase: "Starting",
        generation: attemptGeneration,
        conditions: running.conditions.map((item) => item.type === "RouteReady" ? { ...item, status: "False" as const, reason: "ReadinessPending" } : item),
        updatedAt: running.updatedAt,
      },
      event: { eventId: "evt_prewrite_crash", phase: "Starting", timestamp: running.updatedAt },
      generation: attemptGeneration,
      token: "attempt_prewrite_crash",
    });
    if (starting.outcome !== "updated") throw new Error(starting.outcome);
    const revokedGenerations: string[] = [];
    const observedStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        if (property === "revokeTickets") return (request: Parameters<PortableControlStore["revokeTickets"]>[0]) => {
          if ("runtimeGeneration" in request) revokedGenerations.push(request.runtimeGeneration);
          return target.revokeTickets(request);
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const restarted = new LocalDriver({ ...base.options, store: observedStore });
    drivers.push(restarted);
    const recovered = await restarted.setRuntimeDesiredState(running.id, "Running", starting.resource.revision);
    expect(recovered).toMatchObject({ outcome: "updated", resource: { phase: "Ready" } });
    expect(revokedGenerations).toEqual(expect.arrayContaining([attemptGeneration, running.generation]));
    expect(() => statSync(attemptCredential)).toThrow();
    expect(base.store.getRuntimeStartAttempt(running.id)).toBeUndefined();
    if (recovered.outcome === "updated") await restarted.setRuntimeDesiredState(running.id, "Stopped", recovered.resource.revision);
  });


  test("rejects a symlinked controller root before creating backend state", () => {
    const base = mkdtempSync(join(tmpdir(), "portable-driver-symlink-")); roots.push(base);
    const target = join(base, "target");
    const linked = join(base, "linked");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, linked, "dir");
    const store = new SqliteControlStore({ databasePath: join(base, "control.sqlite") });
    const admissionStorage = new SqliteSharedControlLedgerStorage(join(base, "admission.sqlite"));
    admissionStorages.push(admissionStorage);
    expect(() => new LocalDriver({ root: linked, store, bootstrapScopes: [], launch: () => { throw new Error("not reached"); }, capabilities, admissionLedger: new SharedControlStore({ storage: admissionStorage }), admissionPolicy, lsofExecutable: lsof })).toThrow(/symlink rejected/);
    stores.push(store);
  });
  test("pre-backend launch failure revokes the deterministic generation credential", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const failing = new LocalDriver({ ...base.options, launch: () => { throw new Error("launch factory failed"); } });
    drivers.push(failing);
    const created = await failing.createRuntime({ id: "runtime-launch-throw", scopeId: "scope-a", displayName: "Launch Throw", workspaceId: ws.id, hostProfileId: "host-default", desiredState: "Running", browserPolicy: "Disabled" });
    expect(created).toMatchObject({ outcome: "fenceUncertain", resource: { phase: "Degraded" } });
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    expect(readdirSync(join(base.options.root, "runtime-state", runtimeDirectoryName)).filter((name) => name.endsWith(".credential"))).toEqual([]);
    expect(base.store.getRuntimeStartAttempt("runtime-launch-throw")).toBeUndefined();
  });

  test("drain revokes tickets before deleting the generation credential", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const runtimeDirectory = join(base.options.root, "runtime-state", runtimeDirectoryName);
    const backend = JSON.parse(readFileSync(join(runtimeDirectory, "supervisor-state.json"), "utf8")) as { credentialName: string };
    const credentialPath = join(runtimeDirectory, backend.credentialName);
    let credentialExistedWhenTicketsWereRevoked = false;
    const observedStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        if (property === "revokeTickets") return (request: Parameters<PortableControlStore["revokeTickets"]>[0]) => {
          try { credentialExistedWhenTicketsWereRevoked = statSync(credentialPath).isFile(); } catch { credentialExistedWhenTicketsWereRevoked = false; }
          return target.revokeTickets(request);
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const draining = new LocalDriver({ ...base.options, store: observedStore });
    drivers.push(draining);
    const sleeping = await draining.setRuntimeDesiredState(running.id, "Sleeping", running.revision);
    expect(sleeping.outcome).toBe("updated");
    expect(credentialExistedWhenTicketsWereRevoked).toBe(true);
    expect(() => statSync(credentialPath)).toThrow();
  });



  test("control-store revocation failure still tears down the real process and fails the fence closed", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const backend = JSON.parse(readFileSync(join(base.options.root, "runtime-state", runtimeDirectoryName, "supervisor-state.json"), "utf8")) as { pid: number };
    const failingStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        if (property === "revokeTickets") return () => { throw new Error("revocation unavailable"); };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const failingDriver = new LocalDriver({ ...base.options, store: failingStore });
    drivers.push(failingDriver);
    expect(await failingDriver.setRuntimeDesiredState(running.id, "Sleeping", running.revision)).toMatchObject({ outcome: "fenceUncertain", resource: { phase: "Degraded" } });
    expect(pidDead(backend.pid)).toBe(true);
  });

  test("FenceUncertain blocks automatic writer retry until explicit recovery under a fresh revision", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const uncertainDriver = new LocalDriver({ ...base.options, lsofExecutable: "/definitely-missing-lsof" });
    drivers.push(uncertainDriver);
    const uncertain = await uncertainDriver.setRuntimeDesiredState(running.id, "Sleeping", running.revision);
    expect(uncertain).toMatchObject({ outcome: "fenceUncertain", resource: { phase: "Degraded", conditions: expect.arrayContaining([expect.objectContaining({ type: "Fenced", status: "False", reason: "FenceUncertain" })]) } });
    if (uncertain.outcome !== "fenceUncertain") return;
    expect(await uncertainDriver.setRuntimeDesiredState(running.id, "Running", uncertain.resource.revision)).toMatchObject({ outcome: "invalidState", reason: "ManualFenceRecoveryRequired" });
    expect(await base.driver.recoverRuntimeFence(running.id, running.revision)).toMatchObject({ outcome: "revisionMismatch", currentRevision: uncertain.resource.revision });
    const recovered = await base.driver.recoverRuntimeFence(running.id, uncertain.resource.revision);
    expect(recovered.outcome).toBe("updated");
    if (recovered.outcome !== "updated") return;
    const woke = await base.driver.setRuntimeDesiredState(running.id, "Running", recovered.resource.revision);
    expect(woke.outcome).toBe("updated");
    if (woke.outcome === "updated") await base.driver.setRuntimeDesiredState(running.id, "Stopped", woke.resource.revision);
  });

  test("unsafe configuration path leaves the prior stopped resource revision and phase authoritative", async () => {
    const base = setup({ admissionPolicy: { ...admissionPolicy, browserEnabled: true } });
    const ws = await workspace(base.driver);
    const stopped = await runtime(base.driver, ws.id, "Stopped");
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const runtimeDirectory = join(base.options.root, "runtime-state", runtimeDirectoryName);
    const movedRuntimeDirectory = `${runtimeDirectory}-moved`;
    renameSync(runtimeDirectory, movedRuntimeDirectory);
    symlinkSync(movedRuntimeDirectory, runtimeDirectory, "dir");
    try {
      expect(await base.driver.updateRuntime(stopped.id, { browserPolicy: "Allowed" }, stopped.revision)).toMatchObject({ outcome: "invalidState", reason: "ConfigurationReadFailed" });
      expect(base.driver.getRuntime(stopped.id)).toMatchObject({ outcome: "found", resource: { revision: stopped.revision, phase: "Stopped" } });
    } finally {
      rmSync(runtimeDirectory, { force: true });
      renameSync(movedRuntimeDirectory, runtimeDirectory);
    }
  });

  test("a crash after entering Deleting is retryable without another transitional CAS", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const stopped = await runtime(base.driver, ws.id, "Stopped");
    let injected = false;
    const crashingStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "finalizeRuntimeDeletion") return () => { injected = true; throw new Error("simulated controller crash"); };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const crashingDriver = new LocalDriver({ ...base.options, store: crashingStore });
    drivers.push(crashingDriver);
    let failure: unknown;
    try { await crashingDriver.deleteRuntime(stopped.id, stopped.revision); }
    catch (cause) { failure = cause; }
    expect(failure).toEqual(expect.objectContaining({ message: "simulated controller crash" }));
    expect(injected).toBe(true);
    const deleting = base.driver.getRuntime(stopped.id);
    expect(deleting).toMatchObject({ outcome: "found", resource: { phase: "Deleting" } });
    if (deleting.outcome !== "found") return;
    expect(await base.driver.deleteRuntime(stopped.id, deleting.resource.revision)).toMatchObject({ outcome: "deleted" });
  });

  test("delete tombstones immediately before cleanup, preserves issued IDs, and stale revisions cannot delete", async () => {
    const base = setup();
    const ws = await workspace(base.driver);
    const running = await runtime(base.driver, ws.id);
    const stopped = await base.driver.setRuntimeDesiredState(running.id, "Stopped", running.revision);
    if (stopped.outcome !== "updated") throw new Error(stopped.outcome);
    expect(await base.driver.deleteRuntime(running.id, running.revision)).toMatchObject({ outcome: "revisionMismatch", currentRevision: stopped.resource.revision });
    const runtimeDirectoryName = readdirSync(join(base.options.root, "runtime-state"))[0];
    if (!runtimeDirectoryName) throw new Error("runtime directory missing");
    const runtimeDirectory = join(base.options.root, "runtime-state", runtimeDirectoryName);
    let existedAtTombstone = false;
    const observedStore = new Proxy(base.store as PortableControlStore, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "finalizeRuntimeDeletion") return (request: Parameters<PortableControlStore["finalizeRuntimeDeletion"]>[0]) => {
          existedAtTombstone = statSync(runtimeDirectory).isDirectory();
          return target.finalizeRuntimeDeletion(request);
        };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const deletingDriver = new LocalDriver({ ...base.options, store: observedStore });
    drivers.push(deletingDriver);
    expect(await deletingDriver.deleteRuntime(running.id, stopped.resource.revision)).toMatchObject({ outcome: "deleted" });
    expect(existedAtTombstone).toBe(true);
    expect(base.store.identifierWasIssued("runtime", running.id)).toBe(true);
    expect(base.store.getTombstone({ scopeId: "scope-a", resourceKind: "runtime", resourceId: running.id })).toBeDefined();
    expect(await deletingDriver.createRuntime({ id: running.id, scopeId: "scope-a", displayName: "Reused", workspaceId: ws.id, hostProfileId: "host-default", desiredState: "Stopped", browserPolicy: "Disabled" })).toEqual({ outcome: "alreadyIssued" });
    const currentWorkspace = deletingDriver.getWorkspace(ws.id);
    if (currentWorkspace.outcome !== "found") throw new Error("workspace missing");
    expect(await deletingDriver.deleteWorkspace(ws.id, currentWorkspace.resource.revision)).toMatchObject({ outcome: "deleted" });
    expect(base.store.identifierWasIssued("workspace", ws.id)).toBe(true);
  });
});
