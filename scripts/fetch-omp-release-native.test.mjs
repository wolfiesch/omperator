import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { restoreReleaseNative } from "./fetch-omp-release-native.mjs";

const repository = "wolfiesch/oh-my-pi";
const commit = "a".repeat(40);
const tag = "t4code-17.0.5-appserver-17";
const addon = Buffer.from("proven native addon");
const digest = createHash("sha256").update(addon).digest("hex");

function matrix() {
  return {
    verifiedRuntime: {
      sourceRepository: `https://github.com/${repository}`,
      sourceCommit: commit,
      sourceTag: tag,
    },
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    source: {
      repository,
      commit,
      tag,
      nativeSourceHash: "b".repeat(16),
      ...overrides.source,
    },
    assets: [
      {
        name: "pi_natives.linux-x64-modern.node",
        sha256: digest,
        size: addon.byteLength,
        ...overrides.asset,
      },
    ],
  };
}

function response(body, status = 200) {
  return new Response(body, { status });
}

test("restores a release addon only after source identity and digest verification", async (context) => {
  const sourceDir = await mkdtemp(join(tmpdir(), "omperator-release-native-"));
  context.after(() => rm(sourceDir, { recursive: true, force: true }));
  const requests = [];
  const result = await restoreReleaseNative({
    matrix: matrix(),
    sourceDir,
    githubOutput: undefined,
    fetchImpl: async (url) => {
      requests.push(url);
      return requests.length === 1 ? response(JSON.stringify(manifest())) : response(addon);
    },
  });

  assert.equal(result.restored, true);
  assert.deepEqual(
    await readFile(join(sourceDir, "packages/natives/native/pi_natives.linux-x64-modern.node")),
    addon,
  );
  assert.equal(requests.length, 2);
});

test("falls back only when an older release has no provenance manifest", async () => {
  const result = await restoreReleaseNative({
    matrix: matrix(),
    sourceDir: "/unused",
    githubOutput: undefined,
    fetchImpl: async () => response("missing", 404),
  });
  assert.deepEqual(result, { restored: false, reason: "release-manifest-missing" });
});

test("rejects a manifest for a different source commit", async () => {
  await assert.rejects(
    restoreReleaseNative({
      matrix: matrix(),
      sourceDir: "/unused",
      githubOutput: undefined,
      fetchImpl: async () => response(JSON.stringify(manifest({ source: { commit: "c".repeat(40) } }))),
    }),
    /commit mismatch/u,
  );
});

test("rejects bytes that do not match the published digest", async () => {
  let request = 0;
  await assert.rejects(
    restoreReleaseNative({
      matrix: matrix(),
      sourceDir: "/unused",
      githubOutput: undefined,
      fetchImpl: async () => (++request === 1 ? response(JSON.stringify(manifest())) : response("tampered native addon")),
    }),
    /size mismatch|digest mismatch/u,
  );
});
