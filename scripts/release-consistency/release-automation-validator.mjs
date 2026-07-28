import { requireText } from "./shared.mjs";

export function validateReleaseAutomation(context) {
  const { errors, files } = context;
  const releaseWorkflow = files.get(".github/workflows/release.yml") ?? "";
  requireText(
    releaseWorkflow,
    'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    "body_path: docs/CURRENT_RELEASE_NOTES.md",
    ".github/workflows/release.yml",
    errors,
  );
  for (const expected of [
    "github.ref == 'refs/heads/main'",
    "Check out trusted release-control source",
    "Resolve immutable release source",
    'git merge-base --is-ancestor "$source_sha" refs/remotes/origin/main',
    "ref: ${{ steps.source.outputs.source_sha }}",
    "ref: ${{ needs.verify.outputs.source_sha }}",
    "ci-authority:",
    "actions: read",
    "Require successful exact-SHA main CI",
    "node scripts/wait-for-exact-ci.mjs",
    '--commit "$SOURCE_SHA"',
    "Confirm the release tag still resolves to the verified source",
    'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"',
    "build-android:",
    "T4_ANDROID_KEYSTORE_BASE64",
    "T4_ANDROID_KEYSTORE_PASSWORD",
    "T4_ANDROID_KEY_ALIAS",
    "T4_ANDROID_KEY_PASSWORD",
    "pnpm --filter @t4-code/mobile build:android:release",
    "node scripts/inspect-android-release.mjs",
    "node scripts/inspect-linux-update.mjs",
    "node scripts/inspect-macos-update.mjs",
    '--metadata "$metadata"',
    '--aapt "$build_tools/aapt"',
    '--apksigner "$build_tools/apksigner"',
    "Omperator-${VERSION}-android.apk",
    "artifacts/latest-linux.yml",
    "artifacts/latest-mac.yml",
    "artifacts/Omperator-*.zip.blockmap",
    "needs: [verify, ci-authority, build-android, build-linux, build-macos]",
    'node scripts/reconcile-release-assets.mjs --mode prepare --version "$VERSION"',
    'node scripts/reconcile-release-assets.mjs --mode verify --version "$VERSION"',
    "needs: [verify, publish]",
    "node scripts/dispatch-site-deployment.mjs",
    '--tag "$RELEASE_TAG"',
    '--commit "$SOURCE_SHA"',
  ]) {
    requireText(releaseWorkflow, expected, ".github/workflows/release.yml", errors);
  }
  const releaseVerifyStart = releaseWorkflow.indexOf("  verify:");
  const releaseAuthorityStart = releaseWorkflow.indexOf("  ci-authority:");
  if (!(releaseVerifyStart >= 0 && releaseAuthorityStart > releaseVerifyStart)) {
    errors.push(".github/workflows/release.yml must resolve release source before CI authority");
  } else {
    const releaseVerify = releaseWorkflow.slice(releaseVerifyStart, releaseAuthorityStart);
    requireText(
      releaseVerify,
      "pnpm install --frozen-lockfile",
      ".github/workflows/release.yml source verification",
      errors,
    );
    for (const duplicate of [
      "pnpm check",
      "pnpm test",
      "pnpm build",
      "playwright install",
    ]) {
      if (releaseVerify.includes(duplicate)) {
        errors.push(
          `.github/workflows/release.yml source verification must not repeat exact-SHA CI via ${duplicate}`,
        );
      }
    }
  }
  const releaseLinuxStart = releaseWorkflow.indexOf("  build-linux:");
  const releaseAndroidStart = releaseWorkflow.indexOf("  build-android:");
  const releaseMacosStart = releaseWorkflow.indexOf("  build-macos:");
  const releasePublishStart = releaseWorkflow.indexOf("  publish:");
  for (const [jobName, start, end] of [
    ["build-linux", releaseLinuxStart, releaseAndroidStart],
    ["build-macos", releaseMacosStart, releasePublishStart],
  ]) {
    if (!(start >= 0 && end > start)) {
      errors.push(`.github/workflows/release.yml must define ${jobName} before its next job`);
      continue;
    }
    const releaseBuild = releaseWorkflow.slice(start, end);
    requireText(
      releaseBuild,
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      `.github/workflows/release.yml ${jobName}`,
      errors,
    );
    requireText(
      releaseBuild,
      "bun-version: 1.3.14",
      `.github/workflows/release.yml ${jobName}`,
      errors,
    );
  }
  const releaseSiteStart = releaseWorkflow.indexOf("  dispatch-site:");
  if (!(releasePublishStart >= 0 && releaseSiteStart > releasePublishStart)) {
    errors.push(".github/workflows/release.yml must define publish before site handoff");
  } else {
    const releasePublish = releaseWorkflow.slice(releasePublishStart, releaseSiteStart);
    requireText(
      releasePublish,
      "pnpm install --frozen-lockfile",
      ".github/workflows/release.yml publish",
      errors,
    );
    if (
      releasePublish.indexOf("pnpm install --frozen-lockfile") >
      releasePublish.indexOf("node scripts/reconcile-release-assets.mjs")
    ) {
      errors.push(
        ".github/workflows/release.yml publish must install dependencies before release reconciliation",
      );
    }
  }
  const exactCiWaiter = files.get("scripts/wait-for-exact-ci.mjs") ?? "";
  for (const expected of [
    'WORKFLOW = "ci.yml"',
    'WORKFLOW_NAME = "CI"',
    'WORKFLOW_PATH = ".github/workflows/ci.yml"',
    'MAIN_BRANCH = "main"',
    "run.head_sha === commit",
    'run.event === "push"',
    "run.head_branch === MAIN_BRANCH",
    'status === "completed" && conclusion === "success"',
    "readBoundedResponseBytes",
  ]) {
    requireText(exactCiWaiter, expected, "scripts/wait-for-exact-ci.mjs", errors);
  }
  const builderConfig = files.get("electron-builder.config.mjs") ?? "";
  for (const expected of [
    'provider: "github"',
    'owner: "wolfiesch"',
    'repo: "omperator"',
    'channel: "latest"',
    "publish: [desktopUpdatePublish]",
  ]) {
    requireText(builderConfig, expected, "electron-builder.config.mjs", errors);
  }
  const manifestGenerator = files.get("scripts/generate-release-manifest.mjs") ?? "";
  for (const expected of [
    "RELEASE_MANIFEST_SCHEMA_VERSION = 1",
    'LINUX_UPDATE_METADATA_NAME = "latest-linux.yml"',
    'MAC_UPDATE_METADATA_NAME = "latest-mac.yml"',
    'channel: "stable"',
    "validateLinuxUpdateMetadata",
    "readBoundedResponseBytes",
  ]) {
    requireText(manifestGenerator, expected, "scripts/generate-release-manifest.mjs", errors);
  }
  requireText(
    files.get("scripts/deploy-site.mjs") ?? "",
    '"apps/site/dist/releases/latest.json"',
    "scripts/deploy-site.mjs",
    errors,
  );
  const releasePreparation = releaseWorkflow.indexOf("--mode prepare");
  const releaseUpload = releaseWorkflow.indexOf("softprops/action-gh-release@");
  const releaseRemoteVerification = releaseWorkflow.indexOf("--mode verify");
  if (
    !(
      releasePreparation >= 0 &&
      releasePreparation < releaseUpload &&
      releaseUpload < releaseRemoteVerification
    )
  ) {
    errors.push(
      ".github/workflows/release.yml must preserve or prepare remote assets before conditional upload and verify the exact remote bundle afterward",
    );
  }
  requireText(
    files.get("scripts/wait-for-release-assets.mjs") ?? "",
    '"latest-linux.yml"',
    "scripts/wait-for-release-assets.mjs",
    errors,
  );
  requireText(
    files.get("scripts/wait-for-release-assets.mjs") ?? "",
    '"latest-mac.yml"',
    "scripts/wait-for-release-assets.mjs",
    errors,
  );
  for (const expected of [
    "classifyStableReleasePublication",
    "response.status === 404",
    "response.status !== 200",
    "readBoundedResponseBytes",
    'state: "not-published"',
  ]) {
    requireText(
      files.get("scripts/check-release-publication.mjs") ?? "",
      expected,
      "scripts/check-release-publication.mjs",
      errors,
    );
  }
  for (const expected of [
    "prepareExistingReleaseAssets",
    'state: "ready"',
    "publishRequired: false",
    "verifyExactPublishedReleaseAssets",
    "expectedPublishedAssetNames",
    'method: "DELETE"',
    'asset.state !== "uploaded"',
    "asset.browser_download_url !== expectedUrl",
  ]) {
    requireText(
      files.get("scripts/reconcile-release-assets.mjs") ?? "",
      expected,
      "scripts/reconcile-release-assets.mjs",
      errors,
    );
  }
  for (const expected of [
    "dispatchAndWaitForSiteDeployment",
    "body: { ref: tag, inputs: { release_tag: tag, dispatch_nonce: dispatchNonce } }",
    "run.head_branch === tag",
    "run.head_sha === commit",
    "run.display_title === `Deploy project site ${tag} ${dispatchNonce}`",
    'exact.conclusion !== "success"',
  ]) {
    requireText(
      files.get("scripts/dispatch-site-deployment.mjs") ?? "",
      expected,
      "scripts/dispatch-site-deployment.mjs",
      errors,
    );
  }
  if (releaseWorkflow.includes("ref: ${{ env.RELEASE_TAG }}")) {
    errors.push(
      ".github/workflows/release.yml must build from the verified immutable source SHA, not env.RELEASE_TAG",
    );
  }
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'node scripts/wait-for-release-assets.mjs --version "$RELEASE_VERSION" --timeout-ms 2400000 --interval-ms 15000',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'node scripts/check-release-publication.mjs --version "$RELEASE_VERSION" --github-output "$GITHUB_OUTPUT"',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "steps.release_state.outputs.state == 'not-published'",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "releases/tags/${release_tag}",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  for (const expected of [
    "run-name: Deploy project site ${{ inputs.release_tag || github.ref_name }} ${{ inputs.dispatch_nonce || github.sha }}",
    "startsWith(github.ref, 'refs/tags/')",
    "dispatch_nonce:",
    '[[ "$GITHUB_REF" != "refs/tags/${expected_tag}" ]]',
    '[[ "$source_sha" != "$TRUSTED_SHA" ]]',
    'git merge-base --is-ancestor "$source_sha" "$TRUSTED_SHA"',
  ]) {
    requireText(
      files.get(".github/workflows/deploy-site.yml") ?? "",
      expected,
      ".github/workflows/deploy-site.yml",
      errors,
    );
  }
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "ref: ${{ steps.immutable_source.outputs.source_sha }}",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'release_tag="$expected_tag"',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  if ((files.get(".github/workflows/deploy-site.yml") ?? "").includes('source_sha="$MAIN_SHA"')) {
    errors.push(
      ".github/workflows/deploy-site.yml must deploy the published release tag, not a same-version main SHA",
    );
  }
  if ((files.get(".github/workflows/deploy-site.yml") ?? "").includes("cache: pnpm")) {
    errors.push(
      ".github/workflows/deploy-site.yml must not save a pnpm cache on the no-install release-defer path",
    );
  }
  if ((files.get(".github/workflows/deploy-site.yml") ?? "").includes("continue-on-error: true")) {
    errors.push(
      ".github/workflows/deploy-site.yml must fail on release lookup and validation errors",
    );
  }
  const releaseGate = files.get("docs/RELEASE_GATE.md") ?? "";
  for (const expected of [
    "`testDebugUnitTest`, `assembleDebug`, and `lintDebug`",
    "pinned Developer ID certificate",
    "exact nine-asset GitHub bundle",
    "defers only when the exact GitHub release lookup returns HTTP 404",
    "writes `/releases/latest.json`",
    "immutable release tag",
    "waits for that exact deployment run",
  ]) {
    requireText(releaseGate, expected, "docs/RELEASE_GATE.md", errors);
  }
  const maintainerReadme = files.get("ops/t4-maintainer/README.md") ?? "";
  for (const expected of [
    "exact nine-asset bundle",
    "whose six entries cover the packages and Linux updater metadata",
    "https://t4code.net/releases/latest.json",
    "downloads the live `latest-linux.yml`, deb, and AppImage",
    "actual byte sizes and SHA-512",
  ]) {
    requireText(maintainerReadme, expected, "ops/t4-maintainer/README.md", errors);
  }
}
