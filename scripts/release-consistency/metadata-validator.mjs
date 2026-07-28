import { isDeepStrictEqual } from "node:util";
import { parseJson } from "./contracts.mjs";
import {
  OMP_APP_WIRE_SOURCE_REPOSITORY,
  OMP_HOST_MIGRATION_INPUTS,
  OMP_HOST_MIGRATION_SOURCE_REPOSITORY,
  OMP_RUNTIME_REPOSITORY,
  OMP_UPSTREAM_REPOSITORY,
  PATCH_NAME_PATTERN,
  requireText,
  SHA256_PATTERN,
  SHA_PATTERN,
  VERSION_PATTERN,
} from "./shared.mjs";

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

function validateOfficialRuntimeMetadata(value, matrixPath, errors) {
  const prefix = `${matrixPath} official runtime`;
  const version = value?.version;
  const sourceCommit = value?.sourceCommit;
  if (value?.package !== "omp") errors.push(`${prefix} package must be omp`);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push(`${prefix} version must be a stable x.y.z version`);
  }
  if (value?.sourceRepository !== OMP_UPSTREAM_REPOSITORY) {
    errors.push(`${prefix} repository must be ${OMP_UPSTREAM_REPOSITORY}`);
  }
  if (typeof sourceCommit !== "string" || !SHA_PATTERN.test(sourceCommit)) {
    errors.push(`${prefix} commit must be a lowercase 40-character Git SHA`);
  }
  if (value?.sourceUrl !== `${OMP_UPSTREAM_REPOSITORY}/commit/${sourceCommit ?? ""}`) {
    errors.push(`${prefix} URL must match its source commit`);
  }
  if (typeof version === "string" && value?.sourceTag !== `v${version}`) {
    errors.push(`${prefix} tag must be v${version}`);
  }
  const expectedArtifacts = {
    "darwin-arm64": "omp-darwin-arm64",
    "darwin-x64": "omp-darwin-x64",
    "linux-arm64": "omp-linux-arm64",
    "linux-x64": "omp-linux-x64",
    "win32-x64": "omp-windows-x64.exe",
  };
  const artifacts = value?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    errors.push(`${prefix} artifacts must be an object`);
    return;
  }
  const actualKeys = Object.keys(artifacts).sort();
  const expectedKeys = Object.keys(expectedArtifacts).sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    errors.push(`${prefix} artifacts must pin ${expectedKeys.join(", ")}`);
  }
  for (const [platform, expectedName] of Object.entries(expectedArtifacts)) {
    const artifact = artifacts[platform];
    if (artifact?.name !== expectedName) errors.push(`${prefix} ${platform} artifact name must be ${expectedName}`);
    if (!Number.isSafeInteger(artifact?.size) || artifact.size <= 0) {
      errors.push(`${prefix} ${platform} artifact size must be a positive integer`);
    }
    if (typeof artifact?.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
      errors.push(`${prefix} ${platform} artifact SHA-256 must be a lowercase digest`);
    }
  }
}

function validateOfficialGate0Snapshot(snapshot, officialRuntime, path, errors) {
  if (snapshot?.schemaVersion !== 1) errors.push(`${path} schemaVersion must be 1`);
  if (snapshot?.gate !== "official-omp-gate0") errors.push(`${path} gate must be official-omp-gate0`);
  for (const [field, expected] of [
    ["version", officialRuntime?.version],
    ["tag", officialRuntime?.sourceTag],
    ["commit", officialRuntime?.sourceCommit],
  ]) {
    if (snapshot?.runtime?.[field] !== expected) {
      errors.push(`${path} runtime ${field} must match compat/omp-app-matrix.json officialRuntime`);
    }
  }
  const requiredPlatforms = ["darwin-arm64", "linux-x64", "linux-arm64"];
  if (!isDeepStrictEqual(snapshot?.requiredPlatforms, requiredPlatforms)) {
    errors.push(`${path} requiredPlatforms must cover macOS ARM64 and Linux x64/ARM64`);
  }
  const requiredScenarios = [
    "lifecycle",
    "crash-resume",
    "steer",
    "follow-up",
    "approval",
    "cancellation",
    "large-rpc-payload",
    "crash-after-dispatch-no-replay",
  ];
  if (!isDeepStrictEqual(snapshot?.requiredScenarios, requiredScenarios)) {
    errors.push(`${path} requiredScenarios must match the Gate 0 proof contract`);
  }
  for (const capability of ["prompt", "steer", "followUp", "approvalRoundTrip", "abort", "sessionResume"]) {
    if (snapshot?.officialRpcSupport?.[capability] !== true) {
      errors.push(`${path} officialRpcSupport.${capability} must be true`);
    }
  }
  for (const seam of ["readyTranscriptWatermark", "liveSessionEntries", "durableCommandKey"]) {
    if (snapshot?.missingOfficialSeams?.[seam] !== true) {
      errors.push(`${path} missingOfficialSeams.${seam} must remain explicit`);
    }
  }
  for (const capability of [
    "jsonlTranscriptReconciliation",
    "synthesizedReadyWatermark",
    "durableEntryProjection",
    "liveEntryDeduplication",
    "conservativePromptCorrelation",
  ]) {
    if (snapshot?.t4AdapterCoverage?.[capability] !== true) {
      errors.push(`${path} t4AdapterCoverage.${capability} must be true`);
    }
  }
  if (snapshot?.t4AdapterCoverage?.durableCommandKey !== false) {
    errors.push(`${path} t4AdapterCoverage.durableCommandKey must remain false`);
  }
  if (!isDeepStrictEqual(snapshot?.packagedHostProof?.requiredPlatforms, requiredPlatforms)) {
    errors.push(`${path} packagedHostProof.requiredPlatforms must cover macOS ARM64 and Linux x64/ARM64`);
  }
  if (
    !isDeepStrictEqual(snapshot?.packagedHostProof?.requiredScenarios, [
      "discovery",
      "attach",
      "prompt",
      "durable-jsonl",
      "t4-wire-projection",
      "terminal",
    ])
  ) {
    errors.push(`${path} packagedHostProof.requiredScenarios must match the packaged host contract`);
  }
  if (snapshot?.packagedHostProof?.authorityMode !== "official-exclusive-profile") {
    errors.push(`${path} packagedHostProof.authorityMode must be official-exclusive-profile`);
  }
  if (snapshot?.packagedHostProof?.releasedDefault !== "lycaon-authority-bridge") {
    errors.push(`${path} packagedHostProof.releasedDefault must preserve the Lycaon fallback`);
  }
  if (snapshot?.t4Policy?.ambiguousDispatch !== "outcome-unknown-no-auto-replay") {
    errors.push(`${path} ambiguous dispatch policy must fail closed without automatic replay`);
  }
}

