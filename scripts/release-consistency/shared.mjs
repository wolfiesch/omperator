export const REPOSITORY_URL = "https://github.com/wolfiesch/omperator";
export const OMP_RUNTIME_REPOSITORY = "https://github.com/wolfiesch/oh-my-pi";
export const OMP_APP_WIRE_SOURCE_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
export const OMP_UPSTREAM_REPOSITORY = "https://github.com/can1357/oh-my-pi";
export const OMP_HOST_MIGRATION_SOURCE_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
export const OMP_HOST_MIGRATION_INPUTS = Object.freeze({
  t4codeBase: "09835b929cd028e7e3f800b3e4203e3d1f37931c",
  operationsContinuity: "08504b1281f01d8fb81e27306f7d3f6e6c29c4a6",
  artifactAndTurnReview: "796bb7dca4f9c0ebba98bafc37dc67359bb6ea39",
  runtimeAndWorkspaceAdapters: "6ce1d41b35db9a5feaa4743f4a3200d9a8f9ae61",
});

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
export const SHA_PATTERN = /^[0-9a-f]{40}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const PATCH_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function requireText(text, expected, path, errors) {
  if (!text.includes(expected)) errors.push(`${path} is missing ${JSON.stringify(expected)}`);
}
