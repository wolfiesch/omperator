import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { load as parseYaml } from "js-yaml";

import {
  collectReleaseConsistencyErrors,
  discoverReleasePackagePaths,
  loadReleaseContractFiles,
  parseCliArguments,
} from "./check-release-consistency.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const files = loadReleaseContractFiles(repoRoot);

test("keeps the pre-install release verifier dependency-free", () => {
  const source = readFileSync(resolve(repoRoot, "scripts/check-release-consistency.mjs"), "utf8");
  assert.doesNotMatch(source, /from\s+["'](?!node:|\.)[^"']+["']/u);
});

function changed(path, replace) {
  const copy = new Map(files);
  copy.set(path, replace(copy.get(path)));
  return copy;
}

function changedRuntime(name, mutate) {
  return changed("compat/omp-app-matrix.json", (text) => {
    const matrix = JSON.parse(text);
    mutate(matrix[name]);
    return JSON.stringify(matrix);
  });
}

function replaceRequired(text, search, replacement) {
  assert.ok(text.includes(search), `fixture is missing expected value ${search}`);
  return text.replace(search, replacement);
}

function nextPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  assert.ok(match, `expected a stable semantic version, received ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function requiredWorkflowJob(workflow, name) {
  const parsed = parseYaml(workflow);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const job = parsed.jobs?.[name];
  assert.ok(job && typeof job === "object" && !Array.isArray(job), `missing workflow job ${name}`);
  return job;
}

function requiredNamedStep(job, name) {
  assert.ok(Array.isArray(job.steps), "workflow job must contain steps");
  const matches = job.steps.filter((step) => step?.name === name);
  assert.equal(matches.length, 1, `expected one workflow step named ${name}`);
  return matches[0];
}

function resolveWorkflowExpression(expression, context) {
  assert.equal(typeof expression, "string");
  const match = expression.match(/^\$\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/u);
  assert.ok(match, `expected one direct workflow expression, received ${expression}`);
  assert.ok(Object.hasOwn(context, match[1]), `missing workflow context value ${match[1]}`);
  return context[match[1]];
}

test("current source tree has one consistent release version", () => {
  assert.deepEqual(collectReleaseConsistencyErrors(files), []);
});

test("release package discovery ignores non-Node package directories", () => {
  assert.equal(discoverReleasePackagePaths(repoRoot).includes("packages/cluster-operator/package.json"), false);
});

test("rejects duplicate keys in JSON release contracts", () => {
  const duplicated = changed("compat/omp-app-matrix.json", (text) =>
    text.replace(
      '"appProtocol": "omp-app/1",',
      '"appProtocol": "omp-app/1",\n  "appProtocol": "omp-app/1",',
    ),
  );

  assert.ok(
    collectReleaseConsistencyErrors(duplicated).some((error) =>
      error.includes("duplicated mapping key"),
    ),
  );
});

test("promotes the verified runtime into the product release", () => {
  const matrix = JSON.parse(files.get("compat/omp-app-matrix.json"));
  assert.equal(matrix.verifiedRuntime.sourceTag, "t4code-17.0.5-appserver-13");
  assert.equal(matrix.publishedRuntime.sourceTag, "t4code-17.0.5-appserver-13");
  assert.deepEqual(matrix.publishedRuntime, matrix.verifiedRuntime);
});

test("freezes the legacy OMP host-migration provenance literals", () => {
  const sourceDrift = changed("provenance/omp-host-migration.json", (text) => {
    const provenance = JSON.parse(text);
    provenance.sourceRepository = "https://github.com/wolfiesch/oh-my-pi";
    return JSON.stringify(provenance);
  });
  assert.ok(
    collectReleaseConsistencyErrors(sourceDrift).some((error) =>
      error.includes("source repository must remain"),
    ),
  );

  for (const field of [
    "t4codeBase",
    "operationsContinuity",
    "artifactAndTurnReview",
    "runtimeAndWorkspaceAdapters",
  ]) {
    const inputDrift = changed("provenance/omp-host-migration.json", (text) => {
      const provenance = JSON.parse(text);
      provenance.inputs[field] = "0".repeat(40);
      return JSON.stringify(provenance);
    });
    assert.ok(
      collectReleaseConsistencyErrors(inputDrift).some((error) =>
        error.includes("migration inputs must remain"),
      ),
      field,
    );
  }
});

test("rejects the retired OMP fork in the active Woodpecker workflow", () => {
  const staleWorkflow = changed(".woodpecker.yml", (text) =>
    replaceRequired(
      text,
      "https://github.com/wolfiesch/oh-my-pi.git",
      "https://github.com/lyc-aon/oh-my-pi.git",
    ),
  );
  assert.ok(
    collectReleaseConsistencyErrors(staleWorkflow).some((error) =>
      error.includes("retired Lycaon OMP integration fork"),
    ),
  );
});

test("pins official OMP artifacts and the Gate 0 proof contract", () => {
  const officialDrift = changedRuntime("officialRuntime", (runtime) => {
    runtime.artifacts["linux-arm64"].sha256 = "invalid";
  });
  assert.ok(
    collectReleaseConsistencyErrors(officialDrift).some((error) =>
      error.includes("official runtime linux-arm64 artifact SHA-256"),
    ),
  );

  const snapshotDrift = changed("compat/official-omp-gate0.json", (text) => {
    const snapshot = JSON.parse(text);
    snapshot.runtime.commit = "0".repeat(40);
    snapshot.requiredScenarios = snapshot.requiredScenarios.filter((item) => item !== "approval");
    snapshot.t4AdapterCoverage.liveEntryDeduplication = false;
    snapshot.packagedHostProof.requiredScenarios = ["prompt"];
    return JSON.stringify(snapshot);
  });
  const errors = collectReleaseConsistencyErrors(snapshotDrift);
  assert.ok(errors.some((error) => error.includes("runtime commit must match")));
  assert.ok(errors.some((error) => error.includes("requiredScenarios must match")));
  assert.ok(errors.some((error) => error.includes("liveEntryDeduplication must be true")));
  assert.ok(errors.some((error) => error.includes("packagedHostProof.requiredScenarios")));
});

test("rejects a tag that differs from the package version", () => {
  assert.ok(
    collectReleaseConsistencyErrors(files, "v9.9.9").some((error) =>
      error.includes("release tag v9.9.9 does not match v0.1.31"),
    ),
  );
});

test("tagged releases reject published provenance drift", () => {
  const appWireCases = [
    [
      "version",
      (record) => {
        record.version = "0.5.8";
      },
    ],
    [
      "commit",
      (record) => {
        record.sourceCommit = "0".repeat(40);
      },
    ],
    [
      "source tree",
      (record) => {
        record.sourceTreeHash = "0".repeat(40);
      },
    ],
  ];
  for (const [field, mutate] of appWireCases) {
    const drifted = changedRuntime("publishedAppWire", mutate);
    assert.ok(
      collectReleaseConsistencyErrors(drifted, "v0.1.31").some((error) =>
        error.includes(
          `published app-wire ${field} must match current app-wire for tagged releases`,
        ),
      ),
    );
  }

  const runtimeCases = [
    [
      "version",
      (runtime) => {
        runtime.version = "17.0.0";
      },
    ],
    [
      "commit",
      (runtime) => {
        runtime.sourceCommit = "0".repeat(40);
      },
    ],
    [
      "tag",
      (runtime) => {
        runtime.sourceTag = "t4code-17.0.5-appserver-2";
      },
    ],
    [
      "upstream commit",
      (runtime) => {
        runtime.upstreamCommit = "0".repeat(40);
      },
    ],
    [
      "integration patches",
      (runtime) => {
        runtime.integrationPatches = runtime.integrationPatches.slice(0, -1);
      },
    ],
  ];
  for (const [field, mutate] of runtimeCases) {
    const drifted = changedRuntime("publishedRuntime", mutate);
    assert.ok(
      collectReleaseConsistencyErrors(drifted, "v0.1.31").some((error) =>
        error.includes(
          `published runtime ${field} must match current verified runtime for tagged releases`,
        ),
      ),
    );
  }

  const extended = changedRuntime("publishedRuntime", (runtime) => {
    runtime.artifactSha256 = "0".repeat(64);
  });
  assert.ok(
    collectReleaseConsistencyErrors(extended, "v0.1.31").some((error) =>
      error.includes(
        "published runtime must exactly match current verified runtime for tagged releases",
      ),
    ),
  );
});

test("rejects workspace, site, README, and runtime version drift", () => {
  const cases = [
    ["apps/web/package.json", (text) => text.replace('"version": "0.1.31"', '"version": "0.1.3"')],
    [
      "apps/site/src/release.ts",
      (text) => text.replace('RELEASE_TAG = "v0.1.31"', 'RELEASE_TAG = "v0.1.3"'),
    ],
    ["README.md", (text) => text.replace("Download v0.1.31", "Download v0.1.3")],
    [
      "apps/desktop/src/target-manager.ts",
      (text) => text.replace('version: "0.1.31"', 'version: "0.1.3"'),
    ],
    [
      "apps/site/src/docs/content.ts",
      (text) => text.replace('id: "troubleshooting-large-session"', 'id: "missing-large-session"'),
    ],
  ];
  for (const [path, replace] of cases) {
    assert.ok(
      collectReleaseConsistencyErrors(changed(path, replace)).length > 0,
      `${path} drift should fail`,
    );
  }
});

test("rejects version drift in a newly added workspace package", () => {
  const withNewPackage = new Map(files);
  withNewPackage.set(
    "packages/new-workspace/package.json",
    JSON.stringify({ name: "@t4-code/new-workspace", version: "0.1.3", private: true }),
  );
  assert.ok(
    collectReleaseConsistencyErrors(withNewPackage).some((error) =>
      error.includes("packages/new-workspace/package.json version"),
    ),
  );
});

test("rejects updater channel, stable manifest, and publication-contract drift", () => {
  const cases = [
    ["electron-builder.config.mjs", (text) => text.replace('repo: "t4-code"', 'repo: "renamed"')],
    [
      "scripts/generate-release-manifest.mjs",
      (text) =>
        text.replace("RELEASE_MANIFEST_SCHEMA_VERSION = 1", "RELEASE_MANIFEST_SCHEMA_VERSION = 2"),
    ],
    ["scripts/wait-for-release-assets.mjs", (text) => text.replace(', "latest-linux.yml"', "")],
    [
      ".github/workflows/release.yml",
      (text) => text.replace("artifacts/latest-linux.yml", "artifacts/missing-linux.yml"),
    ],
    [
      ".github/workflows/release.yml",
      (text) =>
        text.replace(
          "needs: [verify, ci-authority, build-android, build-linux, build-macos]",
          "needs: [verify, build-android, build-linux, build-macos]",
        ),
    ],
    [
      ".github/workflows/ci.yml",
      (text) =>
        text.replace(
          "needs: [changes, t4-api-generation, core, legacy-bridge-continuity, current-bridge-continuity, official-omp-gate0, cluster, tooling, android-debug]",
          "needs: [changes, core, tooling, android-debug]",
        ),
    ],
    [
      ".github/workflows/ci.yml",
      (text) =>
        text.replaceAll(
          "ref: ${{ github.event.pull_request.head.sha || github.sha }}",
          "ref: ${{ github.ref }}",
        ),
    ],
    [
      ".github/workflows/ci.yml",
      (text) =>
        replaceRequired(
          text,
          'test "$source_repository" = "https://github.com/wolfiesch/oh-my-pi"',
          'test "$source_repository" = "https://github.com/example/other"',
        ),
    ],
    [
      ".github/workflows/ci.yml",
      (text) => replaceRequired(text, '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]', '[[ -n "$sha" ]]'),
    ],
    [
      ".github/workflows/ci.yml",
      (text) => text.replace("run: pnpm test:legacy-bridge-continuity", "run: pnpm test"),
    ],
    [
      "scripts/reconcile-release-assets.mjs",
      (text) => text.replace('method: "DELETE"', 'method: "POST"'),
    ],
    [
      "scripts/dispatch-site-deployment.mjs",
      (text) => text.replace("body: { ref: tag", 'body: { ref: "main"'),
    ],
    [
      "scripts/wait-for-exact-ci.mjs",
      (text) =>
        text.replace(
          'WORKFLOW_PATH = ".github/workflows/ci.yml"',
          'WORKFLOW_PATH = ".github/workflows/release.yml"',
        ),
    ],
    [
      ".github/workflows/deploy-site.yml",
      (text) =>
        text.replace("startsWith(github.ref, 'refs/tags/')", "github.ref == 'refs/heads/main'"),
    ],
  ];
  for (const [path, replace] of cases) {
    assert.ok(
      collectReleaseConsistencyErrors(changed(path, replace)).length > 0,
      `${path} updater drift should fail`,
    );
  }
});

test("historical repair runs CI authority from trusted control while querying old source", () => {
  const trustedControlSha = "a".repeat(40);
  const historicalSourceSha = "b".repeat(40);
  const waiterPath = "scripts/wait-for-exact-ci.mjs";
  const historicalFixtureRoot = resolve(
    repoRoot,
    "scripts/fixtures/historical-release-without-ci-waiter",
  );
  const sourceTrees = new Map([
    [trustedControlSha, repoRoot],
    [historicalSourceSha, historicalFixtureRoot],
  ]);
  const context = {
    "github.sha": trustedControlSha,
    "needs.verify.outputs.source_sha": historicalSourceSha,
  };

  assert.ok(existsSync(resolve(repoRoot, waiterPath)));
  assert.equal(existsSync(resolve(historicalFixtureRoot, waiterPath)), false);

  const authorityJob = requiredWorkflowJob(
    files.get(".github/workflows/release.yml"),
    "ci-authority",
  );
  const checkoutStep = requiredNamedStep(authorityJob, "Check out trusted CI-authority source");
  const authorityStep = requiredNamedStep(authorityJob, "Require successful exact-SHA main CI");
  const checkoutIndex = authorityJob.steps.indexOf(checkoutStep);
  const authorityIndex = authorityJob.steps.indexOf(authorityStep);
  assert.ok(checkoutIndex >= 0 && checkoutIndex < authorityIndex);

  let checkoutSha;
  for (const step of authorityJob.steps.slice(0, authorityIndex)) {
    if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
      checkoutSha = resolveWorkflowExpression(step.with?.ref, context);
    }
  }
  assert.equal(checkoutSha, trustedControlSha);
  const checkoutRoot = sourceTrees.get(checkoutSha);
  assert.ok(checkoutRoot, "authority checkout must resolve a known fixture tree");
  assert.ok(existsSync(resolve(checkoutRoot, waiterPath)));

  assert.match(authorityStep.run, /node scripts\/wait-for-exact-ci\.mjs/u);
  const commitVariable = authorityStep.run.match(/--commit\s+"\$([A-Z][A-Z0-9_]*)"/u)?.[1];
  assert.ok(commitVariable, "authority command must pass one environment SHA to --commit");
  const queriedSha = resolveWorkflowExpression(authorityStep.env[commitVariable], context);
  assert.equal(queriedSha, historicalSourceSha);
  assert.notEqual(checkoutSha, queriedSha);
});

test("historical repair keeps trusted verification code separate from immutable source", () => {
  const verifyJob = requiredWorkflowJob(files.get(".github/workflows/release.yml"), "verify");
  const controlCheckout = requiredNamedStep(verifyJob, "Check out trusted release-control source");
  const sourceCheckout = requiredNamedStep(verifyJob, "Check out immutable release source");
  const consistencyStep = requiredNamedStep(
    verifyJob,
    "Verify tag, packages, clients, docs, and downloads agree",
  );

  assert.equal(controlCheckout.with.ref, "${{ github.sha }}");
  assert.equal(sourceCheckout.with.ref, "${{ steps.source.outputs.source_sha }}");
  assert.equal(sourceCheckout.with.path, ".release-source");
  assert.equal(
    consistencyStep.run,
    'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG" --repo-root .release-source',
  );
  assert.deepEqual(parseCliArguments(["--tag", "v0.1.31", "--repo-root", ".release-source"]), {
    releaseTag: "v0.1.31",
    repoRoot: resolve(".release-source"),
  });
});

test("historical repair keeps trusted publication control separate from release content", () => {
  const publishJob = requiredWorkflowJob(files.get(".github/workflows/release.yml"), "publish");
  const controlCheckout = requiredNamedStep(
    publishJob,
    "Check out trusted publication-control source",
  );
  const contentCheckout = requiredNamedStep(publishJob, "Check out verified release content");
  const tagStep = requiredNamedStep(
    publishJob,
    "Confirm the release tag still resolves to the verified source",
  );
  const prepareStep = requiredNamedStep(
    publishJob,
    "Preserve an exact release or prepare an incomplete release for repair",
  );
  const publishStep = requiredNamedStep(publishJob, "Publish GitHub release");
  const verifyStep = requiredNamedStep(publishJob, "Verify the exact remote release bundle");

  assert.equal(controlCheckout.with.ref, "${{ github.sha }}");
  assert.equal(contentCheckout.with.ref, "${{ needs.verify.outputs.source_sha }}");
  assert.equal(contentCheckout.with.path, ".release-source");
  assert.equal(tagStep["working-directory"], ".release-source");
  assert.match(prepareStep.run, /^node scripts\/reconcile-release-assets\.mjs/u);
  assert.equal(publishStep.with.body_path, ".release-source/docs/CURRENT_RELEASE_NOTES.md");
  assert.match(verifyStep.run, /^node scripts\/reconcile-release-assets\.mjs/u);
});

test("rejects published app-wire version drift until release surfaces agree", () => {
  const drifted = changedRuntime("publishedAppWire", (record) => {
    record.version = "0.5.1";
  });
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some(
      (error) => error.startsWith("README.md") || error.startsWith("apps/site/src/release.ts"),
    ),
  );
});

test("rejects published app-wire provenance drift until release surfaces agree", () => {
  const drifted = changedRuntime("publishedAppWire", (record) => {
    record.sourceCommit = "0".repeat(40);
  });
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some(
      (error) => error.startsWith("README.md") || error.startsWith("docs/CURRENT_RELEASE_NOTES.md"),
    ),
  );
});

test("rejects drift between the compatibility matrix and vendored app-wire manifest", () => {
  const drifted = changed("vendor/app-wire/manifest.json", (text) => {
    const manifest = JSON.parse(text);
    manifest.sourceTreeHash = "0".repeat(40);
    return JSON.stringify(manifest);
  });
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) =>
      error.includes("vendor/app-wire/manifest.json sourceTreeHash must match"),
    ),
  );
});

test("rejects a stale app-wire third-party notice", () => {
  const { package: packageName, version } = JSON.parse(files.get("vendor/app-wire/manifest.json"));
  const drifted = changed("THIRD_PARTY_NOTICES.md", (text) =>
    replaceRequired(text, `${packageName}@${version}`, `${packageName}@0.0.0`),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) =>
      error.startsWith("THIRD_PARTY_NOTICES.md is missing"),
    ),
  );
});

test("rejects drift in verified OMP runtime provenance", () => {
  const cases = [
    (runtime) => {
      runtime.sourceCommit = "0000000000000000000000000000000000000000";
    },
    (runtime) => {
      runtime.sourceTag = "wrong-tag";
    },
    (runtime) => {
      runtime.upstreamCommit = "invalid";
    },
    (runtime) => {
      runtime.integrationPatches = runtime.integrationPatches.map((patch) =>
        patch === "versioned-agent-view-lifecycle-corpus" ? "Wrong integration patch" : patch,
      );
    },
  ];
  for (const [index, mutate] of cases.entries()) {
    const drifted = changedRuntime("verifiedRuntime", mutate);
    assert.ok(collectReleaseConsistencyErrors(drifted).length > 0, `runtime drift case ${index}`);
  }
});

test("rejects drift in published OMP runtime provenance", () => {
  const cases = [
    (runtime) => {
      runtime.sourceCommit = "0000000000000000000000000000000000000000";
    },
    (runtime) => {
      runtime.sourceTag = "wrong-tag";
    },
    (runtime) => {
      runtime.upstreamCommit = "0000000000000000000000000000000000000000";
    },
  ];
  for (const mutate of cases) {
    const drifted = changedRuntime("publishedRuntime", mutate);
    assert.ok(collectReleaseConsistencyErrors(drifted).length > 0);
  }
});

test("accepts a current app-wire update without rewriting published release surfaces", () => {
  const coordinated = new Map(files);
  const matrix = JSON.parse(coordinated.get("compat/omp-app-matrix.json"));
  const manifest = JSON.parse(coordinated.get("vendor/app-wire/manifest.json"));
  const current = { ...matrix.appWire };
  const proposed = {
    version: nextPatchVersion(current.version),
    sourceCommit: "1".repeat(40),
    sourceTreeHash: "2".repeat(40),
    tarballSha256: "3".repeat(64),
    goldenCorpusSha256: "4".repeat(64),
  };

  Object.assign(matrix.appWire, proposed, {
    tarball: `vendor/app-wire/oh-my-pi-app-wire-${proposed.version}.tgz`,
  });
  Object.assign(manifest, proposed, {
    tarball: `oh-my-pi-app-wire-${proposed.version}.tgz`,
  });
  coordinated.set("compat/omp-app-matrix.json", JSON.stringify(matrix));
  coordinated.set("vendor/app-wire/manifest.json", JSON.stringify(manifest));
  coordinated.set(
    "THIRD_PARTY_NOTICES.md",
    [
      [`${current.package}@${current.version}`, `${current.package}@${proposed.version}`],
      [current.sourceCommit, proposed.sourceCommit],
      [current.sourceTreeHash, proposed.sourceTreeHash],
      [current.tarballSha256, proposed.tarballSha256],
      [current.goldenCorpusSha256, proposed.goldenCorpusSha256],
    ].reduce(
      (notice, [from, to]) => replaceRequired(notice, from, to),
      coordinated.get("THIRD_PARTY_NOTICES.md"),
    ),
  );

  assert.deepEqual(collectReleaseConsistencyErrors(coordinated), []);
  assert.equal(
    coordinated.get(".github/workflows/release.yml"),
    files.get(".github/workflows/release.yml"),
  );
});

test("rejects stale README release URLs while allowing historical prose", () => {
  const oldTag = ["v0", "1", "3"].join(".");
  const oldReleaseUrl = `https://github.com/LycaonLLC/t4-code/releases/tag/${oldTag}`;
  const staleLink = changed("README.md", (text) => `${text}\n[Old release](${oldReleaseUrl})\n`);
  assert.ok(
    collectReleaseConsistencyErrors(staleLink).some((error) =>
      error.includes("release URL for v0.1.3; expected v0.1.31"),
    ),
  );
  assert.deepEqual(collectReleaseConsistencyErrors(files), []);
});

