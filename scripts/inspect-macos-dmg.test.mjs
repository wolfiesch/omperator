import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

import { findMountedApp, inspectMacosDmg } from "./inspect-macos-dmg.mjs";

const dmgPath = "/tmp/T4-Code-0.1.8-mac-arm64.dmg";
const mountPoint = "/tmp/t4-code-dmg-test";

function directory(name) {
  return { name, isDirectory: () => true };
}

function fixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    platform: "darwin",
    isFile: () => true,
    createMountPoint: () => mountPoint,
    readMountedEntries: () => [directory("T4 Code.app")],
    resolveAppRoot: (path) => `${path}/Contents`,
    inspectArtifact: (path) => {
      calls.push(["inspect", path]);
      return { asarEntries: 42 };
    },
    runCommand: (command, args) => calls.push([command, ...args]),
    removeMountPoint: (path) => calls.push(["remove", path]),
    ...overrides,
  };
  return { calls, dependencies };
}

test("DMG inspection mounts read-only, inspects the app, detaches, then removes the mount point", () => {
  const { calls, dependencies } = fixture();
  assert.deepEqual(inspectMacosDmg(dmgPath, dependencies), { asarEntries: 42 });
  assert.deepEqual(calls, [
    [
      "hdiutil",
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ],
    ["inspect", `${mountPoint}/T4 Code.app/Contents`],
    ["hdiutil", "detach", mountPoint],
    ["remove", mountPoint],
  ]);
});

test("DMG inspection detaches even when package inspection fails", () => {
  const { calls, dependencies } = fixture({
    inspectArtifact: (path) => {
      calls.push(["inspect", path]);
      throw new Error("bad package");
    },
  });
  assert.throws(() => inspectMacosDmg(dmgPath, dependencies), /bad package/);
  assert.deepEqual(calls.slice(-2), [
    ["hdiutil", "detach", mountPoint],
    ["remove", mountPoint],
  ]);
});

test("DMG inspection force-detaches when the normal detach is busy", () => {
  const { calls, dependencies } = fixture({
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "detach" && args[1] !== "-force") throw new Error("busy");
    },
  });
  assert.deepEqual(inspectMacosDmg(dmgPath, dependencies), { asarEntries: 42 });
  assert.deepEqual(calls.slice(-3), [
    ["hdiutil", "detach", mountPoint],
    ["hdiutil", "detach", "-force", mountPoint],
    ["remove", mountPoint],
  ]);
});

test("DMG inspection fails closed and preserves the mount point when detach cannot complete", () => {
  const { calls, dependencies } = fixture({
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "detach") throw new Error("still busy");
    },
  });
  assert.throws(() => inspectMacosDmg(dmgPath, dependencies), /could not detach mounted DMG/);
  assert.equal(calls.some(([command]) => command === "remove"), false);
});

test("mounted DMGs must contain exactly one application bundle", () => {
  assert.equal(
    findMountedApp(mountPoint, () => [directory("T4 Code.app")]),
    `${mountPoint}/T4 Code.app`,
  );
  assert.throws(() => findMountedApp(mountPoint, () => []), /found 0/);
  assert.throws(
    () => findMountedApp(mountPoint, () => [directory("One.app"), directory("Two.app")]),
    /found 2/,
  );
});

test("release workflow inspects the DMG before staging it for publication", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
  const inspect = workflow.indexOf("pnpm inspect:dmg -- release/*.dmg");
  const stage = workflow.indexOf("cp release/T4-Code-*.dmg");
  assert.ok(inspect >= 0, "release workflow must invoke the DMG inspector");
  assert.ok(stage > inspect, "DMG inspection must run before staging the artifact");
});
