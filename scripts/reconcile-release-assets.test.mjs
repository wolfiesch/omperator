import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKSUMS_NAME,
  expectedPublishedAssetNames,
  LINUX_UPDATE_METADATA_NAME,
  releasePackageDescriptors,
} from "./generate-release-manifest.mjs";
import {
  prepareExistingReleaseAssets,
  verifyExactPublishedReleaseAssets,
} from "./reconcile-release-assets.mjs";

const version = "0.1.17";
const tag = `v${version}`;
const packageDescriptors = releasePackageDescriptors(version);
const deb = packageDescriptors.find(({ kind }) => kind === "deb").name;
const appImage = packageDescriptors.find(({ kind }) => kind === "appimage").name;
const debSha512 = Buffer.alloc(64, 1).toString("base64");
const appImageSha512 = Buffer.alloc(64, 2).toString("base64");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function asset(name, id) {
  return {
    id,
    name,
    state: "uploaded",
    size: id + 100,
    digest: `sha256:${String(id).padStart(64, "0")}`,
    browser_download_url: `https://github.com/wolfiesch/omperator/releases/download/${tag}/${name}`,
  };
}

function release(assets = expectedPublishedAssetNames(version).map((name, index) => asset(name, index + 1))) {
  return {
    tag_name: tag,
    html_url: `https://github.com/wolfiesch/omperator/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: "2026-07-15T20:00:00Z",
    assets,
  };
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), { status });
}

function healthyFixture({ corruptChecksums = false } = {}) {
  const linuxMetadataText = `version: ${version}
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
`;
  const checksummedNames = [
    ...packageDescriptors.map(({ name }) => name),
    LINUX_UPDATE_METADATA_NAME,
  ];
  const expectedDigests = new Map(
    checksummedNames.map((name) => [
      name,
      name === LINUX_UPDATE_METADATA_NAME ? sha256(linuxMetadataText) : sha256(name),
    ]),
  );
  if (corruptChecksums) expectedDigests.set(packageDescriptors[0].name, "0".repeat(64));
  const checksumsText = `${checksummedNames
    .map((name) => `${expectedDigests.get(name)}  ${name}`)
    .join("\n")}\n`;
  const bodies = new Map([
    [CHECKSUMS_NAME, checksumsText],
    [LINUX_UPDATE_METADATA_NAME, linuxMetadataText],
  ]);
  const assets = expectedPublishedAssetNames(version).map((name, index) => {
    const body = bodies.get(name);
    const size = name === deb ? 100 : name === appImage ? 200 : body ? Buffer.byteLength(body) : 300 + index;
    const digest = body ? sha256(body) : sha256(name);
    return {
      id: index + 1,
      name,
      state: "uploaded",
      size,
      digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/wolfiesch/omperator/releases/download/${tag}/${name}`,
    };
  });
  return { release: release(assets), bodies };
}

function fixtureFetch(fixture, { deleted = [], failDownloads = false } = {}) {
  return async (url, init = {}) => {
    if (init.method === "DELETE") {
      deleted.push(Number(url.split("/").at(-1)));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/releases/tags/")) {
      return jsonResponse(200, deleted.length > 0 ? release([]) : fixture.release);
    }
    if (failDownloads) return new Response("unavailable", { status: 503 });
    const name = decodeURIComponent(url.split("/").at(-1));
    const body = fixture.bodies.get(name);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  };
}

test("preserves an exact healthy release as an idempotent no-op", async () => {
  const deleted = [];
  const fixture = healthyFixture();
  const result = await prepareExistingReleaseAssets({
    version,
    token: "test-token",
    fetchImpl: fixtureFetch(fixture, { deleted }),
  });

  assert.deepEqual(result, { state: "ready", deleted: 0, publishRequired: false });
  assert.deepEqual(deleted, []);
});

