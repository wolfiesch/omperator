import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import config from "../electron-builder.config.mjs";
import { validateMacosIdentityContract } from "./inspect-macos-release.mjs";
import {
  createT4MacOptionsForFile,
  isBundledOmpRuntime,
  macSigner,
  normalizeMacSignOptions,
} from "./sign-macos.mjs";
import { createPackage } from "@electron/asar";
import { runPreflight, validatePreloadArtifact, validateWebIndex } from "./package-preflight.mjs";
import { inspectPackage, locateAppRoot } from "./inspect-package.mjs";
import { LINUX_ICON_SIZES, verifyDesktopIcon } from "./desktop-icon-checks.mjs";
import {
  buildElectronBuilderArgs,
  PUBLIC_ARTIFACT_UMASK,
  withPublicArtifactUmask,
  withPublicReadAccess,
} from "./run-electron-builder.mjs";
import {
  deriveAndroidVersionCode,
  parseAaptBadging,
  parseApkSignerReport,
  validateAndroidRelease,
  validateIdentityContract,
} from "./inspect-android-release.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const androidIdentity = JSON.parse(
  readFileSync(resolve(repoRoot, ".github/android-release-identity.json"), "utf8"),
);
const macosIdentity = JSON.parse(
  readFileSync(resolve(repoRoot, ".github/macos-release-identity.json"), "utf8"),
);
const productionCertificate = "fa58f53c953a078d8db2b633ee8c226cfd2ad3f7220cd55dd03a2e195a81b0ac";

function androidReleaseFixture(overrides = {}) {
  const packageVersion = overrides.packageVersion ?? "0.1.17";
  const versionCode = deriveAndroidVersionCode(packageVersion);
  const contract = structuredClone(androidIdentity);
  Object.assign(contract, overrides.contract);
  return {
    contract,
    packageVersion,
    mobilePackageVersion: overrides.mobilePackageVersion ?? packageVersion,
    apkName: overrides.apkName ?? "app-release.apk",
    apkFileNames: overrides.apkFileNames ?? ["app-release.apk"],
    outputMetadata: overrides.outputMetadata ?? {
      artifactType: { type: "APK", kind: "Directory" },
      applicationId: contract.applicationId,
      variantName: "release",
      elements: [
        {
          type: "SINGLE",
          filters: [],
          versionCode,
          versionName: packageVersion,
          outputFile: "app-release.apk",
        },
      ],
    },
    badgingOutput:
      overrides.badgingOutput ??
      `package: name='${contract.applicationId}' versionCode='${versionCode}' versionName='${packageVersion}' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'\nsdkVersion:'${contract.minSdkVersion}'\ntargetSdkVersion:'${contract.targetSdkVersion}'\n`,
    manifestTreeOutput:
      overrides.manifestTreeOutput ?? 'E: manifest\n  A: package="com.lycaonsolutions.t4code"\n',
    signerOutput:
      overrides.signerOutput ??
      `Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${productionCertificate}\n`,
  };
}

test("builder config keeps release contract", () => {
  assert.equal(config.appId, "com.lycaonsolutions.t4code");
  assert.equal(config.productName, "T4 Code");
  assert.equal(config.asar, true);
  assert.deepEqual(config.protocols[0].schemes, ["t4-code"]);
  assert.equal(config.linux.category, "Development");
  assert.deepEqual(config.linux.publish, [
    { provider: "github", owner: "LycaonLLC", repo: "t4-code", channel: "latest" },
  ]);
  assert.equal(config.mac.category, "public.app-category.developer-tools");
  assert.deepEqual(config.mac.publish, []);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.artifactName, "T4-Code-${version}-${os}-${arch}.${ext}");
  assert.ok(config.extraResources.some((entry) => entry.to === "runtime/t4-host"));
});

