import assert from "node:assert/strict";
import test from "node:test";
import { classifyCiPaths, formatGitHubOutputs } from "./ci-paths.mjs";

const none = {
  continuity: false,
  cluster: false,
  tooling: false,
  android_debug: false,
  flutter: false,
  flutter_android: false,
  flutter_apple: false,
};

test("host runtime source runs host gates without unrelated platform builds", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-service/src/rpc-child.ts"]), {
    ...none,
    continuity: true,
    cluster: true,
    tooling: true,
  });
});

test("lifecycle harness and architecture docs run tooling only", () => {
  assert.deepEqual(
    classifyCiPaths([
      "packages/host-service/bin/official-omp-gate0.ts",
      "docs/T4_ARCHITECTURE.html",
      "compat/omp-app-matrix.json",
    ]),
    { ...none, tooling: true },
  );
});

test("cluster implementation changes run the cluster gate", () => {
  assert.deepEqual(classifyCiPaths(["packages/cluster-operator/controllers/session_controller.go"]), {
    ...none,
    cluster: true,
  });
});

test("Flutter changes run all Flutter legs", () => {
  assert.deepEqual(classifyCiPaths(["apps/flutter/lib/src/client/t4_client_controller.dart"]), {
    ...none,
    flutter: true,
    flutter_android: true,
    flutter_apple: true,
  });
});

test("host wire changes run every dependent client and continuity gate", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-wire/src/command.ts"]), {
    continuity: true,
    cluster: true,
    tooling: true,
    android_debug: true,
    flutter: true,
    flutter_android: true,
    flutter_apple: true,
  });
});

test("host daemon changes run the Apple packaging leg", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-daemon/src/main.ts"]), {
    ...none,
    tooling: true,
    flutter_apple: true,
  });
});

test("mobile web changes run only the Android debug product leg", () => {
  assert.deepEqual(classifyCiPaths(["apps/web/src/App.tsx"]), {
    ...none,
    android_debug: true,
  });
});

test("dependency graph changes conservatively run every leg", () => {
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    assert.deepEqual(classifyCiPaths([path]), {
      continuity: true,
      cluster: true,
      tooling: true,
      android_debug: true,
      flutter: true,
      flutter_android: true,
      flutter_apple: true,
    });
  }
});

test("workflow changes run tooling on the PR and the full matrix after merge", () => {
  assert.deepEqual(classifyCiPaths([".github/workflows/ci.yml"]), {
    ...none,
    cluster: true,
    tooling: true,
  });
});

test("paths are normalized and GitHub outputs are stable", () => {
  const result = classifyCiPaths(["./apps\\flutter\\pubspec.yaml", "./apps/flutter/pubspec.yaml"]);
  assert.equal(
    formatGitHubOutputs(result),
    "continuity=false\ncluster=false\ntooling=false\nandroid_debug=false\nflutter=true\nflutter_android=true\nflutter_apple=true\n",
  );
});
