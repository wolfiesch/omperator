import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MANIFEST_PATH = "compat/portable-agent-platform-v1.json";
const OPENAPI_PATH = "packages/t4-api-contract/openapi.json";
const COMMAND_REGISTRY_PATH = "packages/host-wire/src/command.ts";
const CLIENT_FRAME_PATH = "packages/host-wire/src/envelope.ts";
const PROVIDER_PROTOCOL_PATH =
  "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs";
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
  authorizationDocumentation: "docs/adr/022-portable-identity-authorization-contract.md",
  authorizationDocumentationSha256: "76c1f3f13387b7fbf0beed0b7f643135848f6bdc9431b9de86c43b137845ac1a",
  authorizationContractsSha256: "ee53955763299dc51907c029a33c6ebcbefc95bdf3fa33a522cc8af4e0c0236a",
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

function sha256Json(value) {
  const json = JSON.stringify(value);
  return json === undefined ? null : createHash("sha256").update(json).digest("hex");
}

function findAuthorizationSpecificField(value, prefix = "portableAuthorizationContracts") {
  const forbiddenKeys = new Set([
    "backend",
    "backendType",
    "identityProvider",
    "providerName",
    "providerType",
    "policyBackend",
  ]);
  const forbiddenProduct = /\b(?:kubernetes|postgres(?:ql)?|sqlite|mysql|auth0|keycloak|amazon|azure|google cloud)\b/iu;
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const field = `${prefix}.${key}`;
    if (forbiddenKeys.has(key)) return field;
    if (typeof child === "string" && forbiddenProduct.test(child)) return field;
    const nested = findAuthorizationSpecificField(child, field);
    if (nested) return nested;
  }
  return null;
}

function exactSourceSlice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) throw new Error(`${label} sentinels are missing or reordered`);
  return source.slice(start, end);
}

function commandDescriptorKeys(source) {
  const block = exactSourceSlice(
    source,
    "export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {",
    "export const DESKTOP_CATALOG_COMMANDS:",
    "COMMAND_DESCRIPTORS",
  );
  const keys = [...block.matchAll(/^\t"([^"]+)": \{$/gmu)].map((match) => match[1]);
  if (!keys.length || new Set(keys).size !== keys.length) {
    throw new Error("COMMAND_DESCRIPTORS keys are empty or duplicated");
  }
  return keys;
}
function commandDescriptorConfirmations(source) {
  const block = exactSourceSlice(
    source,
    "export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {",
    "export const DESKTOP_CATALOG_COMMANDS:",
    "COMMAND_DESCRIPTORS",
  );
  const entries = [...block.matchAll(/^\t"([^"]+)": \{\n([\s\S]*?)^\t\},$/gmu)];
  if (!entries.length) throw new Error("COMMAND_DESCRIPTORS blocks are empty");
  const confirmations = entries.map(([, key, body]) => {
    const matches = [...body.matchAll(/^\t\tconfirmation: "(none|challenge)",$/gmu)];
    if (matches.length !== 1) throw new Error(`COMMAND_DESCRIPTORS.${key} must have one exact confirmation`);
    return [key, matches[0][1]];
  });
  if (new Set(confirmations.map(([key]) => key)).size !== confirmations.length) {
    throw new Error("COMMAND_DESCRIPTORS blocks are duplicated");
  }
  return confirmations;
}


function clientFrameTypes(source) {
  const block = exactSourceSlice(
    source,
    "export function decodeClientFrame",
    "export function decodeServerFrame",
    "client frame decoder",
  );
  const types = [...block.matchAll(/^\t\tcase "([^"]+)":$/gmu)].map((match) => match[1]);
  if (!types.length || new Set(types).size !== types.length) {
    throw new Error("client frame types are empty or duplicated");
  }
  return types;
}

function providerRequestMethods(source) {
  const block = exactSourceSlice(
    source,
    "pub enum ProviderRequest {",
    "pub struct ResponseEnvelope<T>",
    "ProviderRequest",
  );
  const variants = [...block.matchAll(/^    ([A-Z][A-Za-z0-9]+)\(/gmu)].map((match) => match[1]);
  const methods = variants.map((variant) =>
    variant
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2")
      .toLowerCase(),
  );
  if (!methods.length || new Set(methods).size !== methods.length) {
    throw new Error("ProviderRequest methods are empty or duplicated");
  }
  return methods;
}

function resolveOpenApiLocalRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("OpenAPI schema ref must be local");
  let value = document;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) {
      throw new Error(`OpenAPI local ref ${ref} is unresolved`);
    }
    value = value[key];
  }
  return value;
}