export function validateReleaseMetadata(context) {
  const { errors, files, releaseTag } = context;
  const rootManifest = parseJson(files, "package.json", errors);
  const version = rootManifest?.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push("package.json version must be a stable x.y.z release version");
    context.validVersion = false;
    return;
  }
  context.validVersion = true;
  const expectedTag = `v${version}`;

  const androidIdentityPath = ".github/android-release-identity.json";
  const androidIdentity = parseJson(files, androidIdentityPath, errors);
  if (androidIdentity?.schemaVersion !== 1) {
    errors.push(`${androidIdentityPath} schemaVersion must be 1`);
  }
  if (androidIdentity?.applicationId !== "net.t4code.app") {
    errors.push(`${androidIdentityPath} applicationId must be net.t4code.app`);
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
  const androidIdentityIsObject =
    typeof androidIdentity === "object" && androidIdentity !== null;
  if (androidIdentityIsObject && !("certificateBaseline" in androidIdentity)) {
    errors.push(
      `${androidIdentityPath} must declare certificateBaseline, or null when no published APK establishes the key yet`,
    );
  } else if (
    androidIdentity?.certificateBaseline !== null &&
    (typeof androidIdentity?.certificateBaseline?.assetSha256 !== "string" ||
      !SHA256_PATTERN.test(androidIdentity.certificateBaseline.assetSha256))
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
  if (macosIdentity?.bundleId !== "net.t4code.app") {
    errors.push(`${macosIdentityPath} bundleId must be net.t4code.app`);
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
  requireText(
    files.get("apps/desktop/src/bundled-runtime.ts") ?? "",
    macosIdentity?.certificateSha256 ?? "missing macOS certificate SHA-256",
    "apps/desktop/src/bundled-runtime.ts",
    errors,
  );

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
  const hostMigrationPath = "provenance/omp-host-migration.json";
  const hostMigration = parseJson(files, hostMigrationPath, errors);
  if (hostMigration?.sourceRepository !== OMP_HOST_MIGRATION_SOURCE_REPOSITORY) {
    errors.push(
      `${hostMigrationPath} source repository must remain ${OMP_HOST_MIGRATION_SOURCE_REPOSITORY}`,
    );
  }
  if (!isDeepStrictEqual(hostMigration?.inputs, OMP_HOST_MIGRATION_INPUTS)) {
    errors.push(`${hostMigrationPath} migration inputs must remain the frozen reviewed commits`);
  }
  validateOfficialRuntimeMetadata(matrix?.officialRuntime, matrixPath, errors);
  const officialGatePath = "compat/official-omp-gate0.json";
  const officialGate = parseJson(files, officialGatePath, errors);
  validateOfficialGate0Snapshot(officialGate, matrix?.officialRuntime, officialGatePath, errors);
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
  if (appWire?.sourceRepository !== OMP_APP_WIRE_SOURCE_REPOSITORY) {
    errors.push(`${matrixPath} app-wire repository must be ${OMP_APP_WIRE_SOURCE_REPOSITORY}`);
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
  if (publishedAppWire?.sourceRepository !== OMP_APP_WIRE_SOURCE_REPOSITORY) {
    errors.push(`${matrixPath} published app-wire repository must be ${OMP_APP_WIRE_SOURCE_REPOSITORY}`);
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

  Object.assign(context, {
    expectedTag,
    macosIdentity,
    ompRuntimeCommit,
    ompRuntimeCommitUrl,
    ompRuntimeSourceTag,
    ompRuntimeSourceUrl,
    ompRuntimeVersion,
    ompUpstreamCommit,
    ompUpstreamCommitUrl,
    ompUpstreamTag,
    ompUpstreamTagUrl,
    publishedAppWireSourceCommit,
    publishedAppWireSourceTree,
    publishedAppWireVersion,
    version,
  });
}
