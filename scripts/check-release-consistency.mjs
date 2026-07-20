import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

export const RELEASE_CONTRACT_PATHS = [
  ".github/android-release-identity.json",
  ".github/macos-release-identity.json",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-site.yml",
  ".github/workflows/release.yml",
  "electron-builder.config.mjs",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "apps/desktop/src/target-manager.ts",
  "apps/site/src/docs/content.ts",
  "apps/site/src/release.ts",
  "apps/web/src/platform/browser-shell-port.ts",
  "compat/omp-app-matrix.json",
  "docs/CURRENT_RELEASE_NOTES.md",
  "docs/MACOS_SIGNING.md",
  "docs/RELEASE_GATE.md",
  "ops/t4-maintainer/README.md",
  "packages/client/src/omp-client-frames.ts",
  "scripts/check-release-publication.mjs",
  "scripts/deploy-site.mjs",
  "scripts/dispatch-site-deployment.mjs",
  "scripts/generate-release-manifest.mjs",
  "scripts/inspect-linux-update.mjs",
  "scripts/read-bounded-response.mjs",
  "scripts/reconcile-release-assets.mjs",
  "scripts/wait-for-exact-ci.mjs",
  "scripts/wait-for-release-assets.mjs",
  "vendor/app-wire/manifest.json",
];

const REPOSITORY_URL = "https://github.com/LycaonLLC/t4-code";
const OMP_RUNTIME_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
const OMP_UPSTREAM_REPOSITORY = "https://github.com/can1357/oh-my-pi";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PATCH_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

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

