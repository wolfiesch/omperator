import { readFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PATH = "compat/portable-agent-platform-v1.json";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const expected = Object.freeze({
  specificationUrl: "https://roycorp.net/briefs/omperator-portable-agent-platform-v1-f4c81ee5.html",
  specificationDate: "2026-07-28",
  specificationSha256: "f31778a0d57b3b39b822faa0d6e7a3f1af2888dd09a9a39780025c43acce6194",
  omperatorRepository: "https://github.com/wolfiesch/omperator",
  omperatorBaseline: "2ab8fc746f3b588d172da57101036e0d8dd3e0e7",
  cmuxRepository: "https://github.com/manaflow-ai/cmux",
  cmuxBaseline: "192e44428c16b98210c951ec4bd5a86bc7139014",
  ompRepository: "https://github.com/can1357/oh-my-pi",
  ompBaseline: "d16c6168c86f40fc44f25118c2fd06fe160fcb93",
  implementationStart: "48b1ba7b94f468154ed0e0998118d01f7dbffbd0",
  packagedOmpRepository: "https://github.com/wolfiesch/oh-my-pi",
  packagedOmpTag: "t4code-17.0.5-appserver-15",
  packagedOmpCommit: "ca2902bc095a0b17067f4b8b34ecf454390f85ff",
  packagedOmpUpstreamRepository: "https://github.com/can1357/oh-my-pi",
  packagedOmpUpstreamTag: "v17.0.5",
  packagedOmpUpstreamCommit: "9fd6e97113f5ed3a847e66d346970efdf8afcad9",
  pinResolutionReason:
    "The packaged authority bridge is based on OMP v17.0.5, while the portable contract was reviewed against a newer official OMP commit. Portable runtime behavior must use a new fork integration commit descended from the contract commit and must pass the pinned OMP RPC and authority-bridge gates before packaging.",
});

function diagnostic(message) {
  return `${MANIFEST_PATH}: ${message}`;
}

function requireEqual(failures, label, actual, wanted) {
  if (actual !== wanted) failures.push(diagnostic(`${label} must be ${JSON.stringify(wanted)}`));
}

function requireCommit(failures, label, value) {
  if (typeof value !== "string" || !SHA1.test(value)) {
    failures.push(diagnostic(`${label} must be a full 40-character lowercase Git commit`));
  }
}

export async function checkPortablePlatformBaseline(root = process.cwd()) {
  const failures = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), "utf8"));
  } catch (error) {
    return { failures: [diagnostic(`cannot read valid JSON: ${error.message}`)] };
  }

  requireEqual(failures, "schemaVersion", manifest.schemaVersion, 1);
  requireEqual(failures, "contract", manifest.contract, "omperator-portable-agent-platform-v1");
  requireEqual(failures, "specification.url", manifest.specification?.url, expected.specificationUrl);
  requireEqual(failures, "specification.date", manifest.specification?.date, expected.specificationDate);
  requireEqual(failures, "specification.sha256", manifest.specification?.sha256, expected.specificationSha256);
  if (!SHA256.test(manifest.specification?.sha256 ?? "")) {
    failures.push(diagnostic("specification.sha256 must be 64 lowercase hex characters"));
  }

  requireEqual(failures, "baselines.omperator.repository", manifest.baselines?.omperator?.repository, expected.omperatorRepository);
  requireEqual(failures, "baselines.cmux.repository", manifest.baselines?.cmux?.repository, expected.cmuxRepository);
  requireEqual(failures, "baselines.omp.repository", manifest.baselines?.omp?.repository, expected.ompRepository);

  const commitFields = [
    ["baselines.omperator.commit", manifest.baselines?.omperator?.commit, expected.omperatorBaseline],
    ["baselines.cmux.commit", manifest.baselines?.cmux?.commit, expected.cmuxBaseline],
    ["baselines.omp.commit", manifest.baselines?.omp?.commit, expected.ompBaseline],
    ["implementationStart.omperatorCommit", manifest.implementationStart?.omperatorCommit, expected.implementationStart],
    ["implementationStart.packagedOmpAuthority.commit", manifest.implementationStart?.packagedOmpAuthority?.commit, expected.packagedOmpCommit],
    ["implementationStart.packagedOmpAuthority.upstreamCommit", manifest.implementationStart?.packagedOmpAuthority?.upstreamCommit, expected.packagedOmpUpstreamCommit],
  ];
  for (const [label, actual, wanted] of commitFields) {
    requireCommit(failures, label, actual);
    requireEqual(failures, label, actual, wanted);
  }
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.repository",
    manifest.implementationStart?.packagedOmpAuthority?.repository,
    expected.packagedOmpRepository,
  );
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.tag",
    manifest.implementationStart?.packagedOmpAuthority?.tag,
    expected.packagedOmpTag,
  );
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.upstreamRepository",
    manifest.implementationStart?.packagedOmpAuthority?.upstreamRepository,
    expected.packagedOmpUpstreamRepository,
  );
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.upstreamTag",
    manifest.implementationStart?.packagedOmpAuthority?.upstreamTag,
    expected.packagedOmpUpstreamTag,
  );

  requireEqual(failures, "baselines.cmux.machineProviderProtocol", manifest.baselines?.cmux?.machineProviderProtocol, 1);
  requireEqual(failures, "baselines.cmux.muxProtocol", manifest.baselines?.cmux?.muxProtocol, 10);
  if (JSON.stringify(manifest.baselines?.omp?.rpcProtocols) !== "[1,2]") {
    failures.push(diagnostic("baselines.omp.rpcProtocols must be exactly [1,2]"));
  }

  requireEqual(failures, "ompPinResolution.contractCommit", manifest.ompPinResolution?.contractCommit, expected.ompBaseline);
  requireEqual(failures, "ompPinResolution.currentPackagedCommit", manifest.ompPinResolution?.currentPackagedCommit, expected.packagedOmpCommit);
  requireEqual(failures, "ompPinResolution.strategy", manifest.ompPinResolution?.strategy, "replace-before-portable-runtime");
  requireEqual(
    failures,
    "ompPinResolution.portableRuntimeAdmission",
    manifest.ompPinResolution?.portableRuntimeAdmission,
    "requires-descendant-integration-proof",
  );
  requireEqual(failures, "ompPinResolution.reason", manifest.ompPinResolution?.reason, expected.pinResolutionReason);
  if (manifest.ompPinResolution?.contractCommit === manifest.ompPinResolution?.currentPackagedCommit) {
    failures.push(diagnostic("OMP contract and packaged commits must not be conflated"));
  }

  const rollTogether = manifest.compatibilitySetPolicy?.rollTogether;
  if (JSON.stringify(rollTogether) !== '["omperator-host","omp-runtime","cmux-runtime"]') {
    failures.push(diagnostic("compatibilitySetPolicy.rollTogether must contain the complete ordered runtime set"));
  }
  requireEqual(
    failures,
    "compatibilitySetPolicy.independentComponentRollsAllowed",
    manifest.compatibilitySetPolicy?.independentComponentRollsAllowed,
    false,
  );
  requireEqual(
    failures,
    "compatibilitySetPolicy.privateProtocolForksAllowed",
    manifest.compatibilitySetPolicy?.privateProtocolForksAllowed,
    false,
  );

  failures.sort((left, right) => left.localeCompare(right));
  return { failures };
}

export function formatPortablePlatformBaselineReport(result) {
  return `Portable platform baseline: ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}.${
    result.failures.length ? `\n${result.failures.join("\n")}` : ""
  }`;
}

if (import.meta.main) {
  const result = await checkPortablePlatformBaseline(process.cwd());
  console.log(formatPortablePlatformBaselineReport(result));
  if (result.failures.length) process.exitCode = 1;
}
