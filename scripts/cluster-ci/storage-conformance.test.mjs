import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./storage-conformance.sh", import.meta.url);

function run(args, env = {}) {
  return spawnSync(script.pathname, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("--plan is exact and never invokes kubectl", () => {
  const result = run(["--plan"], { KUBECTL: "/definitely/not/a/kubectl" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `T4 storage conformance plan (read-only; no cluster requests)
Prerequisites:
  1. kubectl context explicitly names a disposable non-production cluster.
  2. At least two schedulable Linux nodes with CSI topology/reattach support.
  3. An installed CSI provisioner exposing an online-expandable ReadWriteMany StorageClass.
  4. A separate online-expandable ReadWriteOncePod or ReadWriteOnce runtime-state StorageClass.
  5. snapshot.storage.k8s.io/v1 VolumeSnapshot and VolumeSnapshotClass APIs; both selected StorageClasses must have a compatible snapshot class/driver.
  6. T4_STORAGE_FIXTURE_IMAGE is a digest-pinned image containing POSIX sh and sqlite3; no pull credentials are created or read by this harness.
  7. T4_STORAGE_NAMESPACE starts with t4-storage-conformance- and is disposable.
Scenarios:
  A. Provision workspace RWX and separate fenced runtime-state PVCs; verify selected access modes and online expansion.
  B. Write shared workspace data plus SQLite WAL, cmux state, browser state, and OMP generation state.
  C. Refuse a cross-node contender while the old attachment remains; require authoritative VolumeAttachment absence before one replacement writer remounts elsewhere and reads durable state.
  D. Assert exact one-writer/PVC cardinality, quiesce SQLite/OMP/cmux/browser for the exact generation, stop the writer, and create separately labeled workspace and runtime-state snapshots.
  E. Restore both ReadyToUse snapshots into new PVCs, start a fresh generation, and prove workspace/runtime-state data and generation separation.
  F. Record bounded conformance annotations only after every proof passes; namespace cleanup remains explicit.
Run prerequisites are validated before mutation. Live results are not implied by --plan.
`);
});

test("run contract is fail-closed, credential-free, and storage-separated", async () => {
  const source = await readFile(script, "utf8");
  for (const required of [
    "ReadWriteMany",
    "ReadWriteOncePod|ReadWriteOnce",
    "writer-contender",
    "operator: NotIn",
    "jsonpath={.provisioner}",
    "jsonpath={.driver}",
    "selected StorageClasses and VolumeSnapshotClass must use the same CSI driver",
    "allowVolumeExpansion",
    "selected StorageClasses must both allow online expansion",
    "status.capacity.storage",
    "volumeattachments.storage.k8s.io",
    "old runtime-state VolumeAttachment remained; refusing replacement writer",
    "expected exactly one generation 1 writer after fenced remount",
    "expected exactly workspace and runtime-state PVCs before snapshot",
    "PRAGMA wal_checkpoint(TRUNCATE)",
    "checkpoint.ack",
    "snapshot-consistency: Quiesced",
    "readyToUse",
    "gen_conformance_2",
    "generation 1 runtime remained active during restore",
    "persistentVolumeClaimName: workspace",
    "persistentVolumeClaimName: runtime-state",
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /kind:\s*Secret|dockerconfigjson|imagePullSecrets|password|token/i);

  const result = run(["--run"], {
    T4_STORAGE_NAMESPACE: "production",
    KUBECTL: "/definitely/not/a/kubectl",
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must begin t4-storage-conformance-/);
});