function runtimePatchAuthorizationShape(document) {
  const patch = document?.components?.schemas?.RuntimePatch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("OpenAPI RuntimePatch schema is missing");
  }
  const properties = patch.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("OpenAPI RuntimePatch properties are missing");
  }
  const desiredState = resolveOpenApiLocalRef(document, properties.desiredState?.$ref);
  if (!Array.isArray(desiredState?.enum) || desiredState.enum.some((value) => typeof value !== "string")) {
    throw new Error("OpenAPI DesiredState enum is missing or invalid");
  }
  return { propertyKeys: Object.keys(properties), desiredStateValues: desiredState.enum };
}

function openApiOperationIds(document) {
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  const operationIds = [];
  for (const pathItem of Object.values(document?.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      if (!operation || typeof operation !== "object" || Array.isArray(operation) || typeof operation.operationId !== "string") {
        throw new Error(`OpenAPI ${method} operation is missing operationId`);
      }
      operationIds.push(operation.operationId);
    }
  }
  if (!operationIds.length || new Set(operationIds).size !== operationIds.length) {
    throw new Error("OpenAPI operationIds are empty or duplicated");
  }
  return operationIds;
}

function sameJson(actual, wanted) {
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

const authorizationSemanticInvariants = [
  ["adapter proves principal", (c) => c?.interfaces?.IdentityAdapter?.provesOnly === "adapter-subject"],
  ["client principal authority", (c) => sameJson(c?.serverDerivedAuthorities, [
    "principalMapping", "scopeMembership", "resourceScope", "resourceGeneration",
    "resourceProfile", "resourceState", "roleBindings", "currentPolicy",
  ])],
  ["unknown action fail open", (c) => c?.policy?.unknownAction === "deny"],
  ["missing capability intersection factor", (c) => sameJson(c?.capabilities?.formula, ["implementation", "profile", "state", "authorization"])],
  ["client capability widening", (c) => c?.capabilities?.clientRequestMayOnlyNarrow === true],
  ["trusted proxy immediate-peer shortcut", (c) => c?.trustedProxy?.immediatePeerTrustRequired === true],
  ["trusted proxy scope shortcut", (c) => sameJson(c?.trustedProxy?.neverSupplies, ["principalId", "scopeId", "membership", "role", "policy"])],
  ["implicit owner role grant", (c) => c?.roles?.implicitOwnerGrantAllowed === false],
  ["implicit admin role grant", (c) => c?.roles?.implicitAdminGrantAllowed === false],
  ["authority collapse", (c) => sameJson(c?.distinctAuthorities, [
    "identityEvidence", "principalMapping", "scopeMembership", "resourceScope", "roleBinding",
    "policy", "workload", "delegatedEdge", "connection", "capability",
  ])],
  ["grant invalidation omission", (c) => sameJson(c?.grantInvalidation, [
    "principalRevocation", "membershipRevision", "policyRevision", "resourceStateChange",
    "resourceProfileChange", "resourceGenerationChange", "routeGenerationChange",
  ])],
  ["connection descriptor omission weakening", (c) => c?.connectionDescriptors?.omitUnauthorizedTransports === true],
  ["cross-scope existence disclosure", (c) => c?.concealment?.existenceLeakAllowed === false],
  ["confirmation without current reauthorization", (c) => c?.confirmation?.consume === "reauthorize-original-action-against-current-authorities"],
  ["WSS frame bypass", (c) => c?.ompAppWss?.authorizeEveryFrame === true],
  ["SSH shell escape", (c) => c?.ssh?.shell === "deny"],
  ["internal workload authority collapse", (c) => c?.internalRoute?.workloadIdentityImpliesEdgeAuthority === false],
  ["unbounded decision logging", (c) => c?.decisionLog?.maximumRecordBytes === 16384],
  ["audit persistence scope expansion", (c) => c?.decisionLog?.persistenceRequiredByP006 === false],
  ["required identity adapter category omission", (c) => sameJson(c?.identityAdapters?.categories, [
    "oidc-oauth2.1", "openssh-key-or-certificate", "tailscale-trusted-ingress",
    "administrator-mtls-or-service-identity",
  ])],
  ["Tailscale-only identity contract", (c) => c?.identityAdapters?.tailscaleOnlyContractAllowed === false],
  ["provider subject escapes adapter", (c) => c?.identityAdapters?.stableProviderSubjectVisibility === "adapter-private"],
  ["principal resolution metadata omission", (c) => sameJson(c?.interfaces?.PrincipalResolver?.output, ["principalId", "kind", "enabled", "principalRevision"])],
  ["authorization decision output weakening", (c) => sameJson(c?.interfaces?.AuthorizationChecker?.output, ["allowed", "reasonCode", "policyRevision", "effectiveCapabilities"])],
  ["canonical minimum action omission", (c) => sameJson(c?.canonicalActions, [
    "scope.read", "scope.admin", "workspace.read", "workspace.create", "workspace.update",
    "workspace.delete", "workspace.purge", "runtime.read", "runtime.create", "runtime.wake",
    "runtime.sleep", "runtime.stop", "runtime.delete", "runtime.purge", "runtime.connect.cmux",
    "runtime.connect.omp-app/1", "browser.read", "browser.control", "browser.input",
    "settings.read", "settings.write", "config.read", "config.write", "destructive.confirmation",
  ])],
  ["REST canonical action mapping omission", (c) => sameJson(c?.rest?.operations?.putRuntime?.canonicalActions, ["runtime.create"])],
  ["command canonical mapping drift", (c) => sameJson(c?.ompAppWss?.commandCanonicalActions?.["settings.write"], ["settings.write"])],
  ["confirmation action omission", (c) => sameJson(c?.confirmation?.requiredActions, ["destructive.confirmation", "bound-original-action"])],
  ["trusted proxy duplicate-header shortcut", (c) => c?.trustedProxy?.duplicateIdentityHeader === "deny"],
  ["trusted proxy unknown-adapter shortcut", (c) => c?.trustedProxy?.unknownOrDisabledAdapter === "deny"],
  ["direct cmux semantic translation", (c) => c?.directCmuxWss?.semanticTranslationAllowed === false],
  ["direct cmux per-frame action protocol", (c) => c?.directCmuxWss?.perFrameActionDecodingAllowed === false],
  ["SSH optional command advertised while disabled", (c) => c?.ssh?.disabledOptionalCommand === "deny-and-unadvertised"],
  ["SSH attach PTY weakening", (c) => c?.ssh?.optionalCommands?.["omperator attach <runtime-id>"]?.pty === "required"],
  ["provider control connection-time grant", (c) => c?.ssh?.providerControl?.authorizeEveryRequest === true],
  ["provider control lifecycle mapping omission", (c) => sameJson(c?.ssh?.providerControl?.methodCanonicalActions?.delete_machine, ["runtime.delete", "destructive.confirmation"])],
  ["runtime patch desired-state action drift", (c) => sameJson(c?.rest?.operations?.patchRuntime?.canonicalActionResolver?.desiredStateActions?.Running, ["runtime.wake"])],
  ["runtime patch administrative field omission", (c) => sameJson(c?.rest?.operations?.patchRuntime?.canonicalActionResolver?.fieldActions?.browserPolicy, ["scope.admin"])],
  ["runtime patch multi-field union weakening", (c) => c?.rest?.operations?.patchRuntime?.canonicalActionResolver?.multiField === "union"],
  ["runtime patch unknown field fail open", (c) => c?.rest?.operations?.patchRuntime?.canonicalActionResolver?.unknownField === "deny"],
  ["runtime patch unknown value fail open", (c) => c?.rest?.operations?.patchRuntime?.canonicalActionResolver?.unknownValue === "deny"],
  ["runtime patch finer action omission", (c) => c?.rest?.operations?.patchRuntime?.action === "runtime.update"],
  ["command confirmation registry omission", (c) => sameJson(c?.ompAppWss?.challengeCommandDescriptorKeys, [
    "workspace.archive", "session.delete", "session.cancel", "session.close", "files.write",
    "files.patch", "review.apply", "agent.cancel", "bash.run", "term.open", "config.write",
    "settings.write", "preview.launch", "preview.navigate", "preview.upload",
  ])],
  ["non-challenge confirmation fail open", (c) => c?.ompAppWss?.nonChallengeConfirmation === "none"],
];

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

  const authorizationContracts = manifest.portableAuthorizationContracts;
  requireEqual(
    failures,
    "portableAuthorizationContracts.documentation",
    authorizationContracts?.documentation,
    expected.authorizationDocumentation,
  );
  requireEqual(
    failures,
    "portableAuthorizationContracts.documentationSha256",
    authorizationContracts?.documentationSha256,
    expected.authorizationDocumentationSha256,
  );
  requireEqual(failures, "portableAuthorizationContracts.contractOnly", authorizationContracts?.contractOnly, true);
  requireEqual(
    failures,
    "portableAuthorizationContracts.runtimeImplementationIncluded",
    authorizationContracts?.runtimeImplementationIncluded,
    false,
  );
  requireEqual(
    failures,
    "portableAuthorizationContracts.publicSchemaChangesIncluded",
    authorizationContracts?.publicSchemaChangesIncluded,
    false,
  );
  requireEqual(
    failures,
    "portableAuthorizationContracts.firstProductNeutralTypesWorkPackage",
    authorizationContracts?.firstProductNeutralTypesWorkPackage,
    "P1-01",
  );
  requireEqual(
    failures,
    "portableAuthorizationContracts exact object digest",
    sha256Json(authorizationContracts),
    expected.authorizationContractsSha256,
  );
  for (const [name, holds] of authorizationSemanticInvariants) {
    if (!holds(authorizationContracts)) {
      failures.push(diagnostic(`portableAuthorizationContracts semantic invariant "${name}" must hold`));
    }
  }
  if (!SHA256.test(authorizationContracts?.documentationSha256 ?? "")) {
    failures.push(diagnostic("portableAuthorizationContracts.documentationSha256 must be 64 lowercase hex characters"));
  }
  for (const [label, actual, wanted] of [
    [
      "portableAuthorizationContracts.capabilities.formula",
      authorizationContracts?.capabilities?.formula,
      ["implementation", "profile", "state", "authorization"],
    ],
    [
      "portableAuthorizationContracts.interfaces.AuthorizationChecker.input",
      authorizationContracts?.interfaces?.AuthorizationChecker?.input,
      ["principalId", "scopeId", "resourceKind", "resourceId", "action", "transport"],
    ],
    [
      "portableAuthorizationContracts.interfaces.PrincipalResolver.output",
      authorizationContracts?.interfaces?.PrincipalResolver?.output,
      ["principalId", "kind", "enabled", "principalRevision"],
    ],
    [
      "portableAuthorizationContracts.interfaces.AuthorizationChecker.output",
      authorizationContracts?.interfaces?.AuthorizationChecker?.output,
      ["allowed", "reasonCode", "policyRevision", "effectiveCapabilities"],
    ],
    [
      "portableAuthorizationContracts.identityAdapters.categories",
      authorizationContracts?.identityAdapters?.categories,
      [
        "oidc-oauth2.1",
        "openssh-key-or-certificate",
        "tailscale-trusted-ingress",
        "administrator-mtls-or-service-identity",
      ],
    ],
    [
      "portableAuthorizationContracts.canonicalActions",
      authorizationContracts?.canonicalActions,
      [
        "scope.read",
        "scope.admin",
        "workspace.read",
        "workspace.create",
        "workspace.update",
        "workspace.delete",
        "workspace.purge",
        "runtime.read",
        "runtime.create",
        "runtime.wake",
        "runtime.sleep",
        "runtime.stop",
        "runtime.delete",
        "runtime.purge",
        "runtime.connect.cmux",
        "runtime.connect.omp-app/1",
        "browser.read",
        "browser.control",
        "browser.input",
        "settings.read",
        "settings.write",
        "config.read",
        "config.write",
        "destructive.confirmation",
      ],
    ],
    [
      "portableAuthorizationContracts.rest.anonymousActions",
      authorizationContracts?.rest?.anonymousActions,
      ["discovery.read"],
    ],
    [
      "portableAuthorizationContracts.distinctAuthorities",
      authorizationContracts?.distinctAuthorities,
      [
        "identityEvidence",
        "principalMapping",
        "scopeMembership",
        "resourceScope",
        "roleBinding",
        "policy",
        "workload",
        "delegatedEdge",
        "connection",
        "capability",
      ],
    ],
  ]) {
    requireJsonEqual(failures, label, actual, wanted);
  }
  for (const [label, actual, wanted] of [
    ["portableAuthorizationContracts.policy.unknownAction", authorizationContracts?.policy?.unknownAction, "deny"],
    [
      "portableAuthorizationContracts.roles.implicitOwnerGrantAllowed",
      authorizationContracts?.roles?.implicitOwnerGrantAllowed,
      false,
    ],
    [
      "portableAuthorizationContracts.roles.implicitAdminGrantAllowed",
      authorizationContracts?.roles?.implicitAdminGrantAllowed,
      false,
    ],
    [
      "portableAuthorizationContracts.trustedProxy.immediatePeerTrustRequired",
      authorizationContracts?.trustedProxy?.immediatePeerTrustRequired,
      true,
    ],
    [
      "portableAuthorizationContracts.trustedProxy.authenticatedTransportRequired",
      authorizationContracts?.trustedProxy?.authenticatedTransportRequired,
      true,
    ],
    [
      "portableAuthorizationContracts.identityAdapters.productionMinimumEnabled",
      authorizationContracts?.identityAdapters?.productionMinimumEnabled,
      1,
    ],
    [
      "portableAuthorizationContracts.identityAdapters.tailscaleOnlyContractAllowed",
      authorizationContracts?.identityAdapters?.tailscaleOnlyContractAllowed,
      false,
    ],
    [
      "portableAuthorizationContracts.identityAdapters.stableProviderSubjectVisibility",
      authorizationContracts?.identityAdapters?.stableProviderSubjectVisibility,
      "adapter-private",
    ],
    [
      "portableAuthorizationContracts.trustedProxy.missingIdentityHeader",
      authorizationContracts?.trustedProxy?.missingIdentityHeader,
      "deny",
    ],
    [
      "portableAuthorizationContracts.trustedProxy.duplicateIdentityHeader",
      authorizationContracts?.trustedProxy?.duplicateIdentityHeader,
      "deny",
    ],
    [
      "portableAuthorizationContracts.trustedProxy.ambiguousIdentityEvidence",
      authorizationContracts?.trustedProxy?.ambiguousIdentityEvidence,
      "deny",
    ],
    [
      "portableAuthorizationContracts.trustedProxy.unknownOrDisabledAdapter",
      authorizationContracts?.trustedProxy?.unknownOrDisabledAdapter,
      "deny",
    ],
    [
      "portableAuthorizationContracts.directCmuxWss.semanticTranslationAllowed",
      authorizationContracts?.directCmuxWss?.semanticTranslationAllowed,
      false,
    ],
    [
      "portableAuthorizationContracts.directCmuxWss.authorizationGranularity",
      authorizationContracts?.directCmuxWss?.authorizationGranularity,
      "stream-direction-not-semantic-frame",
    ],
    [
      "portableAuthorizationContracts.ssh.providerControl.authorizeEveryRequest",
      authorizationContracts?.ssh?.providerControl?.authorizeEveryRequest,
      true,
    ],
    [
      "portableAuthorizationContracts.ssh.disabledOptionalCommand",
      authorizationContracts?.ssh?.disabledOptionalCommand,
      "deny-and-unadvertised",
    ],
    [
      "portableAuthorizationContracts.trustedProxy.neverSupplies",
      JSON.stringify(authorizationContracts?.trustedProxy?.neverSupplies),
      JSON.stringify(["principalId", "scopeId", "membership", "role", "policy"]),
    ],
    [
      "portableAuthorizationContracts.connectionDescriptors.omitUnauthorizedTransports",
      authorizationContracts?.connectionDescriptors?.omitUnauthorizedTransports,
      true,
    ],
  ]) {
    requireEqual(failures, label, actual, wanted);
  }
  requireJsonEqual(
    failures,
    "portableAuthorizationContracts.rest.operations.patchRuntime.canonicalActionResolver",
    authorizationContracts?.rest?.operations?.patchRuntime?.canonicalActionResolver,
    {
      fieldActions: {
        displayName: ["scope.admin"],
        browserPolicy: ["scope.admin"],
        idlePolicy: ["scope.admin"],
      },
      desiredStateActions: {
        Running: ["runtime.wake"],
        Sleeping: ["runtime.sleep"],
        Stopped: ["runtime.stop"],
      },
      multiField: "union",
      duplicateActionEvaluation: "once",
      unknownField: "deny",
      unknownValue: "deny",
      decodeFailure: "deny",
      missingMapping: "deny",
    },
  );
  const authorizationSpecificField = findAuthorizationSpecificField(authorizationContracts);
  if (authorizationSpecificField) {
    failures.push(diagnostic(`${authorizationSpecificField} introduces a backend or identity-provider-specific contract field`));
  }
  try {
    const documentationBytes = await readFile(path.join(root, expected.authorizationDocumentation));
    const digest = createHash("sha256").update(documentationBytes).digest("hex");
    requireEqual(
      failures,
      "portableAuthorizationContracts.documentationSha256",
      digest,
      expected.authorizationDocumentationSha256,
    );
  } catch (error) {
    failures.push(diagnostic(`portableAuthorizationContracts.documentation is unreadable: ${error.message}`));
  }
  try {
    const openApi = JSON.parse(await readFile(path.join(root, OPENAPI_PATH), "utf8"));
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.rest.operations operationId registry",
      Object.keys(authorizationContracts?.rest?.operations ?? {}),
      openApiOperationIds(openApi),
    );
    const patchShape = runtimePatchAuthorizationShape(openApi);
    const patchResolver = authorizationContracts?.rest?.operations?.patchRuntime?.canonicalActionResolver;
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.rest.operations.patchRuntime schema property registry",
      [...Object.keys(patchResolver?.fieldActions ?? {}), "desiredState"].sort(),
      [...patchShape.propertyKeys].sort(),
    );
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.rest.operations.patchRuntime DesiredState registry",
      Object.keys(patchResolver?.desiredStateActions ?? {}),
      patchShape.desiredStateValues,
    );
  } catch (error) {
    failures.push(diagnostic(`portable authorization OpenAPI registry is unreadable: ${error.message}`));
  }
  try {
    const commandSource = await readFile(path.join(root, COMMAND_REGISTRY_PATH), "utf8");
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss.commandDescriptorKeys",
      authorizationContracts?.ompAppWss?.commandDescriptorKeys,
      commandDescriptorKeys(commandSource),
    );
    const confirmationEntries = commandDescriptorConfirmations(commandSource);
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss command confirmation keys",
      confirmationEntries.map(([key]) => key),
      authorizationContracts?.ompAppWss?.commandDescriptorKeys,
    );
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss.challengeCommandDescriptorKeys",
      authorizationContracts?.ompAppWss?.challengeCommandDescriptorKeys,
      confirmationEntries.filter(([, confirmation]) => confirmation === "challenge").map(([key]) => key),
    );
    if (confirmationEntries.some(([, confirmation]) => confirmation !== "challenge" && confirmation !== authorizationContracts?.ompAppWss?.nonChallengeConfirmation)) {
      failures.push(diagnostic("portableAuthorizationContracts.ompAppWss.nonChallengeConfirmation must match every non-challenge descriptor"));
    }
  } catch (error) {
    failures.push(diagnostic(`portable authorization command registry is unreadable: ${error.message}`));
  }
  try {
    const frameSource = await readFile(path.join(root, CLIENT_FRAME_PATH), "utf8");
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss.frameActions",
      Object.keys(authorizationContracts?.ompAppWss?.frameActions ?? {}),
      clientFrameTypes(frameSource),
    );
  } catch (error) {
    failures.push(diagnostic(`portable authorization client-frame registry is unreadable: ${error.message}`));
  }

  try {
    const providerSource = await readFile(path.join(root, PROVIDER_PROTOCOL_PATH), "utf8");
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ssh.providerControl.methodCanonicalActions",
      Object.keys(authorizationContracts?.ssh?.providerControl?.methodCanonicalActions ?? {}),
      providerRequestMethods(providerSource),
    );
  } catch (error) {
    failures.push(diagnostic(`portable authorization provider-control registry is unreadable: ${error.message}`));
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
