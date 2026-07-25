import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { candidatePorts, parseWorktreeSlug, worktreeIdentity, worktreePortEnvironment } from "./worktree-sandbox.mjs";

test("worktree identities are explicit and repository-contained", () => {
  assert.deepEqual(worktreeIdentity("host-watch", "/tmp/omperator-fixture"), {
    slug: "host-watch",
    path: "/tmp/omperator-fixture/.worktrees/host-watch",
    branch: "worktree/host-watch",
    sandbox: "host-watch",
    metadataPath: "/tmp/omperator-fixture/.artifacts/worktrees/host-watch.json",
    environmentPath: "/tmp/omperator-fixture/.worktrees/host-watch/.artifacts/worktree.env",
  });
  for (const invalid of ["", "../escape", "UPPER", "a".repeat(41)]) {
    assert.throws(() => parseWorktreeSlug(invalid));
  }
});

test("worktree port ranges are stable and non-overlapping", () => {
  const first = candidatePorts("host-watch");
  assert.deepEqual(first, candidatePorts("host-watch"));
  assert.equal(new Set(Object.values(first)).size, 3);
  assert.ok(first.renderer >= 41_000 && first.renderer < 42_000);
  assert.ok(first.tailnet >= 43_000 && first.tailnet < 44_000);
  assert.ok(first.fixture >= 45_000 && first.fixture < 46_000);
  assert.notDeepEqual(first, candidatePorts("host-watch", 1));
});

test("worktree ports become development process environment", () => {
  assert.deepEqual(worktreePortEnvironment({ renderer: 41_001, tailnet: 43_002, fixture: 45_003 }), {
    T4_DEV_RENDERER_PORT: "41001",
    T4_GATEWAY_PORT: "43002",
    T4_FIXTURE_PORT: "45003",
  });
  assert.throws(() => worktreePortEnvironment({ renderer: 0, tailnet: 43_002, fixture: 45_003 }));
});

test("development commands consume the worktree port environment", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.dev, /--env-file-if-exists=\.artifacts\/worktree\.env/u);
  assert.match(packageJson.scripts["serve:tailnet"], /--env-file-if-exists=\.artifacts\/worktree\.env/u);
});
