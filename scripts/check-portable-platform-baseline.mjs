import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MANIFEST_PATH = "compat/portable-agent-platform-v1.json";
const OPENAPI_PATH = "packages/t4-api-contract/openapi.json";
export const COMMAND_REGISTRY_PATHS = [
  "packages/host-wire/src/command-descriptors/ci.ts",
  "packages/host-wire/src/command-descriptors/operations.ts",
  "packages/host-wire/src/command-descriptors/preview.ts",
  "packages/host-wire/src/command-descriptors/prompt-media.ts",
  "packages/host-wire/src/command-descriptors/runtime-workspace.ts",
  "packages/host-wire/src/command-descriptors/sessions.ts",
];
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
  portableOmpRepository: "https://github.com/wolfiesch/oh-my-pi",
  portableOmpCommit: "107c7ca3054dbd7f4b2247598580a63a06d72bc4",
  portableOmpProvenance: "provenance/omp-runtime-v1.json",
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
  topologyDocumentation: "docs/adr/025-portable-runtime-single-authority.md",
  topologyDocumentationSha256: "264fe8dd8d5b7196a1e8fc726c827a5940fb4221770ab17de0f4335556a8eeee",
  pinResolutionReason:
    "The owned OMP fork commit is descended from the reviewed d16c616 contract, exposes the complete t4-omp-authority/1 method set, and passed the source bridge plus real host lifecycle gates.",
  authorizationDocumentation: "docs/adr/022-portable-identity-authorization-contract.md",
  authorizationDocumentationSha256: "76c1f3f13387b7fbf0beed0b7f643135848f6bdc9431b9de86c43b137845ac1a",
  authorizationContractsSha256: "17504f1eb88b4847ecf128ed20cda5bacb0ab6100fef9a9ef5b2dc7f06d7e472",
  lifecycleDocumentation: "docs/adr/023-portable-lifecycle-state-machines.md",
  lifecycleDocumentationSha256: "83a06e408edc521cc00e28479141c8d34d8139c2466b764b875ff059376f6cba",
  lifecycleContractsSha256: "8a86ca01041657095f879b8ee66ba18e7c5b08b4bcd1f9967340e92eeb60e6e2",
  threatModelDocumentation: "docs/adr/024-portable-threat-model.md",
  threatModelDocumentationSha256: "6ed95d461a780f9430585033bdac25a61c679bbb183279613c672cd0722cfb46",
  threatModelContractsSha256: "2b400ef4413ca0232882f3868912acc71a7d48d2fa7632fef43c974dc2731cef",
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

function commandDescriptorEntries(source) {
  const entries = [...source.matchAll(/^\s*"([^"]+)":\s*descriptor\(([\s\S]*?)\),?$/gmu)].map(
    ([, key, argumentsSource]) => {
      const argumentsList = [...argumentsSource.matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
      if (argumentsList.length < 5) {
        throw new Error(`COMMAND_DESCRIPTORS.${key} has an incomplete descriptor`);
      }
      return [key, argumentsList[4]];
    },
  );
  if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error("COMMAND_DESCRIPTORS keys are empty or duplicated");
  }
  for (const [key, confirmation] of entries) {
    if (confirmation !== "none" && confirmation !== "challenge") {
      throw new Error(`COMMAND_DESCRIPTORS.${key} has an invalid confirmation`);
    }
  }
  return entries;
}

function commandDescriptorKeys(source) {
  return commandDescriptorEntries(source).map(([key]) => key);
}

function commandDescriptorConfirmations(source) {
  return commandDescriptorEntries(source);
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
    "workspace.archive", "session.delete", "session.cancel", "session.close", "session.release",
    "files.write", "files.patch", "review.apply", "agent.cancel", "bash.run", "term.open",
    "config.write", "settings.write", "preview.launch", "preview.navigate", "preview.upload",
  ])],
  ["non-challenge confirmation fail open", (c) => c?.ompAppWss?.nonChallengeConfirmation === "none"],
];

