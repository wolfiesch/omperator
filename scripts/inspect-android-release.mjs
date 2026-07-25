import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ANDROID_VERSION_CODE = 2_100_000_000;
const UNIVERSAL_APK_NAME = "app-release.apk";

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function normalizeCertificateDigest(value) {
  return String(value).replaceAll(":", "").toLowerCase();
}

export function deriveAndroidVersionCode(versionName) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(versionName);
  if (match === null) {
    fail(`Android release version must be a numeric major.minor.patch value, received ${JSON.stringify(versionName)}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor > 99) fail(`Android release minor version must be at most 99, received ${minor}`);
  if (patch > 9_999) fail(`Android release patch version must be at most 9999, received ${patch}`);

  const versionCode = major * 1_000_000 + minor * 10_000 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_ANDROID_VERSION_CODE) {
    fail(`derived Android versionCode ${versionCode} is outside the supported range`);
  }
  return versionCode;
}

function quotedAttributes(line) {
  const attributes = new Map();
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9_-]*)='([^']*)'/gu)) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

export function parseAaptBadging(output) {
  const packageLine = output.split(/\r?\n/u).find((line) => line.startsWith("package:"));
  if (packageLine === undefined) fail("aapt badging output is missing the package record");
  const attributes = quotedAttributes(packageLine);
  const applicationId = attributes.get("name");
  const versionName = attributes.get("versionName");
  const versionCodeText = attributes.get("versionCode");
  if (applicationId === undefined || versionName === undefined || !/^\d+$/u.test(versionCodeText ?? "")) {
    fail("aapt package record is missing name, versionName, or numeric versionCode");
  }

  const minSdkMatch = /^sdkVersion:'(\d+)'$/mu.exec(output);
  const targetSdkMatch = /^targetSdkVersion:'(\d+)'$/mu.exec(output);
  if (minSdkMatch === null || targetSdkMatch === null) {
    fail("aapt badging output is missing numeric sdkVersion or targetSdkVersion");
  }

  return {
    applicationId,
    versionCode: Number(versionCodeText),
    versionName,
    minSdkVersion: Number(minSdkMatch[1]),
    targetSdkVersion: Number(targetSdkMatch[1]),
    splitName: attributes.get("split") ?? null,
    declaresSplitDependency: /^uses-split:/mu.test(output),
  };
}

export function parseApkSignerReport(output) {
  const countMatch = /^Number of signers:\s*(\d+)\s*$/mu.exec(output);
  if (countMatch === null) fail("apksigner output is missing the signer count");

  const certificateDigests = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gimu)]
    .map((match) => normalizeCertificateDigest(match[1]));
  const modernSchemeVerified = [...output.matchAll(/^Verified using v(?:2|3|3\.1) scheme[^:]*:\s*(true|false)\s*$/gimu)]
    .some((match) => match[1].toLowerCase() === "true");

  return {
    signerCount: Number(countMatch[1]),
    certificateDigests,
    modernSchemeVerified,
  };
}

export function validateIdentityContract(contract) {
  requirePlainObject(contract, "Android release identity contract");
  if (contract.schemaVersion !== 1) fail("Android release identity contract schemaVersion must be 1");
  if (typeof contract.applicationId !== "string" || contract.applicationId.length === 0) {
    fail("Android release identity contract applicationId must be a non-empty string");
  }
  for (const field of ["minSdkVersion", "targetSdkVersion"]) {
    if (!Number.isInteger(contract[field]) || contract[field] < 1) {
      fail(`Android release identity contract ${field} must be a positive integer`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(contract.signingCertificateSha256 ?? "")) {
    fail("Android release identity contract signingCertificateSha256 must be 64 lowercase hexadecimal characters");
  }

  // A baseline pins the published APK that established the current signing key.
  // The first release under a newly minted key has no such artifact yet, so the
  // contract declares that with an explicit null. Omitting the field stays an
  // error, so a typo cannot silently skip this gate.
  if (!("certificateBaseline" in contract)) {
    fail("Android release identity contract must declare certificateBaseline, or null when no published APK establishes the key yet");
  }
  if (contract.certificateBaseline !== null) {
    const baseline = requirePlainObject(contract.certificateBaseline, "Android certificate baseline");
    if (!/^v\d+\.\d+\.\d+$/u.test(baseline.tag ?? "")) {
      fail("Android certificate baseline tag must be a stable v<major>.<minor>.<patch> tag");
    }
    if (typeof baseline.asset !== "string" || !baseline.asset.endsWith("-android.apk")) {
      fail("Android certificate baseline asset must name a published Android APK");
    }
    if (!/^[0-9a-f]{64}$/u.test(baseline.assetSha256 ?? "")) {
      fail("Android certificate baseline assetSha256 must be 64 lowercase hexadecimal characters");
    }
  }
  return contract;
}

function validateUniversalMetadata(metadata, expected) {
  requirePlainObject(metadata, "Android output metadata");
  if (metadata.artifactType?.type !== "APK") fail("Android output metadata artifact type must be APK");
  if (metadata.applicationId !== expected.applicationId) {
    fail(`Android output metadata applicationId ${JSON.stringify(metadata.applicationId)} does not match ${expected.applicationId}`);
  }
  if (metadata.variantName !== "release") fail("Android output metadata variantName must be release");
  if (!Array.isArray(metadata.elements) || metadata.elements.length !== 1) {
    fail("Android release must contain exactly one APK output element");
  }

  const element = requirePlainObject(metadata.elements[0], "Android output metadata element");
  if (element.type !== "SINGLE") fail("Android release output element type must be SINGLE");
  if (!Array.isArray(element.filters) || element.filters.length !== 0) {
    fail("Android release output must have no ABI, density, or language split filters");
  }
  if (element.outputFile !== UNIVERSAL_APK_NAME) {
    fail(`Android release output file must be ${UNIVERSAL_APK_NAME}`);
  }
  if (element.versionCode !== expected.versionCode || element.versionName !== expected.versionName) {
    fail("Android output metadata version does not match the package-derived release version");
  }
}

export function validateAndroidRelease({
  contract,
  packageVersion,
  mobilePackageVersion,
  apkName,
  apkFileNames,
  outputMetadata,
  badgingOutput,
  manifestTreeOutput,
  signerOutput,
}) {
  validateIdentityContract(contract);
  if (mobilePackageVersion !== packageVersion) {
    fail(`mobile package version ${mobilePackageVersion} does not match root package version ${packageVersion}`);
  }

  const versionCode = deriveAndroidVersionCode(packageVersion);
  const expected = {
    applicationId: contract.applicationId,
    versionName: packageVersion,
    versionCode,
  };

  if (apkName !== UNIVERSAL_APK_NAME) fail(`Android release APK must be named ${UNIVERSAL_APK_NAME}`);
  if (apkFileNames.length !== 1 || apkFileNames[0] !== UNIVERSAL_APK_NAME) {
    fail(`Android release output directory must contain only ${UNIVERSAL_APK_NAME}`);
  }
  validateUniversalMetadata(outputMetadata, expected);

  const badging = parseAaptBadging(badgingOutput);
  if (badging.applicationId !== contract.applicationId) {
    fail(`Android APK applicationId ${badging.applicationId} does not match ${contract.applicationId}`);
  }
  if (badging.versionName !== packageVersion) {
    fail(`Android APK versionName ${badging.versionName} does not match package version ${packageVersion}`);
  }
  if (badging.versionCode !== versionCode) {
    fail(`Android APK versionCode ${badging.versionCode} does not match derived versionCode ${versionCode}`);
  }
  if (badging.minSdkVersion !== contract.minSdkVersion) {
    fail(`Android APK minSdkVersion ${badging.minSdkVersion} does not match ${contract.minSdkVersion}`);
  }
  if (badging.targetSdkVersion !== contract.targetSdkVersion) {
    fail(`Android APK targetSdkVersion ${badging.targetSdkVersion} does not match ${contract.targetSdkVersion}`);
  }
  if (badging.splitName !== null || badging.declaresSplitDependency) {
    fail("Android release APK must be standalone and must not be a split APK or depend on a split");
  }
  if (/^\s*E:\s+uses-split\b|^\s*A:\s+(?:android:)?(?:split|configForSplit|isSplitRequired)(?:\([^)]*\))?=/mu.test(manifestTreeOutput)) {
    fail("Android release manifest contains split-only metadata");
  }

  const signer = parseApkSignerReport(signerOutput);
  if (!signer.modernSchemeVerified) fail("Android release APK must verify with APK Signature Scheme v2 or newer");
  if (signer.signerCount !== 1 || signer.certificateDigests.length !== 1) {
    fail("Android release APK must have exactly one signing certificate");
  }
  if (signer.certificateDigests[0] !== contract.signingCertificateSha256) {
    fail("Android release APK signing certificate does not match the pinned production certificate SHA-256 identity");
  }

  return {
    applicationId: badging.applicationId,
    versionName: badging.versionName,
    versionCode: badging.versionCode,
    minSdkVersion: badging.minSdkVersion,
    targetSdkVersion: badging.targetSdkVersion,
    signingCertificateSha256: signer.certificateDigests[0],
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("usage: inspect-android-release.mjs --apk <path> --metadata <path> --aapt <path> --apksigner <path> [--repo-root <path>]");
    }
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, value);
  }
  for (const required of ["--apk", "--metadata", "--aapt", "--apksigner"]) {
    if (!values.has(required)) fail(`missing required argument ${required}`);
  }
  for (const key of values.keys()) {
    if (!["--apk", "--metadata", "--aapt", "--apksigner", "--repo-root"].includes(key)) fail(`unknown argument ${key}`);
  }
  return values;
}

export function inspectAndroidRelease({ repoRoot, apk, metadata, aapt, apksigner }) {
  for (const [label, file] of Object.entries({ apk, metadata, aapt, apksigner })) {
    if (!existsSync(file)) fail(`${label} path does not exist: ${file}`);
  }

  const contract = readJson(resolve(repoRoot, ".github/android-release-identity.json"), "Android release identity contract");
  const rootPackage = readJson(resolve(repoRoot, "package.json"), "root package manifest");
  const mobilePackage = readJson(resolve(repoRoot, "apps/mobile/package.json"), "mobile package manifest");
  const outputMetadata = readJson(metadata, "Android output metadata");
  const apkFileNames = readdirSync(dirname(apk)).filter((file) => file.endsWith(".apk")).sort();
  const badgingOutput = execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8" });
  const manifestTreeOutput = execFileSync(aapt, ["dump", "xmltree", apk, "AndroidManifest.xml"], { encoding: "utf8" });
  const signerOutput = execFileSync(apksigner, ["verify", "--verbose", "--print-certs", apk], { encoding: "utf8" });

  return validateAndroidRelease({
    contract,
    packageVersion: rootPackage.version,
    mobilePackageVersion: mobilePackage.version,
    apkName: basename(apk),
    apkFileNames,
    outputMetadata,
    badgingOutput,
    manifestTreeOutput,
    signerOutput,
  });
}

const isEntrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = inspectAndroidRelease({
      repoRoot: resolve(args.get("--repo-root") ?? resolve(import.meta.dirname, "..")),
      apk: resolve(args.get("--apk")),
      metadata: resolve(args.get("--metadata")),
      aapt: resolve(args.get("--aapt")),
      apksigner: resolve(args.get("--apksigner")),
    });
    console.log(
      `Android release contract passed for ${result.applicationId} ${result.versionName} (versionCode ${result.versionCode})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
