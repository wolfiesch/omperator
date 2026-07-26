#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_REPOSITORY = "wolfiesch/oh-my-pi";
const EXPECTED_ASSET = "pi_natives.linux-x64-modern.node";
const MANIFEST_ASSET = "omp-native-addons.json";

function assertMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}: ${String(value)}`);
  return value;
}

function repositorySlug(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(url);
  if (!match) throw new Error(`Unsupported OMP source repository: ${url}`);
  return match[1];
}

function releaseAssetUrl(repository, tag, asset) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

function parseManifest(raw, expected) {
  const manifest = JSON.parse(raw);
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported OMP native addon manifest schema");
  if (manifest?.source?.repository !== expected.repository) {
    throw new Error(`OMP native addon repository mismatch: ${String(manifest?.source?.repository)}`);
  }
  if (manifest?.source?.commit !== expected.commit) {
    throw new Error(`OMP native addon commit mismatch: ${String(manifest?.source?.commit)}`);
  }
  if (manifest?.source?.tag !== expected.tag) {
    throw new Error(`OMP native addon tag mismatch: ${String(manifest?.source?.tag)}`);
  }
  assertMatch(manifest?.source?.nativeSourceHash, /^[0-9a-f]{16,64}$/u, "OMP native source hash");
  if (!Array.isArray(manifest.assets)) throw new Error("OMP native addon manifest has no assets");
  const asset = manifest.assets.find((candidate) => candidate?.name === EXPECTED_ASSET);
  if (!asset) throw new Error(`OMP native addon manifest does not contain ${EXPECTED_ASSET}`);
  assertMatch(asset.sha256, /^[0-9a-f]{64}$/u, "OMP native addon SHA-256");
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error("Invalid OMP native addon size");
  return { asset, nativeSourceHash: manifest.source.nativeSourceHash };
}

async function responseBytes(response, label) {
  if (!response.ok) throw new Error(`Failed to download ${label}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function appendGitHubOutput(name, value, outputPath) {
  if (!outputPath) return Promise.resolve();
  return writeFile(outputPath, `${name}=${value}\n`, { flag: "a" });
}

export async function restoreReleaseNative({
  matrix,
  sourceDir,
  fetchImpl = fetch,
  githubOutput = process.env.GITHUB_OUTPUT,
}) {
  const runtime = matrix?.verifiedRuntime;
  const repository = repositorySlug(runtime?.sourceRepository);
  if (repository !== EXPECTED_REPOSITORY) throw new Error(`Unexpected OMP repository: ${repository}`);
  const commit = assertMatch(runtime?.sourceCommit, /^[0-9a-f]{40}$/u, "OMP source commit");
  const tag = assertMatch(runtime?.sourceTag, /^[A-Za-z0-9._-]+$/u, "OMP source tag");

  const manifestResponse = await fetchImpl(releaseAssetUrl(repository, tag, MANIFEST_ASSET));
  if (manifestResponse.status === 404) {
    await appendGitHubOutput("restored", "false", githubOutput);
    return { restored: false, reason: "release-manifest-missing" };
  }
  const manifestBytes = await responseBytes(manifestResponse, MANIFEST_ASSET);
  const { asset, nativeSourceHash } = parseManifest(new TextDecoder().decode(manifestBytes), {
    repository,
    commit,
    tag,
  });

  const addonResponse = await fetchImpl(releaseAssetUrl(repository, tag, asset.name));
  const addonBytes = await responseBytes(addonResponse, asset.name);
  if (addonBytes.byteLength !== asset.size) {
    throw new Error(`OMP native addon size mismatch: expected ${asset.size}, received ${addonBytes.byteLength}`);
  }
  const digest = createHash("sha256").update(addonBytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`OMP native addon digest mismatch: expected ${asset.sha256}, received ${digest}`);
  }

  const destination = resolve(sourceDir, "packages/natives/native", basename(asset.name));
  const temporary = `${destination}.tmp.${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, addonBytes, { mode: 0o755 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  await appendGitHubOutput("restored", "true", githubOutput);
  await appendGitHubOutput("native-source-hash", nativeSourceHash, githubOutput);
  return { restored: true, destination, nativeSourceHash };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument list near ${key ?? "<end>"}`);
    values.set(key.slice(2), value);
  }
  if (!values.get("matrix")) throw new Error("Missing --matrix");
  if (!values.get("source-dir")) throw new Error("Missing --source-dir");
  return { matrixPath: values.get("matrix"), sourceDir: values.get("source-dir") };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { matrixPath, sourceDir } = parseArguments(process.argv.slice(2));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const result = await restoreReleaseNative({ matrix, sourceDir });
  process.stdout.write(
    result.restored
      ? `Restored ${EXPECTED_ASSET} from the source release (${result.nativeSourceHash}).\n`
      : "Source release has no native addon manifest; using the exact-commit build fallback.\n",
  );
}
