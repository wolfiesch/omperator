import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKSUMS_NAME,
  createStableReleaseManifest,
  expectedPublishedAssetNames,
  generateStableReleaseManifest,
  LINUX_UPDATE_METADATA_NAME,
  parseChecksums,
  releasePackageDescriptors,
} from "./generate-release-manifest.mjs";

const version = "0.1.17";
const tag = `v${version}`;
const packages = releasePackageDescriptors(version);
const deb = packages.find(({ kind }) => kind === "deb").name;
const appImage = packages.find(({ kind }) => kind === "appimage").name;
const debSha512 = Buffer.alloc(64, 1).toString("base64");
const appImageSha512 = Buffer.alloc(64, 2).toString("base64");

function digest(name) {
  return createHash("sha256").update(name).digest("hex");
}

function fixture() {
  const checksummed = [...packages.map(({ name }) => name), LINUX_UPDATE_METADATA_NAME];
  const checksumsText = `${checksummed.map((name) => `${digest(name)}  ${name}`).join("\n")}\n`;
  const assets = expectedPublishedAssetNames(version).map((name, index) => ({
    name,
    state: "uploaded",
    size: name === deb ? 100 : name === appImage ? 200 : 300 + index,
    digest: `sha256:${name === CHECKSUMS_NAME ? digest("checksum-file") : digest(name)}`,
    browser_download_url: `https://github.com/wolfiesch/omperator/releases/download/${tag}/${name}`,
  }));
  return {
    checksumsText,
    linuxMetadataText: `version: ${version}
files:
  - url: ${appImage}
    sha512: ${appImageSha512}
    size: 200
    blockMapSize: 20
  - url: ${deb}
    sha512: ${debSha512}
    size: 100
path: ${appImage}
sha512: ${appImageSha512}
releaseDate: '2026-07-15T20:00:00Z'
`,
    release: {
      tag_name: tag,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/wolfiesch/omperator/releases/tag/${tag}`,
      published_at: "2026-07-15T20:00:00Z",
      assets,
    },
  };
}

function unboundedStreamingResponse({ contentLength, chunkBytes }) {
  let canceled = false;
  const chunk = new Uint8Array(chunkBytes);
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return {
    response: { ok: true, status: 200, headers, body },
    wasCanceled: () => canceled,
  };
}

test("builds the small deterministic stable manifest in canonical platform order", () => {
  const value = fixture();
  const manifest = createStableReleaseManifest({ version, ...value });
  assert.deepEqual(Object.keys(manifest), [
    "schemaVersion",
    "channel",
    "version",
    "tag",
    "publishedAt",
    "releaseUrl",
    "assets",
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.channel, "stable");
  assert.deepEqual(manifest.assets.map(({ kind }) => kind), ["apk", "deb", "appimage", "dmg", "zip"]);
  assert.deepEqual(manifest.assets.map(({ sha256 }) => sha256), packages.map(({ name }) => digest(name)));
  assert.ok(manifest.assets.every(({ url }) => url.includes(`/releases/download/${tag}/`)));
});

test("checksum parser requires one exact entry per package and Linux metadata", () => {
  const { checksumsText } = fixture();
  const names = [...packages.map(({ name }) => name), LINUX_UPDATE_METADATA_NAME];
  assert.equal(parseChecksums(checksumsText, names).size, 6);
  assert.throws(() => parseChecksums(`${checksumsText}${digest("extra")}  extra.bin\n`, names), /exactly/u);
  assert.throws(() => parseChecksums(checksumsText.replace("  Omperator", " *Omperator"), names), /invalid/u);
});

test("fails closed on extra, renamed, draft, mutable-URL, and digest drift", () => {
  const cases = [
    (value) => value.release.assets.push({ ...value.release.assets[0], name: "extra.bin" }),
    (value) => { value.release.assets[0].name = "renamed.apk"; },
    (value) => { value.release.draft = true; },
    (value) => { value.release.assets[0].browser_download_url = "https://example.invalid/file"; },
    (value) => { value.release.assets[0].digest = `sha256:${"0".repeat(64)}`; },
    (value) => { value.linuxMetadataText = value.linuxMetadataText.replace(deb, "renamed.deb"); },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => createStableReleaseManifest({ version, ...value }));
  }
});

test("bounds and cancels an oversized API response without Content-Length", async () => {
  const streamed = unboundedStreamingResponse({ chunkBytes: 1100 * 1024 });
  await assert.rejects(
    generateStableReleaseManifest({
      version,
      fetchImpl: async () => streamed.response,
    }),
    /release response exceeded 2097152 bytes/u,
  );
  assert.equal(streamed.wasCanceled(), true);
});

test("bounds and cancels an oversized API response with a lying Content-Length", async () => {
  const streamed = unboundedStreamingResponse({ contentLength: "1", chunkBytes: 1100 * 1024 });
  await assert.rejects(
    generateStableReleaseManifest({
      version,
      fetchImpl: async () => streamed.response,
    }),
    /release response exceeded 2097152 bytes/u,
  );
  assert.equal(streamed.wasCanceled(), true);
});
