import assert from "node:assert/strict";
import test from "node:test";
import { validateMacUpdateMetadata } from "./inspect-macos-update.mjs";

const sha512 = Buffer.alloc(64, 7).toString("base64");
const dmgSha512 = Buffer.alloc(64, 8).toString("base64");

function metadata(overrides = {}) {
  return [
    "version: 0.2.0",
    "files:",
    "  - url: Omperator-0.2.0-mac-arm64.zip",
    `    sha512: ${sha512}`,
    "    size: 1234",
    "  - url: Omperator-0.2.0-mac-arm64.dmg",
    `    sha512: ${dmgSha512}`,
    "    size: 2345",
    "path: Omperator-0.2.0-mac-arm64.zip",
    `sha512: ${sha512}`,
    "releaseDate: '2026-07-25T00:00:00.000Z'",
    ...Object.entries(overrides).map(([key, value]) => `${key}: ${value}`),
  ].join("\n");
}

test("validates the exact signed macOS update zip contract", () => {
  assert.deepEqual(
    validateMacUpdateMetadata(metadata(), {
      version: "0.2.0",
      zipName: "Omperator-0.2.0-mac-arm64.zip",
      zipSize: 1234,
      zipSha512: sha512,
      dmgName: "Omperator-0.2.0-mac-arm64.dmg",
      dmgSize: 2345,
      dmgSha512,
    }),
    {
      version: "0.2.0",
      zipName: "Omperator-0.2.0-mac-arm64.zip",
      zipSize: 1234,
      zipSha512: sha512,
      dmgName: "Omperator-0.2.0-mac-arm64.dmg",
      dmgSize: 2345,
      dmgSha512,
    },
  );
});

test("rejects extra fields and zip identity, size, or digest substitution", () => {
  const options = {
    version: "0.2.0",
    zipName: "Omperator-0.2.0-mac-arm64.zip",
    zipSize: 1234,
    zipSha512: sha512,
    dmgName: "Omperator-0.2.0-mac-arm64.dmg",
    dmgSize: 2345,
    dmgSha512,
  };
  assert.throws(() => validateMacUpdateMetadata(metadata({ extra: true }), options), /unsupported fields/u);
  assert.throws(
    () => validateMacUpdateMetadata(metadata().replace("size: 1234", "size: 1235"), options),
    /size does not match/u,
  );
  assert.throws(
    () =>
      validateMacUpdateMetadata(
        metadata().replace(sha512, Buffer.alloc(64, 8).toString("base64")),
        options,
      ),
    /does not match/u,
  );
});
