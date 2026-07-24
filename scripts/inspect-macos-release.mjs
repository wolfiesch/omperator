#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const MACOS_APP_BUNDLE_NAME = "T4 Code.app";

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateMacosIdentityContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("macOS release identity must be an object");
  }
  if (contract.schemaVersion !== 1) throw new Error("macOS identity schemaVersion must be 1");
  if (requireString(contract.bundleId, "bundleId") !== "com.lycaonsolutions.t4code") {
    throw new Error("macOS identity bundleId must be com.lycaonsolutions.t4code");
  }
  if (!TEAM_ID_PATTERN.test(requireString(contract.teamId, "teamId"))) {
    throw new Error("macOS identity teamId must be 10 uppercase letters or digits");
  }
  requireString(contract.certificateCommonName, "certificateCommonName");
  if (!SHA256_PATTERN.test(requireString(contract.certificateSha256, "certificateSha256"))) {
    throw new Error("macOS identity certificateSha256 must be a lowercase SHA-256 digest");
  }
  requireString(contract.certificateAuthority, "certificateAuthority");
  if (contract.architecture !== "arm64") {
    throw new Error("macOS identity architecture must be arm64");
  }
  if (!TAG_PATTERN.test(requireString(contract.firstSignedReleaseTag, "firstSignedReleaseTag"))) {
    throw new Error("macOS identity firstSignedReleaseTag must be vX.Y.Z");
  }
  if (contract.notarizationRequired !== true) {
    throw new Error("macOS identity must require notarization");
  }
  return Object.freeze({ ...contract });
}

export function parseCodesignDisplay(output) {
  const fields = new Map();
  const authorities = [];
  let hardenedRuntime = false;
  for (const line of String(output).split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    const separator = line.indexOf("=");
    if (separator >= 0) {
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "Authority") authorities.push(value);
      else fields.set(key, value);
    }
    if (/\bflags=.*\bruntime\b/iu.test(trimmedLine) || trimmedLine.startsWith("Runtime Version=")) {
      hardenedRuntime = true;
    }
  }
  return {
    identifier: fields.get("Identifier") ?? null,
    teamIdentifier: fields.get("TeamIdentifier") ?? null,
    timestamp: fields.get("Timestamp") ?? null,
    authorities,
    hardenedRuntime,
  };
}

export function validateMacosSignatureReport(report, contract) {
  const identity = validateMacosIdentityContract(contract);
  const errors = [];
  if (report.identifier !== identity.bundleId) {
    errors.push(
      `bundle identifier ${report.identifier ?? "missing"} does not match ${identity.bundleId}`,
    );
  }
  if (report.teamIdentifier !== identity.teamId) {
    errors.push(
      `team identifier ${report.teamIdentifier ?? "missing"} does not match ${identity.teamId}`,
    );
  }
  if (!report.authorities.includes(identity.certificateCommonName)) {
    errors.push(`signing authority does not include ${identity.certificateCommonName}`);
  }
  if (!report.authorities.includes(identity.certificateAuthority)) {
    errors.push(`certificate chain does not include ${identity.certificateAuthority}`);
  }
  if (report.certificateSha256 !== identity.certificateSha256) {
    errors.push("leaf signing certificate SHA-256 does not match the pinned release identity");
  }
  if (!report.hardenedRuntime) errors.push("hardened runtime is not enabled");
  if (!report.timestamp) errors.push("secure signing timestamp is missing");
  if (errors.length > 0) throw new Error(errors.join("; "));
  return Object.freeze({ ...report });
}

