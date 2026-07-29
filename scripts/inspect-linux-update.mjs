import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;

function scalar(value, label) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`${label} has an invalid quoted YAML scalar`);
    }
  }
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error(`${label} must be a scalar`);
  return trimmed;
}

function positiveSize(value, label) {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

function validSha512(value, label) {
  if (!SHA512_BASE64_PATTERN.test(value) || Buffer.from(value, "base64").byteLength !== 64) {
    throw new Error(`${label} must be a base64-encoded SHA-512 digest`);
  }
  return value;
}

/** Parse the intentionally small electron-builder update-info subset we publish. */
export function parseLinuxUpdateMetadata(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024) {
    throw new Error("latest-linux.yml must be non-empty and at most 64 KiB");
  }
  const top = new Map();
  const files = [];
  let currentFile = null;
  let inFiles = false;

  for (const [index, rawLine] of text.replace(/\r\n?/gu, "\n").split("\n").entries()) {
    if (!rawLine.trim()) continue;
    let match = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/u.exec(rawLine);
    if (match) {
      const [, key, rawValue = ""] = match;
      if (top.has(key)) throw new Error(`latest-linux.yml repeats ${key}`);
      top.set(key, key === "files" && rawValue === "" ? "" : scalar(rawValue, `latest-linux.yml ${key}`));
      inFiles = key === "files";
      currentFile = null;
      continue;
    }
    match = /^  - url: (.+)$/u.exec(rawLine);
    if (match && inFiles) {
      currentFile = { url: scalar(match[1], `latest-linux.yml files[${files.length}].url`) };
      files.push(currentFile);
      continue;
    }
    match = /^    ([A-Za-z][A-Za-z0-9]*): (.+)$/u.exec(rawLine);
    if (match && inFiles && currentFile) {
      const [, key, rawValue] = match;
      if (Object.hasOwn(currentFile, key)) {
        throw new Error(`latest-linux.yml repeats files.${key}`);
      }
      currentFile[key] = scalar(rawValue, `latest-linux.yml files.${key}`);
      continue;
    }
    throw new Error(`latest-linux.yml has unsupported syntax on line ${index + 1}`);
  }

  return {
    version: top.get("version"),
    files,
    path: top.get("path"),
    sha512: top.get("sha512"),
    releaseDate: top.get("releaseDate"),
  };
}

export function expectedLinuxUpdateNames(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  return [
    `T4-Code-${version}-linux-amd64.deb`,
    `T4-Code-${version}-linux-x86_64.AppImage`,
  ];
}

/**
 * Validate exact updater routing. `artifacts` maps basename to `{size, sha512?}`;
 * local release inspection supplies sha512, while site publication can validate
 * the names and GitHub sizes without downloading both packages again.
 */
export function validateLinuxUpdateMetadata(text, { version, artifacts }) {
  const metadata = parseLinuxUpdateMetadata(text);
  if (metadata.version !== version) {
    throw new Error(`latest-linux.yml version ${metadata.version ?? "missing"} must be ${version}`);
  }
  const expectedNames = expectedLinuxUpdateNames(version);
  if (!(artifacts instanceof Map) || artifacts.size !== expectedNames.length) {
    throw new Error("Linux updater validation requires exactly the deb and AppImage artifacts");
  }
  if (metadata.files.length !== expectedNames.length) {
    throw new Error("latest-linux.yml must contain exactly the deb and AppImage entries");
  }

  const entries = new Map();
  for (const entry of metadata.files) {
    if (entries.has(entry.url)) throw new Error(`latest-linux.yml repeats ${entry.url}`);
    entries.set(entry.url, entry);
  }
  for (const name of expectedNames) {
    const artifact = artifacts.get(name);
    const entry = entries.get(name);
    if (!artifact || !entry) throw new Error(`latest-linux.yml is missing exact artifact ${name}`);
    const sha512 = validSha512(entry.sha512 ?? "", `latest-linux.yml ${name} sha512`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`${name} size must be a positive integer`);
    }
    if (entry.size !== undefined && positiveSize(entry.size, `${name} metadata size`) !== artifact.size) {
      throw new Error(`${name} metadata size does not match the artifact`);
    }
    if (name.endsWith(".AppImage")) {
      const blockMapSize = positiveSize(entry.blockMapSize ?? "", `${name} blockMapSize`);
      if (blockMapSize >= artifact.size) {
        throw new Error(`${name} blockMapSize must be smaller than the artifact`);
      }
    } else if (entry.blockMapSize !== undefined) {
      throw new Error(`${name} must not declare AppImage block-map metadata`);
    }
    if (artifact.sha512 !== undefined && sha512 !== artifact.sha512) {
      throw new Error(`${name} metadata SHA-512 does not match the artifact`);
    }
  }
  for (const name of artifacts.keys()) {
    if (!expectedNames.includes(name)) throw new Error(`unexpected Linux updater artifact ${name}`);
  }

  const compatibilityEntry = entries.get(metadata.path);
  if (!compatibilityEntry) {
    throw new Error("latest-linux.yml compatibility path must name one of its exact artifacts");
  }
  if (validSha512(metadata.sha512 ?? "", "latest-linux.yml compatibility sha512") !== compatibilityEntry.sha512) {
    throw new Error("latest-linux.yml compatibility path and sha512 must identify the same artifact");
  }
  if (metadata.releaseDate !== undefined && !Number.isFinite(Date.parse(metadata.releaseDate))) {
    throw new Error("latest-linux.yml releaseDate must be an ISO timestamp");
  }
  return metadata;
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha512");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("base64")));
  });
}

async function inspect({ metadataPath, artifactPaths, version }) {
  const artifacts = new Map();
  for (const path of artifactPaths) {
    const name = basename(path);
    if (artifacts.has(name)) throw new Error(`duplicate artifact ${name}`);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size <= 0) throw new Error(`${name} must be a non-empty file`);
    artifacts.set(name, { size: stats.size, sha512: await hashFile(path) });
  }
  validateLinuxUpdateMetadata(readFileSync(metadataPath, "utf8"), { version, artifacts });
}

function parseArguments(args) {
  const options = { artifactPaths: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--metadata") options.metadataPath = resolve(value);
    else if (flag === "--artifact") options.artifactPaths.push(resolve(value));
    else if (flag === "--version") options.version = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.metadataPath || !options.version || options.artifactPaths.length !== 2) {
    throw new Error("usage: inspect-linux-update.mjs --version x.y.z --metadata latest-linux.yml --artifact file.deb --artifact file.AppImage");
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await inspect(options);
    console.log(`Linux updater metadata passed for v${options.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
