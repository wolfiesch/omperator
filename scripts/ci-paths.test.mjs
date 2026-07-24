import assert from "node:assert/strict";
import test from "node:test";
import { classifyCiPaths, formatGitHubOutputs } from "./ci-paths.mjs";

const none = {
  continuity: false,
  cluster: false,
  official_omp_gate0: false,
  tooling: false,
  android_debug: false,
};

test("host runtime source runs host gates without unrelated platform builds", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-service/src/rpc-child.ts"]), {
    ...none,
    continuity: true,
    cluster: true,
    official_omp_gate0: true,
    tooling: true,
  });
});

test("official lifecycle inputs run their native proof and tooling", () => {
  assert.deepEqual(
    classifyCiPaths([
      "packages/host-service/bin/official-omp-gate0.ts",
      "docs/T4_ARCHITECTURE.html",
      "compat/omp-app-matrix.json",
    ]),
    { ...none, continuity: true, official_omp_gate0: true, tooling: true },
  );
  assert.deepEqual(classifyCiPaths(["docs/archive/flutter-migration/OMP_T4_CAPABILITY_TRACKER.csv"]), {
    ...none,
    official_omp_gate0: true,
    tooling: true,
  });
});

test("cluster implementation changes run the cluster gate", () => {
  assert.deepEqual(classifyCiPaths(["packages/cluster-operator/controllers/session_controller.go"]), {
    ...none,
    cluster: true,
  });
});

test("host wire changes run every dependent client and continuity gate", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-wire/src/command.ts"]), {
    continuity: true,
    cluster: true,
    official_omp_gate0: false,
    tooling: true,
    android_debug: true,
  });
});

test("client runtime changes run both bridge continuity gates", () => {
  assert.deepEqual(classifyCiPaths(["packages/client/src/omp-client-runtime.ts"]), {
    ...none,
    continuity: true,
    android_debug: true,
  });
});

test("host daemon changes run its host gates", () => {
  assert.deepEqual(classifyCiPaths(["packages/host-daemon/src/main.ts"]), {
    ...none,
    tooling: true,
  });
  assert.deepEqual(classifyCiPaths(["packages/host-daemon/src/cli.ts"]), {
    ...none,
    official_omp_gate0: true,
    tooling: true,
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
      official_omp_gate0: true,
      tooling: true,
      android_debug: true,
    });
  }
});

test("workflow changes run tooling on the PR and the full matrix after merge", () => {
  assert.deepEqual(classifyCiPaths([".github/workflows/ci.yml"]), {
    ...none,
    continuity: true,
    cluster: true,
    official_omp_gate0: true,
    tooling: true,
  });
});

test("Woodpecker continuity changes run the equivalent GitHub continuity gate", () => {
  assert.deepEqual(classifyCiPaths([".woodpecker.yml"]), {
    ...none,
    continuity: true,
    cluster: true,
  });
});

test("paths are normalized and GitHub outputs are stable", () => {
  const result = classifyCiPaths(["./apps\\web\\package.json", "./apps/web/package.json"]);
  assert.equal(
    formatGitHubOutputs(result),
    "continuity=false\ncluster=false\nofficial_omp_gate0=false\ntooling=false\nandroid_debug=true\n",
  );
});
