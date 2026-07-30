import { expectedReleaseAssetNames } from "../release-asset-names.mjs";
import {
  discoverReleasePackagePaths,
  loadReleaseContractFiles,
  RELEASE_CONTRACT_PATHS,
} from "./contracts.mjs";
import { validateCiPolicy } from "./ci-policy-validator.mjs";
import { validateReleaseMetadata } from "./metadata-validator.mjs";
import { validatePublishedSurfaces } from "./published-surfaces-validator.mjs";
import { validateReleaseAutomation } from "./release-automation-validator.mjs";

export {
  discoverReleasePackagePaths,
  expectedReleaseAssetNames,
  loadReleaseContractFiles,
  RELEASE_CONTRACT_PATHS,
  validateCiPolicy,
  validatePublishedSurfaces,
  validateReleaseAutomation,
  validateReleaseMetadata,
};

export const RELEASE_VALIDATORS = Object.freeze([
  validateReleaseMetadata,
  validatePublishedSurfaces,
  validateCiPolicy,
  validateReleaseAutomation,
]);

export function collectReleaseConsistencyErrors(files, releaseTag) {
  const context = { errors: [], files, releaseTag, validVersion: undefined };
  for (const validate of RELEASE_VALIDATORS) {
    validate(context);
    if (context.validVersion === false) break;
  }
  return context.errors;
}

export function checkReleaseConsistency(repoRoot, releaseTag) {
  return collectReleaseConsistencyErrors(loadReleaseContractFiles(repoRoot), releaseTag);
}