test("deploys release site source only after artifact publication", () => {
  const ciWorkflow = files.get(".github/workflows/ci.yml");
  const releaseWorkflow = files.get(".github/workflows/release.yml");
  const deployWorkflow = files.get(".github/workflows/deploy-site.yml");

  assert.ok(ciWorkflow.includes("android-debug:"));
  assert.ok(ciWorkflow.includes("core:"));
  assert.ok(ciWorkflow.includes("legacy-bridge-continuity:"));
  assert.ok(ciWorkflow.includes("current-bridge-continuity:"));
  assert.ok(ciWorkflow.includes("ref: ${{ github.event.pull_request.head.sha || github.sha }}"));
  assert.ok(
    ciWorkflow.includes(
      `source_repository="$(jq -er '.verifiedRuntime.sourceRepository' compat/omp-app-matrix.json)"`,
    ),
  );
  assert.ok(
    ciWorkflow.includes('test "$source_repository" = "https://github.com/wolfiesch/oh-my-pi"'),
  );
  assert.ok(
    ciWorkflow.includes("sha=\"$(jq -er '.inputs.operationsContinuity' provenance/omp-host-migration.json)\""),
  );
  assert.ok(ciWorkflow.includes('[[ "$sha" =~ ^[0-9a-f]{40}$ ]]'));
  assert.ok(ciWorkflow.includes('echo "repository=wolfiesch/oh-my-pi" >> "$GITHUB_OUTPUT"'));
  assert.ok(ciWorkflow.includes("repository: ${{ steps.authority.outputs.repository }}"));
  assert.ok(ciWorkflow.includes("ref: ${{ steps.authority.outputs.sha }}"));
  assert.ok(ciWorkflow.includes("T4_OMP_SOURCE_DIR: ${{ github.workspace }}/.continuity/omp"));
  assert.ok(ciWorkflow.includes("run: pnpm test:legacy-bridge-continuity"));
  assert.ok(ciWorkflow.includes("path: artifacts/legacy-bridge-continuity/"));
  assert.ok(
    ciWorkflow.includes("sha=\"$(jq -er '.verifiedRuntime.sourceCommit' compat/omp-app-matrix.json)\""),
  );
  assert.ok(
    ciWorkflow.includes("T4_CURRENT_OMP_SOURCE_DIR: ${{ github.workspace }}/.current-continuity/omp"),
  );
  assert.ok(
    ciWorkflow.includes("run: pnpm --filter @t4-code/host-service verify:current-omp-bridge"),
  );
  assert.ok(ciWorkflow.includes("path: artifacts/current-omp-bridge/"));
  assert.ok(ciWorkflow.includes("if-no-files-found: error"));
  assert.ok(ciWorkflow.includes("tooling:"));
  assert.ok(ciWorkflow.includes("cluster:"));
  assert.ok(ciWorkflow.includes("actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16"));
  assert.ok(ciWorkflow.includes("run: pnpm test:cluster:ci"));
  assert.ok(ciWorkflow.includes("run: go test ./..."));
  assert.ok(ciWorkflow.includes("run: helm lint deploy/charts/t4-cluster"));
  assert.ok(ciWorkflow.includes("name: verify"));
  assert.ok(ciWorkflow.includes("if: ${{ always() }}"));
  assert.ok(
    ciWorkflow.includes(
      "needs: [changes, t4-api-generation, core, legacy-bridge-continuity, current-bridge-continuity, official-omp-gate0, cluster, tooling, android-debug]",
    ),
  );
  assert.ok(ciWorkflow.includes('test "$CHANGES_RESULT" = success'));
  assert.ok(ciWorkflow.includes('test "$T4_API_GENERATION_RESULT" = success'));
  assert.ok(ciWorkflow.includes('test "$CORE_RESULT" = success'));
  assert.ok(
    ciWorkflow.includes("CURRENT_CONTINUITY_RESULT: ${{ needs.current-bridge-continuity.result }}"),
  );
  assert.ok(ciWorkflow.includes('"$CURRENT_CONTINUITY_RESULT" \\'));
  assert.ok(ciWorkflow.includes("for result in \\"));
  assert.ok(ciWorkflow.includes("success|skipped) ;;"));
  assert.ok(ciWorkflow.includes("github.event_name == 'pull_request' && github.ref || github.sha"));
  assert.ok(ciWorkflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
  assert.ok(ciWorkflow.includes('java-version: "21"'));
  assert.ok(
    ciWorkflow.includes('sdkmanager --install "platforms;android-36" "build-tools;36.0.0"'),
  );
  assert.ok(ciWorkflow.includes("pnpm --filter @t4-code/mobile check:android:debug"));
  assert.ok(!ciWorkflow.includes("T4_ANDROID_KEYSTORE_BASE64"));
  assert.equal(
    JSON.parse(files.get("apps/mobile/package.json")).scripts["check:android:debug"],
    "pnpm sync:android && node ./scripts/run-gradle.mjs testDebugUnitTest assembleDebug lintDebug",
  );

  assert.ok(releaseWorkflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(releaseWorkflow.includes("Check out trusted release-control source"));
  assert.ok(releaseWorkflow.includes("fetch-depth: 0"));
  assert.ok(releaseWorkflow.includes("Resolve immutable release source"));
  assert.ok(releaseWorkflow.includes('expected_tag="v${tag_version}"'));
  assert.ok(
    releaseWorkflow.includes(
      '[[ "$EVENT_NAME" == "push" && "$TRUSTED_CONTROL_SHA" != "$source_sha" ]]',
    ),
  );
  assert.ok(!releaseWorkflow.includes("trusted_version="));
  assert.ok(
    releaseWorkflow.includes('git merge-base --is-ancestor "$source_sha" refs/remotes/origin/main'),
  );
  assert.ok(releaseWorkflow.includes("ref: ${{ steps.source.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("ref: ${{ needs.verify.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("ci-authority:"));
  assert.ok(releaseWorkflow.includes("actions: read"));
  assert.ok(releaseWorkflow.includes("node scripts/wait-for-exact-ci.mjs"));
  assert.ok(releaseWorkflow.includes('--commit "$SOURCE_SHA"'));
  assert.ok(releaseWorkflow.includes("timeout-minutes: 50"));
  assert.ok(releaseWorkflow.includes("--timeout-ms 2700000"));
  const ciAuthority = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  ci-authority:"),
    releaseWorkflow.indexOf("  build-linux:"),
  );
  assert.ok(ciAuthority.includes("ref: ${{ github.sha }}"));
  assert.ok(!ciAuthority.includes("ref: ${{ needs.verify.outputs.source_sha }}"));
  assert.ok(
    releaseWorkflow.includes(
      "needs: [verify, ci-authority, build-android, build-linux, build-macos]",
    ),
  );
  const releaseVerify = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  verify:"),
    releaseWorkflow.indexOf("  ci-authority:"),
  );
  for (const duplicate of [
    "pnpm install",
    "pnpm check",
    "pnpm test",
    "pnpm build",
    "playwright install",
  ]) {
    assert.ok(!releaseVerify.includes(duplicate));
  }
  assert.ok(releaseWorkflow.includes("pnpm --filter @t4-code/mobile build:android:release"));
  assert.ok(releaseWorkflow.includes("T4_ANDROID_KEYSTORE_BASE64"));
  assert.ok(releaseWorkflow.includes("node scripts/inspect-android-release.mjs"));
  assert.ok(releaseWorkflow.includes('--metadata "$metadata"'));
  assert.ok(releaseWorkflow.includes('--aapt "$build_tools/aapt"'));
  assert.ok(releaseWorkflow.includes('--apksigner "$build_tools/apksigner"'));
  assert.ok(
    releaseWorkflow.includes("Confirm the release tag still resolves to the verified source"),
  );
  assert.ok(
    releaseWorkflow.includes('test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"'),
  );
  assert.ok(!releaseWorkflow.includes("ref: ${{ env.RELEASE_TAG }}"));
  assert.ok(
    releaseWorkflow.includes(
      "Preserve an exact release or prepare an incomplete release for repair",
    ),
  );
  assert.ok(releaseWorkflow.includes("Verify the exact remote release bundle"));
  assert.ok(
    releaseWorkflow.indexOf("--mode prepare") <
      releaseWorkflow.indexOf("softprops/action-gh-release@"),
  );
  assert.ok(
    releaseWorkflow.includes("if: steps.release-assets.outputs.publish_required == 'true'"),
  );
  assert.ok(
    releaseWorkflow.indexOf("softprops/action-gh-release@") <
      releaseWorkflow.indexOf("--mode verify"),
  );
  assert.ok(releaseWorkflow.includes("needs: [verify, publish]"));
  assert.ok(releaseWorkflow.includes("actions: write"));
  assert.ok(releaseWorkflow.includes("node scripts/dispatch-site-deployment.mjs"));
  assert.ok(releaseWorkflow.includes('--tag "$RELEASE_TAG"'));
  assert.ok(releaseWorkflow.includes('--commit "$SOURCE_SHA"'));
  assert.ok(!releaseWorkflow.includes("gh workflow run deploy-site.yml"));
  const dispatchSite = releaseWorkflow.slice(releaseWorkflow.indexOf("  dispatch-site:"));
  assert.ok(dispatchSite.includes("ref: ${{ github.sha }}"));
  assert.ok(!dispatchSite.includes("ref: ${{ needs.verify.outputs.source_sha }}"));
  assert.ok(!releaseWorkflow.includes("--ref main"));

  const exactCiWaiter = files.get("scripts/wait-for-exact-ci.mjs");
  assert.ok(exactCiWaiter.includes('WORKFLOW = "ci.yml"'));
  assert.ok(exactCiWaiter.includes('WORKFLOW_NAME = "CI"'));
  assert.ok(exactCiWaiter.includes('WORKFLOW_PATH = ".github/workflows/ci.yml"'));
  assert.ok(exactCiWaiter.includes('MAIN_BRANCH = "main"'));
  assert.ok(exactCiWaiter.includes("run.head_sha === commit"));
  assert.ok(exactCiWaiter.includes('run.event === "push"'));
  assert.ok(exactCiWaiter.includes("run.head_branch === MAIN_BRANCH"));
  assert.ok(exactCiWaiter.includes('status === "completed" && conclusion === "success"'));

  assert.ok(deployWorkflow.includes("workflow_dispatch:"));
  assert.ok(deployWorkflow.includes("release_tag:"));
  assert.ok(deployWorkflow.includes("dispatch_nonce:"));
  assert.ok(deployWorkflow.includes("inputs.dispatch_nonce || github.sha"));
  assert.ok(deployWorkflow.includes("startsWith(github.ref, 'refs/tags/')"));
  assert.ok(deployWorkflow.includes('[[ "$GITHUB_REF" != "refs/tags/${expected_tag}" ]]'));
  assert.ok(deployWorkflow.includes('expected_tag="v${TRUSTED_VERSION}"'));
  assert.ok(deployWorkflow.includes('release_tag="$expected_tag"'));
  assert.ok(deployWorkflow.includes("releases/tags/${release_tag}"));
  assert.ok(deployWorkflow.includes('[[ "$source_sha" != "$TRUSTED_SHA" ]]'));
  assert.ok(deployWorkflow.includes('git merge-base --is-ancestor "$source_sha" "$TRUSTED_SHA"'));
  assert.ok(deployWorkflow.includes("ref: ${{ steps.immutable_source.outputs.source_sha }}"));
  assert.ok(!deployWorkflow.includes('source_sha="$MAIN_SHA"'));
  assert.ok(!deployWorkflow.includes("cache: pnpm"));
  assert.ok(
    deployWorkflow.indexOf("Resolve immutable deployment source") >
      deployWorkflow.indexOf("Classify the stable release referenced by an ordinary main push"),
  );
  assert.ok(!deployWorkflow.includes("source_ref:"));
  assert.ok(!deployWorkflow.includes("release_published:"));
  assert.ok(deployWorkflow.includes("steps.release_state.outputs.state == 'not-published'"));
  assert.ok(!deployWorkflow.includes("continue-on-error: true"));
  assert.ok(deployWorkflow.includes("branches: [main, master]"));
});