function hasEnabledEntitlement(output, entitlement) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`, "u").test(String(output));
}

export function validateMacosLibraryValidationBoundary(appEntitlements, runtimeEntitlements) {
  const entitlement = "com.apple.security.cs.disable-library-validation";
  if (hasEnabledEntitlement(appEntitlements, entitlement)) {
    throw new Error("top-level T4 Code app must keep library validation enabled");
  }
  if (!hasEnabledEntitlement(runtimeEntitlements, entitlement)) {
    throw new Error("bundled OMP runtime must disable library validation");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    killSignal: "SIGTERM",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}${details ? `: ${details}` : ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function validateMacosAppBundleName(appPath) {
  const actualName = basename(appPath);
  if (actualName !== MACOS_APP_BUNDLE_NAME) {
    throw new Error(
      `macOS release app must be named ${MACOS_APP_BUNDLE_NAME}; found ${actualName}`,
    );
  }
  return appPath;
}

function findSingleApp(directory) {
  const apps = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && extname(entry.name).toLowerCase() === ".app")
    .map((entry) => join(directory, entry.name));
  if (apps.length !== 1)
    throw new Error(`expected exactly one top-level macOS app; found ${apps.length}`);
  return validateMacosAppBundleName(apps[0]);
}

function inspectApp(appPath, contract, certificatePrefix) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const display = run("codesign", [
    "--display",
    "--verbose=4",
    `--extract-certificates=${certificatePrefix}`,
    appPath,
  ]);
  const leafCertificate = readFileSync(`${certificatePrefix}0`);
  const report = {
    ...parseCodesignDisplay(display),
    certificateSha256: createHash("sha256").update(leafCertificate).digest("hex"),
  };
  validateMacosSignatureReport(report, contract);
  const runtimePath = join(appPath, "Contents", "Resources", "runtime", "omp");
  const hostPath = join(appPath, "Contents", "Resources", "runtime", "t4-host");
  run("codesign", ["--verify", "--strict", "--verbose=2", runtimePath]);
  run("codesign", ["--verify", "--strict", "--verbose=2", hostPath]);
  const appEntitlements = run("codesign", ["--display", "--entitlements", ":-", appPath]);
  const runtimeEntitlements = run("codesign", ["--display", "--entitlements", ":-", runtimePath]);
  validateMacosLibraryValidationBoundary(appEntitlements, runtimeEntitlements);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  return report;
}

function requireArtifact(path, extension) {
  const absolutePath = resolve(path);
  let isFile = false;
  try {
    isFile = statSync(absolutePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile || extname(absolutePath).toLowerCase() !== extension) {
    throw new Error(`expected an existing ${extension} artifact: ${absolutePath}`);
  }
  return absolutePath;
}

export function inspectMacosRelease(zipPath, dmgPath, identityPath) {
  if (process.platform !== "darwin") {
    throw new Error(
      `macOS release inspection requires darwin; current platform is ${process.platform}`,
    );
  }
  const zip = requireArtifact(zipPath, ".zip");
  const dmg = requireArtifact(dmgPath, ".dmg");
  const identity = validateMacosIdentityContract(
    JSON.parse(readFileSync(resolve(identityPath), "utf8")),
  );
  const root = mkdtempSync(join(tmpdir(), "t4-macos-release-"));
  const zipRoot = join(root, "zip");
  const mountPoint = join(root, "dmg");
  let mounted = false;
  try {
    mkdirSync(zipRoot);
    mkdirSync(mountPoint);
    run("ditto", ["-x", "-k", zip, zipRoot]);
    const zipReport = inspectApp(findSingleApp(zipRoot), identity, join(root, "zip-cert-"));

    run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      dmg,
    ]);
    mounted = true;
    const dmgReport = inspectApp(findSingleApp(mountPoint), identity, join(root, "dmg-cert-"));
    return Object.freeze({ zip: zipReport, dmg: dmgReport });
  } finally {
    if (mounted) {
      try {
        run("hdiutil", ["detach", mountPoint]);
      } catch {
        run("hdiutil", ["detach", "-force", mountPoint]);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const [zipPath, dmgPath, identityPath = ".github/macos-release-identity.json"] =
      process.argv.slice(2);
    if (!zipPath || !dmgPath) {
      throw new Error(
        "usage: node scripts/inspect-macos-release.mjs APP.zip APP.dmg [identity.json]",
      );
    }
    inspectMacosRelease(zipPath, dmgPath, identityPath);
    console.log(
      "macOS Developer ID identity, hardened runtime, Gatekeeper, and notarization checks passed",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
