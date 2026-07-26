import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_BLOCKMAP_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
  return value;
}

function validSha512(value, label) {
  if (typeof value !== "string" || !SHA512_PATTERN.test(value) || Buffer.from(value, "base64").byteLength !== 64) {
    throw new Error(`${label} must be a base64 SHA-512 digest`);
  }
  return value;
}

async function sha512File(path, size, label) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES) {
    throw new Error(`${label} must be a non-empty file no larger than 512 MiB`);
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

export function validateMacUpdateMetadata(
  text,
  { version, zipName, zipSize, zipSha512, dmgName, dmgSize, dmgSha512 },
) {
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be x.y.z");
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text) > MAX_METADATA_BYTES) {
    throw new Error("latest-mac.yml must be non-empty and at most 64 KiB");
  }
  const metadata = exactKeys(
    load(text),
    ["files", "path", "releaseDate", "sha512", "version"],
    "latest-mac.yml",
  );
  if (metadata.version !== version) throw new Error(`latest-mac.yml version must be ${version}`);
  if (!Array.isArray(metadata.files) || metadata.files.length !== 2) {
    throw new Error("latest-mac.yml must contain exactly the zip and DMG files");
  }
  const zipFile = exactKeys(metadata.files[0], ["sha512", "size", "url"], "latest-mac.yml files[0]");
  const dmgFile = exactKeys(metadata.files[1], ["sha512", "size", "url"], "latest-mac.yml files[1]");
  if (zipFile.url !== zipName || metadata.path !== zipName) {
    throw new Error("latest-mac.yml must reference the exact signed zip");
  }
  if (!Number.isSafeInteger(zipFile.size) || zipFile.size !== zipSize || zipSize <= 0) {
    throw new Error("latest-mac.yml zip size does not match the signed zip");
  }
  const fileSha512 = validSha512(zipFile.sha512, "latest-mac.yml files[0].sha512");
  if (validSha512(metadata.sha512, "latest-mac.yml sha512") !== fileSha512) {
    throw new Error("latest-mac.yml compatibility digest does not match its update file");
  }
  if (zipSha512 !== undefined && fileSha512 !== zipSha512) {
    throw new Error("latest-mac.yml SHA-512 does not match the signed zip");
  }
  if (dmgFile.url !== dmgName) {
    throw new Error("latest-mac.yml must reference the exact signed DMG");
  }
  if (!Number.isSafeInteger(dmgFile.size) || dmgFile.size !== dmgSize || dmgSize <= 0) {
    throw new Error("latest-mac.yml DMG size does not match the signed DMG");
  }
  const metadataDmgSha512 = validSha512(dmgFile.sha512, "latest-mac.yml files[1].sha512");
  if (dmgSha512 !== undefined && metadataDmgSha512 !== dmgSha512) {
    throw new Error("latest-mac.yml SHA-512 does not match the signed DMG");
  }
  if (typeof metadata.releaseDate !== "string" || !Number.isFinite(Date.parse(metadata.releaseDate))) {
    throw new Error("latest-mac.yml releaseDate must be an ISO timestamp");
  }
  return {
    version,
    zipName,
    zipSize,
    zipSha512: fileSha512,
    dmgName,
    dmgSize,
    dmgSha512: metadataDmgSha512,
  };
}

async function inspect({ version, metadataPath, zipPath, dmgPath, blockmapPath }) {
  const [metadata, zipInfo, dmgInfo, blockmapInfo] = await Promise.all([
    readFile(metadataPath, "utf8"),
    stat(zipPath),
    stat(dmgPath),
    stat(blockmapPath),
  ]);
  if (!blockmapInfo.isFile() || blockmapInfo.size <= 0 || blockmapInfo.size > MAX_BLOCKMAP_BYTES) {
    throw new Error("macOS update blockmap must be a non-empty file no larger than 4 MiB");
  }
  const [zipSha512, dmgSha512] = await Promise.all([
    sha512File(zipPath, zipInfo.size, "macOS update zip"),
    sha512File(dmgPath, dmgInfo.size, "macOS update DMG"),
  ]);
  const result = validateMacUpdateMetadata(metadata, {
    version,
    zipName: `T4-Code-${version}-mac-arm64.zip`,
    zipSize: zipInfo.size,
    zipSha512,
    dmgName: `T4-Code-${version}-mac-arm64.dmg`,
    dmgSize: dmgInfo.size,
    dmgSha512,
  });
  return { ...result, blockmapBytes: blockmapInfo.size };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--version") options.version = value;
    else if (flag === "--metadata") options.metadataPath = resolve(value);
    else if (flag === "--zip") options.zipPath = resolve(value);
    else if (flag === "--dmg") options.dmgPath = resolve(value);
    else if (flag === "--blockmap") options.blockmapPath = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (
    !options.version ||
    !options.metadataPath ||
    !options.zipPath ||
    !options.dmgPath ||
    !options.blockmapPath
  ) {
    throw new Error(
      "usage: inspect-macos-update.mjs --version x.y.z --metadata latest-mac.yml --zip app.zip --dmg app.dmg --blockmap app.zip.blockmap",
    );
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await inspect(parseArguments(process.argv.slice(2)));
    console.log(
      `Verified native macOS update metadata for v${result.version} (${result.zipSize} zip bytes, ${result.blockmapBytes} blockmap bytes).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
