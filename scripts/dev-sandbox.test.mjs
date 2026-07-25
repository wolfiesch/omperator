import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseLiveDevelopmentArguments } from "./dev-live.mjs";
import {
  developmentSandboxPaths,
  parseSandboxName,
  prepareDevelopmentSandbox,
  resetDevelopmentSandbox,
  sandboxEnvironment,
} from "./dev-sandbox.mjs";
import { pnpmProcessInvocation } from "./pnpm-process.mjs";

test("development sandbox paths stay project-owned and explicitly named", () => {
  const root = "/tmp/omperator-fixture";
  const paths = developmentSandboxPaths("watch-loop", root);
  assert.equal(paths.root, join(root, ".artifacts", "dev", "watch-loop"));
  assert.equal(paths.electronUserData, join(paths.root, "electron", "user-data"));
  assert.equal(parseSandboxName("watch-loop"), "watch-loop");
  for (const invalid of ["", "../escape", "UPPER", "a".repeat(41)]) {
    assert.throws(() => parseSandboxName(invalid));
  }
});

test("sandbox preparation creates private disposable roots and reset removes only that sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "omperator-dev-sandbox-"));
  try {
    const paths = await prepareDevelopmentSandbox("test-loop", root);
    const environment = sandboxEnvironment(paths, { PATH: "/usr/bin" });
    assert.equal(environment.HOME, paths.home);
    assert.equal(environment.XDG_RUNTIME_DIR, paths.runtime);
    assert.equal(environment.T4_DEV_SANDBOX_ROOT, paths.root);
    assert.equal((await lstat(paths.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.runtime)).mode & 0o777, 0o700);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    assert.deepEqual(
      { sandbox: manifest.sandbox, disposable: manifest.disposable },
      { sandbox: "test-loop", disposable: true },
    );
    assert.equal(await resetDevelopmentSandbox("test-loop", root), true);
    await assert.rejects(lstat(paths.root), { code: "ENOENT" });
    assert.equal(await resetDevelopmentSandbox("test-loop", root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live development arguments select pinned runtime and a reusable sandbox by default", () => {
  assert.deepEqual(parseLiveDevelopmentArguments([]), {
    help: false,
    runtime: "pinned",
    sandbox: "local",
  });
  assert.deepEqual(
    parseLiveDevelopmentArguments(["--runtime", "system", "--sandbox", "host-work"]),
    { help: false, runtime: "system", sandbox: "host-work" },
  );
  assert.throws(() => parseLiveDevelopmentArguments(["--runtime", "unknown"]));
});

test("pnpm invocation supports both JavaScript entrypoints and native executables", () => {
  assert.deepEqual(pnpmProcessInvocation(["dev"], "/opt/pnpm/pnpm.cjs"), {
    command: process.execPath,
    args: ["/opt/pnpm/pnpm.cjs", "dev"],
  });
  assert.deepEqual(pnpmProcessInvocation(["dev"], "/opt/pnpm/pnpm"), {
    command: "/opt/pnpm/pnpm",
    args: ["dev"],
  });
});
