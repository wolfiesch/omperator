import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseCodesignDisplay,
  validateMacosLibraryValidationBoundary,
  validateMacosIdentityContract,
  validateMacosSignatureReport,
} from "./inspect-macos-release.mjs";

const identity = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../.github/macos-release-identity.json"), "utf8"),
);

const displayFixture = `
Executable=/Applications/T4 Code.app/Contents/MacOS/t4-code
Identifier=net.t4code.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=640 flags=0x10000(runtime) hashes=10+7 location=embedded
Authority=Developer ID Application: Michael Schoenberger (WJLM3D3DK6)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Jul 18, 2026 at 8:30:00 PM
TeamIdentifier=WJLM3D3DK6
`;

test("macOS release identity pins the public Developer ID contract", () => {
  assert.doesNotThrow(() => validateMacosIdentityContract(identity));
  assert.equal(identity.firstSignedReleaseTag, "v0.1.33");
  assert.equal(identity.notarizationRequired, true);
});

test("library validation is relaxed for the bundled runtime but not the app", () => {
  const relaxed = `<?xml version="1.0"?><plist><dict>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
  </dict></plist>`;
  const hardened = `<?xml version="1.0"?><plist><dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
  </dict></plist>`;

  assert.doesNotThrow(() => validateMacosLibraryValidationBoundary(hardened, relaxed));
  assert.throws(
    () => validateMacosLibraryValidationBoundary(relaxed, relaxed),
    /top-level T4 Code app must keep library validation enabled/u,
  );
  assert.throws(
    () => validateMacosLibraryValidationBoundary(hardened, hardened),
    /bundled OMP runtime must disable library validation/u,
  );
});

test("codesign display parser preserves identity, runtime, and timestamp", () => {
  assert.deepEqual(parseCodesignDisplay(displayFixture), {
    identifier: "net.t4code.app",
    teamIdentifier: "WJLM3D3DK6",
    timestamp: "Jul 18, 2026 at 8:30:00 PM",
    authorities: [
      "Developer ID Application: Michael Schoenberger (WJLM3D3DK6)",
      "Developer ID Certification Authority",
      "Apple Root CA",
    ],
    hardenedRuntime: true,
  });
});

test("signature report fails closed on certificate, team, runtime, and timestamp drift", async (t) => {
  const valid = {
    ...parseCodesignDisplay(displayFixture),
    certificateSha256: identity.certificateSha256,
  };
  assert.doesNotThrow(() => validateMacosSignatureReport(valid, identity));

  const cases = [
    ["certificate", { certificateSha256: "0".repeat(64) }, /certificate SHA-256/u],
    ["team", { teamIdentifier: "AAAAAAAAAA" }, /team identifier/u],
    ["runtime", { hardenedRuntime: false }, /hardened runtime/u],
    ["timestamp", { timestamp: null }, /timestamp/u],
  ];
  for (const [name, override, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateMacosSignatureReport({ ...valid, ...override }, identity), expected);
    });
  }
});
