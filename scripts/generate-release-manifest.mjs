import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedReleaseAssetNames } from "./check-release-consistency.mjs";
import { validateLinuxUpdateMetadata } from "./inspect-linux-update.mjs";
import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const REPOSITORY = "wolfiesch/omperator";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const LINUX_UPDATE_METADATA_NAME = "latest-linux.yml";
export const MAC_UPDATE_METADATA_NAME = "latest-mac.yml";
export const CHECKSUMS_NAME = "SHA256SUMS.txt";

export function macUpdateBlockmapName(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  return `T4-Code-${version}-mac-arm64.zip.blockmap`;
}

export function releasePackageDescriptors(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  const names = expectedReleaseAssetNames(version);
  return [
    { platform: "android", kind: "apk", arch: "universal", name: names[0] },
    { platform: "linux", kind: "deb", arch: "x86_64", name: names[1] },
    { platform: "linux", kind: "appimage", arch: "x86_64", name: names[2] },
    { platform: "mac", kind: "dmg", arch: "arm64", name: names[3] },
    { platform: "mac", kind: "zip", arch: "arm64", name: names[4] },
  ];
}

export function expectedPublishedAssetNames(version) {
  return [
    ...expectedReleaseAssetNames(version),
    LINUX_UPDATE_METADATA_NAME,
    MAC_UPDATE_METADATA_NAME,
    macUpdateBlockmapName(version),
    CHECKSUMS_NAME,
  ];
}

export function parseChecksums(text, expectedNames) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_METADATA_BYTES) {
    throw new Error(`${CHECKSUMS_NAME} must be non-empty and at most 64 KiB`);
  }
  const checksums = new Map();
  for (const [index, line] of text.replace(/\r\n?/gu, "\n").trimEnd().split("\n").entries()) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    if (!match) throw new Error(`${CHECKSUMS_NAME} has an invalid entry on line ${index + 1}`);
    const [, digest, name] = match;
    if (checksums.has(name)) throw new Error(`${CHECKSUMS_NAME} repeats ${name}`);
    checksums.set(name, digest);
  }
  if (checksums.size !== expectedNames.length) {
    throw new Error(`${CHECKSUMS_NAME} must contain exactly ${expectedNames.length} entries`);
  }
  for (const name of expectedNames) {
    if (!checksums.has(name)) throw new Error(`${CHECKSUMS_NAME} is missing ${name}`);
  }
  for (const name of checksums.keys()) {
    if (!expectedNames.includes(name)) throw new Error(`${CHECKSUMS_NAME} has unexpected ${name}`);
  }
  return checksums;
}