test("signed macOS packaging is explicit, credentialed, and release-gated", async () => {
  const previousSignedBuild = process.env.T4_MACOS_SIGNED_BUILD;
  process.env.T4_MACOS_SIGNED_BUILD = "1";
  try {
    const signedConfigUrl = new URL("../electron-builder.config.mjs", import.meta.url);
    signedConfigUrl.searchParams.set("signed-test", String(Date.now()));
    const { default: signedConfig } = await import(signedConfigUrl.href);
    assert.equal(signedConfig.mac.identity, undefined);
    assert.equal(signedConfig.mac.hardenedRuntime, true);
    assert.equal(signedConfig.mac.notarize, true);
    assert.equal(signedConfig.mac.entitlements, "apps/desktop/build/entitlements.mac.plist");
    assert.equal(signedConfig.mac.entitlementsInherit, "apps/desktop/build/entitlements.mac.plist");
    assert.equal(signedConfig.mac.sign, "scripts/sign-macos.mjs");
    assert.deepEqual(signedConfig.mac.publish, []);
  } finally {
    if (previousSignedBuild === undefined) delete process.env.T4_MACOS_SIGNED_BUILD;
    else process.env.T4_MACOS_SIGNED_BUILD = previousSignedBuild;
  }

  assert.doesNotThrow(() => validateMacosIdentityContract(macosIdentity));
  const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  for (const expected of [
    "T4_MACOS_CERTIFICATE_BASE64",
    "T4_MACOS_CERTIFICATE_PASSWORD",
    "T4_APPLE_API_KEY_BASE64",
    "T4_APPLE_API_KEY_ID",
    "T4_APPLE_API_ISSUER_ID",
    "T4_APPLE_TEAM_ID",
    "pnpm package:mac",
    "scripts/inspect-macos-release.mjs",
  ]) {
    assert.ok(releaseWorkflow.includes(expected), `release workflow must include ${expected}`);
  }
  assert.doesNotMatch(releaseWorkflow, /Build unsigned macOS packages/u);
});

