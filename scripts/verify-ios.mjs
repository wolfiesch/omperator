#!/usr/bin/env node

// Builds the iOS application and runs its XCUITest bundle on a simulator.
//
// The runtime and device type are discovered at run time rather than pinned.
// A hosted runner's Xcode trails a developer's local install, so a pinned
// "iOS 26.5 / iPhone 17 Pro" would pass on a workstation and fail on CI for a
// reason that has nothing to do with the change under test. Newest available
// runtime plus any available iPhone keeps both honest.
//
// This never skips. Off macOS, or without Xcode, it exits non-zero and says
// which prerequisite is missing: a verification leg that silently no-ops is
// worse than one that is absent, because the plan still claims the coverage.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iosRoot = join(repoRoot, "apps", "ios");
const SCHEME = "T4Code";
const SIMULATOR_NAME = "t4-verify-ios";

function fail(message) {
  process.stderr.write(`verify-ios: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: iosRoot, stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: iosRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function requireTool(command, hint) {
  if (capture(command, ["--version"]) === undefined && capture(command, ["-version"]) === undefined) {
    fail(`${command} is unavailable. ${hint}`);
  }
}

// A runner image ships several Xcodes and preselects one that is not
// necessarily the newest. When the selected SDK is older than the deployment
// target, the compiler reports a missing iOS-26 type such as `Glass` as an
// ordinary "cannot find type in scope", which reads like a source bug rather
// than a toolchain mismatch. Select the newest Xcode, then check the SDK up
// front and say plainly which two numbers disagree.
function selectNewestXcode() {
  if (process.env.DEVELOPER_DIR) return;
  let candidates;
  try {
    candidates = readdirSync("/Applications").filter((entry) => /^Xcode.*\.app$/u.test(entry));
  } catch {
    return;
  }
  const versioned = candidates
    .map((entry) => {
      const developer = join("/Applications", entry, "Contents", "Developer");
      const raw = capture("plutil", [
        "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
        join("/Applications", entry, "Contents", "version.plist"),
      ]);
      if (raw === undefined || !existsSync(developer)) return undefined;
      const parts = raw.trim().split(".").map(Number);
      return { developer, order: (parts[0] ?? 0) * 1000 + (parts[1] ?? 0) };
    })
    .filter(Boolean)
    .sort((left, right) => right.order - left.order);
  if (versioned.length > 0) process.env.DEVELOPER_DIR = versioned[0].developer;
}

function assertSdkSupportsDeploymentTarget() {
  const project = readFileSync(join(iosRoot, "project.yml"), "utf8");
  const target = /^\s*iOS:\s*"?([\d.]+)"?\s*$/mu.exec(project)?.[1];
  const sdk = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"])?.trim();
  if (!target || !sdk) return;
  const major = (value) => Number(value.split(".")[0]);
  if (major(sdk) < major(target)) {
    fail(
      `the selected iOS simulator SDK is ${sdk} but project.yml targets iOS ${target}. ` +
        `Select an Xcode whose SDK is at least ${target} (DEVELOPER_DIR overrides the choice).`,
    );
  }
}

// simctl reports runtime identifiers as com.apple.CoreSimulator.SimRuntime.iOS-26-5.
// Sorting on the parsed version rather than the string keeps iOS-9-0 below
// iOS-26-0, which a lexical sort gets backwards.
function newestIosRuntime(runtimes) {
  return runtimes
    .filter((runtime) => runtime.isAvailable && runtime.identifier.includes("SimRuntime.iOS-"))
    .map((runtime) => {
      const parts = runtime.identifier.split("SimRuntime.iOS-")[1].split("-").map(Number);
      return { runtime, order: (parts[0] ?? 0) * 1000 + (parts[1] ?? 0) };
    })
    .sort((left, right) => right.order - left.order)
    .at(0)?.runtime;
}

function iphoneDeviceType(deviceTypes, runtime) {
  const supported = new Set(runtime.supportedDeviceTypes?.map((entry) => entry.identifier) ?? []);
  const candidates = deviceTypes.filter(
    (type) => type.identifier.includes("SimDeviceType.iPhone") && (supported.size === 0 || supported.has(type.identifier)),
  );
  // Rank by the model number so iPhone-17-Pro beats iPhone-16-Pro. A lexical
  // compare puts iPhone-SE-3rd-generation on top instead, because "S" sorts
  // above every digit; unnumbered models therefore rank last and only win when
  // nothing else is available.
  const rank = (identifier) => Number(/iPhone-(\d+)/u.exec(identifier)?.[1] ?? -1);
  return candidates.sort((left, right) => rank(right.identifier) - rank(left.identifier)).at(0);
}

function simulatorUdid(runtime, deviceType) {
  const listed = JSON.parse(capture("xcrun", ["simctl", "list", "devices", "--json"]) ?? "{}");
  const existing = (listed.devices?.[runtime.identifier] ?? []).find((device) => device.name === SIMULATOR_NAME);
  if (existing) return existing.udid;
  const created = capture("xcrun", ["simctl", "create", SIMULATOR_NAME, deviceType.identifier, runtime.identifier]);
  if (!created) fail(`could not create a simulator for ${deviceType.identifier} on ${runtime.identifier}`);
  return created.trim();
}

if (process.platform !== "darwin") {
  fail(`iOS verification needs macOS with Xcode; this host is ${process.platform}.`);
}
selectNewestXcode();
requireTool("xcodebuild", "Install Xcode and select it with xcode-select.");
requireTool("xcodegen", "Install it with: brew install xcodegen");
assertSdkSupportsDeploymentTarget();

const runtimes = JSON.parse(capture("xcrun", ["simctl", "list", "runtimes", "--json"]) ?? "{}").runtimes ?? [];
const runtime = newestIosRuntime(runtimes);
if (!runtime) fail("no available iOS simulator runtime. Install one through Xcode.");

const deviceTypes = JSON.parse(capture("xcrun", ["simctl", "list", "devicetypes", "--json"]) ?? "{}").devicetypes ?? [];
const deviceType = iphoneDeviceType(deviceTypes, runtime);
if (!deviceType) fail(`no iPhone device type available for ${runtime.identifier}.`);

process.stderr.write(
  `verify-ios: Xcode at ${process.env.DEVELOPER_DIR ?? "the selected developer directory"}, ` +
    `${runtime.identifier} on ${deviceType.identifier}\n`,
);
const udid = simulatorUdid(runtime, deviceType);

run("xcodegen", ["generate"]);
// build-for-testing then test-without-building keeps a compile failure
// distinguishable from a test failure in the log. Both phases pin the same
// derived-data path so the test phase reads the build this script just
// produced, rather than depending on Xcode locating it in the default
// DerivedData, which a fresh runner does not have.
const derivedData = join(iosRoot, ".build", "derived-data");
run("xcodebuild", [
  "build-for-testing",
  "-scheme", SCHEME,
  "-destination", "generic/platform=iOS Simulator",
  "-derivedDataPath", derivedData,
  "CODE_SIGNING_ALLOWED=NO",
  "-quiet",
]);
run("xcodebuild", [
  "test-without-building",
  "-scheme", SCHEME,
  "-destination", `platform=iOS Simulator,id=${udid}`,
  "-derivedDataPath", derivedData,
  // A fresh hosted simulator can wedge its first accessibility snapshot while
  // XCTest finishes loading the runtime's accessibility bundles. Retry only
  // the failed test once; a repeat failure still fails the verification leg.
  "-retry-tests-on-failure",
  "-test-iterations", "2",
  "CODE_SIGNING_ALLOWED=NO",
]);