function exactReleaseAssetMap(release, version) {
  if (!release || typeof release !== "object") throw new Error("GitHub release payload is invalid");
  const tag = `v${version}`;
  const expectedReleaseUrl = `${REPOSITORY_URL}/releases/tag/${tag}`;
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`GitHub release must be the published stable ${tag} release`);
  }
  if (release.html_url !== expectedReleaseUrl) throw new Error("GitHub release URL is not exact");
  if (typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error("GitHub release published_at must be a timestamp");
  }
  const expectedNames = expectedPublishedAssetNames(version);
  if (!Array.isArray(release.assets) || release.assets.length !== expectedNames.length) {
    throw new Error(`GitHub release must contain exactly ${expectedNames.length} published assets`);
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.name !== "string") {
      throw new Error("GitHub release contains an invalid asset");
    }
    if (assets.has(asset.name)) throw new Error(`GitHub release repeats ${asset.name}`);
    if (!expectedNames.includes(asset.name)) throw new Error(`GitHub release has unexpected ${asset.name}`);
    const expectedUrl = `${REPOSITORY_URL}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
    if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`${asset.name} must be a non-empty uploaded asset`);
    }
    if (asset.browser_download_url !== expectedUrl) {
      throw new Error(`${asset.name} download URL is not the immutable tagged URL`);
    }
    if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) {
      throw new Error(`${asset.name} must expose its GitHub SHA-256 digest`);
    }
    assets.set(asset.name, asset);
  }
  for (const name of expectedNames) {
    if (!assets.has(name)) throw new Error(`GitHub release is missing ${name}`);
  }
  return assets;
}

export function createStableReleaseManifest({ version, release, checksumsText, linuxMetadataText }) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  const packageDescriptors = releasePackageDescriptors(version);
  const releaseAssets = exactReleaseAssetMap(release, version);
  const checksummedNames = [...packageDescriptors.map(({ name }) => name), LINUX_UPDATE_METADATA_NAME];
  const checksums = parseChecksums(checksumsText, checksummedNames);

  for (const name of checksummedNames) {
    const githubDigest = releaseAssets.get(name).digest.slice("sha256:".length);
    if (checksums.get(name) !== githubDigest) {
      throw new Error(`${name} GitHub digest does not match ${CHECKSUMS_NAME}`);
    }
  }

  const linuxArtifacts = new Map(
    packageDescriptors
      .filter(({ platform }) => platform === "linux")
      .map(({ name }) => [name, { size: releaseAssets.get(name).size }]),
  );
  validateLinuxUpdateMetadata(linuxMetadataText, { version, artifacts: linuxArtifacts });

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    channel: "stable",
    version,
    tag: `v${version}`,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    assets: packageDescriptors.map((descriptor) => {
      const asset = releaseAssets.get(descriptor.name);
      return {
        ...descriptor,
        url: asset.browser_download_url,
        size: asset.size,
        sha256: checksums.get(descriptor.name),
      };
    }),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url, { token, maxBytes, accept, fetchImpl }) {
  const headers = {
    Accept: accept,
    "User-Agent": "t4-code-release-manifest",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
  const bytes = await readBoundedResponseBytes(response, { maxBytes, label: "release response" });
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error("response size is invalid");
  return bytes;
}

export async function generateStableReleaseManifest({ version, token, fetchImpl = fetch }) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  const tag = `v${version}`;
  const apiBytes = await fetchBytes(
    `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`,
    { token, maxBytes: MAX_API_BYTES, accept: "application/vnd.github+json", fetchImpl },
  );
  let release;
  try {
    release = JSON.parse(apiBytes.toString("utf8"));
  } catch {
    throw new Error("GitHub release response is not valid JSON");
  }
  const assets = exactReleaseAssetMap(release, version);
  const checksumAsset = assets.get(CHECKSUMS_NAME);
  const metadataAsset = assets.get(LINUX_UPDATE_METADATA_NAME);
  const [checksumsBytes, metadataBytes] = await Promise.all([
    fetchBytes(checksumAsset.browser_download_url, {
      token,
      maxBytes: MAX_METADATA_BYTES,
      accept: "application/octet-stream",
      fetchImpl,
    }),
    fetchBytes(metadataAsset.browser_download_url, {
      token,
      maxBytes: MAX_METADATA_BYTES,
      accept: "application/octet-stream",
      fetchImpl,
    }),
  ]);
  for (const [asset, bytes] of [
    [checksumAsset, checksumsBytes],
    [metadataAsset, metadataBytes],
  ]) {
    if (`sha256:${sha256(bytes)}` !== asset.digest) {
      throw new Error(`${asset.name} downloaded content does not match its GitHub digest`);
    }
  }
  return createStableReleaseManifest({
    version,
    release,
    checksumsText: checksumsBytes.toString("utf8"),
    linuxMetadataText: metadataBytes.toString("utf8"),
  });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--version") options.version = value;
    else if (flag === "--output") options.output = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.version || !options.output) {
    throw new Error("usage: generate-release-manifest.mjs --version x.y.z --output path/latest.json");
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await generateStableReleaseManifest({
      version: options.version,
      token: process.env.GH_TOKEN?.trim(),
    });
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    console.log(`Stable release manifest written for v${options.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
