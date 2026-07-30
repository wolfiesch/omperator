import assert from "node:assert/strict";
import test from "node:test";
import { classifyCiPaths, formatGitHubOutputs } from "./ci-paths.mjs";

const none = {
  continuity: false,
  cluster: false,
  official_omp_gate0: false,
  tooling: false,
  maintainer: false,
  ios: false,
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
    maintainer: false,
    ios: true,
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
      maintainer: true,
      ios: true,
      android_debug: true,
    });
  }
});

test("selection and release-authority sources can only be proven by a full run", () => {
  const all = {
    continuity: true,
    cluster: true,
    official_omp_gate0: true,
    tooling: true,
    maintainer: true,
    ios: true,
    android_debug: true,
  };
  // The classifier cannot grade itself. If a bug in one of these let a run
  // pick a narrow set of legs and still conclude green, that run would become
  // the baseline every later run inherits from.
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "scripts/ci-paths.mjs",
    "scripts/ci-paths.test.mjs",
    "scripts/ci-baseline.mjs",
    "scripts/ci-baseline.test.mjs",
    "scripts/check-release-consistency.mjs",
    "scripts/check-release-consistency.test.mjs",
    "scripts/release-consistency/metadata-validator.mjs",
    "scripts/read-bounded-response.mjs",
    "scripts/wait-for-exact-ci.mjs",
    "scripts/wait-for-exact-ci.test.mjs",
  ]) {
    assert.deepEqual(classifyCiPaths([path]), all, path);
  }
});

test("the maintainer deployment suite runs only for its own surface", () => {
  assert.deepEqual(classifyCiPaths(["ops/t4-maintainer/deploy-local.sh"]), {
    ...none,
    maintainer: true,
  });
  assert.deepEqual(classifyCiPaths(["scripts/t4-maintainer-deploy.test.mjs"]), {
    ...none,
    tooling: true,
    maintainer: true,
  });
  assert.deepEqual(classifyCiPaths(["docs/DEVELOPMENT.md", "scripts/deploy-site.mjs"]), {
    ...none,
    tooling: true,
  });
});

test("Woodpecker changes run its manual cluster and tooling contracts only", () => {
  assert.deepEqual(classifyCiPaths([".woodpecker.yml"]), {
    ...none,
    cluster: true,
    tooling: true,
  });
});

test("paths are normalized and GitHub outputs are stable", () => {
  const result = classifyCiPaths(["./apps\\web\\package.json", "./apps/web/package.json"]);
  assert.equal(
    formatGitHubOutputs(result),
    "continuity=false\ncluster=false\nofficial_omp_gate0=false\ntooling=false\nmaintainer=false\nios=false\nandroid_debug=true\n",
  );
});

test("an unclassified path widens coverage instead of narrowing it", () => {
  const all = {
    continuity: true,
    cluster: true,
    official_omp_gate0: true,
    tooling: true,
    maintainer: true,
    ios: true,
    android_debug: true,
  };
  // Selection now decides what a merge run proves, so a path no group claims
  // must run everything rather than silently prove nothing.
  assert.deepEqual(classifyCiPaths(["packages/brand-new-package/src/index.ts"]), all);
  assert.deepEqual(classifyCiPaths(["some-new-top-level-dir/file.ts"]), all);
  assert.deepEqual(classifyCiPaths(["patches/@legendapp__list@3.2.0.patch"]), all);
  // One unclassified path in a batch widens the whole batch.
  assert.deepEqual(classifyCiPaths(["README.md", "unclaimed/file.ts"]), all);
});

test("surfaces the unconditional legs already prove select no extra legs", () => {
  for (const path of [
    ".gitignore",
    "AGENTS.md",
    "README.md",
    "Taskfile.yml",
    "apps/desktop/src/main.ts",
    "apps/site/src/pages/index.astro",
    "e2e/remote-app.spec.ts",
    "electron-builder.config.mjs",
    "infra/site/caddy.conf",
    "packages/fixture-server/src/index.ts",
    "packages/service-manager/src/index.ts",
  ]) {
    assert.deepEqual(classifyCiPaths([path]), none, path);
  }
  // The cluster spec is claimed by the cluster group, not excused by the
  // end-to-end exclusion above it.
  assert.deepEqual(classifyCiPaths(["e2e/cluster-operator.spec.ts"]), {
    ...none,
    cluster: true,
  });
});

test("the wire contract runs every gate that ships it", () => {
  assert.deepEqual(classifyCiPaths(["packages/protocol/src/index.ts"]), {
    ...none,
    continuity: true,
    official_omp_gate0: true,
    ios: true,
    android_debug: true,
  });
});

test("iOS sources select their own leg instead of the whole matrix", () => {
  // Before apps/ios was claimed, no group matched it and no no-impact rule
  // excused it, so a Swift-only change fell through to the full matrix: every
  // gate ran and none of them compiled the app that changed.
  for (const path of [
    "apps/ios/Sources/T4FilesPane.swift",
    "apps/ios/HostWire/Sources/HostWire/Commands.swift",
    "apps/ios/project.yml",
    "apps/ios/UITests/T4CodeUITests.swift",
  ]) {
    assert.deepEqual(classifyCiPaths([path]), { ...none, ios: true }, path);
  }
});

test("iOS CI scripts select tooling and the Xcode leg", () => {
  for (const path of [
    "scripts/prepare-ios-ci-cache.mjs",
    "scripts/verify-ios.mjs",
  ]) {
    assert.deepEqual(classifyCiPaths([path]), { ...none, tooling: true, ios: true }, path);
  }
});
