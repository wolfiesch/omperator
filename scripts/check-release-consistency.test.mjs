import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectReleaseConsistencyErrors,
  loadReleaseContractFiles,
} from "./check-release-consistency.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const files = loadReleaseContractFiles(repoRoot);

function changed(path, replace) {
  const copy = new Map(files);
  copy.set(path, replace(copy.get(path)));
  return copy;
}

test("current source tree has one consistent release version", () => {
  assert.deepEqual(collectReleaseConsistencyErrors(files, "v0.1.8"), []);
});

test("rejects a tag that differs from the package version", () => {
  assert.ok(
    collectReleaseConsistencyErrors(files, "v9.9.9").some((error) =>
      error.includes("release tag v9.9.9 does not match v0.1.8"),
    ),
  );
});

test("rejects workspace, site, README, and runtime version drift", () => {
  const cases = [
    ["apps/web/package.json", (text) => text.replace('"version": "0.1.8"', '"version": "0.1.3"')],
    ["apps/site/src/release.ts", (text) => text.replace('RELEASE_TAG = "v0.1.8"', 'RELEASE_TAG = "v0.1.3"')],
    ["README.md", (text) => text.replace("Download v0.1.8", "Download v0.1.3")],
    ["apps/desktop/src/target-manager.ts", (text) => text.replace('version: "0.1.8"', 'version: "0.1.3"')],
    ["apps/site/src/docs/content.ts", (text) => text.replace('id: "troubleshooting-large-session"', 'id: "missing-large-session"')],
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

test("rejects app-wire version drift inside a desktop release", () => {
  const drifted = changed("compat/omp-app-matrix.json", (text) =>
    text.replace('"version": "0.5.2"', '"version": "0.5.1"'),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) => error.includes("must be 0.5.2")),
  );
});

test("rejects drift in frozen app-wire source provenance", () => {
  const drifted = changed("compat/omp-app-matrix.json", (text) =>
    text.replace(
      '"sourceCommit": "5d4315eea317260fec030e2b4726f10fed0cd5f6"',
      '"sourceCommit": "0000000000000000000000000000000000000000"',
    ),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) => error.includes("app-wire commit")),
  );
});

test("rejects drift in verified OMP runtime provenance", () => {
  const cases = [
    (text) => text.replace(
      "d4a0b9344e1796c0e56041cfeea3431a8a728e61",
      "0000000000000000000000000000000000000000",
    ),
    (text) => text.replace(
      '"sourceTag": "t4code-16.5.0-appserver-3"',
      '"sourceTag": "wrong-tag"',
    ),
    (text) => text.replace(
      '"upstreamCommit": "3047c27c332c5629c8e063283d349384c10c9a56"',
      '"upstreamCommit": "0000000000000000000000000000000000000000"',
    ),
    (text) => text.replace(
      '"complete-session-event-projection"',
      '"wrong-integration-patch"',
    ),
    (text) => text.replace(
      '"upstreamTagContainsIntegrationPatches": false',
      '"upstreamTagContainsIntegrationPatches": true',
    ),
  ];
  for (const replace of cases) {
    const drifted = changed("compat/omp-app-matrix.json", replace);
    assert.ok(
      collectReleaseConsistencyErrors(drifted).some(
        (error) =>
          error.includes("app-wire") ||
          error.includes("verified runtime") ||
          error.includes("upstream") ||
          error.includes("stock upstream"),
      ),
    );
  }
});

test("rejects stale README release URLs while allowing historical prose", () => {
  const oldTag = ["v0", "1", "3"].join(".");
  const oldReleaseUrl = `https://github.com/LycaonLLC/t4-code/releases/tag/${oldTag}`;
  const staleLink = changed("README.md", (text) =>
    `${text}\n[Old release](${oldReleaseUrl})\n`,
  );
  assert.ok(
    collectReleaseConsistencyErrors(staleLink).some((error) =>
      error.includes("release URL for v0.1.3; expected v0.1.8"),
    ),
  );
  assert.deepEqual(collectReleaseConsistencyErrors(files), []);
});

test("deploys release site source only after artifact publication", () => {
  const releaseWorkflow = files.get(".github/workflows/release.yml");
  const deployWorkflow = files.get(".github/workflows/deploy-site.yml");

  assert.ok(releaseWorkflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(releaseWorkflow.includes("Check out trusted release-control source"));
  assert.ok(releaseWorkflow.includes("fetch-depth: 0"));
  assert.ok(releaseWorkflow.includes("Resolve immutable release source"));
  assert.ok(
    releaseWorkflow.includes(
      'git merge-base --is-ancestor "$source_sha" refs/remotes/origin/main',
    ),
  );
  assert.ok(releaseWorkflow.includes("ref: ${{ steps.source.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("ref: ${{ needs.verify.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("needs: [verify, build-linux, build-macos]"));
  assert.ok(
    releaseWorkflow.includes("Confirm the release tag still resolves to the verified source"),
  );
  assert.ok(
    releaseWorkflow.includes(
      'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"',
    ),
  );
  assert.ok(!releaseWorkflow.includes("ref: ${{ env.RELEASE_TAG }}"));
  assert.ok(releaseWorkflow.includes("Dispatch site deployment after release publication"));
  assert.ok(releaseWorkflow.includes("needs: publish"));
  assert.ok(releaseWorkflow.includes("actions: write"));
  assert.ok(releaseWorkflow.includes("GH_REPO: ${{ github.repository }}"));
  assert.ok(releaseWorkflow.includes("gh workflow run deploy-site.yml"));
  assert.ok(releaseWorkflow.includes("--ref main"));
  assert.ok(releaseWorkflow.includes('-f release_tag="$RELEASE_TAG"'));

  assert.ok(deployWorkflow.includes("workflow_dispatch:"));
  assert.ok(deployWorkflow.includes("release_tag:"));
  assert.ok(deployWorkflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(deployWorkflow.includes('expected_tag="v${TRUSTED_VERSION}"'));
  assert.ok(deployWorkflow.includes('release_tag="$expected_tag"'));
  assert.ok(deployWorkflow.includes("releases/tags/${release_tag}"));
  assert.ok(deployWorkflow.includes('git merge-base --is-ancestor "$source_sha" "$MAIN_SHA"'));
  assert.ok(deployWorkflow.includes("ref: ${{ steps.immutable_source.outputs.source_sha }}"));
  assert.ok(!deployWorkflow.includes('source_sha="$MAIN_SHA"'));
  assert.ok(!deployWorkflow.includes("cache: pnpm"));
  assert.ok(
    deployWorkflow.indexOf("Resolve immutable deployment source") >
      deployWorkflow.indexOf("Check whether an ordinary main push references an existing release"),
  );
  assert.ok(!deployWorkflow.includes("source_ref:"));
  assert.ok(!deployWorkflow.includes("release_published:"));
  assert.ok(deployWorkflow.includes("steps.existing_release.outcome == 'failure'"));
  assert.ok(deployWorkflow.includes("branches: [main, master]"));
});