const lifecycleSemanticInvariants = [
  ["desired state authority must remain resource input", (c) =>
    c?.authorities?.desiredStateSource === "authoritative-resource-input" &&
    c?.authorities?.workloadMayRewriteDesiredState === false],
  ["runtime generation authorities must remain distinct", (c) => sameJson(c?.authorities?.distinctValues, [
    "resourceRevision", "runtimeGeneration", "kubernetesMetadataGeneration",
    "kubernetesObservedGeneration", "eventCursor", "providerControlGeneration", "routeReference",
  ]) && sameJson(c?.authorities?.runtimeGenerationDerivationAllowedFrom, [])],
  ["generation advance must wait for positive fence proof", (c) =>
    c?.generationMachine?.advanceBeforeFenceProvenAllowed === false &&
    sameJson(c?.generationMachine?.advanceRequires, [
      "NoPriorWriterOrFenceProven", "expectedResourceRevision", "authoritativeCas",
    ])],
  ["potential writer attempts must never reuse a generation", (c) =>
    c?.generationMachine?.potentialWriterAttemptGenerationReuseAllowed === false],
  ["FenceUncertain must be the sole uncertain terminal", (c) =>
    sameJson(c?.fenceMachine?.uncertainTerminalOutcomes, ["FenceUncertain"]) &&
    c?.fenceMachine?.fenceUncertainAutomaticRetryAllowed === false],
  ["FenceUncertain public projection must fail closed", (c) => sameJson(
    c?.fenceMachine?.fenceUncertainPublicProjection,
    { phase: "Degraded", condition: "Fenced", status: "False", reason: "FenceUncertain" },
  )],
  ["FenceUncertain must block every writer-capable progression", (c) => sameJson(
    c?.generationMachine?.fenceUncertainBlocks,
    ["generationAdvance", "route", "ticket", "credential", "attachment", "replacement",
      "finalizerProgress", "writerCapableStart"],
  )],
  ["FenceUncertain recovery must use a new resource revision", (c) => sameJson(
    c?.generationMachine?.fenceUncertainExitRequires,
    ["fresh-authoritative-proof-under-new-resource-revision",
      "explicit-manual-recovery-under-new-resource-revision"],
  )],
  ["drain ordering must revoke admission before fence verification", (c) => sameJson(
    c?.drainMachine?.orderedStates,
    ["RouteDraining", "TicketsRevoked", "CredentialsRevoked", "ConnectionsClosing",
      "AuthorityQuiescing", "FenceVerifying"],
  ) && sameJson(c?.drainMachine?.resultStates, ["FenceProven", "FenceUncertain"])],
  ["replacement must prove process and attachment fence before generation CAS", (c) =>
    sameJson(c?.replacementMachine?.orderedActions, [
      "recordCauseAndRemoveRouteReadiness",
      "revokeTicketsCredentialsAndCloseConnections",
      "terminateAndProveProcessPlusAttachmentFence",
      "casFreshRuntimeGeneration",
      "attachExclusiveRuntimeStateAndCreateOneProcessGroup",
      "acquireWriterLeaseAndStartAuthorities",
      "proveCompositeReadinessThenPublishRoutesAndMintTickets",
      "onPotentialWriterFailureReturnThroughDrainFenceAndFreshGeneration",
    ]) && c?.replacementMachine?.fenceRequiredBeforeAction === "casFreshRuntimeGeneration" &&
    c?.replacementMachine?.leaseAloneIsFenceProof === false],
  ["Kubernetes fencing must require the complete positive-proof conjunction", (c) => sameJson(
    c?.fenceMachine?.kubernetesProofConjunction,
    ["oldPodUidAuthoritativelyAbsentOrTerminated", "generationCredentialsRevoked",
      "oldServiceAndEndpointsCannotRoute", "runtimeStateAttachmentReleasedOrOldNodeStorageFenced",
      "sameResourceRevisionAndGenerationDecision"],
  ) && c?.fenceMachine?.kubernetesInsufficientAlone?.includes("lease")],
  ["local fencing must require descendants, revocation, lease, and write exclusion", (c) => sameJson(
    c?.fenceMachine?.localProofConjunction,
    ["supervisedProcessGroupAndDescendantsDead", "generationCredentialsAndSocketRoutesRevoked",
      "exclusiveRuntimeStateWriterLeaseReacquired", "oldProcessWriteAccessAbsent"],
  )],
  ["Ready-only route and ticket publication must remain exact", (c) =>
    c?.readiness?.routeAndTicketPublication === "after-full-conjunction-only" &&
    c?.desiredStateMachine?.Running?.routePublicationPhase === "Ready" &&
    c?.routeTicketInvalidation?.publicationPhase === "Ready" &&
    c?.replacementMachine?.readinessFailureRoutesPresent === false],
  ["composite readiness must retain every authority check", (c) => sameJson(
    c?.readiness?.conjunction,
    ["desiredStateRunning", "publicPhaseReady", "authoritativeAndWorkloadRuntimeGenerationMatch",
      "everyOlderGenerationFenced", "runtimeStateStorageReady", "exclusiveWriterLeaseHeld",
      "cmuxIdentifyProtocol10Ready", "singlePinnedOmpAuthorityReady",
      "internalGenerationAuthenticationReady", "profileRequiredBrowserReady"],
  ) && c?.readiness?.properSubsetSufficient === false && c?.readiness?.tcpOrPodReadinessSufficient === false],
  ["ticket invalidation must include runtime generation replacement", (c) =>
    c?.routeTicketInvalidation?.invalidationTriggers?.includes("runtimeGenerationReplacement")],
  ["tombstone must follow positive fence and immediately precede backend cleanup", (c) => {
    const states = c?.deletionMachine?.orderedStates;
    return Array.isArray(states) &&
      states.includes("Tombstoned") &&
      states.includes("BackendCleanup") &&
      sameJson(states, [
        "DeleteAccepted", "DrainingAndFencing", "Tombstoned", "BackendCleanup",
        "RetentionDisposition", "FinalizerComplete",
      ]) &&
      states.indexOf("DrainingAndFencing") < states.indexOf("Tombstoned") &&
      states.indexOf("Tombstoned") + 1 === states.indexOf("BackendCleanup") &&
      c?.deletionMachine?.tombstoneBeforeBackendDelete === true &&
      c?.deletionMachine?.backendDeleteOnTombstoneUncertaintyAllowed === false &&
      c?.deletionMachine?.fenceProvenBeforeTombstone === true &&
      c?.deletionMachine?.tombstoneImmediatelyBeforeBackendCleanup === true &&
      c?.deletionMachine?.tombstoneRetainedAfterRetentionDisposition === true;
  }],
  ["finalizer must wait for fence cleanup absence and retention", (c) => sameJson(
    c?.deletionMachine?.finalizerRequires,
    ["durableRetainedTombstone", "writerAndAttachmentFenceProven", "ownedWorkloadCleanupComplete",
      "routesAbsent", "ticketsAbsent", "credentialsAbsent", "retentionDispositionComplete"],
  ) && c?.deletionMachine?.fenceUncertainAllowsFinalizerRemoval === false],
  ["sleep and stop semantics must remain distinct from deletion and auto-wake", (c) =>
    c?.desiredStateMachine?.Sleeping?.equivalentToDelete === false &&
    c?.desiredStateMachine?.Stopped?.equivalentToDelete === false &&
    c?.desiredStateMachine?.Stopped?.providerPolicyWakeAllowed === false &&
    c?.desiredStateMachine?.Stopped?.explicitAuthorizedStartRequired === true],
  ["consistent snapshots must require quiescence and drained routes", (c) => sameJson(
    c?.snapshotRestore?.consistentSnapshotRequires,
    ["SleepingOrOmpAndCmuxConfirmedQuiescence", "routesAndTicketsDrained"],
  ) && c?.snapshotRestore?.unquiescedSnapshotLabel === "crash-consistent"],
  ["restore must use a fresh fence and forbid dual live attachment", (c) =>
    c?.snapshotRestore?.restoreRequires?.includes("freshFencedRuntimeGeneration") &&
    c?.snapshotRestore?.sourceGenerationReuseAllowed === false &&
    c?.snapshotRestore?.oneSnapshotAttachedToTwoLiveRuntimesAllowed === false &&
    c?.snapshotRestore?.uncertainAttachmentOutcome === "FenceUncertain"],
  ["workspace and runtime-state storage fencing must remain separate", (c) =>
    c?.storageSeparation?.workspaceAttachmentProvesRuntimeStateFence === false &&
    sameJson(c?.storageSeparation?.runtimeStateFenceProofRequiredFor, [
      "generationAdvance", "replacement", "restore", "purge", "finalizerCompletion",
    ])],
  ["legacy CRD evolution must remain additive and default-safe", (c) =>
    c?.legacyCrdCompatibility?.missingDesiredStateDefault === "Running" &&
    c?.legacyCrdCompatibility?.newFieldsRequired === false &&
    c?.legacyCrdCompatibility?.existingPersistedObjectsRemainValid === true],
  ["Kubernetes public fields and authorities must remain explicit", (c) =>
    sameJson(c?.kubernetesV1Alpha1?.publicFields?.["T4ClusterHost.spec"], [
      "storageClassName", "runtimeStateStorageProfile", "runtimeProfiles", "ciProvider", "allowedOrigins",
    ]) &&
    sameJson(c?.kubernetesV1Alpha1?.publicFields?.["T4Workspace.spec"], [
      "publicId", "hostRef", "displayName", "owner", "repository", "size",
      "storageClassName", "restoreSnapshotRef", "retentionPolicy",
    ]) &&
    sameJson(c?.kubernetesV1Alpha1?.publicFields?.["T4Session.spec"], [
      "publicId", "publicHostProfileId", "hostRef", "workspaceRef", "title",
      "runtimeProfile", "desiredState", "browserPolicy", "idlePolicy", "cmuxSessionName",
      "runtimeStateRestoreSnapshotRef", "initialPromptSecretRef", "guiEnabled", "ci",
    ]) &&
    c?.kubernetesV1Alpha1?.trustBoundaries?.statusAuthority === "cluster-controller-only" &&
    c?.kubernetesV1Alpha1?.trustBoundaries?.runtimeWriterLeaseAuthority ===
      "per-session-service-account-resource-name-bound" &&
    c?.kubernetesV1Alpha1?.trustBoundaries?.runtimeShellKubernetesCredentials === false],
  ["Kubernetes CRD lifecycle must remain guarded and additive", (c) =>
    c?.kubernetesV1Alpha1?.evolution === "additive-only-structural-openapi" &&
    sameJson(c?.kubernetesV1Alpha1?.guardedLifecycle?.storedVersions, ["v1alpha1"]) &&
    c?.kubernetesV1Alpha1?.guardedLifecycle?.liveObjectValidationBeforeMutation === true &&
    c?.kubernetesV1Alpha1?.guardedLifecycle?.resourceVersionAndUidGuardedMutation === true &&
    c?.kubernetesV1Alpha1?.guardedLifecycle?.servedOpenApiConvergenceRequired === true &&
    c?.kubernetesV1Alpha1?.guardedLifecycle?.serverDryRunBeforeWorkloadMutation === true &&
    c?.kubernetesV1Alpha1?.guardedLifecycle?.helmManagesCrds === false],
];

