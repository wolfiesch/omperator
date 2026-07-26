import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKSUMS_NAME,
  createStableReleaseManifest,
  expectedPublishedAssetNames,
  LINUX_UPDATE_METADATA_NAME,
  MAC_UPDATE_METADATA_NAME,
} from "./generate-release-manifest.mjs";
import { validateMacUpdateMetadata } from "./inspect-macos-update.mjs";
import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const REPOSITORY = "wolfiesch/omperator";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_METADATA_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function requireVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("version must be x.y.z");
  }
  return version;
}

function headers(token) {
  if (!token) throw new Error("GH_TOKEN is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "t4-code-release-asset-reconciler",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function request(url, { token, method = "GET", fetchImpl }) {
  try {
    return await fetchImpl(url, {
      method,
      headers: headers(token),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub ${method} request failed for ${url}`, { cause: error });
  }
}

async function readJson(response, label) {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_API_RESPONSE_BYTES,
    label,
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function validateReleaseShell(release, version) {
  const tag = `v${version}`;
  if (
    !release ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    release.tag_name !== tag ||
    release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/${tag}` ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== "string" ||
    !Number.isFinite(Date.parse(release.published_at)) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(`GitHub response did not describe the published stable release ${tag}`);
  }
  return release;
}

async function fetchRelease({ version, token, fetchImpl, allowMissing }) {
  const tag = `v${version}`;
  const response = await request(
    `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`,
    { token, fetchImpl },
  );
  if (response.status === 404 && allowMissing) {
    try {
      await response.body?.cancel();
    } catch {
      // A closed error body needs no further cleanup.
    }
    return null;
  }
  if (response.status !== 200) {
    throw new Error(`GitHub release lookup for ${tag} returned HTTP ${response.status}`);
  }
  return validateReleaseShell(await readJson(response, "GitHub release response"), version);
}

function exactPublishedAssetMap(release, version) {
  const tag = `v${version}`;
  const expectedNames = expectedPublishedAssetNames(version);
  if (release.assets.length !== expectedNames.length) return null;

  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.name !== "string") return null;
    if (assets.has(asset.name) || !expectedNames.includes(asset.name)) return null;
    const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
    if (
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? "") ||
      asset.browser_download_url !== expectedUrl
    ) {
      return null;
    }
    assets.set(asset.name, asset);
  }
  return expectedNames.every((name) => assets.has(name)) ? assets : null;
}

async function fetchReleaseAssetBytes(asset, { token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(asset.browser_download_url, {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "User-Agent": "t4-code-release-asset-reconciler",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub asset download failed for ${asset.name}`, { cause: error });
  }
  if (response.status !== 200) {
    throw new Error(`GitHub asset download for ${asset.name} returned HTTP ${response.status}`);
  }
  return readBoundedResponseBytes(response, {
    maxBytes: MAX_RELEASE_METADATA_BYTES,
    label: asset.name,
  });
}

async function exactPublishedContentIsValid({ release, version, assets, token, fetchImpl }) {
  const checksumAsset = assets.get(CHECKSUMS_NAME);
  const metadataAsset = assets.get(LINUX_UPDATE_METADATA_NAME);
  const macMetadataAsset = assets.get(MAC_UPDATE_METADATA_NAME);
  const [checksumsBytes, metadataBytes, macMetadataBytes] = await Promise.all([
    fetchReleaseAssetBytes(checksumAsset, { token, fetchImpl }),
    fetchReleaseAssetBytes(metadataAsset, { token, fetchImpl }),
    fetchReleaseAssetBytes(macMetadataAsset, { token, fetchImpl }),
  ]);

  for (const [asset, bytes] of [
    [checksumAsset, checksumsBytes],
    [metadataAsset, metadataBytes],
    [macMetadataAsset, macMetadataBytes],
  ]) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (`sha256:${digest}` !== asset.digest) {
      throw new Error(`GitHub asset download digest mismatch for ${asset.name}`);
    }
  }

  try {
    createStableReleaseManifest({
      version,
      release,
      checksumsText: checksumsBytes.toString("utf8"),
      linuxMetadataText: metadataBytes.toString("utf8"),
    });
    const zipName = `T4-Code-${version}-mac-arm64.zip`;
    const dmgName = `T4-Code-${version}-mac-arm64.dmg`;
    validateMacUpdateMetadata(macMetadataBytes.toString("utf8"), {
      version,
      zipName,
      zipSize: assets.get(zipName).size,
      dmgName,
      dmgSize: assets.get(dmgName).size,
    });
    return true;
  } catch {
    return false;
  }
}

export async function prepareExistingReleaseAssets({ version, token, fetchImpl = fetch }) {
  requireVersion(version);
  const release = await fetchRelease({ version, token, fetchImpl, allowMissing: true });
  if (!release) return { state: "missing", deleted: 0, publishRequired: true };

  const exactAssets = exactPublishedAssetMap(release, version);
  if (
    exactAssets &&
    (await exactPublishedContentIsValid({ release, version, assets: exactAssets, token, fetchImpl }))
  ) {
    return { state: "ready", deleted: 0, publishRequired: false };
  }

  const seenIds = new Set();
  for (const asset of release.assets) {
    if (
      !asset ||
      typeof asset !== "object" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      seenIds.has(asset.id)
    ) {
      throw new Error("GitHub release contains an invalid or repeated asset id");
    }
    seenIds.add(asset.id);
  }

  for (const assetId of seenIds) {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/releases/assets/${assetId}`,
      { token, method: "DELETE", fetchImpl },
    );
    if (response.status !== 204) {
      throw new Error(`GitHub asset deletion for ${assetId} returned HTTP ${response.status}`);
    }
  }

  const emptied = await fetchRelease({ version, token, fetchImpl, allowMissing: false });
  if (emptied.assets.length !== 0) {
    throw new Error("GitHub release still contains assets after deterministic cleanup");
  }
  return { state: "cleared", deleted: seenIds.size, publishRequired: true };
}

export async function verifyExactPublishedReleaseAssets({ version, token, fetchImpl = fetch }) {
  requireVersion(version);
  const release = await fetchRelease({ version, token, fetchImpl, allowMissing: false });
  const tag = `v${version}`;
  const assets = exactPublishedAssetMap(release, version);
  if (
    !assets ||
    !(await exactPublishedContentIsValid({ release, version, assets, token, fetchImpl }))
  ) {
    throw new Error(`GitHub release must contain the exact published asset contract for ${tag}`);
  }
  return { tag, assets: expectedPublishedAssetNames(version) };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--mode") options.mode = value;
    else if (flag === "--version") options.version = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!["prepare", "verify"].includes(options.mode) || !options.version) {
    throw new Error("usage: reconcile-release-assets.mjs --mode prepare|verify --version x.y.z");
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const action = options.mode === "prepare" ? prepareExistingReleaseAssets : verifyExactPublishedReleaseAssets;
    const result = await action({
      version: options.version,
      token: process.env.GH_TOKEN?.trim() ?? "",
    });
    if (options.mode === "prepare") {
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `publish_required=${String(result.publishRequired)}\n`, "utf8");
      }
      console.log(
        result.publishRequired
          ? `Release publication is required (${result.deleted ?? 0} invalid or incomplete assets removed).`
          : "Existing exact release bundle is healthy; publication is an idempotent no-op.",
      );
    } else {
      console.log(`Exact remote release bundle verified for ${result.tag}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
