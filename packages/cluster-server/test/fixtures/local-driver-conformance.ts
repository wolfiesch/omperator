import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SharedControlStore, SqliteControlStore, SqliteSharedControlLedgerStorage } from "@t4-code/portable-control-store";
import { LocalDriver, type CompleteReadiness, type LocalDriverOptions } from "@t4-code/portable-driver";
import type { Capabilities, Timestamp } from "@t4-code/portable-core";

const runtimeChild = fileURLToPath(new URL("../../../portable-driver/test/fixtures/runtime-child.mjs", import.meta.url));
const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
const capabilities: Capabilities = {
  apiVersion: "v1",
  protocols: { machineProvider: { versions: [1], capabilities: [] }, cmux: { versions: [10] }, ompApp: { versions: [1] } },
  limits: { maxActiveRuntimes: 8, maxRetainedRuntimes: 32, idempotencyRetentionSeconds: 86_400, eventRetentionSeconds: 86_400, maxPageSize: 200 },
  features: { restLifecycle: true, sshProvider: false, directCmuxWebSocket: true, browser: true, scaleToZero: true },
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

function processGroupDead(processGroupId: number): boolean {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1_000 });
  if (result.status !== 0) return false;
  return !result.stdout.split("\n").some(row => {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(row);
    return match !== null && Number(match[1]) === processGroupId && !match[2]!.startsWith("Z");
  });
}

async function turn(): Promise<void> {
  const pending = Promise.withResolvers<void>();
  setImmediate(pending.resolve);
  await pending.promise;
}

export interface ActualLocalDriverFixture {
  readonly driver: LocalDriver;
  close(): Promise<void>;
}

export function createActualLocalDriverFixture(scopeId: string): ActualLocalDriverFixture {
  const root = mkdtempSync(join(tmpdir(), "portable-conformance-local-"));
  const store = new SqliteControlStore({ databasePath: join(root, "control.sqlite") });
  const admissionStorage = new SqliteSharedControlLedgerStorage(join(root, "admission.sqlite"));
  const admissionLedger = new SharedControlStore({ storage: admissionStorage });
  const launch: LocalDriverOptions["launch"] = (_runtime, context) => ({
    executable: process.execPath,
    arguments: [runtimeChild],
    routeKinds: ["cmux-v10", "omp-app-v1"],
    readinessProbe: async () => {
      try {
        const marker = JSON.parse(readFileSync(join(context.runtimeStatePath, "ready.json"), "utf8")) as { generation: string };
        if (marker.generation !== context.generation) return undefined;
        return { runtimeGeneration: marker.generation, storageReady: true, exclusiveWriterLeaseHeld: true, internalGenerationAuthenticationReady: true, hostReady: true, ompAuthorityReady: true, cmuxProtocol10Ready: true, requiredBrowserReady: true } as CompleteReadiness;
      } catch {
        return undefined;
      }
    },
    terminateAndProveFence: async (_context, containment) => {
      try { process.kill(-containment.processGroupId, "SIGTERM"); } catch { /* observed below */ }
      let deadline = Date.now() + containment.graceMilliseconds;
      while (Date.now() <= deadline && !processGroupDead(containment.processGroupId)) await turn();
      try { process.kill(-containment.processGroupId, "SIGKILL"); } catch { /* observed below */ }
      deadline = Date.now() + containment.killMilliseconds;
      while (Date.now() <= deadline && !processGroupDead(containment.processGroupId)) await turn();
      return processGroupDead(containment.processGroupId);
    },
  });
  const driver = new LocalDriver({
    root: join(root, "owned"),
    store,
    bootstrapScopes: [{ id: scopeId, displayName: "Conformance", kind: "Personal" }],
    launch,
    capabilities,
    admissionLedger,
    admissionPolicy,
    lsofExecutable: lsof,
    readinessTimeoutMilliseconds: 3_000,
    shutdownGraceMilliseconds: 1_000,
    shutdownKillMilliseconds: 1_000,
  });
  return {
    driver,
    close: async () => {
      await driver.close();
      store.close();
      admissionStorage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
