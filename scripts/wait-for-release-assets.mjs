import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedReleaseAssetNames } from "./release-asset-names.mjs";

export const DEFAULT_INTERVAL_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 40 * 60 * 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const REPOSITORY_URL = "https://github.com/wolfiesch/omperator";

export function releaseAssetUrls(version) {
  const tag = `v${version}`;
  return [...expectedReleaseAssetNames(version), "latest-linux.yml", "SHA256SUMS.txt"].map((filename) => ({
    filename,
    url: `${REPOSITORY_URL}/releases/download/${tag}/${filename}`,
  }));
}

async function returnsOk(url, fetchImpl, requestTimeoutMs) {
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export async function waitForReleaseAssets({
  version,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  logger = console,
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("version must be x.y.z");
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(intervalMs, "intervalMs");
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");

  const assets = releaseAssetUrls(version);
  const startedAt = now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    const availability = await Promise.all(
      assets.map(async (asset) => ({
        ...asset,
        ready: await returnsOk(asset.url, fetchImpl, requestTimeoutMs),
      })),
    );
    const missing = availability.filter((asset) => !asset.ready);
    if (missing.length === 0) {
      const elapsedMs = now() - startedAt;
      logger.log(`All ${assets.length} v${version} release files returned HTTP 200 after ${attempts} check${attempts === 1 ? "" : "s"}.`);
      return { attempts, elapsedMs, assets };
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Timed out after ${elapsedMs} ms waiting for v${version} release files: ${missing.map((asset) => asset.filename).join(", ")}`,
      );
    }
    const delayMs = Math.min(intervalMs, timeoutMs - elapsedMs);
    logger.log(
      `${missing.length}/${assets.length} v${version} release files are not ready; checking again in ${delayMs} ms.`,
    );
    await sleep(delayMs);
  }
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--version") options.version = value;
    else if (flag === "--timeout-ms") options.timeoutMs = Number(value);
    else if (flag === "--interval-ms") options.intervalMs = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const rootVersion = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version;
    const options = parseArguments(process.argv.slice(2));
    await waitForReleaseAssets({ version: rootVersion, ...options });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
