import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNativeAppleLaunchAgent,
  ompExecutableFromProgramArguments,
  parseNativeAppleDogfoodArguments,
  validateTailnetIpv4,
} from "./native-apple-dogfood.mjs";

test("native Apple dogfood CLI keeps mutation explicit", () => {
  assert.deepEqual(parseNativeAppleDogfoodArguments(["status"]), {
    help: false,
    command: "status",
  });
  assert.deepEqual(
    parseNativeAppleDogfoodArguments([
      "start",
      "--omp",
      "/opt/omp/bin/omp",
      "--address",
      "100.64.0.9",
    ]),
    {
      help: false,
      command: "start",
      omp: "/opt/omp/bin/omp",
      address: "100.64.0.9",
    },
  );
  assert.throws(() => parseNativeAppleDogfoodArguments(["restore", "--address", "100.64.0.9"]));
  assert.throws(() => parseNativeAppleDogfoodArguments(["start", "--omp", "relative/omp"]));
  assert.throws(() => parseNativeAppleDogfoodArguments(["unknown"]));
});

test("native Apple dogfood accepts only Tailnet IPv4 listeners", () => {
  assert.equal(validateTailnetIpv4("100.64.0.1"), "100.64.0.1");
  assert.equal(validateTailnetIpv4("100.127.255.254"), "100.127.255.254");
  for (const invalid of ["127.0.0.1", "100.63.0.1", "100.128.0.1", "10.0.0.1", "::1"]) {
    assert.throws(() => validateTailnetIpv4(invalid));
  }
});

test("native Apple dogfood definition preserves default-profile bridge authority", () => {
  const definition = buildNativeAppleLaunchAgent({
    host: "/repo/packages/host-daemon/dist/t4-host",
    omp: "/runtime/omp",
    stateRoot: "/repo/.artifacts/native-dogfood/compat-state",
    address: "100.64.0.9",
    logs: "/Users/test/Library/Logs/T4 Code/appserver",
  });
  assert.match(definition, /<string>--profile<\/string>\s*<string>default<\/string>/u);
  assert.match(definition, /<string>--remote-mode<\/string>\s*<string>direct<\/string>/u);
  assert.match(definition, /<string>--remote-tls-port<\/string>\s*<string>8788<\/string>/u);
  assert.doesNotMatch(definition, /--omp-authority|--omp-sessions-root|official/u);
  assert.equal(
    ompExecutableFromProgramArguments([
      "/repo/t4-host",
      "serve",
      "--omp",
      "/runtime/omp",
      "--profile",
      "default",
    ]),
    "/runtime/omp",
  );
});
