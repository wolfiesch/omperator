import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  discoverReleasePackagePaths,
  expectedReleaseAssetNames,
  loadReleaseContractFiles as loadBaseReleaseContractFiles,
  RELEASE_CONTRACT_PATHS as BASE_RELEASE_CONTRACT_PATHS,
  validateCiPolicy,
  validatePublishedSurfaces,
  validateReleaseAutomation,
  validateReleaseMetadata,
} from "./release-consistency/validators.mjs";

const PORTABLE_OMP_COMMIT = "c4d3ecdc35234d1aa470c3e1101d9a4ca45b64c5";
const PORTABLE_OMP_CONTRACT_COMMIT = "d16c6168c86f40fc44f25118c2fd06fe160fcb93";
const OMP_RUNTIME_REPOSITORY = "https://github.com/wolfiesch/oh-my-pi";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PORTABLE_PROVENANCE_PATH = "provenance/omp-runtime-v1.json";

export const RELEASE_CONTRACT_PATHS = [
  ...BASE_RELEASE_CONTRACT_PATHS,
  PORTABLE_PROVENANCE_PATH,
];

export { discoverReleasePackagePaths, expectedReleaseAssetNames };

export function loadReleaseContractFiles(repoRoot) {
  const files = loadBaseReleaseContractFiles(repoRoot);
  files.set(
    PORTABLE_PROVENANCE_PATH,
    readFileSync(resolve(repoRoot, PORTABLE_PROVENANCE_PATH), "utf8"),
  );
  return files;
}

function parsePortableJson(files, path, errors) {
  try {
    return JSON.parse(files.get(path) ?? "");
  } catch (error) {
    errors.push(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function validatePortableRuntime(context) {
  const { errors, files } = context;
  const matrixPath = "compat/omp-app-matrix.json";
  const matrix = parsePortableJson(files, matrixPath, errors);
  const portableRuntime = matrix?.portableRuntime;
  const portableProvenance = parsePortableJson(files, PORTABLE_PROVENANCE_PATH, errors);

  for (const [field, actual, expected] of [
    ["repository", portableRuntime?.sourceRepository, OMP_RUNTIME_REPOSITORY],
    ["commit", portableRuntime?.sourceCommit, PORTABLE_OMP_COMMIT],
    [
      "commit URL",
      portableRuntime?.sourceUrl,
      `${OMP_RUNTIME_REPOSITORY}/commit/${PORTABLE_OMP_COMMIT}`,
    ],
    ["contract commit", portableRuntime?.contractCommit, PORTABLE_OMP_CONTRACT_COMMIT],
    ["provenance", portableRuntime?.provenance, PORTABLE_PROVENANCE_PATH],
    ["bridge protocol", portableRuntime?.bridge?.protocol, "t4-omp-authority/1"],
    ["compatibility status", portableRuntime?.bridge?.compatibilityStatus, "admitted"],
  ]) {
    if (actual !== expected) {
      errors.push(`${matrixPath} portable runtime ${field} must be ${expected}`);
    }
  }
  if (!SHA_PATTERN.test(portableRuntime?.sourceCommit ?? "")) {
    errors.push(`${matrixPath} portable runtime commit must be a lowercase 40-character Git SHA`);
  }
  if (
    portableProvenance?.source?.repository !== portableRuntime?.sourceRepository ||
    portableProvenance?.source?.commit !== portableRuntime?.sourceCommit ||
    portableProvenance?.source?.contractCommit !== portableRuntime?.contractCommit ||
    portableProvenance?.source?.contractAncestry !== "descendant" ||
    !isDeepStrictEqual(portableProvenance?.bridge, portableRuntime?.bridge)
  ) {
    errors.push(`${PORTABLE_PROVENANCE_PATH} must exactly source the admitted portable OMP bridge`);
  }
  for (const [name, releaseRuntime] of [
    ["published runtime", matrix?.publishedRuntime],
    ["verified runtime", matrix?.verifiedRuntime],
  ]) {
    if (
      releaseRuntime?.compatibilityScope !== "legacy-desktop-release-only" ||
      releaseRuntime?.portableRuntimeEligible !== false
    ) {
      errors.push(`${matrixPath} ${name} must be explicitly excluded from portable runtime selection`);
    }
  }

  context.ompRuntimeCommit = PORTABLE_OMP_COMMIT;
}

export function collectReleaseConsistencyErrors(files, releaseTag) {
  const context = { errors: [], files, releaseTag, validVersion: undefined };
  validateReleaseMetadata(context);
  if (context.validVersion === false) return context.errors;
  validatePublishedSurfaces(context);
  validatePortableRuntime(context);
  validateCiPolicy(context);
  validateReleaseAutomation(context);
  return context.errors;
}

export function checkReleaseConsistency(repoRoot, releaseTag) {
  return collectReleaseConsistencyErrors(loadReleaseContractFiles(repoRoot), releaseTag);
}

function parseTagArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--tag" && args[1]) return args[1];
  throw new Error("usage: node scripts/check-release-consistency.mjs [--tag vX.Y.Z]");
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const errors = checkReleaseConsistency(process.cwd(), parseTagArgument(process.argv.slice(2)));
    if (errors.length > 0) {
      console.error(
        `Release consistency check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`,
      );
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      const version = JSON.parse(
        readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
      ).version;
      console.log(`Release consistency check passed for v${version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
