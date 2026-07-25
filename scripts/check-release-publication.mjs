import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const REPOSITORY = "wolfiesch/omperator";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requireVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("version must be x.y.z");
  }
  return version;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parsePublishedRelease(text, version) {
  let release;
  try {
    release = JSON.parse(text);
  } catch {
    throw new Error("GitHub release response was not valid JSON");
  }

  const tag = `v${version}`;
  const expectedUrl = `${REPOSITORY_URL}/releases/tag/${tag}`;
  if (
    !release ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    release.tag_name !== tag ||
    release.html_url !== expectedUrl ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== "string" ||
    !Number.isFinite(Date.parse(release.published_at)) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(`GitHub release response did not describe published stable release ${tag}`);
  }
  return { tag, releaseUrl: expectedUrl };
}

export async function classifyStableReleasePublication({
  version,
  token = "",
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  requireVersion(version);
  requirePositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  const tag = `v${version}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "t4-code-site-release-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`,
      {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
  } catch (error) {
    throw new Error(`Could not query GitHub for stable release ${tag}`, { cause: error });
  }

  if (response.status === 404) return { state: "not-published", tag };
  if (response.status !== 200) {
    throw new Error(`GitHub stable release query for ${tag} returned HTTP ${response.status}`);
  }
  const responseBytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    label: "GitHub release response",
  });
  const published = parsePublishedRelease(responseBytes.toString("utf8"), version);
  return { state: "published", ...published };
}

export function writePublicationState(outputPath, result) {
  if (!outputPath) throw new Error("--github-output is required");
  if (result?.state !== "published" && result?.state !== "not-published") {
    throw new Error("publication state must be published or not-published");
  }
  appendFileSync(outputPath, `state=${result.state}\n`, "utf8");
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--version") options.version = value;
    else if (flag === "--github-output") options.outputPath = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const rootVersion = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version;
    const options = parseArguments(process.argv.slice(2));
    const result = await classifyStableReleasePublication({
      version: options.version ?? rootVersion,
      token: process.env.GH_TOKEN?.trim() ?? "",
    });
    writePublicationState(options.outputPath, result);
    console.log(
      result.state === "published"
        ? `Stable release ${result.tag} is published.`
        : `Stable release ${result.tag} is not published yet.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
