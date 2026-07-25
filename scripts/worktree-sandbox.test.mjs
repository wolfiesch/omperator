import assert from "node:assert/strict";
import test from "node:test";

import { candidatePorts, parseWorktreeSlug, worktreeIdentity } from "./worktree-sandbox.mjs";

test("worktree identities are explicit and repository-contained", () => {
  assert.deepEqual(worktreeIdentity("host-watch", "/tmp/omperator-fixture"), {
    slug: "host-watch",
    path: "/tmp/omperator-fixture/.worktrees/host-watch",
    branch: "worktree/host-watch",
    sandbox: "host-watch",
    metadataPath: "/tmp/omperator-fixture/.artifacts/worktrees/host-watch.json",
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
