#!/usr/bin/env node

import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
const CACHE_MARKER = `${sep}Library${sep}Caches${sep}omperator-ci${sep}ios${sep}`;

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else total += lstatSync(child).size;
  }
  return total;
}

function availableBytes(path) {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

export function prepareIosCiCache(
  cacheRoot,
  {
    maxBytes = 6 * GIB,
    minFreeBytes = 12 * GIB,
    measureAvailableBytes = availableBytes,
    measureDirectoryBytes = directoryBytes,
  } = {},
) {
  const root = resolve(cacheRoot);
  if (!root.includes(CACHE_MARKER)) {
    throw new Error("cache root must be a versioned child of Library/Caches/omperator-ci/ios");
  }
  const cacheBase = dirname(root);
  if (!basename(root).startsWith("xcode-") || !cacheBase.endsWith(CACHE_MARKER.slice(0, -1))) {
    throw new Error("cache root must be a versioned child of Library/Caches/omperator-ci/ios");
  }

  const prunedVersionRoots = [];
  mkdirSync(cacheBase, { recursive: true });
  for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith("xcode-") &&
      entry.name !== basename(root)
    ) {
      rmSync(join(cacheBase, entry.name), { recursive: true, force: true });
      prunedVersionRoots.push(entry.name);
    }
  }

  const derivedData = join(root, "derived-data");
  mkdirSync(derivedData, { recursive: true });
  const cacheBytesBefore = measureDirectoryBytes(derivedData);
  const freeBytesBefore = measureAvailableBytes(root);
  const resetReason =
    cacheBytesBefore > maxBytes ? "size-limit" :
    freeBytesBefore < minFreeBytes ? "free-space-floor" :
    undefined;

  if (resetReason !== undefined) {
    rmSync(derivedData, { recursive: true, force: true });
    mkdirSync(derivedData, { recursive: true });
  }

  const freeBytesAfter = measureAvailableBytes(root);
  if (freeBytesAfter < minFreeBytes) {
    throw new Error(
      `iOS CI requires ${Math.ceil(minFreeBytes / GIB)} GiB free after cache pruning; ` +
        `${Math.floor(freeBytesAfter / GIB)} GiB remain`,
    );
  }

  return {
    cacheBytesBefore,
    freeBytesBefore,
    freeBytesAfter,
    prunedVersionRoots,
    resetReason: resetReason ?? "none",
  };
}

function positiveGib(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value * GIB;
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  try {
    const cacheRoot = process.env.T4_IOS_CACHE_ROOT;
    if (!cacheRoot) throw new Error("T4_IOS_CACHE_ROOT is required");
    const report = prepareIosCiCache(cacheRoot, {
      maxBytes: positiveGib("T4_IOS_CACHE_MAX_GIB", 6 * GIB),
      minFreeBytes: positiveGib("T4_IOS_CACHE_MIN_FREE_GIB", 12 * GIB),
    });
    process.stdout.write(`prepare-ios-ci-cache: ${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(
      `prepare-ios-ci-cache: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
