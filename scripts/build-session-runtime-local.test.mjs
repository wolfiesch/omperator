import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acquireBuildLease,
  createDockerBuildArguments,
  localRuntimeImage,
} from "./build-session-runtime-local.mjs";

const SOURCE_COMMIT = "a".repeat(40);

test("derives an exact-head ARM64 image and build command", () => {
  const image = localRuntimeImage(SOURCE_COMMIT);
  assert.equal(image, "omperator-session-runtime:aaaaaaaa-arm64");
  assert.deepEqual(createDockerBuildArguments({ image, sourceCommit: SOURCE_COMMIT }), [
    "build",
    "--platform", "linux/arm64",
    "--file", "cluster/images/session-runtime/Dockerfile",
    "--build-arg", `SOURCE_COMMIT=${SOURCE_COMMIT}`,
    "--build-arg", "IMAGE_VERSION=portable-agent-platform-v1-local",
    "--tag", image,
    ".",
  ]);
});

test("rejects non-exact source identities", () => {
  assert.throws(() => localRuntimeImage("abc123"), /40-character lowercase commit/u);
  assert.throws(
    () => createDockerBuildArguments({ image: "runtime:test", sourceCommit: "A".repeat(40) }),
    /40-character lowercase commit/u,
  );
});

test("serializes builds and releases only the owning lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-build-lease-"));
  const lockDirectory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await acquireBuildLease({ lockDirectory, image: "runtime:first", waitMs: 25, pollMs: 5 });
  await assert.rejects(
    acquireBuildLease({ lockDirectory, image: "runtime:second", waitMs: 25, pollMs: 5 }),
    /another session-runtime build owns/u,
  );
  await first.release();

  const second = await acquireBuildLease({ lockDirectory, image: "runtime:second", waitMs: 25, pollMs: 5 });
  await second.release();
});

test("recovers a lease whose recorded process no longer exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-build-stale-"));
  const lockDirectory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({ pid: 999_999_999, token: "stale" })}\n`);

  const lease = await acquireBuildLease({ lockDirectory, image: "runtime:fresh", waitMs: 25, pollMs: 5 });
  await lease.release();
});
