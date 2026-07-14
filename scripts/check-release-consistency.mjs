import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_CONTRACT_PATHS = [
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/workflows/deploy-site.yml",
  ".github/workflows/release.yml",
  "README.md",
  "SECURITY.md",
  "apps/desktop/src/target-manager.ts",
  "apps/site/src/docs/content.ts",
  "apps/site/src/release.ts",
  "apps/web/src/platform/browser-shell-port.ts",
  "compat/omp-app-matrix.json",
  "packages/client/src/omp-client-frames.ts",
];

const REPOSITORY_URL = "https://github.com/LycaonLLC/t4-code";
const APP_WIRE_VERSION = "0.5.2";
const APP_WIRE_SOURCE_COMMIT = "5d4315eea317260fec030e2b4726f10fed0cd5f6";
const APP_WIRE_SOURCE_TREE = "713688e8099d4553a0a30b1bf415a7cffb5963f4";
const OMP_RUNTIME_VERSION = "16.5.0";
const OMP_RUNTIME_COMMIT = "d4a0b9344e1796c0e56041cfeea3431a8a728e61";
const OMP_RUNTIME_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
const OMP_RUNTIME_COMMIT_URL = `${OMP_RUNTIME_REPOSITORY}/commit/${OMP_RUNTIME_COMMIT}`;
const OMP_RUNTIME_SOURCE_TAG = "t4code-16.5.0-appserver-3";
const OMP_RUNTIME_SOURCE_URL = `${OMP_RUNTIME_REPOSITORY}/tree/${OMP_RUNTIME_SOURCE_TAG}`;
const OMP_UPSTREAM_REPOSITORY = "https://github.com/can1357/oh-my-pi";
const OMP_UPSTREAM_TAG = "v16.5.0";
const OMP_UPSTREAM_COMMIT = "3047c27c332c5629c8e063283d349384c10c9a56";
const OMP_UPSTREAM_TAG_URL = `${OMP_UPSTREAM_REPOSITORY}/tree/${OMP_UPSTREAM_TAG}`;
const OMP_UPSTREAM_COMMIT_URL = `${OMP_UPSTREAM_REPOSITORY}/commit/${OMP_UPSTREAM_COMMIT}`;
const OMP_INTEGRATION_PATCHES = [
  "bounded-growing-session-replay",
  "complete-session-event-projection",
  "session-lifecycle-management",
  "ordered-remote-outbound-frames",
  "restart-safe-rpc-session-teardown",
  "catalog-advertised-session-management",
  "cross-client-control-state-convergence",
  "terminal-streaming-state-settlement",
];
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export function expectedReleaseAssetNames(version) {
  return [
    `T4-Code-${version}-android.apk`,
    `T4-Code-${version}-linux-amd64.deb`,
    `T4-Code-${version}-linux-x86_64.AppImage`,
    `T4-Code-${version}-mac-arm64.dmg`,
    `T4-Code-${version}-mac-arm64.zip`,
  ];
}

