import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  cmuxProviderManifest: "provenance/cmux-machine-provider-v1.json",
  cmuxProviderManifestSha256: "ae1e6eafc6f302f201530eed9ee7fba1e1f839e2a05214ef38165efbf2568d4d",
  cmuxProviderCrateTree: "983bee74116c7d5f5832a7695379c870cd41ef60",
  cmuxProviderSourceTreeSha256: "ecf8ea6183275110d6270bd6d563d39eb3cecf7296a7c8e44e21f9ca6a46ca63",
  cmuxProviderFixtureCorpusSha256: "bdcb88ee9f46f300b400165cdb2dac2eebc186cb6b78c068ccab3caae4460f23",
  topologyDocumentation: "docs/adr/020-portable-runtime-single-authority.md",
  topologyDocumentationSha256: "da84f4b15fb7c68770ed77baacf5802da84e7fda496b5df20435f209c4e874d3",
  pinResolutionReason:
    "The packaged authority bridge is based on OMP v17.0.5, while the portable contract was reviewed against a newer official OMP commit. Portable runtime behavior must use a new fork integration commit descended from the contract commit and must pass the pinned OMP RPC and authority-bridge gates before packaging.",
  controlContracts: {
    decision: "backend-neutral-driver-and-control-store",
    documentation: "docs/adr/021-portable-driver-control-contracts.md",
    documentationSha256: "518a33eaf5d2c671bd7b5b70bde4cad035ef25a46780db907b28b4347efa4ede",
    supersedesRequiredBackend: "postgresql",
    requiredBackend: null,
    optionalImplementations: ["kubernetes-api-objects", "sqlite", "postgresql"],
    firstCodeImplementationWorkPackage: "P1-01",
    driver: {
      operations: {
        scope: ["get", "list"],
        workspace: ["create", "get", "list", "update", "delete"],
        runtime: ["create", "get", "list", "update", "delete", "setDesiredState"],
        capability: ["get"],
        runtimeRoute: ["resolve"],
        infrastructureEvent: ["list", "watch"],
      },
      reportedCapabilityCategories: ["storage", "browser", "transport", "autoscaling"],
      unsupportedCapabilityResult: "typed-unsupported",
      backendFieldsAllowed: false,
    },
    routes: {
      descriptorFields: ["kind", "reference"],
      routeKinds: ["cmux-v10", "omp-app-v1"],
      referenceSemantics: "opaque-equality-only",
      boundTo: ["runtimeId", "generation"],
      invalidatedByGenerationChange: true,
      backendFieldsAllowed: false,
      edgeEndpointFieldsAllowed: false,
      publicConnectionDescriptorRole: "edge-dto-not-driver-route",
    },
    revision: {
      semantics: "opaque-equality-only",
      distinctFrom: ["generation", "eventCursor"],
      orderingAllowed: false,
      derivationAllowed: false,
      expectedRevisionRequiredFor: [
        "workspace.update",
        "workspace.delete",
        "runtime.update",
        "runtime.delete",
        "runtime.setDesiredState",
      ],
      workspaceRetentionMutation: "workspace.update",
      mismatchOutcome: "revisionMismatch",
      mismatchIncludesCurrentRevision: true,
      mismatchSideEffectsAllowed: false,
      lastWriteWinsAllowed: false,
    },
    idempotency: {
      operations: ["reserve", "complete"],
      lookupKey: ["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey"],
      requestFingerprint: ["canonicalBodyDigest"],
      replicaSafe: true,
      authoritativeSharedStoreRequired: true,
      minimumRetentionSeconds: 86400,
      reserveAtomic: true,
      reserveOutcomes: ["new", "pending", "replay", "conflict"],
      matchingFingerprintOutcomes: ["pending", "replay"],
      differingFingerprintOutcome: "conflict",
      newOutcomeReturnsReservationToken: true,
      replayOutcomeIncludesRecordedResult: true,
      completeCondition: "matching-reservation-token",
      indeterminateRecovery: "fail-closed-pending-until-authoritative-reconciliation",
      processLocalFallbackAllowed: false,
    },
    tickets: {
      operations: ["mint", "consume", "revoke"],
      store: "authoritative-shared-cas",
      storedMaterial: "sha256-digest-only",
      plaintextRetentionAllowed: false,
      recordAndConsumeBoundTo: ["runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose"],
      maximumTtlSeconds: 60,
      consumption: "atomic-compare-and-delete",
      revocation: "atomic",
      invalidationTriggers: [
        "controlDisconnect",
        "providerControlGenerationReplacement",
        "runtimeGenerationReplacement",
        "explicitCancellation",
      ],
      singleUse: true,
      replicaSafe: true,
    },
    tombstones: {
      operations: ["put", "get"],
      creationOrder: "before-backend-delete",
      creationAtomic: true,
      deletionOnCreationUncertaintyAllowed: false,
      minimumRetentionSeconds: 86400,
      maximumRetentionSeconds: 604800,
      maximumRecordsPerScope: 100000,
      capacityOutcome: "reject-delete-before-evicting-required-tombstone",
      identifierReuseAfterExpiryAllowed: false,
      identifierReuseAuthority: "stable-id-allocator-registry",
    },
    eventJournal: {
      operations: ["append", "readAfter", "subscribe"],
      entryFields: [
        "eventId",
        "resourceKind",
        "resourceId",
        "scopeId",
        "revision",
        "phase",
        "timestamp",
      ],
      entryFieldBounds: "existing-portable-api-schemas",
      payload: "bounded-infrastructure-lifecycle-invalidations-only",
      replicaSafe: true,
      ordering: "monotonic-per-scope",
      retention: "bounded",
      cursorSemantics: "opaque",
      cursorDistinctFrom: ["revision", "generation"],
      expiredCursorOutcome: "cursorExpired",
      sseExpiredCursorEvent: {
        fields: ["event", "eventId", "reason", "timestamp"],
        event: "reset",
        reason: "cursor_expired",
        allocatedFields: ["eventId", "timestamp"],
        allocatedFieldBounds: "existing-portable-api-schemas",
      },
      listReturnsCursor: "atomic-high-water-H",
      readAfterReturns: ["orderedBatch", "tailNextCursorT"],
      emptyReadAfterTailCursor: "H",
      subscribeStarts: "strictly-after-T",
      subscribeReplayCursor: "T",
      interCallEventLossAllowed: false,
      listWatchGapAllowed: false,
    },
  },
});