const threatModelSemanticInvariants = [
  ["ticket replay", (c) =>
    c?.ticketReplay?.storedMaterial === "sha256-digest-only" &&
    c?.ticketReplay?.plaintextRetentionAllowed === false &&
    sameJson(c?.ticketReplay?.boundTo, [
      "runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose",
      "audience", "principalId", "scopeId",
    ]) &&
    c?.ticketReplay?.currentGenerationRequired === true &&
    c?.ticketReplay?.maximumTtlSeconds === 60 &&
    c?.ticketReplay?.consumption === "atomic-compare-and-delete" &&
    c?.ticketReplay?.singleUse === true &&
    c?.ticketReplay?.replicaSafe === true &&
    c?.ticketReplay?.mismatchOrUncertaintyOutcome === "deny-before-side-effect" &&
    c?.negativeChecks?.ticketReplay?.outcome === "deny-before-side-effect"],
  ["sender identity", (c) =>
    c?.senderIdentity?.transportEvidenceVisibility === "adapter-private" &&
    c?.senderIdentity?.clientClaimsAuthoritative === false &&
    c?.senderIdentity?.workloadAndDelegatedAuthorityDistinct === true &&
    c?.senderIdentity?.authorizationOutcome === "explicit-allow-only" &&
    c?.senderIdentity?.denyOverrides === true &&
    c?.senderIdentity?.ambiguousOrUnknownEvidence === "deny" &&
    c?.negativeChecks?.senderIdentity?.mutations?.includes("forged-header")],
  ["shell/path injection", (c) =>
    c?.shellPathInjection?.commandExecution === "array-only-exact-argv" &&
    c?.shellPathInjection?.executionPrimitive === "execFile-or-posix_spawn-equivalent" &&
    c?.shellPathInjection?.shellEnabled === false &&
    c?.shellPathInjection?.commandStringAllowed === false &&
    c?.shellPathInjection?.interpolationAllowed === false &&
    c?.shellPathInjection?.sshCommandRegistry === "exact-allowlist" &&
    c?.shellPathInjection?.sshShell === "deny" &&
    c?.shellPathInjection?.sshForwarding === "deny" &&
    c?.shellPathInjection?.pathRoot === "controller-owned" &&
    c?.shellPathInjection?.pathForm === "canonical-normalized-relative" &&
    sameJson(c?.shellPathInjection?.forbiddenPathForms, [
      "dot-dot", "leading-slash", "nul", "backslash",
    ]) &&
    c?.shellPathInjection?.unknownFields === "deny-before-side-effect" &&
    c?.shellPathInjection?.imageOverride === "deny" &&
    c?.shellPathInjection?.rawSecretInput === "deny" &&
    c?.negativeChecks?.shellPathInjection?.outcome === "deny-before-side-effect"],
  ["credential exposure", (c) =>
    c?.credentialExposure?.runtimeReusableProviderCredentialsAllowed === false &&
    c?.credentialExposure?.references === "pseudonymous" &&
    sameJson(c?.credentialExposure?.surfaces, [
      "logs", "metrics", "status", "events", "discovery", "traces", "connectionDescriptors",
    ]) &&
    c?.credentialExposure?.redactionFailureOutcome === "drop-emission-never-allow" &&
    c?.negativeChecks?.credentialExposure?.outcome === "drop-emission-never-allow"],
  ["cross-scope access", (c) =>
    c?.crossScopeAccess?.scopeAuthority === "server-side-ResourceScopeResolver" &&
    c?.crossScopeAccess?.clientScopeClaimsAuthoritative === false &&
    c?.crossScopeAccess?.authorizationOutcome === "explicit-allow-only" &&
    c?.crossScopeAccess?.concealmentOutcome === "consistent-not-found-shaped" &&
    c?.crossScopeAccess?.existenceLeakAllowed === false &&
    sameJson(c?.crossScopeAccess?.appliesTo, [
      "list", "get", "mutation", "connect", "watch", "confirmation", "error",
    ]) &&
    c?.negativeChecks?.crossScopeAccess?.outcome === "consistent-not-found-shaped"],
  ["duplicate writers", (c) =>
    c?.duplicateWriters?.writerCapableProcessGroupsPerRuntimeMaximum === 1 &&
    c?.duplicateWriters?.writableOmpAuthoritiesPerSessionMaximum === 1 &&
    c?.duplicateWriters?.freshGenerationAfterPositiveFenceRequired === true &&
    c?.duplicateWriters?.leaseAloneIsFenceProof === false &&
    c?.duplicateWriters?.routeAndTicketPublication === "after-full-conjunction-only" &&
    c?.duplicateWriters?.fenceUncertainWriterCapableActivityAllowed === false &&
    c?.negativeChecks?.duplicateWriters?.outcome === "block-writer-capable-activity"],
  ["runtime isolation", (c) =>
    c?.trustBoundaries?.includes("backend-object-storage-controller-runtime") &&
    c?.runtimeIsolation?.runtimeUser === "non-root" &&
    c?.runtimeIsolation?.networkPolicy === "default-deny" &&
    c?.runtimeIsolation?.runtimeToRuntimeTraffic === "deny" &&
    c?.runtimeIsolation?.kubernetesApiAccess === "deny" &&
    c?.runtimeIsolation?.egress === "allowlist-only" &&
    c?.runtimeIsolation?.backendObjectAdmission === "strict-bounded-allowlist" &&
    c?.runtimeIsolation?.backendObjectUnknownFields === "deny-before-side-effect" &&
    c?.runtimeIsolation?.workspaceMountAuthorization === "server-derived-scope-and-ownership" &&
    c?.runtimeIsolation?.workspaceRoot === "controller-generated" &&
    c?.runtimeIsolation?.runtimeStateRoot === "controller-generated-generation-bound-exclusive" &&
    c?.runtimeIsolation?.crossScopeStorageAttachment === "deny-before-side-effect" &&
    c?.runtimeIsolation?.rawOmpRpcTransport === "stdio-only" &&
    c?.runtimeIsolation?.rawOmpRpcNetworkExposureAllowed === false &&
    c?.runtimeIsolation?.cmuxSocketAndFilesystemLocks === "runtime-local" &&
    c?.runtimeIsolation?.cdpBind === "runtime-loopback-only" &&
    c?.runtimeIsolation?.cdpExternalReachability === "deny" &&
    c?.runtimeIsolation?.browserProfileWriter === "single-generation-fenced" &&
    c?.runtimeIsolation?.reusableProviderCredentialsPresent === false &&
    c?.negativeChecks?.runtimeIsolation?.mutations?.includes("hostile-backend-object") &&
    c?.negativeChecks?.runtimeIsolation?.mutations?.includes("cross-scope-workspace-attachment") &&
    c?.negativeChecks?.runtimeIsolation?.mutations?.includes("dual-runtime-state-attachment") &&
    c?.negativeChecks?.runtimeIsolation?.outcome === "deny-before-side-effect"],
  ["audit leakage", (c) =>
    c?.auditLeakage?.schema === "bounded-allowlist-only" &&
    c?.auditLeakage?.maximumRecordBytes === 16384 &&
    c?.auditLeakage?.maximumStringBytes === 512 &&
    c?.auditLeakage?.references === "pseudonymous" &&
    sameJson(c?.auditLeakage?.surfaces, [
      "logs", "metrics", "status", "events", "discovery", "traces",
    ]) &&
    c?.auditLeakage?.excludedSameAsCredentialExposure === true &&
    c?.auditLeakage?.loggingFailureMayAllow === false &&
    c?.auditLeakage?.loggingFailureMayChangeDecision === false &&
    c?.auditLeakage?.persistenceClaimed === false &&
    c?.negativeChecks?.auditLeakage?.outcome === "drop-emission-never-change-authorization"],
];