function rejectDuplicateJsonKeys(source) {
  let offset = 0;

  function skipWhitespace() {
    while (offset < source.length && /\s/u.test(source[offset])) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (source[offset] !== '"') {
      if (source[offset] === "\\") offset += 1;
      offset += 1;
    }
    offset += 1;
    return JSON.parse(source.slice(start, offset));
  }

  function readValue() {
    skipWhitespace();
    if (source[offset] === "{") {
      readObject();
    } else if (source[offset] === "[") {
      readArray();
    } else if (source[offset] === '"') {
      readString();
    } else {
      while (offset < source.length && !/[,}\]]/u.test(source[offset])) offset += 1;
    }
  }

  function readObject() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }

    const keys = new Set();
    while (offset < source.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) throw new SyntaxError(`duplicated mapping key ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace();
      offset += 1;
      readValue();
      skipWhitespace();
      if (source[offset] === ",") {
        offset += 1;
        continue;
      }
      offset += 1;
      return;
    }
  }

  function readArray() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }

    while (offset < source.length) {
      readValue();
      skipWhitespace();
      if (source[offset] === ",") {
        offset += 1;
        continue;
      }
      offset += 1;
      return;
    }
  }

  readValue();
}

function parseJson(files, path, errors) {
  try {
    const source = files.get(path) ?? "";
    const parsed = JSON.parse(source);
    rejectDuplicateJsonKeys(source);
    return parsed;
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

function validateRuntimeMetadata(value, label, matrixPath, errors) {
  const version = value?.version;
  const sourceCommit = value?.sourceCommit;
  const sourceTag = value?.sourceTag;
  const upstreamTag = value?.upstreamTag;
  const upstreamCommit = value?.upstreamCommit;
  const sourceCommitUrl = `${OMP_RUNTIME_REPOSITORY}/commit/${sourceCommit ?? ""}`;
  const sourceTagUrl = `${OMP_RUNTIME_REPOSITORY}/tree/${sourceTag ?? ""}`;
  const upstreamTagUrl = `${OMP_UPSTREAM_REPOSITORY}/tree/${upstreamTag ?? ""}`;
  const upstreamCommitUrl = `${OMP_UPSTREAM_REPOSITORY}/commit/${upstreamCommit ?? ""}`;
  const prefix = `${matrixPath} ${label}`;

  if (value?.package !== "omp") {
    errors.push(`${prefix} package must be omp`);
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push(`${prefix} version must be a stable x.y.z version`);
  }
  if (value?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`${prefix} repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (typeof sourceCommit !== "string" || !SHA_PATTERN.test(sourceCommit)) {
    errors.push(`${prefix} commit must be a lowercase 40-character Git SHA`);
  }
  if (value?.sourceUrl !== sourceCommitUrl) {
    errors.push(`${prefix} URL must be ${sourceCommitUrl}`);
  }
  if (
    typeof version === "string" &&
    (typeof sourceTag !== "string" ||
      !new RegExp(`^t4code-${version.replaceAll(".", "\\.")}-appserver-[1-9]\\d*$`, "u").test(
        sourceTag,
      ))
  ) {
    errors.push(`${prefix} tag must identify the OMP version and appserver revision`);
  }
  if (value?.upstreamRepository !== OMP_UPSTREAM_REPOSITORY) {
    errors.push(`${prefix} upstream repository must be ${OMP_UPSTREAM_REPOSITORY}`);
  }
  if (typeof version === "string" && upstreamTag !== `v${version}`) {
    errors.push(`${prefix} upstream tag must be v${version}`);
  }
  if (typeof upstreamCommit !== "string" || !SHA_PATTERN.test(upstreamCommit)) {
    errors.push(`${prefix} upstream commit must be a lowercase 40-character Git SHA`);
  }
  const integrationPatches = value?.integrationPatches;
  if (
    !Array.isArray(integrationPatches) ||
    integrationPatches.length === 0 ||
    integrationPatches.some(
      (patch) => typeof patch !== "string" || !PATCH_NAME_PATTERN.test(patch),
    ) ||
    new Set(integrationPatches).size !== integrationPatches.length
  ) {
    errors.push(`${prefix} integration patches must be unique kebab-case names`);
  }
  if (value?.upstreamTagContainsIntegrationPatches !== false) {
    errors.push(`${prefix} must record that stock upstream lacks the integration patches`);
  }

  return Object.freeze({
    version,
    sourceCommit,
    sourceTag,
    upstreamTag,
    upstreamCommit,
    sourceCommitUrl,
    sourceTagUrl,
    upstreamTagUrl,
    upstreamCommitUrl,
  });
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

  const androidIdentityPath = ".github/android-release-identity.json";
  const androidIdentity = parseJson(files, androidIdentityPath, errors);
  if (androidIdentity?.schemaVersion !== 1) {
    errors.push(`${androidIdentityPath} schemaVersion must be 1`);
  }
  if (androidIdentity?.applicationId !== "com.lycaonsolutions.t4code") {
    errors.push(`${androidIdentityPath} applicationId must be com.lycaonsolutions.t4code`);
  }
  if (androidIdentity?.minSdkVersion !== 24) {
    errors.push(`${androidIdentityPath} minSdkVersion must be 24`);
  }
  if (androidIdentity?.targetSdkVersion !== 36) {
    errors.push(`${androidIdentityPath} targetSdkVersion must be 36`);
  }
  if (
    typeof androidIdentity?.signingCertificateSha256 !== "string" ||
    !SHA256_PATTERN.test(androidIdentity.signingCertificateSha256)
  ) {
    errors.push(`${androidIdentityPath} signing certificate must be a lowercase SHA-256 digest`);
  }
  if (
    typeof androidIdentity?.certificateBaseline?.assetSha256 !== "string" ||
    !SHA256_PATTERN.test(androidIdentity.certificateBaseline.assetSha256)
  ) {
    errors.push(
      `${androidIdentityPath} certificate baseline asset must have a lowercase SHA-256 digest`,
    );
  }

  const macosIdentityPath = ".github/macos-release-identity.json";
  const macosIdentity = parseJson(files, macosIdentityPath, errors);
  if (macosIdentity?.schemaVersion !== 1) {
    errors.push(`${macosIdentityPath} schemaVersion must be 1`);
  }
  if (macosIdentity?.bundleId !== "com.lycaonsolutions.t4code") {
    errors.push(`${macosIdentityPath} bundleId must be com.lycaonsolutions.t4code`);
  }
  if (!/^[A-Z0-9]{10}$/u.test(macosIdentity?.teamId ?? "")) {
    errors.push(`${macosIdentityPath} teamId must be 10 uppercase letters or digits`);
  }
  if (
    typeof macosIdentity?.certificateSha256 !== "string" ||
    !SHA256_PATTERN.test(macosIdentity.certificateSha256)
  ) {
    errors.push(`${macosIdentityPath} certificate must be a lowercase SHA-256 digest`);
  }
  if (macosIdentity?.certificateAuthority !== "Developer ID Certification Authority") {
    errors.push(`${macosIdentityPath} must pin the Developer ID Certification Authority`);
  }
  if (macosIdentity?.architecture !== "arm64") {
    errors.push(`${macosIdentityPath} architecture must be arm64`);
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(macosIdentity?.firstSignedReleaseTag ?? "")) {
    errors.push(`${macosIdentityPath} firstSignedReleaseTag must be vX.Y.Z`);
  }
  if (macosIdentity?.notarizationRequired !== true) {
    errors.push(`${macosIdentityPath} must require notarization`);
  }

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
  const mobileManifest = parseJson(files, "apps/mobile/package.json", errors);
  if (
    mobileManifest?.scripts?.["check:android:debug"] !==
    "pnpm sync:android && node ./scripts/run-gradle.mjs testDebugUnitTest assembleDebug lintDebug"
  ) {
    errors.push(
      "apps/mobile/package.json must run Android JVM tests, debug compilation, and lint in the pre-merge check",
    );
  }

  if (releaseTag !== undefined && releaseTag !== expectedTag) {
    errors.push(`release tag ${releaseTag} does not match ${expectedTag}`);
  }

  const matrixPath = "compat/omp-app-matrix.json";
  const matrix = parseJson(files, matrixPath, errors);
  if (matrix?.desktop?.version !== version) {
    errors.push(`${matrixPath} desktop version must be ${version}`);
  }

  // The compatibility matrix records both the current vendored contract and
  // immutable provenance for the published release surfaces.
  const appWire = matrix?.appWire;
  const appWireVersion = appWire?.version;
  const appWireSourceCommit = typeof appWire?.sourceCommit === "string" ? appWire.sourceCommit : "";
  const appWireSourceTree =
    typeof appWire?.sourceTreeHash === "string" ? appWire.sourceTreeHash : "";
  const publishedAppWire = matrix?.publishedAppWire;
  const publishedAppWireVersion = publishedAppWire?.version;
  const publishedAppWireSourceCommit =
    typeof publishedAppWire?.sourceCommit === "string" ? publishedAppWire.sourceCommit : "";
  const publishedAppWireSourceTree =
    typeof publishedAppWire?.sourceTreeHash === "string" ? publishedAppWire.sourceTreeHash : "";
  if (appWire?.package !== "@oh-my-pi/app-wire") {
    errors.push(`${matrixPath} app-wire package must be @oh-my-pi/app-wire`);
  }
  if (typeof appWireVersion !== "string" || !VERSION_PATTERN.test(appWireVersion)) {
    errors.push(`${matrixPath} app-wire version must be a stable x.y.z version`);
  }
  if (appWire?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`${matrixPath} app-wire repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (!SHA_PATTERN.test(appWireSourceCommit)) {
    errors.push(`${matrixPath} app-wire commit must be a lowercase 40-character Git SHA`);
  }
  if (!SHA_PATTERN.test(appWireSourceTree)) {
    errors.push(`${matrixPath} app-wire source tree must be a lowercase 40-character Git SHA`);
  }
  if (publishedAppWire?.package !== "@oh-my-pi/app-wire") {
    errors.push(`${matrixPath} published app-wire package must be @oh-my-pi/app-wire`);
  }
  if (
    typeof publishedAppWireVersion !== "string" ||
    !VERSION_PATTERN.test(publishedAppWireVersion)
  ) {
    errors.push(`${matrixPath} published app-wire version must be a stable x.y.z version`);
  }
  if (publishedAppWire?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`${matrixPath} published app-wire repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (!SHA_PATTERN.test(publishedAppWireSourceCommit)) {
    errors.push(`${matrixPath} published app-wire commit must be a lowercase 40-character Git SHA`);
  }
  if (!SHA_PATTERN.test(publishedAppWireSourceTree)) {
    errors.push(
      `${matrixPath} published app-wire source tree must be a lowercase 40-character Git SHA`,
    );
  }
  if (releaseTag !== undefined) {
    for (const [field, currentValue, publishedValue] of [
      ["package", appWire?.package, publishedAppWire?.package],
      ["version", appWireVersion, publishedAppWireVersion],
      ["repository", appWire?.sourceRepository, publishedAppWire?.sourceRepository],
      ["commit", appWireSourceCommit, publishedAppWireSourceCommit],
      ["source tree", appWireSourceTree, publishedAppWireSourceTree],
    ]) {
      if (publishedValue !== currentValue) {
        errors.push(
          `${matrixPath} published app-wire ${field} must match current app-wire for tagged releases`,
        );
      }
    }
  }
  if (
    typeof appWireVersion === "string" &&
    appWire?.tarball !== `vendor/app-wire/oh-my-pi-app-wire-${appWireVersion}.tgz`
  ) {
    errors.push(`${matrixPath} app-wire tarball path must match its version`);
  }
  if (typeof appWire?.tarballSha256 !== "string" || !SHA256_PATTERN.test(appWire.tarballSha256)) {
    errors.push(`${matrixPath} app-wire tarball SHA-256 must be 64 lowercase hex characters`);
  }
  if (
    typeof appWire?.goldenCorpusSha256 !== "string" ||
    !SHA256_PATTERN.test(appWire.goldenCorpusSha256)
  ) {
    errors.push(`${matrixPath} golden corpus SHA-256 must be 64 lowercase hex characters`);
  }

  const appWireManifestPath = "vendor/app-wire/manifest.json";
  const appWireManifest = parseJson(files, appWireManifestPath, errors);
  const expectedManifest = {
    package: appWire?.package,
    version: appWireVersion,
    sourceRepository: appWire?.sourceRepository,
    sourceCommit: appWireSourceCommit,
    sourceTreeHash: appWireSourceTree,
    tarball:
      typeof appWire?.tarball === "string"
        ? appWire.tarball.replace(/^vendor\/app-wire\//u, "")
        : undefined,
    tarballSha256: appWire?.tarballSha256,
    appProtocol: matrix?.appProtocol,
    goldenCorpusSha256: appWire?.goldenCorpusSha256,
  };
  for (const [field, expected] of Object.entries(expectedManifest)) {
    if (appWireManifest?.[field] !== expected) {
      errors.push(`${appWireManifestPath} ${field} must match ${matrixPath}`);
    }
  }
  const manifestCreatedAt = appWireManifest?.createdAt;
  if (
    typeof manifestCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifestCreatedAt)) ||
    new Date(manifestCreatedAt).toISOString().replace(".000Z", "Z") !== manifestCreatedAt
  ) {
    errors.push(`${appWireManifestPath} createdAt must be a canonical ISO timestamp`);
  }

  requireText(
    files.get("THIRD_PARTY_NOTICES.md") ?? "",
    `The vendored \`@oh-my-pi/app-wire@${appWireVersion}\` package is packed from the public \`lyc-aon/oh-my-pi\` integration commit \`${appWireSourceCommit}\`, source tree \`${appWireSourceTree}\`; tarball SHA-256 \`${appWire?.tarballSha256}\`; golden corpus SHA-256 \`${appWire?.goldenCorpusSha256}\`.`,
    "THIRD_PARTY_NOTICES.md",
    errors,
  );

  validateRuntimeMetadata(matrix?.verifiedRuntime, "verified runtime", matrixPath, errors);
  const publishedRuntime = validateRuntimeMetadata(
    matrix?.publishedRuntime,
    "published runtime",
    matrixPath,
    errors,
  );
  if (
    releaseTag !== undefined &&
    !isDeepStrictEqual(matrix?.publishedRuntime, matrix?.verifiedRuntime)
  ) {
    errors.push(
      `${matrixPath} published runtime must exactly match current verified runtime for tagged releases`,
    );
  }
  if (releaseTag !== undefined) {
    for (const [field, currentValue, publishedValue] of [
      ["package", matrix?.verifiedRuntime?.package, matrix?.publishedRuntime?.package],
      ["version", matrix?.verifiedRuntime?.version, matrix?.publishedRuntime?.version],
      [
        "repository",
        matrix?.verifiedRuntime?.sourceRepository,
        matrix?.publishedRuntime?.sourceRepository,
      ],
      ["commit", matrix?.verifiedRuntime?.sourceCommit, matrix?.publishedRuntime?.sourceCommit],
      ["URL", matrix?.verifiedRuntime?.sourceUrl, matrix?.publishedRuntime?.sourceUrl],
      ["tag", matrix?.verifiedRuntime?.sourceTag, matrix?.publishedRuntime?.sourceTag],
      [
        "upstream repository",
        matrix?.verifiedRuntime?.upstreamRepository,
        matrix?.publishedRuntime?.upstreamRepository,
      ],
      ["upstream tag", matrix?.verifiedRuntime?.upstreamTag, matrix?.publishedRuntime?.upstreamTag],
      [
        "upstream commit",
        matrix?.verifiedRuntime?.upstreamCommit,
        matrix?.publishedRuntime?.upstreamCommit,
      ],
      [
        "integration patches",
        JSON.stringify(matrix?.verifiedRuntime?.integrationPatches),
        JSON.stringify(matrix?.publishedRuntime?.integrationPatches),
      ],
      [
        "upstream patch status",
        matrix?.verifiedRuntime?.upstreamTagContainsIntegrationPatches,
        matrix?.publishedRuntime?.upstreamTagContainsIntegrationPatches,
      ],
    ]) {
      if (publishedValue !== currentValue) {
        errors.push(
          `${matrixPath} published runtime ${field} must match current verified runtime for tagged releases`,
        );
      }
    }
  }
  const ompRuntimeVersion = publishedRuntime.version;
  const ompRuntimeCommit = publishedRuntime.sourceCommit;
  const ompRuntimeSourceTag = publishedRuntime.sourceTag;
  const ompUpstreamTag = publishedRuntime.upstreamTag;
  const ompUpstreamCommit = publishedRuntime.upstreamCommit;
  const ompRuntimeCommitUrl = publishedRuntime.sourceCommitUrl;
  const ompRuntimeSourceUrl = publishedRuntime.sourceTagUrl;
  const ompUpstreamTagUrl = publishedRuntime.upstreamTagUrl;
  const ompUpstreamCommitUrl = publishedRuntime.upstreamCommitUrl;

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
    "export const RELEASE_MANIFEST_URL = `${SITE_URL}/releases/latest.json`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_VERSION = "${ompRuntimeVersion}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_COMMIT = "${ompRuntimeCommit}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_TAG = "${ompRuntimeSourceTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_TAG = "${ompUpstreamTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_COMMIT = "${ompUpstreamCommit}";`,
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
    `export const APP_WIRE_VERSION = "${publishedAppWireVersion}";`,
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
    `T4 Code ${expectedTag} was verified with OMP ${ompRuntimeVersion} built from [\`${String(ompRuntimeCommit).slice(0, 8)}\`](${ompRuntimeCommitUrl}), tagged [\`${ompRuntimeSourceTag}\`](${ompRuntimeSourceUrl}).`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `official upstream [\`${ompUpstreamTag}\`](${ompUpstreamTagUrl}) tag at [\`${String(ompUpstreamCommit).slice(0, 8)}\`](${ompUpstreamCommitUrl})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `The official upstream ${ompUpstreamTag} tag has no \`appserver\` command, so it cannot host T4 Code.`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `T4 Code vendors \`@oh-my-pi/app-wire\` ${publishedAppWireVersion} from integration commit [\`${publishedAppWireSourceCommit.slice(0, 8)}\`](${OMP_RUNTIME_REPOSITORY}/commit/${publishedAppWireSourceCommit}), source tree \`${publishedAppWireSourceTree}\`.`,
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

  const releaseNotes = files.get("docs/CURRENT_RELEASE_NOTES.md") ?? "";
  for (const expected of [
    `app-wire ${publishedAppWireVersion}`,
    `[${publishedAppWireSourceCommit.slice(0, 8)}](${OMP_RUNTIME_REPOSITORY}/commit/${publishedAppWireSourceCommit})`,
    `OMP ${ompRuntimeVersion}`,
    `[${String(ompRuntimeCommit).slice(0, 8)}](${ompRuntimeCommitUrl})`,
    `[${ompRuntimeSourceTag}](${ompRuntimeSourceUrl})`,
    `[${ompUpstreamTag} tag](${ompUpstreamTagUrl})`,
    `[${String(ompUpstreamCommit).slice(0, 8)}](${ompUpstreamCommitUrl})`,
  ]) {
    requireText(releaseNotes, expected, "docs/CURRENT_RELEASE_NOTES.md", errors);
  }

  const securityPolicy = files.get("SECURITY.md") ?? "";
  const firstSignedVersion = String(macosIdentity?.firstSignedReleaseTag ?? "").replace(/^v/u, "");
  const signedRelease = VERSION_PATTERN.test(firstSignedVersion)
    ? compareStableVersions(version, firstSignedVersion) >= 0
    : false;
  requireText(
    securityPolicy,
    signedRelease
      ? `The macOS ${expectedTag} build is signed with Apple Developer ID and notarized by Apple`
      : `The macOS ${expectedTag} build is unsigned and unnotarized`,
    "SECURITY.md",
    errors,
  );
  requireText(
    securityPolicy,
    `Starting with ${macosIdentity?.firstSignedReleaseTag ?? "the first signed release"}`,
    "SECURITY.md",
    errors,
  );
  requireText(
    files.get(".github/ISSUE_TEMPLATE/bug_report.yml") ?? "",
    `placeholder: "${version}"`,
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    errors,
  );

  const runtimeIdentifiers = [
    ["apps/desktop/src/target-manager.ts", [`version: "${version}"`, 'build: "desktop"']],
    ["apps/web/src/platform/browser-shell-port.ts", [`version: "${version}"`]],
    ["packages/client/src/omp-client-frames.ts", [`version: "${version}"`, 'build: "client"']],
  ];
  for (const [path, expectedValues] of runtimeIdentifiers) {
    for (const expected of expectedValues) {
      requireText(files.get(path) ?? "", expected, path, errors);
    }
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
  const ciWorkflow = files.get(".github/workflows/ci.yml") ?? "";
  try {
    const workflow = parseYaml(ciWorkflow);
    const continuityJob = workflow?.jobs?.["legacy-bridge-continuity"];
    if (!continuityJob || !Array.isArray(continuityJob.steps)) {
      errors.push(".github/workflows/ci.yml is missing the legacy-bridge-continuity job");
    } else {
      const namedStep = (name) => {
        const matches = continuityJob.steps.filter((step) => step?.name === name);
        if (matches.length !== 1) {
          errors.push(`.github/workflows/ci.yml must contain exactly one ${JSON.stringify(name)} step`);
          return undefined;
        }
        return matches[0];
      };
      const authorityStep = namedStep("Resolve pinned OMP authority source");
      const checkoutStep = namedStep("Check out pinned OMP authority source");
      const continuityStep = namedStep("Run legacy bridge continuity gate");
      const uploadStep = namedStep("Upload continuity evidence");
      const authorityCommands = [
        `source_repository="$(jq -er '.sourceRepository' provenance/omp-host-migration.json)"`,
        `test "$source_repository" = "https://github.com/lyc-aon/oh-my-pi"`,
        `sha="$(jq -er '.inputs.operationsContinuity' provenance/omp-host-migration.json)"`,
        '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
        `echo "repository=lyc-aon/oh-my-pi" >> "$GITHUB_OUTPUT"`,
        `echo "sha=$sha" >> "$GITHUB_OUTPUT"`,
      ];
      for (const command of authorityCommands) {
        if (!authorityStep?.run?.includes(command))
          errors.push(`.github/workflows/ci.yml authority step is missing ${JSON.stringify(command)}`);
      }
      if (checkoutStep?.with?.repository !== "${{ steps.authority.outputs.repository }}")
        errors.push(".github/workflows/ci.yml continuity checkout must use the validated repository output");
      if (checkoutStep?.with?.ref !== "${{ steps.authority.outputs.sha }}")
        errors.push(".github/workflows/ci.yml continuity checkout must use the validated SHA output");
      if (checkoutStep?.with?.path !== ".continuity/omp")
        errors.push(".github/workflows/ci.yml continuity checkout must use .continuity/omp");
      if (continuityStep?.env?.T4_OMP_SOURCE_DIR !== "${{ github.workspace }}/.continuity/omp")
        errors.push(".github/workflows/ci.yml continuity gate must target the checked-out OMP source");
      if (continuityStep?.run !== "pnpm test:legacy-bridge-continuity")
        errors.push(".github/workflows/ci.yml continuity gate must run the release-bound command");
      if (
        uploadStep?.if !== "${{ always() }}" ||
        uploadStep?.with?.path !== "artifacts/legacy-bridge-continuity/" ||
        uploadStep?.with?.["if-no-files-found"] !== "error"
      )
        errors.push(".github/workflows/ci.yml continuity evidence upload is not fail-closed");
    }
  } catch (error) {
    errors.push(`.github/workflows/ci.yml is invalid YAML: ${error instanceof Error ? error.message : error}`);
  }

  for (const expected of [
    "core:",
    "legacy-bridge-continuity:",
    'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    `source_repository="$(jq -er '.sourceRepository' provenance/omp-host-migration.json)"`,
    `test "$source_repository" = "https://github.com/lyc-aon/oh-my-pi"`,
    `sha="$(jq -er '.inputs.operationsContinuity' provenance/omp-host-migration.json)"`,
    '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
    `echo "repository=lyc-aon/oh-my-pi" >> "$GITHUB_OUTPUT"`,
    "repository: ${{ steps.authority.outputs.repository }}",
    "ref: ${{ steps.authority.outputs.sha }}",
    "T4_OMP_SOURCE_DIR: ${{ github.workspace }}/.continuity/omp",
    "run: pnpm test:legacy-bridge-continuity",
    "path: artifacts/legacy-bridge-continuity/",
    "if-no-files-found: error",
    "tooling:",
    "android-debug:",
    "flutter:",
    "flutter-android:",
    "flutter-apple:",
    "Run Flutter iOS launch smoke test",
    'xcrun simctl install "$DEVICE_ID" build/ios/iphonesimulator/Runner.app',
    'kill -0 "$app_pid"',
    "Build standalone T4 host for Flutter macOS",
    "Verify bundled Flutter macOS host",
    "test -x apps/flutter/build/macos/Build/Products/Debug/t4code.app/Contents/Resources/runtime/t4-host",
    "name: verify",
    "if: ${{ always() }}",
    "needs: [core, legacy-bridge-continuity, tooling, android-debug, flutter, flutter-android, flutter-apple]",
    'test "$CORE_RESULT" = success',
    'test "$CONTINUITY_RESULT" = success',
    'test "$TOOLING_RESULT" = success',
    'test "$ANDROID_RESULT" = success',
    'test "$FLUTTER_RESULT" = success',
    'test "$FLUTTER_ANDROID_RESULT" = success',
    'test "$FLUTTER_APPLE_RESULT" = success',
    "github.event_name == 'pull_request' && github.ref || github.sha",
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9",
    "android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407",
    'sdkmanager --install "platforms;android-36" "build-tools;36.0.0"',
    "pnpm --filter @t4-code/mobile check:android:debug",
  ]) {
    requireText(ciWorkflow, expected, ".github/workflows/ci.yml", errors);
  }
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
    '--metadata "$metadata"',
    '--aapt "$build_tools/aapt"',
    '--apksigner "$build_tools/apksigner"',
    "T4-Code-${VERSION}-android.apk",
    "artifacts/latest-linux.yml",
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
    for (const duplicate of [
      "pnpm install",
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
    'owner: "LycaonLLC"',
    'repo: "t4-code"',
    'channel: "latest"',
    "publish: [linuxUpdatePublish]",
    "publish: []",
  ]) {
    requireText(builderConfig, expected, "electron-builder.config.mjs", errors);
  }
  const manifestGenerator = files.get("scripts/generate-release-manifest.mjs") ?? "";
  for (const expected of [
    "RELEASE_MANIFEST_SCHEMA_VERSION = 1",
    'LINUX_UPDATE_METADATA_NAME = "latest-linux.yml"',
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
    "exact seven-asset GitHub bundle",
    "defers only when the exact GitHub release lookup returns HTTP 404",
    "writes `/releases/latest.json`",
    "immutable release tag",
    "waits for that exact deployment run",
  ]) {
    requireText(releaseGate, expected, "docs/RELEASE_GATE.md", errors);
  }
  const maintainerReadme = files.get("ops/t4-maintainer/README.md") ?? "";
  for (const expected of [
    "exact seven-asset bundle",
    "whose six entries cover the packages and updater metadata",
    "https://t4code.net/releases/latest.json",
    "downloads the live `latest-linux.yml`, deb, and AppImage",
    "actual byte sizes and SHA-512",
  ]) {
    requireText(maintainerReadme, expected, "ops/t4-maintainer/README.md", errors);
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