test("desktop release builders install the pinned Bun compiler before packaging", () => {
  const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  const jobs = [
    ["build-linux", "build-android", "pnpm package:linux"],
    ["build-macos", "publish", "pnpm package:mac"],
  ];

  for (const [jobName, nextJobName, packageCommand] of jobs) {
    const job = releaseWorkflow.slice(
      releaseWorkflow.indexOf(`  ${jobName}:`),
      releaseWorkflow.indexOf(`  ${nextJobName}:`),
    );
    const setupBun = job.indexOf(
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    const pinnedVersion = job.indexOf("bun-version: 1.3.14");
    const packaging = job.indexOf(packageCommand);

    assert.ok(setupBun >= 0, `${jobName} must install Bun`);
    assert.ok(pinnedVersion > setupBun, `${jobName} must pin the Bun version`);
    assert.ok(packaging > pinnedVersion, `${jobName} must install Bun before packaging`);
  }
});

test("signed macOS packaging relaxes library validation only for the bundled OMP runtime", () => {
  const appPath = "/tmp/T4 Code.app";
  const inherited = () => ({
    entitlements: "apps/desktop/build/entitlements.mac.plist",
    hardenedRuntime: true,
  });
  const optionsForFile = createT4MacOptionsForFile(inherited);
  const runtimePath = `${appPath}/Contents/Resources/runtime/omp`;
  const helperPath = `${appPath}/Contents/Frameworks/T4 Code Helper.app`;

  assert.equal(isBundledOmpRuntime(runtimePath), true);
  assert.equal(isBundledOmpRuntime(`${runtimePath}.backup`), false);
  assert.deepEqual(optionsForFile(helperPath), inherited());
  assert.deepEqual(optionsForFile(runtimePath), {
    ...inherited(),
    entitlements: "apps/desktop/build/entitlements.omp-runtime.plist",
  });
});

test("macOS signing accepts current and legacy electron-builder callback shapes", () => {
  const current = { app: "/tmp/current.app", identity: "certificate" };
  assert.equal(normalizeMacSignOptions(current), current);
  assert.deepEqual(
    normalizeMacSignOptions({ path: "/tmp/legacy.app", options: { identity: "certificate" } }),
    { app: "/tmp/legacy.app", identity: "certificate" },
  );
  assert.throws(() => normalizeMacSignOptions({}), /did not provide an application path/u);
});

test("macOS signing uses the Promise API that electron-builder can await", async () => {
  const pending = macSigner({});
  assert.equal(typeof pending?.then, "function");
  await assert.rejects(pending);
});

test("Android release identity is public, pinned, and wired into the release workflow", () => {
  assert.doesNotThrow(() => validateIdentityContract(androidIdentity));
  assert.equal(androidIdentity.applicationId, "com.lycaonsolutions.t4code");
  assert.equal(androidIdentity.minSdkVersion, 24);
  assert.equal(androidIdentity.targetSdkVersion, 36);
  assert.equal(androidIdentity.signingCertificateSha256, productionCertificate);
  assert.equal(androidIdentity.certificateBaseline.tag, "v0.1.13");
  assert.equal(androidIdentity.certificateBaseline.asset, "T4-Code-0.1.13-android.apk");

  const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(releaseWorkflow, /node scripts\/inspect-android-release\.mjs/u);
  assert.match(releaseWorkflow, /--metadata "\$metadata"/u);
  assert.match(releaseWorkflow, /--aapt "\$build_tools\/aapt"/u);
  assert.match(releaseWorkflow, /--apksigner "\$build_tools\/apksigner"/u);
  const androidDebugGate = releaseWorkflow.indexOf(
    "pnpm --filter @t4-code/mobile check:android:debug",
  );
  const androidReleaseBuild = releaseWorkflow.indexOf(
    "pnpm --filter @t4-code/mobile build:android:release",
  );
  assert.ok(androidDebugGate >= 0, "release workflow must run the Android debug verification gate");
  assert.ok(
    androidDebugGate < androidReleaseBuild,
    "Android verification must precede the signed build",
  );
});

test("Android versionCode is derived from the package version without a release-specific constant", () => {
  assert.equal(deriveAndroidVersionCode("0.1.13"), 10_013);
  assert.equal(deriveAndroidVersionCode("0.1.17"), 10_017);
  assert.equal(deriveAndroidVersionCode("1.2.3456"), 1_023_456);
  assert.throws(() => deriveAndroidVersionCode("0.1.17-beta.1"), /numeric major\.minor\.patch/u);
  assert.throws(() => deriveAndroidVersionCode("0.100.0"), /minor version must be at most 99/u);
  assert.throws(() => deriveAndroidVersionCode("0.1.10000"), /patch version must be at most 9999/u);
});

test("Android artifact parsers preserve exact package, SDK, split, and certificate identity", () => {
  assert.deepEqual(
    parseAaptBadging(
      "package: name='com.lycaonsolutions.t4code' versionCode='10017' versionName='0.1.17'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n",
    ),
    {
      applicationId: "com.lycaonsolutions.t4code",
      versionCode: 10_017,
      versionName: "0.1.17",
      minSdkVersion: 24,
      targetSdkVersion: 36,
      splitName: null,
      declaresSplitDependency: false,
    },
  );
  assert.deepEqual(
    parseApkSignerReport(
      `Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: FA:58:F5:3C:95:3A:07:8D:8D:B2:B6:33:EE:8C:22:6C:FD:2A:D3:F7:22:0C:D5:5D:D0:3A:2E:19:5A:81:B0:AC\n`,
    ),
    {
      signerCount: 1,
      certificateDigests: [productionCertificate],
      modernSchemeVerified: true,
    },
  );
});

test("Android release inspector accepts the exact production universal APK contract", () => {
  assert.deepEqual(validateAndroidRelease(androidReleaseFixture()), {
    applicationId: "com.lycaonsolutions.t4code",
    versionName: "0.1.17",
    versionCode: 10_017,
    minSdkVersion: 24,
    targetSdkVersion: 36,
    signingCertificateSha256: productionCertificate,
  });
});

test("Android release inspector fails closed on identity, SDK, split, and signer drift", async (t) => {
  const cases = [
    [
      "application id",
      {
        badgingOutput:
          "package: name='example.wrong' versionCode='10017' versionName='0.1.17'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n",
      },
      /applicationId example\.wrong/u,
    ],
    [
      "version name",
      {
        badgingOutput:
          "package: name='com.lycaonsolutions.t4code' versionCode='10017' versionName='0.1.18'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n",
      },
      /versionName 0\.1\.18/u,
    ],
    [
      "version code",
      {
        badgingOutput:
          "package: name='com.lycaonsolutions.t4code' versionCode='10016' versionName='0.1.17'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n",
      },
      /versionCode 10016/u,
    ],
    [
      "minimum sdk",
      {
        badgingOutput:
          "package: name='com.lycaonsolutions.t4code' versionCode='10017' versionName='0.1.17'\nsdkVersion:'23'\ntargetSdkVersion:'36'\n",
      },
      /minSdkVersion 23/u,
    ],
    [
      "target sdk",
      {
        badgingOutput:
          "package: name='com.lycaonsolutions.t4code' versionCode='10017' versionName='0.1.17'\nsdkVersion:'24'\ntargetSdkVersion:'35'\n",
      },
      /targetSdkVersion 35/u,
    ],
    [
      "split package",
      {
        badgingOutput:
          "package: name='com.lycaonsolutions.t4code' versionCode='10017' versionName='0.1.17' split='config.arm64_v8a'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n",
      },
      /standalone/u,
    ],
    [
      "split manifest",
      { manifestTreeOutput: 'E: manifest\n  A: split="config.en"\n' },
      /split-only metadata/u,
    ],
    [
      "split output metadata",
      {
        outputMetadata: {
          artifactType: { type: "APK" },
          applicationId: "com.lycaonsolutions.t4code",
          variantName: "release",
          elements: [
            {
              type: "SINGLE",
              filters: [{ filterType: "ABI", value: "arm64-v8a" }],
              versionCode: 10_017,
              versionName: "0.1.17",
              outputFile: "app-release.apk",
            },
          ],
        },
      },
      /must have no ABI/u,
    ],
    [
      "wrong certificate",
      {
        signerOutput: `Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${"0".repeat(64)}\n`,
      },
      /pinned production certificate/u,
    ],
    [
      "multiple signers",
      {
        signerOutput: `Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 2\nSigner #1 certificate SHA-256 digest: ${productionCertificate}\nSigner #2 certificate SHA-256 digest: ${"1".repeat(64)}\n`,
      },
      /exactly one signing certificate/u,
    ],
  ];

  for (const [name, overrides, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateAndroidRelease(androidReleaseFixture(overrides)), expected);
    });
  }
});