function diagnostic(message) {
  return `${MANIFEST_PATH}: ${message}`;
}

function requireEqual(failures, label, actual, wanted) {
  if (actual !== wanted) failures.push(diagnostic(`${label} must be ${JSON.stringify(wanted)}`));
}

function requireJsonEqual(failures, label, actual, wanted) {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(diagnostic(`${label} must match the pinned contract exactly`));
  }
}

function findLeakedRouteField(value, prefix = "portableControlContracts.routes") {
  const forbidden = new Set([
    "backend",
    "backendType",
    "kubernetesNamespace",
    "namespace",
    "pod",
    "podName",
    "service",
    "serviceName",
    "host",
    "hostname",
    "port",
    "url",
    "socket",
    "socketPath",
    "processId",
    "pid",
    "database",
    "dsn",
    "protocol",
    "transport",
    "wssUrl",
    "sshHost",
    "httpUrl",
  ]);
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const field = `${prefix}.${key}`;
    if (forbidden.has(key)) return field;
    const nested = findLeakedRouteField(child, field);
    if (nested) return nested;
  }
  return null;
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
  const cmuxImport = manifest.cmuxMachineProviderImport;
  requireEqual(failures, "cmuxMachineProviderImport.manifest", cmuxImport?.manifest, expected.cmuxProviderManifest);
  requireEqual(
    failures,
    "cmuxMachineProviderImport.manifestSha256",
    cmuxImport?.manifestSha256,
    expected.cmuxProviderManifestSha256,
  );
  requireEqual(failures, "cmuxMachineProviderImport.sourceCommit", cmuxImport?.sourceCommit, expected.cmuxBaseline);
  requireEqual(failures, "cmuxMachineProviderImport.crateGitTree", cmuxImport?.crateGitTree, expected.cmuxProviderCrateTree);
  requireEqual(
    failures,
    "cmuxMachineProviderImport.sourceTreeSha256",
    cmuxImport?.sourceTreeSha256,
    expected.cmuxProviderSourceTreeSha256,
  );
  requireEqual(
    failures,
    "cmuxMachineProviderImport.fixtureCorpusSha256",
    cmuxImport?.fixtureCorpusSha256,
    expected.cmuxProviderFixtureCorpusSha256,
  );
  requireEqual(failures, "cmuxMachineProviderImport.toolingAndConformanceOnly", cmuxImport?.toolingAndConformanceOnly, true);
  requireEqual(failures, "cmuxMachineProviderImport.packagedInProduct", cmuxImport?.packagedInProduct, false);
  requireEqual(failures, "cmuxMachineProviderImport.packagingRequiresLicenseReview", cmuxImport?.packagingRequiresLicenseReview, true);
  requireCommit(failures, "cmuxMachineProviderImport.sourceCommit", cmuxImport?.sourceCommit);
  if (!SHA1.test(cmuxImport?.crateGitTree ?? "")) {
    failures.push(diagnostic("cmuxMachineProviderImport.crateGitTree must be a full lowercase Git tree ID"));
  }
  for (const [label, value] of [
    ["cmuxMachineProviderImport.manifestSha256", cmuxImport?.manifestSha256],
    ["cmuxMachineProviderImport.sourceTreeSha256", cmuxImport?.sourceTreeSha256],
    ["cmuxMachineProviderImport.fixtureCorpusSha256", cmuxImport?.fixtureCorpusSha256],
  ]) {
    if (!SHA256.test(value ?? "")) failures.push(diagnostic(`${label} must be 64 lowercase hex characters`));
  }
  try {
    const provenanceBytes = await readFile(path.join(root, expected.cmuxProviderManifest));
    const digest = createHash("sha256").update(provenanceBytes).digest("hex");
    requireEqual(failures, "cmuxMachineProviderImport.manifestSha256", digest, expected.cmuxProviderManifestSha256);
  } catch (error) {
    failures.push(diagnostic(`cmuxMachineProviderImport.manifest is unreadable: ${error.message}`));
  }
  if (JSON.stringify(manifest.baselines?.omp?.rpcProtocols) !== "[1,2]") {
    failures.push(diagnostic("baselines.omp.rpcProtocols must be exactly [1,2]"));
  }

  const topology = manifest.runtimeTopology;
  for (const [label, actual, wanted] of [
    ["runtimeTopology.decision", topology?.decision, "host-owned-single-rpc-authority"],
    ["runtimeTopology.documentation", topology?.documentation, expected.topologyDocumentation],
    ["runtimeTopology.documentationSha256", topology?.documentationSha256, expected.topologyDocumentationSha256],
    ["runtimeTopology.schedulingUnit", topology?.schedulingUnit, "top-level-runtime"],
    ["runtimeTopology.cmuxMachinesPerRuntime", topology?.cmuxMachinesPerRuntime, 1],
    ["runtimeTopology.writableOmpAuthoritiesPerSession", topology?.writableOmpAuthoritiesPerSession, 1],
    ["runtimeTopology.authorityProcessOwner", topology?.authorityProcessOwner, "t4-host"],
    [
      "runtimeTopology.authorityInvocation",
      topology?.authorityInvocation,
      "omp --mode rpc --session <runtime-owned-session-path>",
    ],
    ["runtimeTopology.authorityTransport", topology?.authorityTransport, "stdio"],
    ["runtimeTopology.applicationAttachProtocol", topology?.applicationAttachProtocol, "omp-app/1"],
    ["runtimeTopology.cmuxTerminalAttachProtocol", topology?.cmuxTerminalAttachProtocol, "omp-app/1"],
    [
      "runtimeTopology.cmuxTerminalAttachMode",
      topology?.cmuxTerminalAttachMode,
      "client-to-existing-authority",
    ],
    ["runtimeTopology.interactiveWriterInvocationAllowed", topology?.interactiveWriterInvocationAllowed, false],
    ["runtimeTopology.rawRpcNetworkExposureAllowed", topology?.rawRpcNetworkExposureAllowed, false],
    [
      "runtimeTopology.implementationAdmission",
      topology?.implementationAdmission,
      "requires-terminal-client-and-writer-proof",
    ],
    ["runtimeTopology.requiredWorkPackage", topology?.requiredWorkPackage, "P3-04"],
  ]) {
    requireEqual(failures, label, actual, wanted);
  }
  if (!SHA256.test(topology?.documentationSha256 ?? "")) {
    failures.push(diagnostic("runtimeTopology.documentationSha256 must be 64 lowercase hex characters"));
  }
  try {
    const documentationBytes = await readFile(path.join(root, expected.topologyDocumentation));
    const digest = createHash("sha256").update(documentationBytes).digest("hex");
    requireEqual(
      failures,
      "runtimeTopology.documentationSha256",
      digest,
      expected.topologyDocumentationSha256,
    );
  } catch (error) {
    failures.push(diagnostic(`runtimeTopology.documentation is unreadable: ${error.message}`));
  }

  const controlContracts = manifest.portableControlContracts;
  requireJsonEqual(
    failures,
    "portableControlContracts",
    controlContracts,
    expected.controlContracts,
  );
  if (!SHA256.test(controlContracts?.documentationSha256 ?? "")) {
    failures.push(diagnostic("portableControlContracts.documentationSha256 must be 64 lowercase hex characters"));
  }
  const leakedRouteField = findLeakedRouteField(controlContracts?.routes);
  if (leakedRouteField) {
    failures.push(diagnostic(`${leakedRouteField} leaks a backend coordinate or edge endpoint field`));
  }
  try {
    const documentationBytes = await readFile(path.join(root, expected.controlContracts.documentation));
    const digest = createHash("sha256").update(documentationBytes).digest("hex");
    requireEqual(
      failures,
      "portableControlContracts.documentationSha256",
      digest,
      expected.controlContracts.documentationSha256,
    );
  } catch (error) {
    failures.push(diagnostic(`portableControlContracts.documentation is unreadable: ${error.message}`));
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
