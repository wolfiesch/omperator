import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { formatAffectedPlan, planAffectedVerification } from "./verify-affected.mjs";

function ids(paths) {
  return planAffectedVerification(paths).commands.map((item) => item.id);
}

test("selects focused desktop and tooling checks", () => {
  assert.deepEqual(ids(["apps/desktop/src/main.ts", "scripts/dev.mjs"]), [
    "check",
    "workspace:@t4-code/desktop",
    "tooling",
  ]);
});

test("builds package inputs before running packaging checks", () => {
  const plan = planAffectedVerification(["scripts/inspect-macos-release.test.mjs"]);
  const selected = plan.commands.map((item) => item.id);
  assert.ok(selected.indexOf("build") >= 0);
  assert.ok(selected.indexOf("build") < selected.indexOf("packaging"));
});

test("selects native proofs for shared host authority changes", () => {
  const plan = planAffectedVerification(["packages/host-service/src/server.ts"]);
  assert.deepEqual(plan.commands.map((item) => item.id), [
    "check",
    "workspace:@t4-code/host-service",
    "tooling",
    "cluster",
    "official-lifecycle",
    "official-packaged",
    "bridge-continuity",
  ]);
  assert.deepEqual(plan.commands.at(-1)?.requiredEnvironment, ["T4_OMP_SOURCE_DIR"]);
});

test("unknown paths fail closed to the full suite", () => {
  // The classifier now decides what a merge run proves, so an unmapped path
  // selects every gate locally too rather than only the always-on checks.
  assert.deepEqual(ids(["unmapped-root-file.txt"]), [
    "check",
    "tooling",
    "maintainer",
    "cluster",
    "official-lifecycle",
    "official-packaged",
    "bridge-continuity",
    "ios",
    "android-debug",
    "full-test",
  ]);
});

test("empty changes select no work and formatted plans explain requirements", () => {
  assert.deepEqual(ids([]), []);
  const output = formatAffectedPlan(planAffectedVerification(["packages/client/src/index.ts"]));
  assert.match(output, /pnpm test:legacy-bridge-continuity \[requires T4_OMP_SOURCE_DIR\]/u);
  assert.match(output, /bridge continuity inputs changed/u);
});

test("the advertised affected verification command executes its plan", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["verify:affected"], "node scripts/verify-affected.mjs --run");
  assert.equal(packageJson.scripts["verify:affected:plan"], "node scripts/verify-affected.mjs");
});

test("iOS sources select the Xcode leg and nothing else", () => {
  assert.deepEqual(ids(["apps/ios/Sources/T4FilesPane.swift"]), ["check", "ios"]);
});

test("the wire contract the Swift client mirrors selects the Xcode leg", () => {
  // apps/ios/HostWire is a hand-written port, so a host-wire change can pass
  // every TypeScript gate and still fail to compile on the client.
  assert.ok(ids(["packages/host-wire/src/command.ts"]).includes("ios"));
});