test("clears every invalid or incomplete asset before a repair publication", async () => {
  const initial = release([
    ...expectedPublishedAssetNames(version).map((name, index) => asset(name, index + 1)),
    asset("obsolete-debug.zip", 99),
  ]);
  const deleted = [];
  let getCount = 0;
  const result = await prepareExistingReleaseAssets({
    version,
    token: "test-token",
    fetchImpl: async (url, init) => {
      if (init.method === "DELETE") {
        deleted.push(Number(url.split("/").at(-1)));
        return new Response(null, { status: 204 });
      }
      getCount += 1;
      return jsonResponse(200, getCount === 1 ? initial : release([]));
    },
  });

  assert.deepEqual(result, { state: "cleared", deleted: 8, publishRequired: true });
  assert.deepEqual(deleted.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 99]);
});

test("treats only an exact release lookup 404 as a clean first publication", async () => {
  assert.deepEqual(
    await prepareExistingReleaseAssets({
      version,
      token: "test-token",
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    }),
    { state: "missing", deleted: 0, publishRequired: true },
  );
  await assert.rejects(
    prepareExistingReleaseAssets({
      version,
      token: "test-token",
      fetchImpl: async () => jsonResponse(401, { message: "Bad credentials" }),
    }),
    /HTTP 401/u,
  );
});

test("repairs exact-looking assets whose checksum manifest disagrees with GitHub digests", async () => {
  const fixture = healthyFixture({ corruptChecksums: true });
  const deleted = [];
  const result = await prepareExistingReleaseAssets({
    version,
    token: "test-token",
    fetchImpl: fixtureFetch(fixture, { deleted }),
  });

  assert.deepEqual(result, { state: "cleared", deleted: 7, publishRequired: true });
  assert.deepEqual(deleted.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});

test("does not delete a healthy-looking release when metadata downloads are temporarily unavailable", async () => {
  const fixture = healthyFixture();
  const deleted = [];
  await assert.rejects(
    prepareExistingReleaseAssets({
      version,
      token: "test-token",
      fetchImpl: fixtureFetch(fixture, { deleted, failDownloads: true }),
    }),
    /HTTP 503/u,
  );
  assert.deepEqual(deleted, []);
});

test("does not delete a healthy-looking release when downloaded metadata fails its GitHub digest", async () => {
  const fixture = healthyFixture();
  const deleted = [];
  const normalFetch = fixtureFetch(fixture, { deleted });
  const checksumsText = fixture.bodies.get(CHECKSUMS_NAME);
  const corruptChecksumsText = `${checksumsText.startsWith("0") ? "1" : "0"}${checksumsText.slice(1)}`;

  await assert.rejects(
    prepareExistingReleaseAssets({
      version,
      token: "test-token",
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith(`/${CHECKSUMS_NAME}`)) {
          return new Response(corruptChecksumsText, {
            status: 200,
            headers: { "content-length": String(Buffer.byteLength(corruptChecksumsText)) },
          });
        }
        return normalFetch(url, init);
      },
    }),
    /digest mismatch for SHA256SUMS\.txt/u,
  );
  assert.equal(Buffer.byteLength(corruptChecksumsText), Buffer.byteLength(checksumsText));
  assert.deepEqual(deleted, []);
});

test("verifies the exact seven-asset remote release bundle", async () => {
  const fixture = healthyFixture();
  const result = await verifyExactPublishedReleaseAssets({
    version,
    token: "test-token",
    fetchImpl: fixtureFetch(fixture),
  });
  assert.equal(result.tag, tag);
  assert.deepEqual(result.assets, expectedPublishedAssetNames(version));
});

test("rejects extra, missing, mutable-URL, digestless, and empty remote assets", async () => {
  const fixture = healthyFixture();
  const cases = [
    (assets) => assets.push(asset("obsolete-debug.zip", 99)),
    (assets) => assets.pop(),
    (assets) => { assets[0].browser_download_url = "https://example.invalid/file"; },
    (assets) => { assets[0].digest = null; },
    (assets) => { assets[0].size = 0; },
  ];
  for (const mutate of cases) {
    const assets = fixture.release.assets.map((value) => ({ ...value }));
    mutate(assets);
    await assert.rejects(
      verifyExactPublishedReleaseAssets({
        version,
        token: "test-token",
        fetchImpl: fixtureFetch({ ...fixture, release: release(assets) }),
      }),
    );
  }
});