export function discoverReleasePackagePaths(repoRoot) {
  const paths = ["package.json"];
  for (const parent of ["apps", "packages"]) {
    const entries = readdirSync(resolve(repoRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) paths.push(`${parent}/${entry.name}/package.json`);
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

export function loadReleaseContractFiles(repoRoot) {
  const paths = [...new Set([...discoverReleasePackagePaths(repoRoot), ...RELEASE_CONTRACT_PATHS])];
  return new Map(
    paths.map((relativePath) => [
      relativePath,
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ]),
  );
}

function parseJson(files, path, errors) {
  try {
    return JSON.parse(files.get(path) ?? "");
  } catch (error) {
    errors.push(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function requireText(text, expected, path, errors) {
  if (!text.includes(expected)) errors.push(`${path} is missing ${JSON.stringify(expected)}`);
}

export function collectReleaseConsistencyErrors(files, releaseTag) {
  const errors = [];
  const rootManifest = parseJson(files, "package.json", errors);
  const version = rootManifest?.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push("package.json version must be a stable x.y.z release version");
    return errors;
  }
  const expectedTag = `v${version}`;

  const packagePaths = [...files.keys()]
    .filter(
      (path) => path === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path),
    )
    .sort((a, b) => a.localeCompare(b));
  for (const path of packagePaths) {
    const manifest = parseJson(files, path, errors);
    if (manifest && manifest.version !== version) {
      errors.push(`${path} version ${JSON.stringify(manifest.version)} does not match ${version}`);
    }
  }

  if (releaseTag !== undefined && releaseTag !== expectedTag) {
    errors.push(`release tag ${releaseTag} does not match ${expectedTag}`);
  }

  const matrix = parseJson(files, "compat/omp-app-matrix.json", errors);
  if (matrix?.desktop?.version !== version) {
    errors.push(`compat/omp-app-matrix.json desktop version must be ${version}`);
  }
  const appWire = matrix?.appWire;
  if (appWire?.version !== APP_WIRE_VERSION) {
    errors.push(`compat/omp-app-matrix.json app-wire version must be ${APP_WIRE_VERSION}`);
  }
  if (appWire?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`compat/omp-app-matrix.json app-wire repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (appWire?.sourceCommit !== APP_WIRE_SOURCE_COMMIT) {
    errors.push(`compat/omp-app-matrix.json app-wire commit must be ${APP_WIRE_SOURCE_COMMIT}`);
  }
  if (appWire?.sourceTreeHash !== APP_WIRE_SOURCE_TREE) {
    errors.push(`compat/omp-app-matrix.json app-wire source tree must be ${APP_WIRE_SOURCE_TREE}`);
  }
  const verifiedRuntime = matrix?.verifiedRuntime;
  if (verifiedRuntime?.package !== "omp") {
    errors.push("compat/omp-app-matrix.json verified runtime package must be omp");
  }
  if (verifiedRuntime?.version !== OMP_RUNTIME_VERSION) {
    errors.push(
      `compat/omp-app-matrix.json verified runtime version must be ${OMP_RUNTIME_VERSION}`,
    );
  }
  if (verifiedRuntime?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(
      `compat/omp-app-matrix.json verified runtime repository must be ${OMP_RUNTIME_REPOSITORY}`,
    );
  }
  if (verifiedRuntime?.sourceCommit !== OMP_RUNTIME_COMMIT) {
    errors.push(`compat/omp-app-matrix.json verified runtime commit must be ${OMP_RUNTIME_COMMIT}`);
  }
  if (verifiedRuntime?.sourceUrl !== OMP_RUNTIME_COMMIT_URL) {
    errors.push(
      `compat/omp-app-matrix.json verified runtime URL must be ${OMP_RUNTIME_COMMIT_URL}`,
    );
  }
  if (verifiedRuntime?.sourceTag !== OMP_RUNTIME_SOURCE_TAG) {
    errors.push(
      `compat/omp-app-matrix.json verified runtime tag must be ${OMP_RUNTIME_SOURCE_TAG}`,
    );
  }
  if (verifiedRuntime?.upstreamRepository !== OMP_UPSTREAM_REPOSITORY) {
    errors.push(
      `compat/omp-app-matrix.json upstream repository must be ${OMP_UPSTREAM_REPOSITORY}`,
    );
  }
  if (verifiedRuntime?.upstreamTag !== OMP_UPSTREAM_TAG) {
    errors.push(`compat/omp-app-matrix.json upstream tag must be ${OMP_UPSTREAM_TAG}`);
  }
  if (verifiedRuntime?.upstreamCommit !== OMP_UPSTREAM_COMMIT) {
    errors.push(`compat/omp-app-matrix.json upstream commit must be ${OMP_UPSTREAM_COMMIT}`);
  }
  if (
    !Array.isArray(verifiedRuntime?.integrationPatches) ||
    verifiedRuntime.integrationPatches.length !== OMP_INTEGRATION_PATCHES.length ||
    verifiedRuntime.integrationPatches.some(
      (patch, index) => patch !== OMP_INTEGRATION_PATCHES[index],
    )
  ) {
    errors.push(
      `compat/omp-app-matrix.json verified runtime integration patches must be ${OMP_INTEGRATION_PATCHES.join(", ")}`,
    );
  }
  if (verifiedRuntime?.upstreamTagContainsIntegrationPatches !== false) {
    errors.push(
      "compat/omp-app-matrix.json must record that stock upstream v16.5.0 lacks the integration patches",
    );
  }

  const site = files.get("apps/site/src/release.ts") ?? "";
  requireText(
    site,
    `export const RELEASE_TAG = "${expectedTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const RELEASE_VERSION = "${version}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_VERSION = "${OMP_RUNTIME_VERSION}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_COMMIT = "${OMP_RUNTIME_COMMIT}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_TAG = "${OMP_RUNTIME_SOURCE_TAG}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_TAG = "${OMP_UPSTREAM_TAG}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_COMMIT = "${OMP_UPSTREAM_COMMIT}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_UPSTREAM_URL = `${OMP_URL}/tree/${OMP_UPSTREAM_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_RUNTIME_URL = `https://github.com/lyc-aon/oh-my-pi/tree/${OMP_RUNTIME_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const APP_WIRE_VERSION = "${APP_WIRE_VERSION}";`,
    "apps/site/src/release.ts",
    errors,
  );
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(site, `"${filename}"`, "apps/site/src/release.ts", errors);
  }
  const siteAssetVersions = new Set(
    [...site.matchAll(/T4-Code-(\d+\.\d+\.\d+)-(?:android|linux|mac)(?:\.|-)/gu)].map(
      (match) => match[1],
    ),
  );
  for (const assetVersion of siteAssetVersions) {
    if (assetVersion !== version) {
      errors.push(
        `apps/site/src/release.ts contains an asset for ${assetVersion}; expected ${version}`,
      );
    }
  }

  const readme = files.get("README.md") ?? "";
  requireText(
    readme,
    `[**Download ${expectedTag}**](${REPOSITORY_URL}/releases/tag/${expectedTag})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `T4 Code ${expectedTag} was verified with OMP ${OMP_RUNTIME_VERSION} built from [\`${OMP_RUNTIME_COMMIT.slice(0, 8)}\`](${OMP_RUNTIME_COMMIT_URL}), tagged [\`${OMP_RUNTIME_SOURCE_TAG}\`](${OMP_RUNTIME_SOURCE_URL}).`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `official upstream [\`${OMP_UPSTREAM_TAG}\`](${OMP_UPSTREAM_TAG_URL}) tag at [\`${OMP_UPSTREAM_COMMIT.slice(0, 8)}\`](${OMP_UPSTREAM_COMMIT_URL})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    "The official upstream v16.5.0 tag has no `appserver` command, so it cannot host T4 Code.",
    "README.md",
    errors,
  );
  requireText(
    readme,
    `T4 Code vendors \`@oh-my-pi/app-wire\` ${APP_WIRE_VERSION} from integration commit [\`${APP_WIRE_SOURCE_COMMIT.slice(0, 8)}\`](${OMP_RUNTIME_REPOSITORY}/commit/${APP_WIRE_SOURCE_COMMIT}), source tree \`${APP_WIRE_SOURCE_TREE}\`.`,
    "README.md",
    errors,
  );
  requireText(readme, `## What changed in ${expectedTag}`, "README.md", errors);
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(
      readme,
      `${REPOSITORY_URL}/releases/download/${expectedTag}/${filename}`,
      "README.md",
      errors,
    );
  }
  const linkedReleaseTags = new Set(
    [
      ...readme.matchAll(
        /https:\/\/github\.com\/LycaonLLC\/t4-code\/releases\/(?:tag|download)\/(v\d+\.\d+\.\d+)/gu,
      ),
    ].map((match) => match[1]),
  );
  for (const linkedTag of linkedReleaseTags) {
    if (linkedTag !== expectedTag) {
      errors.push(`README.md contains a release URL for ${linkedTag}; expected ${expectedTag}`);
    }
  }

  requireText(
    files.get("SECURITY.md") ?? "",
    `The macOS ${expectedTag} build is unsigned and unnotarized`,
    "SECURITY.md",
    errors,
  );
  requireText(
    files.get(".github/ISSUE_TEMPLATE/bug_report.yml") ?? "",
    `placeholder: "${version}"`,
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    errors,
  );

  const runtimeVersions = [
    ["apps/desktop/src/target-manager.ts", `version: "${version}", build: "desktop"`],
    ["apps/web/src/platform/browser-shell-port.ts", `version: "${version}"`],
    ["packages/client/src/omp-client-frames.ts", `version: "${version}", build: "client"`],
  ];
  for (const [path, expected] of runtimeVersions) {
    requireText(files.get(path) ?? "", expected, path, errors);
  }

  const siteDocs = files.get("apps/site/src/docs/content.ts") ?? "";
  requireText(siteDocs, "OMP_RUNTIME_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_COMMIT", "apps/site/src/docs/content.ts", errors);
  requireText(
    siteDocs,
    "Official upstream OMP v${OMP_RUNTIME_VERSION} does not ship the \\`appserver\\` command, so it cannot host T4 Code.",
    "apps/site/src/docs/content.ts",
    errors,
  );
  requireText(
    siteDocs,
    'id: "troubleshooting-large-session"',
    "apps/site/src/docs/content.ts",
    errors,
  );

  const releaseWorkflow = files.get(".github/workflows/release.yml") ?? "";
  requireText(
    releaseWorkflow,
    'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    OMP_RUNTIME_COMMIT_URL,
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    OMP_RUNTIME_SOURCE_URL,
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    OMP_UPSTREAM_TAG_URL,
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    OMP_UPSTREAM_COMMIT_URL,
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    `This release vendors app-wire ${APP_WIRE_VERSION}`,
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    "Official upstream OMP v16.5.0 has no `appserver` command and cannot host T4 Code.",
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
    "Confirm the release tag still resolves to the verified source",
    'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"',
    "build-android:",
    "T4_ANDROID_KEYSTORE_BASE64",
    "T4_ANDROID_KEYSTORE_PASSWORD",
    "T4_ANDROID_KEY_ALIAS",
    "T4_ANDROID_KEY_PASSWORD",
    "pnpm --filter @t4-code/mobile build:android:release",
    "apksigner verify --verbose",
    "T4-Code-${VERSION}-android.apk",
    "needs: [verify, build-android, build-linux, build-macos]",
  ]) {
    requireText(releaseWorkflow, expected, ".github/workflows/release.yml", errors);
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
    "releases/tags/${release_tag}",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'git merge-base --is-ancestor "$source_sha" "$MAIN_SHA"',
    ".github/workflows/deploy-site.yml",
    errors,
  );
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
  return errors;
}

export function checkReleaseConsistency(repoRoot, releaseTag) {
  return collectReleaseConsistencyErrors(loadReleaseContractFiles(repoRoot), releaseTag);
}

function parseTagArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--tag" && args[1]) return args[1];
  throw new Error("usage: node scripts/check-release-consistency.mjs [--tag vX.Y.Z]");
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const errors = checkReleaseConsistency(process.cwd(), parseTagArgument(process.argv.slice(2)));
    if (errors.length > 0) {
      console.error(
        `Release consistency check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`,
      );
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      const version = JSON.parse(
        readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
      ).version;
      console.log(`Release consistency check passed for v${version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
