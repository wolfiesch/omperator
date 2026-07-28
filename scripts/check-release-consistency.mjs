import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkReleaseConsistency,
  collectReleaseConsistencyErrors,
  discoverReleasePackagePaths,
  expectedReleaseAssetNames,
  loadReleaseContractFiles,
  RELEASE_CONTRACT_PATHS,
} from "./release-consistency/validators.mjs";

export {
  checkReleaseConsistency,
  collectReleaseConsistencyErrors,
  discoverReleasePackagePaths,
  expectedReleaseAssetNames,
  loadReleaseContractFiles,
  RELEASE_CONTRACT_PATHS,
};

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