const threatCrossContractInvariants = [
  ["ticket controls must strengthen control and authorization bindings", (m) => {
    const threat = m?.portableThreatModel?.ticketReplay;
    const control = m?.portableControlContracts?.tickets;
    const delegated = m?.portableAuthorizationContracts?.internalRoute?.delegatedAuthorityBoundTo;
    return control?.recordAndConsumeBoundTo?.every((field) => threat?.boundTo?.includes(field)) &&
      ["audience", "purpose", "principalId", "scopeId", "runtimeGeneration"].every(
        (field) => threat?.boundTo?.includes(field) && delegated?.includes(field),
      ) &&
      threat?.maximumTtlSeconds <= control?.maximumTtlSeconds &&
      threat?.storedMaterial === control?.storedMaterial &&
      threat?.consumption === control?.consumption &&
      threat?.singleUse === control?.singleUse &&
      threat?.replicaSafe === control?.replicaSafe &&
      sameJson(threat?.invalidationTriggers, control?.invalidationTriggers);
  }],
  ["sender and scope authority must remain server-derived", (m) =>
    sameJson(
      m?.portableThreatModel?.senderIdentity?.serverDerivedAuthorities,
      m?.portableAuthorizationContracts?.serverDerivedAuthorities,
    ) &&
    m?.portableAuthorizationContracts?.interfaces?.ResourceScopeResolver?.clientClaimsAuthoritative === false &&
    m?.portableAuthorizationContracts?.interfaces?.AuthorizationChecker?.authorizationOutcome === "explicit-allow-only" &&
    m?.portableAuthorizationContracts?.interfaces?.AuthorizationChecker?.denyOverrides === true &&
    m?.portableAuthorizationContracts?.internalRoute?.workloadIdentityImpliesEdgeAuthority === false &&
    m?.portableAuthorizationContracts?.internalRoute?.edgeAuthorityImpliesWorkloadAuthority === false],
  ["scope-qualified records and concealment must agree", (m) =>
    sameJson(
      m?.portableThreatModel?.crossScopeAccess?.idempotencyLookupKey,
      m?.portableControlContracts?.idempotency?.lookupKey,
    ) &&
    m?.portableThreatModel?.crossScopeAccess?.concealmentOutcome ===
      m?.portableAuthorizationContracts?.concealment?.crossScopeOutcome &&
    m?.portableThreatModel?.crossScopeAccess?.existenceLeakAllowed ===
      m?.portableAuthorizationContracts?.concealment?.existenceLeakAllowed],
  ["shell controls must retain the SSH deny contract", (m) =>
    m?.portableThreatModel?.shellPathInjection?.sshShell ===
      m?.portableAuthorizationContracts?.ssh?.shell &&
    m?.portableThreatModel?.shellPathInjection?.sshForwarding ===
      m?.portableAuthorizationContracts?.ssh?.forwarding],
  ["writer controls must retain topology and lifecycle fencing", (m) =>
    m?.portableThreatModel?.duplicateWriters?.writableOmpAuthoritiesPerSessionMaximum ===
      m?.runtimeTopology?.writableOmpAuthoritiesPerSession &&
    m?.portableThreatModel?.duplicateWriters?.writerCapableProcessGroupsPerRuntimeMaximum ===
      m?.portableLifecycleContracts?.desiredStateMachine?.Running?.writerCardinalityMaximum &&
    m?.portableThreatModel?.duplicateWriters?.leaseAloneIsFenceProof ===
      m?.portableLifecycleContracts?.replacementMachine?.leaseAloneIsFenceProof &&
    m?.portableThreatModel?.duplicateWriters?.routeAndTicketPublication ===
      m?.portableLifecycleContracts?.readiness?.routeAndTicketPublication &&
    sameJson(
      m?.portableThreatModel?.duplicateWriters?.fenceUncertainBlocks,
      m?.portableLifecycleContracts?.generationMachine?.fenceUncertainBlocks,
    )],
  ["runtime isolation must retain internal RPC and generation fencing", (m) =>
    m?.portableThreatModel?.runtimeIsolation?.rawOmpRpcNetworkExposureAllowed ===
      m?.runtimeTopology?.rawRpcNetworkExposureAllowed &&
    m?.portableThreatModel?.runtimeIsolation?.rawOmpRpcTransport === "stdio-only" &&
    m?.runtimeTopology?.authorityTransport === "stdio" &&
    m?.portableLifecycleContracts?.storageSeparation?.runtimeStateStorage ===
      "exclusive-single-writer-omp-cmux-browser-supervisor-state"],
  ["browser isolation must retain lifecycle fencing", (m) =>
    m?.portableThreatModel?.runtimeIsolation?.browserProfileWriter ===
      "single-generation-fenced" &&
    m?.portableLifecycleContracts?.snapshotRestore?.restoreRequires?.includes(
      "freshFencedRuntimeGeneration",
    ) &&
    m?.portableLifecycleContracts?.snapshotRestore?.oneSnapshotAttachedToTwoLiveRuntimesAllowed ===
      false &&
    m?.portableLifecycleContracts?.readiness?.conjunction?.includes(
      "profileRequiredBrowserReady",
    )],
  ["credential and audit exclusions must retain authorization redaction", (m) =>
    sameJson(
      m?.portableThreatModel?.credentialExposure?.excluded,
      m?.portableAuthorizationContracts?.decisionLog?.excluded,
    ) &&
    m?.portableThreatModel?.auditLeakage?.maximumRecordBytes ===
      m?.portableAuthorizationContracts?.decisionLog?.maximumRecordBytes &&
    m?.portableThreatModel?.auditLeakage?.maximumStringBytes ===
      m?.portableAuthorizationContracts?.decisionLog?.maximumStringBytes &&
    m?.portableThreatModel?.auditLeakage?.references ===
      m?.portableAuthorizationContracts?.decisionLog?.references &&
    m?.portableThreatModel?.auditLeakage?.loggingFailureMayAllow ===
      m?.portableAuthorizationContracts?.decisionLog?.loggingFailureMayAllow],
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
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.historical",
    manifest.implementationStart?.packagedOmpAuthority?.historical,
    true,
  );
  requireEqual(
    failures,
    "implementationStart.packagedOmpAuthority.portableRuntimeEligible",
    manifest.implementationStart?.packagedOmpAuthority?.portableRuntimeEligible,
    false,
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

  const lifecycleContracts = manifest.portableLifecycleContracts;
  requireEqual(
    failures,
    "portableLifecycleContracts.documentation",
    lifecycleContracts?.documentation,
    expected.lifecycleDocumentation,
  );
  requireEqual(
    failures,
    "portableLifecycleContracts.documentationSha256",
    lifecycleContracts?.documentationSha256,
    expected.lifecycleDocumentationSha256,
  );
  requireEqual(failures, "portableLifecycleContracts.contractOnly", lifecycleContracts?.contractOnly, false);
  requireEqual(
    failures,
    "portableLifecycleContracts.runtimeImplementationIncluded",
    lifecycleContracts?.runtimeImplementationIncluded,
    true,
  );
  requireEqual(
    failures,
    "portableLifecycleContracts.publicSchemaChangesIncluded",
    lifecycleContracts?.publicSchemaChangesIncluded,
    true,
  );
  requireEqual(
    failures,
    "portableLifecycleContracts exact object digest",
    sha256Json(lifecycleContracts),
    expected.lifecycleContractsSha256,
  );
  for (const [name, holds] of lifecycleSemanticInvariants) {
    if (!holds(lifecycleContracts)) {
      failures.push(diagnostic(`portableLifecycleContracts semantic invariant "${name}" must hold`));
    }
  }
  if (!SHA256.test(lifecycleContracts?.documentationSha256 ?? "")) {
    failures.push(diagnostic("portableLifecycleContracts.documentationSha256 must be 64 lowercase hex characters"));
  }
  try {
    const documentationBytes = await readFile(path.join(root, expected.lifecycleDocumentation));
    const digest = createHash("sha256").update(documentationBytes).digest("hex");
    requireEqual(
      failures,
      "portableLifecycleContracts.documentationSha256",
      digest,
      expected.lifecycleDocumentationSha256,
    );
  } catch (error) {
    failures.push(diagnostic(`portableLifecycleContracts.documentation is unreadable: ${error.message}`));
  }
  if (
    topology?.writableOmpAuthoritiesPerSession !== lifecycleContracts?.desiredStateMachine?.Running?.writerCardinalityMaximum ||
    topology?.interactiveWriterInvocationAllowed !== false
  ) {
    failures.push(diagnostic("portableLifecycleContracts ADR-025 single-authority alignment must hold"));
  }
  if (
    !sameJson(controlContracts?.revision?.distinctFrom, ["generation", "eventCursor"]) ||
    !lifecycleContracts?.authorities?.distinctValues?.includes("resourceRevision") ||
    !lifecycleContracts?.authorities?.distinctValues?.includes("runtimeGeneration") ||
    !lifecycleContracts?.authorities?.distinctValues?.includes("eventCursor")
  ) {
    failures.push(diagnostic("portableLifecycleContracts ADR-021 revision/generation/cursor separation must hold"));
  }
  if (
    !sameJson(controlContracts?.routes?.boundTo, ["runtimeId", "generation"]) ||
    !sameJson(lifecycleContracts?.routeTicketInvalidation?.routesAndTicketsBoundTo, ["runtimeId", "runtimeGeneration"])
  ) {
    failures.push(diagnostic("portableLifecycleContracts ADR-021 generation-bound route alignment must hold"));
  }
  const lifecycleInvalidationTriggers = new Set(
    lifecycleContracts?.routeTicketInvalidation?.invalidationTriggers ?? [],
  );
  const lifecycleTriggerForControlTrigger = {
    controlDisconnect: "controlDisconnect",
    providerControlGenerationReplacement: "providerControlGenerationReplacement",
    runtimeGenerationReplacement: "runtimeGenerationReplacement",
    explicitCancellation: "explicitCancellation",
  };
  if (
    controlContracts?.tickets?.invalidationTriggers?.some(
      (trigger) => !lifecycleInvalidationTriggers.has(lifecycleTriggerForControlTrigger[trigger]),
    )
  ) {
    failures.push(diagnostic("portableLifecycleContracts ADR-021 ticket invalidation alignment must hold"));
  }
  if (
    controlContracts?.tombstones?.creationOrder !== "before-backend-delete" ||
    controlContracts?.tombstones?.deletionOnCreationUncertaintyAllowed !== false ||
    lifecycleContracts?.deletionMachine?.tombstoneBeforeBackendDelete !== true ||
    lifecycleContracts?.deletionMachine?.backendDeleteOnTombstoneUncertaintyAllowed !== false ||
    lifecycleContracts?.deletionMachine?.fenceProvenBeforeTombstone !== true ||
    lifecycleContracts?.deletionMachine?.tombstoneImmediatelyBeforeBackendCleanup !== true ||
    lifecycleContracts?.deletionMachine?.tombstoneRetainedAfterRetentionDisposition !== true
  ) {
    failures.push(diagnostic("portableLifecycleContracts ADR-021 tombstone ordering and retention must hold"));
  }
  try {
    const openApi = JSON.parse(await readFile(path.join(root, OPENAPI_PATH), "utf8"));
    requireJsonEqual(
      failures,
      "portableLifecycleContracts OpenAPI DesiredState registry",
      lifecycleContracts?.openApiRegistry?.desiredStates,
      openApi?.components?.schemas?.DesiredState?.enum,
    );
    requireJsonEqual(
      failures,
      "portableLifecycleContracts OpenAPI Phase registry",
      lifecycleContracts?.openApiRegistry?.publicPhases,
      openApi?.components?.schemas?.Phase?.enum,
    );
  } catch (error) {
    failures.push(diagnostic(`portable lifecycle OpenAPI registry is unreadable: ${error.message}`));
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
      "portableAuthorizationContracts.rest.operations.patchRuntime RuntimePatch schema property registry",
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
    const commandSource = (
      await Promise.all(COMMAND_REGISTRY_PATHS.map((registryPath) => readFile(path.join(root, registryPath), "utf8")))
    ).join("\n");
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss.commandDescriptorKeys",
      [...(authorizationContracts?.ompAppWss?.commandDescriptorKeys ?? [])].sort(),
      commandDescriptorKeys(commandSource).sort(),
    );
    const confirmationEntries = commandDescriptorConfirmations(commandSource);
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss command confirmation keys",
      confirmationEntries.map(([key]) => key).sort(),
      [...(authorizationContracts?.ompAppWss?.commandDescriptorKeys ?? [])].sort(),
    );
    requireJsonEqual(
      failures,
      "portableAuthorizationContracts.ompAppWss.challengeCommandDescriptorKeys",
      [...(authorizationContracts?.ompAppWss?.challengeCommandDescriptorKeys ?? [])].sort(),
      confirmationEntries
        .filter(([, confirmation]) => confirmation === "challenge")
        .map(([key]) => key)
        .sort(),
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

  const threatModel = manifest.portableThreatModel;
  for (const [label, actual, wanted] of [
    [
      "portableThreatModel.decision",
      threatModel?.decision,
      "transport-provider-backend-neutral-fail-closed-threat-controls",
    ],
    [
      "portableThreatModel.documentation",
      threatModel?.documentation,
      expected.threatModelDocumentation,
    ],
    [
      "portableThreatModel.documentationSha256",
      threatModel?.documentationSha256,
      expected.threatModelDocumentationSha256,
    ],
    ["portableThreatModel.specificationSection", threatModel?.specificationSection, "Appendix B.10"],
    ["portableThreatModel.contractOnly", threatModel?.contractOnly, true],
    ["portableThreatModel.runtimeImplementationIncluded", threatModel?.runtimeImplementationIncluded, false],
    ["portableThreatModel.deploymentChangesIncluded", threatModel?.deploymentChangesIncluded, false],
    ["portableThreatModel.publicSchemaChangesIncluded", threatModel?.publicSchemaChangesIncluded, false],
    ["portableThreatModel.newProtocolIncluded", threatModel?.newProtocolIncluded, false],
    [
      "portableThreatModel.implementationBoundaries.currentImplementationClaim",
      threatModel?.implementationBoundaries?.currentImplementationClaim,
      false,
    ],
  ]) {
    requireEqual(failures, label, actual, wanted);
  }
  requireJsonEqual(
    failures,
    "portableThreatModel.trustBoundaries",
    threatModel?.trustBoundaries,
    [
      "public-rest-sse",
      "public-omp-app-wss",
      "public-direct-cmux-wss",
      "public-ssh-provider",
      "public-discovery-status-observability",
      "trusted-ingress-identity-adapter",
      "edge-control-plane",
      "driver-backend-control-store",
      "backend-object-storage-controller-runtime",
      "controller-runtime",
      "runtime-process",
      "runtime-credential-model-gateway",
      "runtime-browser-cdp",
      "runtime-network-egress",
      "component-observability-sink",
    ],
  );
  requireJsonEqual(
    failures,
    "portableThreatModel.threatClasses",
    threatModel?.threatClasses,
    [
      "ticketReplay", "senderIdentity", "shellPathInjection", "credentialExposure",
      "crossScopeAccess", "duplicateWriters", "runtimeIsolation", "auditLeakage",
    ],
  );
  requireEqual(
    failures,
    "portableThreatModel contract SHA-256",
    sha256Json(threatModel),
    expected.threatModelContractsSha256,
  );
  if (!SHA256.test(threatModel?.documentationSha256 ?? "")) {
    failures.push(diagnostic("portableThreatModel.documentationSha256 must be 64 lowercase hex characters"));
  }
  for (const [name, holds] of threatModelSemanticInvariants) {
    if (!holds(threatModel)) {
      failures.push(diagnostic(`portableThreatModel semantic invariant "${name}" must hold`));
    }
  }
  for (const [name, holds] of threatCrossContractInvariants) {
    if (!holds(manifest)) {
      failures.push(diagnostic(`portableThreatModel cross-contract invariant "${name}" must hold`));
    }
  }
  try {
    const documentationBytes = await readFile(path.join(root, expected.threatModelDocumentation));
    const digest = createHash("sha256").update(documentationBytes).digest("hex");
    requireEqual(
      failures,
      "portableThreatModel.documentationSha256",
      digest,
      expected.threatModelDocumentationSha256,
    );
  } catch (error) {
    failures.push(diagnostic(`portableThreatModel.documentation is unreadable: ${error.message}`));
  }

  requireEqual(failures, "ompPinResolution.repository", manifest.ompPinResolution?.repository, expected.portableOmpRepository);
  requireEqual(failures, "ompPinResolution.sourceCommit", manifest.ompPinResolution?.sourceCommit, expected.portableOmpCommit);
  requireCommit(failures, "ompPinResolution.sourceCommit", manifest.ompPinResolution?.sourceCommit);
  requireEqual(failures, "ompPinResolution.contractCommit", manifest.ompPinResolution?.contractCommit, expected.ompBaseline);
  requireEqual(failures, "ompPinResolution.contractAncestry", manifest.ompPinResolution?.contractAncestry, "descendant");
  requireEqual(failures, "ompPinResolution.provenance", manifest.ompPinResolution?.provenance, expected.portableOmpProvenance);
  requireEqual(failures, "ompPinResolution.strategy", manifest.ompPinResolution?.strategy, "immutable-source-authority");
  requireEqual(
    failures,
    "ompPinResolution.portableRuntimeAdmission",
    manifest.ompPinResolution?.portableRuntimeAdmission,
    "admitted",
  );
  requireEqual(failures, "ompPinResolution.reason", manifest.ompPinResolution?.reason, expected.pinResolutionReason);
  requireEqual(failures, "ompPinResolution.bridge.protocol", manifest.ompPinResolution?.bridge?.protocol, "t4-omp-authority/1");
  requireEqual(failures, "ompPinResolution.bridge.compatibilityStatus", manifest.ompPinResolution?.bridge?.compatibilityStatus, "admitted");
  if (!Array.isArray(manifest.ompPinResolution?.bridge?.methods) || manifest.ompPinResolution.bridge.methods.length !== 33) {
    failures.push(diagnostic("ompPinResolution.bridge.methods must contain the complete 33-method authority contract"));
  }
  if ("currentPackagedCommit" in (manifest.ompPinResolution ?? {})) {
    failures.push(diagnostic("ompPinResolution must not retain a legacy packaged commit as the current portable authority"));
  }
  try {
    const provenance = JSON.parse(await readFile(path.join(root, expected.portableOmpProvenance), "utf8"));
    requireEqual(failures, "OMP provenance source repository", provenance.source?.repository, manifest.ompPinResolution?.repository);
    requireEqual(failures, "OMP provenance source commit", provenance.source?.commit, manifest.ompPinResolution?.sourceCommit);
    requireEqual(failures, "OMP provenance contract commit", provenance.source?.contractCommit, manifest.ompPinResolution?.contractCommit);
    requireEqual(failures, "OMP provenance contract ancestry", provenance.source?.contractAncestry, manifest.ompPinResolution?.contractAncestry);
    if (JSON.stringify(provenance.bridge) !== JSON.stringify(manifest.ompPinResolution?.bridge)) {
      failures.push(diagnostic("OMP provenance bridge contract must match ompPinResolution.bridge"));
    }
  } catch (error) {
    failures.push(diagnostic(`ompPinResolution.provenance is unreadable: ${error.message}`));
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