test("builder never publishes implicitly from a release tag", () => {
  assert.deepEqual(buildElectronBuilderArgs(["--linux", "--x64"], repoRoot).slice(-2), [
    "--publish",
    "never",
  ]);
});

test("builder uses a public artifact umask without changing its caller", () => {
  const original = process.umask(0o077);
  try {
    let observed;
    withPublicArtifactUmask(() => {
      observed = process.umask();
    });
    assert.equal(observed, PUBLIC_ARTIFACT_UMASK);
    assert.equal(process.umask(), 0o077);
  } finally {
    process.umask(original);
  }
});

test("builder exposes restrictive source assets only while packaging", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-package-mode-"));
  const asset = join(scratch, "icon.png");
  try {
    writeFileSync(asset, "fixture");
    chmodSync(asset, 0o600);
    withPublicReadAccess([asset], () => {
      assert.equal(statSync(asset).mode & 0o777, 0o644);
    });
    assert.equal(statSync(asset).mode & 0o777, 0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("preflight accepts built desktop inputs", () => {
  const result = runPreflight(repoRoot);
  assert.ok(existsSync(result.electronEntry));
  assert.ok(existsSync(result.webIndex));
});

test("web index preflight rejects absolute assets, inline executable scripts, and missing bootstrap", () => {
  const valid =
    '<script src="./t4-bootstrap.js"></script><script type="module" src="./assets/main.js"></script><link rel="stylesheet" href="./assets/main.css">';
  assert.deepEqual(validateWebIndex(valid), []);
  assert.ok(
    validateWebIndex(
      '<script src="/src/main.js"></script><script src="./t4-bootstrap.js"></script>',
    ).some((error) => error.includes("root-absolute")),
  );
  assert.ok(
    validateWebIndex('<script src="./t4-bootstrap.js"></script><script>window.x=1</script>').some(
      (error) => error.includes("inline"),
    ),
  );
  assert.ok(
    validateWebIndex('<script type="module" src="./main.js"></script>').some((error) =>
      error.includes("missing external"),
    ),
  );
});

test("preload artifact guard rejects local edges and requires the bridge marker", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-preload-guard-"));
  try {
    const bad = join(scratch, "bad.cjs");
    writeFileSync(bad, 'require("./chunks/desktop-ipc.cjs");');
    assert.deepEqual(validatePreloadArtifact(bad), [
      "preload contains a relative or local module require/import",
      "preload is missing the exposeInMainWorld bridge marker",
    ]);

    const good = join(scratch, "good.cjs");
    writeFileSync(good, 'require("electron").contextBridge.exposeInMainWorld("ompShell", {});');
    assert.deepEqual(validatePreloadArtifact(good), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("artifact inspector reads unpacked package metadata", () => {
  const unpacked = resolve(repoRoot, "release/linux-unpacked");
  if (!existsSync(unpacked)) return;
  const result = inspectPackage(unpacked);
  assert.equal(result.manifest.productName, "T4 Code");
  assert.ok(result.asarEntries > 0);
});

test("artifact inspector reads macOS bundles with capitalized Resources", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-code-mac-root-"));
  try {
    const contents = join(scratch, "t4-code.app", "Contents");
    const resources = join(contents, "Resources");
    const asarSource = join(scratch, "asar-source");
    mkdirSync(join(resources, "web"), { recursive: true });
    mkdirSync(join(resources, "runtime"), { recursive: true });
    mkdirSync(join(asarSource, "dist-electron"), { recursive: true });
    writeFileSync(join(resources, "web", "index.html"), "<!doctype html>");
    writeFileSync(join(resources, "LICENSE"), "MIT");
    writeFileSync(join(resources, "runtime", "t4-host"), "host");
    chmodSync(join(resources, "runtime", "t4-host"), 0o755);
    writeFileSync(join(asarSource, "dist-electron", "main.cjs"), "");
    writeFileSync(join(asarSource, "dist-electron", "preload.cjs"), "");
    writeFileSync(
      join(asarSource, "package.json"),
      JSON.stringify({ productName: config.productName }),
    );
    await createPackage(asarSource, join(resources, "app.asar"));
    assert.equal(locateAppRoot(scratch), contents);
    const result = inspectPackage(contents);
    assert.equal(result.manifest.productName, config.productName);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("builder config wires the T4 icon set for linux and the 1024 master for mac", () => {
  assert.equal(config.linux.icon, "apps/desktop/build/icons");
  assert.equal(config.mac.icon, "apps/desktop/build/icon.png");
  assert.ok(existsSync(resolve(repoRoot, config.mac.icon)));
  assert.ok(existsSync(resolve(repoRoot, "apps/desktop/build/icon.svg")));
  for (const size of LINUX_ICON_SIZES) {
    assert.ok(
      existsSync(resolve(repoRoot, config.linux.icon, `${size}x${size}.png`)),
      `missing ${size}x${size}.png`,
    );
  }
});

test("desktop icon set satisfies the brand raster contract at every size", () => {
  const { errors } = verifyDesktopIcon(repoRoot);
  assert.deepEqual(errors, []);
});

test("icon verification fails closed when assets are missing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-icon-check-"));
  try {
    const { errors } = verifyDesktopIcon(scratch);
    assert.ok(errors.some((message) => message.includes("icon.svg")));
    assert.ok(errors.some((message) => message.includes("icon.png")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
