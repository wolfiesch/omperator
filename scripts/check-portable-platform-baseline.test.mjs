import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkPortablePlatformBaseline,
  COMMAND_REGISTRY_PATHS,
} from "./check-portable-platform-baseline.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "compat/portable-agent-platform-v1.json");

async function fixture(mutator = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-platform-baseline-"));
  await mkdir(path.join(root, "compat"), { recursive: true });
  await mkdir(path.join(root, "provenance"), { recursive: true });
  await mkdir(path.join(root, "docs/adr"), { recursive: true });
  await mkdir(path.join(root, "packages/t4-api-contract"), { recursive: true });
  await mkdir(path.join(root, "packages/host-wire/src"), { recursive: true });
  await mkdir(path.join(root, "packages/host-wire/src/command-descriptors"), { recursive: true });
  await mkdir(
    path.join(root, "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src"),
    { recursive: true },
  );
  await writeFile(
    path.join(root, "provenance/cmux-machine-provider-v1.json"),
    await readFile(path.join(repositoryRoot, "provenance/cmux-machine-provider-v1.json")),
  );
  await writeFile(
    path.join(root, "provenance/omp-runtime-v1.json"),
    await readFile(path.join(repositoryRoot, "provenance/omp-runtime-v1.json")),
  );
  await writeFile(
    path.join(root, "docs/adr/025-portable-runtime-single-authority.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/025-portable-runtime-single-authority.md")),
  );
  await writeFile(
    path.join(root, "docs/adr/021-portable-driver-control-contracts.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/021-portable-driver-control-contracts.md")),
  );
  await writeFile(
    path.join(root, "docs/adr/022-portable-identity-authorization-contract.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/022-portable-identity-authorization-contract.md")),
  );
  await writeFile(
    path.join(root, "docs/adr/023-portable-lifecycle-state-machines.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/023-portable-lifecycle-state-machines.md")),
  );
  await writeFile(
    path.join(root, "docs/adr/024-portable-threat-model.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/024-portable-threat-model.md")),
  );
  await writeFile(
    path.join(root, "packages/t4-api-contract/openapi.json"),
    await readFile(path.join(repositoryRoot, "packages/t4-api-contract/openapi.json")),
  );
  for (const registryPath of COMMAND_REGISTRY_PATHS) {
    await writeFile(
      path.join(root, registryPath),
      await readFile(path.join(repositoryRoot, registryPath)),
    );
  }
  await writeFile(
    path.join(root, "packages/host-wire/src/envelope.ts"),
    await readFile(path.join(repositoryRoot, "packages/host-wire/src/envelope.ts")),
  );
  await writeFile(
    path.join(root, "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs"),
    await readFile(
      path.join(
        repositoryRoot,
        "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs",
      ),
    ),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutator(manifest);
  await writeFile(
    path.join(root, "compat/portable-agent-platform-v1.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

test("accepts the pinned portable platform baseline", async () => {
  const result = await checkPortablePlatformBaseline(await fixture());
  assert.deepEqual(result.failures, []);
});

test("rejects abbreviated or drifting upstream pins", async () => {
  const root = await fixture((manifest) => {
    manifest.baselines.cmux.commit = "192e444";
    manifest.baselines.omp.commit = "a".repeat(40);
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(result.failures.some((failure) => failure.includes("baselines.cmux.commit must be a full")));
  assert(result.failures.some((failure) => failure.includes("baselines.omp.commit must be")));
});

test("rejects drift in contract-bearing repositories, dates, tags, and rationale", async () => {
  const root = await fixture((manifest) => {
    manifest.specification.date = "2026-07-29";
    manifest.baselines.omperator.repository = "https://example.test/omperator";
    manifest.baselines.cmux.repository = "https://example.test/cmux";
    manifest.baselines.omp.repository = "https://example.test/omp";
    manifest.implementationStart.packagedOmpAuthority.repository = "https://example.test/fork";
    manifest.implementationStart.packagedOmpAuthority.tag = "moving-tag";
    manifest.implementationStart.packagedOmpAuthority.upstreamRepository = "https://example.test/upstream";
    manifest.implementationStart.packagedOmpAuthority.upstreamTag = "moving-upstream-tag";
    manifest.ompPinResolution.reason = "trust the current package";
    manifest.ompPinResolution.sourceCommit = "a".repeat(40);
    manifest.ompPinResolution.bridge.compatibilityStatus = "missing-bridge";
    manifest.cmuxMachineProviderImport.manifestSha256 = "b".repeat(64);
    manifest.cmuxMachineProviderImport.fixtureCorpusSha256 = "c".repeat(64);
  });
  const result = await checkPortablePlatformBaseline(root);
  for (const field of [
    "specification.date",
    "baselines.omperator.repository",
    "baselines.cmux.repository",
    "baselines.omp.repository",
    "implementationStart.packagedOmpAuthority.repository",
    "implementationStart.packagedOmpAuthority.tag",
    "implementationStart.packagedOmpAuthority.upstreamRepository",
    "implementationStart.packagedOmpAuthority.upstreamTag",
    "ompPinResolution.reason",
    "ompPinResolution.sourceCommit",
    "ompPinResolution.bridge.compatibilityStatus",
    "cmuxMachineProviderImport.manifestSha256",
    "cmuxMachineProviderImport.fixtureCorpusSha256",
  ]) {
    assert(result.failures.some((failure) => failure.includes(field)), `missing diagnostic for ${field}`);
  }
});

test("rejects weakening the admitted OMP pin resolution", async () => {
  const root = await fixture((manifest) => {
    manifest.ompPinResolution.strategy = "use-current-package";
    manifest.ompPinResolution.portableRuntimeAdmission = "allowed";
    manifest.compatibilitySetPolicy.independentComponentRollsAllowed = true;
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(result.failures.some((failure) => failure.includes("immutable-source-authority")));
  assert(result.failures.some((failure) => failure.includes("admitted")));
  assert(result.failures.some((failure) => failure.includes("independentComponentRollsAllowed")));
});

test("rejects weakening the one-authority runtime topology", async () => {
  const root = await fixture((manifest) => {
    manifest.baselines.cmux.muxProtocol = 11;
    manifest.runtimeTopology.authorityProcessOwner = "cmux";
    manifest.runtimeTopology.authorityInvocation = "omp --resume <runtime-owned-session-path>";
    manifest.runtimeTopology.authorityTransport = "unix-socket";
    manifest.runtimeTopology.applicationAttachProtocol = "private-attach-v1";
    manifest.runtimeTopology.cmuxTerminalAttachMode = "launch-second-writer";
    manifest.runtimeTopology.writableOmpAuthoritiesPerSession = 2;
    manifest.runtimeTopology.cmuxTerminalAttachProtocol = "private-attach-v1";
    manifest.runtimeTopology.interactiveWriterInvocationAllowed = true;
    manifest.runtimeTopology.rawRpcNetworkExposureAllowed = true;
    manifest.runtimeTopology.implementationAdmission = "allowed";
  });
  const result = await checkPortablePlatformBaseline(root);
  for (const field of [
    "baselines.cmux.muxProtocol",
    "runtimeTopology.authorityProcessOwner",
    "runtimeTopology.authorityInvocation",
    "runtimeTopology.authorityTransport",
    "runtimeTopology.applicationAttachProtocol",
    "runtimeTopology.cmuxTerminalAttachMode",
    "runtimeTopology.writableOmpAuthoritiesPerSession",
    "runtimeTopology.cmuxTerminalAttachProtocol",
    "runtimeTopology.interactiveWriterInvocationAllowed",
    "runtimeTopology.rawRpcNetworkExposureAllowed",
    "runtimeTopology.implementationAdmission",
  ]) {
    assert(result.failures.some((failure) => failure.includes(field)), `missing diagnostic for ${field}`);
  }
});

test("rejects topology documentation drift", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "docs/adr/025-portable-runtime-single-authority.md"), "drift\n");
  const result = await checkPortablePlatformBaseline(root);
  assert(result.failures.some((failure) => failure.includes("runtimeTopology.documentationSha256")));
});

test("rejects portable control-contract manifest and ADR digest drift", async () => {
  const manifestRoot = await fixture((manifest) => {
    manifest.portableControlContracts.documentation = "docs/adr/unpinned.md";
    manifest.portableControlContracts.documentationSha256 = "a".repeat(64);
  });
  const manifestResult = await checkPortablePlatformBaseline(manifestRoot);
  assert(
    manifestResult.failures.some((failure) => failure.includes("portableControlContracts")),
    "missing portable control-contract manifest drift diagnostic",
  );

  const adrRoot = await fixture();
  await writeFile(path.join(adrRoot, "docs/adr/021-portable-driver-control-contracts.md"), "drift\n");
  const adrResult = await checkPortablePlatformBaseline(adrRoot);
  assert(
    adrResult.failures.some((failure) =>
      failure.includes("portableControlContracts.documentationSha256"),
    ),
    "missing portable control-contract ADR digest diagnostic",
  );
});

const weakenedControlContractCases = [
  ["backend-neutral decision", (contract) => {
    contract.decision = "postgresql-control-store";
  }],
  ["PostgreSQL prescription supersession", (contract) => {
    contract.supersedesRequiredBackend = null;
  }],
  ["no required backend", (contract) => {
    contract.requiredBackend = "postgresql";
  }],
  ["optional backend implementations", (contract) => contract.optionalImplementations.pop()],
  ["P1-01 first code boundary", (contract) => {
    contract.firstCodeImplementationWorkPackage = "P0-05";
  }],
  ["resource operations", (contract) => contract.driver.operations.runtime.pop()],
  ["capability operation", (contract) => {
    delete contract.driver.operations.capability;
  }],
  ["capability categories", (contract) => contract.driver.reportedCapabilityCategories.pop()],
  ["typed unsupported result", (contract) => {
    contract.driver.unsupportedCapabilityResult = "empty-success";
  }],
  ["driver backend neutrality", (contract) => {
    contract.driver.backendFieldsAllowed = true;
  }],
  ["minimal route descriptor", (contract) => contract.routes.descriptorFields.push("host")],
  ["exact semantic route kinds", (contract) => contract.routes.routeKinds.pop()],
  ["opaque route references", (contract) => {
    contract.routes.referenceSemantics = "parseable";
  }],
  ["generation-bound route references", (contract) => contract.routes.boundTo.pop()],
  ["runtime-bound route references", (contract) => contract.routes.boundTo.shift()],
  ["route generation invalidation", (contract) => {
    contract.routes.invalidatedByGenerationChange = false;
  }],
  ["route backend neutrality", (contract) => {
    contract.routes.backendFieldsAllowed = true;
  }],
  ["route edge endpoint neutrality", (contract) => {
    contract.routes.edgeEndpointFieldsAllowed = true;
  }],
  ["ConnectionDescriptor edge boundary", (contract) => {
    contract.routes.publicConnectionDescriptorRole = "driver-route";
  }],
  ["opaque equality-only revisions", (contract) => {
    contract.revision.semantics = "ordered-integer";
  }],
  ["revision separation", (contract) => contract.revision.distinctFrom.pop()],
  ["revision ordering prohibition", (contract) => {
    contract.revision.orderingAllowed = true;
  }],
  ["revision derivation prohibition", (contract) => {
    contract.revision.derivationAllowed = true;
  }],
  ...[
    "workspace.update",
    "workspace.delete",
    "runtime.update",
    "runtime.delete",
    "runtime.setDesiredState",
  ].map((operation) => [
    `expectedRevision requirement for ${operation}`,
    (contract) => {
      contract.revision.expectedRevisionRequiredFor =
        contract.revision.expectedRevisionRequiredFor.filter((candidate) => candidate !== operation);
    },
  ]),
  ["workspace retention revision path", (contract) => {
    contract.revision.workspaceRetentionMutation = "workspace.setRetention";
  }],
  ["typed revision mismatch", (contract) => {
    contract.revision.mismatchOutcome = "conflict";
  }],
  ["current revision in mismatch", (contract) => {
    contract.revision.mismatchIncludesCurrentRevision = false;
  }],
  ["revision mismatch has no side effect", (contract) => {
    contract.revision.mismatchSideEffectsAllowed = true;
  }],
  ["last-write-wins prohibition", (contract) => {
    contract.revision.lastWriteWinsAllowed = true;
  }],
  ...["reserve", "complete"].map((operation) => [
    `idempotency operation ${operation}`,
    (contract) => {
      contract.idempotency.operations =
        contract.idempotency.operations.filter((candidate) => candidate !== operation);
    },
  ]),
  ...["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey"].map((field) => [
    `idempotency lookup key ${field}`,
    (contract) => {
      contract.idempotency.lookupKey =
        contract.idempotency.lookupKey.filter((candidate) => candidate !== field);
    },
  ]),
  ["ordered idempotency lookup key", (contract) => {
    contract.idempotency.lookupKey.reverse();
  }],
  ["canonical body request fingerprint", (contract) => {
    contract.idempotency.requestFingerprint = ["canonicalPath"];
  }],
  ["replica-safe idempotency", (contract) => {
    contract.idempotency.replicaSafe = false;
  }],
  ["authoritative shared idempotency store", (contract) => {
    contract.idempotency.authoritativeSharedStoreRequired = false;
  }],
  ["idempotency retention", (contract) => {
    contract.idempotency.minimumRetentionSeconds = 86399;
  }],
  ["atomic idempotency reservation", (contract) => {
    contract.idempotency.reserveAtomic = false;
  }],
  ["idempotency reserve outcomes", (contract) => contract.idempotency.reserveOutcomes.pop()],
  ["matching idempotency fingerprint outcomes", (contract) => {
    contract.idempotency.matchingFingerprintOutcomes.pop();
  }],
  ["differing idempotency fingerprint conflict", (contract) => {
    contract.idempotency.differingFingerprintOutcome = "replay";
  }],
  ["idempotency reservation token", (contract) => {
    contract.idempotency.newOutcomeReturnsReservationToken = false;
  }],
  ["exact retry replay", (contract) => {
    contract.idempotency.replayOutcomeIncludesRecordedResult = false;
  }],
  ["conditional idempotency completion", (contract) => {
    contract.idempotency.completeCondition = "unconditional";
  }],
  ["indeterminate idempotency recovery", (contract) => {
    contract.idempotency.indeterminateRecovery = "rerun-mutation";
  }],
  ["no process-local idempotency fallback", (contract) => {
    contract.idempotency.processLocalFallbackAllowed = true;
  }],
  ...["mint", "consume", "revoke"].map((operation) => [
    `ticket operation ${operation}`,
    (contract) => {
      contract.tickets.operations =
        contract.tickets.operations.filter((candidate) => candidate !== operation);
    },
  ]),
  ["authoritative shared ticket CAS", (contract) => {
    contract.tickets.store = "process-local";
  }],
  ["digest-only tickets", (contract) => {
    contract.tickets.storedMaterial = "plaintext";
  }],
  ["no ticket plaintext retention", (contract) => {
    contract.tickets.plaintextRetentionAllowed = true;
  }],
  ...["runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose"].map((field) => [
    `ticket binding ${field}`,
    (contract) => {
      contract.tickets.recordAndConsumeBoundTo =
        contract.tickets.recordAndConsumeBoundTo.filter((candidate) => candidate !== field);
    },
  ]),
  ["ticket maximum TTL", (contract) => {
    contract.tickets.maximumTtlSeconds = 61;
  }],
  ["atomic ticket consumption", (contract) => {
    contract.tickets.consumption = "read-then-delete";
  }],
  ["atomic ticket revocation", (contract) => {
    contract.tickets.revocation = "best-effort";
  }],
  ...[
    "controlDisconnect",
    "providerControlGenerationReplacement",
    "runtimeGenerationReplacement",
    "explicitCancellation",
  ].map((trigger) => [
    `ticket invalidation ${trigger}`,
    (contract) => {
      contract.tickets.invalidationTriggers =
        contract.tickets.invalidationTriggers.filter((candidate) => candidate !== trigger);
    },
  ]),
  ["single-use tickets", (contract) => {
    contract.tickets.singleUse = false;
  }],
  ["replica-safe tickets", (contract) => {
    contract.tickets.replicaSafe = false;
  }],
  ["tombstone operations", (contract) => contract.tombstones.operations.pop()],
  ["pre-delete tombstones", (contract) => {
    contract.tombstones.creationOrder = "after-backend-delete";
  }],
  ["atomic tombstone creation", (contract) => {
    contract.tombstones.creationAtomic = false;
  }],
  ["tombstone failure closure", (contract) => {
    contract.tombstones.deletionOnCreationUncertaintyAllowed = true;
  }],
  ["tombstone minimum retention", (contract) => {
    contract.tombstones.minimumRetentionSeconds = 86399;
  }],
  ["tombstone maximum retention", (contract) => {
    contract.tombstones.maximumRetentionSeconds = null;
  }],
  ["tombstone count bound", (contract) => {
    contract.tombstones.maximumRecordsPerScope = null;
  }],
  ["tombstone capacity failure closure", (contract) => {
    contract.tombstones.capacityOutcome = "evict-oldest-and-delete";
  }],
  ["identifier reuse prevention after tombstone expiry", (contract) => {
    contract.tombstones.identifierReuseAfterExpiryAllowed = true;
  }],
  ["stable-ID non-reuse authority", (contract) => {
    contract.tombstones.identifierReuseAuthority = "live-tombstone-only";
  }],
  ...["append", "readAfter", "subscribe"].map((operation) => [
    `journal operation ${operation}`,
    (contract) => {
      contract.eventJournal.operations =
        contract.eventJournal.operations.filter((candidate) => candidate !== operation);
    },
  ]),
  ...[
    "eventId",
    "resourceKind",
    "resourceId",
    "scopeId",
    "revision",
    "phase",
    "timestamp",
  ].map((field) => [
    `journal entry field ${field}`,
    (contract) => {
      contract.eventJournal.entryFields =
        contract.eventJournal.entryFields.filter((candidate) => candidate !== field);
    },
  ]),
  ["journal entry API bounds", (contract) => {
    contract.eventJournal.entryFieldBounds = "unbounded";
  }],
  ["infrastructure-only journal", (contract) => {
    contract.eventJournal.payload = "resource-and-transcript-events";
  }],
  ["replica-safe journal", (contract) => {
    contract.eventJournal.replicaSafe = false;
  }],
  ["ordered journal", (contract) => {
    contract.eventJournal.ordering = "best-effort";
  }],
  ["bounded journal", (contract) => {
    contract.eventJournal.retention = "unbounded";
  }],
  ["opaque journal cursors", (contract) => {
    contract.eventJournal.cursorSemantics = "numeric-offset";
  }],
  ["journal cursor separation", (contract) => contract.eventJournal.cursorDistinctFrom.pop()],
  ["explicit expired cursor", (contract) => {
    contract.eventJournal.expiredCursorOutcome = "empty-success";
  }],
  ...["event", "eventId", "reason", "timestamp"].map((field) => [
    `SSE ResetEvent field ${field}`,
    (contract) => {
      contract.eventJournal.sseExpiredCursorEvent.fields =
        contract.eventJournal.sseExpiredCursorEvent.fields.filter(
          (candidate) => candidate !== field,
        );
    },
  ]),
  ["SSE expired cursor event", (contract) => {
    contract.eventJournal.sseExpiredCursorEvent.event = "message";
  }],
  ["SSE expired cursor reason", (contract) => {
    contract.eventJournal.sseExpiredCursorEvent.reason = "cursorExpired";
  }],
  ...["eventId", "timestamp"].map((field) => [
    `SSE ResetEvent allocated ${field}`,
    (contract) => {
      contract.eventJournal.sseExpiredCursorEvent.allocatedFields =
        contract.eventJournal.sseExpiredCursorEvent.allocatedFields.filter(
          (candidate) => candidate !== field,
        );
    },
  ]),
  ["SSE ResetEvent allocated field bounds", (contract) => {
    contract.eventJournal.sseExpiredCursorEvent.allocatedFieldBounds = "unbounded";
  }],
  ["atomic list high-water H", (contract) => {
    contract.eventJournal.listReturnsCursor = "eventually-consistent";
  }],
  ...["orderedBatch", "tailNextCursorT"].map((component) => [
    `readAfter result ${component}`,
    (contract) => {
      contract.eventJournal.readAfterReturns =
        contract.eventJournal.readAfterReturns.filter((candidate) => candidate !== component);
    },
  ]),
  ["empty readAfter returns H as T", (contract) => {
    contract.eventJournal.emptyReadAfterTailCursor = "new-tail";
  }],
  ["subscribe starts strictly after T", (contract) => {
    contract.eventJournal.subscribeStarts = "after-H";
  }],
  ["subscribe replays from T", (contract) => {
    contract.eventJournal.subscribeReplayCursor = "current-tail";
  }],
  ["inter-call journal event preservation", (contract) => {
    contract.eventJournal.interCallEventLossAllowed = true;
  }],
  ["no list/watch gap", (contract) => {
    contract.eventJournal.listWatchGapAllowed = true;
  }],
];

for (const [name, weaken] of weakenedControlContractCases) {
  test(`rejects weakened portable control contract: ${name}`, async () => {
    const root = await fixture((manifest) => weaken(manifest.portableControlContracts));
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) => failure.includes("portableControlContracts")),
      `missing portable control-contract diagnostic for ${name}`,
    );
  });
}

test("rejects backend coordinate and edge endpoint field leakage in route descriptors", async () => {
  const root = await fixture((manifest) => {
    manifest.portableControlContracts.routes.kubernetesNamespace = "runtime-system";
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("leaks a backend coordinate or edge endpoint field"),
    ),
  );
});

test("rejects portable lifecycle-contract manifest and ADR digest drift", async () => {
  const manifestRoot = await fixture((manifest) => {
    manifest.portableLifecycleContracts.documentationSha256 = "a".repeat(64);
  });
  const manifestResult = await checkPortablePlatformBaseline(manifestRoot);
  assert(
    manifestResult.failures.some((failure) => failure.includes("portableLifecycleContracts")),
    "missing portable lifecycle-contract manifest drift diagnostic",
  );

  const adrRoot = await fixture();
  await writeFile(path.join(adrRoot, "docs/adr/023-portable-lifecycle-state-machines.md"), "drift\n");
  const adrResult = await checkPortablePlatformBaseline(adrRoot);
  assert(
    adrResult.failures.some((failure) =>
      failure.includes("portableLifecycleContracts.documentationSha256"),
    ),
    "missing portable lifecycle-contract ADR digest diagnostic",
  );
});

const weakenedLifecycleContractCases = [
  ["workload-inferred desired state", "desired state authority", (contract) => {
    contract.authorities.desiredStateSource = "workload-observation";
    contract.authorities.workloadMayRewriteDesiredState = true;
  }],
  ["generation authority conflation", "runtime generation authorities", (contract) => {
    contract.authorities.distinctValues = ["resourceRevision", "eventCursor"];
    contract.authorities.runtimeGenerationDerivationAllowedFrom = ["kubernetesMetadataGeneration"];
  }],
  ["generation advance before fencing", "generation advance must wait", (contract) => {
    contract.generationMachine.advanceBeforeFenceProvenAllowed = true;
  }],
  ["generation reuse after potential writer", "must never reuse a generation", (contract) => {
    contract.generationMachine.potentialWriterAttemptGenerationReuseAllowed = true;
  }],
  ["FenceUncertain replaced by Failed", "sole uncertain terminal", (contract) => {
    contract.fenceMachine.uncertainTerminalOutcomes = ["Failed"];
  }],
  ["second uncertain terminal added", "sole uncertain terminal", (contract) => {
    contract.fenceMachine.uncertainTerminalOutcomes.push("Failed");
  }],
  ["FenceUncertain made retryable", "sole uncertain terminal", (contract) => {
    contract.fenceMachine.fenceUncertainAutomaticRetryAllowed = true;
  }],
  ["FenceUncertain projected as Failed", "public projection must fail closed", (contract) => {
    contract.fenceMachine.fenceUncertainPublicProjection.phase = "Failed";
  }],
  ["FenceUncertain recovery omits fresh proof", "recovery must use a new resource revision", (contract) => {
    contract.generationMachine.fenceUncertainExitRequires =
      ["explicit-manual-recovery-under-new-resource-revision"];
  }],
  ["FenceUncertain recovery omits manual action", "recovery must use a new resource revision", (contract) => {
    contract.generationMachine.fenceUncertainExitRequires =
      ["fresh-authoritative-proof-under-new-resource-revision"];
  }],
  ["route allowed during Starting", "Ready-only route", (contract) => {
    contract.routeTicketInvalidation.publicationPhase = "Starting";
  }],
  ["runtime generation invalidation removed", "ticket invalidation", (contract) => {
    contract.routeTicketInvalidation.invalidationTriggers =
      contract.routeTicketInvalidation.invalidationTriggers.filter(
        (trigger) => trigger !== "runtimeGenerationReplacement",
      );
  }],
  ["replacement CAS moved before attachment proof", "replacement must prove process", (contract) => {
    const actions = contract.replacementMachine.orderedActions;
    [actions[2], actions[3]] = [actions[3], actions[2]];
  }],
  ["Lease accepted as sole fence proof", "replacement must prove process", (contract) => {
    contract.replacementMachine.leaseAloneIsFenceProof = true;
  }],
  ["Kubernetes attachment proof removed", "Kubernetes fencing", (contract) => {
    contract.fenceMachine.kubernetesProofConjunction =
      contract.fenceMachine.kubernetesProofConjunction.filter(
        (proof) => proof !== "runtimeStateAttachmentReleasedOrOldNodeStorageFenced",
      );
  }],
  ["cmux readiness removed", "composite readiness", (contract) => {
    contract.readiness.conjunction =
      contract.readiness.conjunction.filter((check) => check !== "cmuxIdentifyProtocol10Ready");
  }],
  ["OMP authority readiness removed", "composite readiness", (contract) => {
    contract.readiness.conjunction =
      contract.readiness.conjunction.filter((check) => check !== "singlePinnedOmpAuthorityReady");
  }],
  ["generation authentication readiness removed", "composite readiness", (contract) => {
    contract.readiness.conjunction =
      contract.readiness.conjunction.filter(
        (check) => check !== "internalGenerationAuthenticationReady",
      );
  }],
  ["backend deletion before tombstone", "tombstone must follow positive fence", (contract) => {
    contract.deletionMachine.orderedStates = [
      "DeleteAccepted",
      "DrainingAndFencing",
      "BackendCleanup",
      "Tombstoned",
      "RetentionDisposition",
      "FinalizerComplete",
    ];
  }],
  ["Tombstoned state removed", "tombstone must follow positive fence", (contract) => {
    contract.deletionMachine.orderedStates =
      contract.deletionMachine.orderedStates.filter((state) => state !== "Tombstoned");
  }],
  ["BackendCleanup state removed", "tombstone must follow positive fence", (contract) => {
    contract.deletionMachine.orderedStates =
      contract.deletionMachine.orderedStates.filter((state) => state !== "BackendCleanup");
  }],
  ["backend deletion on uncertain tombstone", "tombstone must follow positive fence", (contract) => {
    contract.deletionMachine.backendDeleteOnTombstoneUncertaintyAllowed = true;
  }],
  ["finalizer skips retention", "finalizer must wait", (contract) => {
    contract.deletionMachine.finalizerRequires =
      contract.deletionMachine.finalizerRequires.filter(
        (requirement) => requirement !== "retentionDispositionComplete",
      );
  }],
  ["sleep equated with delete", "sleep and stop semantics", (contract) => {
    contract.desiredStateMachine.Sleeping.equivalentToDelete = true;
  }],
  ["stop becomes provider-auto-wakeable", "sleep and stop semantics", (contract) => {
    contract.desiredStateMachine.Stopped.providerPolicyWakeAllowed = true;
  }],
  ["consistent snapshot permits unquiesced state", "consistent snapshots", (contract) => {
    contract.snapshotRestore.consistentSnapshotRequires = ["storageSnapshotAvailable"];
  }],
  ["restore reuses source generation", "restore must use a fresh fence", (contract) => {
    contract.snapshotRestore.sourceGenerationReuseAllowed = true;
  }],
  ["snapshot attached to two live runtimes", "restore must use a fresh fence", (contract) => {
    contract.snapshotRestore.oneSnapshotAttachedToTwoLiveRuntimesAllowed = true;
  }],
  ["workspace mount accepted as runtime-state fence", "storage fencing must remain separate", (contract) => {
    contract.storageSeparation.workspaceAttachmentProvesRuntimeStateFence = true;
  }],
  ["legacy desired state no longer defaults Running", "legacy CRD evolution", (contract) => {
    contract.legacyCrdCompatibility.missingDesiredStateDefault = "Stopped";
  }],
  ["new CRD lifecycle fields made required", "legacy CRD evolution", (contract) => {
    contract.legacyCrdCompatibility.newFieldsRequired = true;
  }],
];

for (const [name, diagnostic, weaken] of weakenedLifecycleContractCases) {
  test(`rejects weakened portable lifecycle contract: ${name}`, async () => {
    const root = await fixture((manifest) => weaken(manifest.portableLifecycleContracts));
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) => failure.includes(diagnostic)),
      `missing portable lifecycle-contract diagnostic for ${name}`,
    );
  });
}

test("rejects OpenAPI DesiredState and Phase registry drift from lifecycle contracts", async () => {
  for (const [schemaName, mutate] of [
    ["DesiredState", (schema) => schema.enum.push("Paused")],
    ["Phase", (schema) => {
      schema.enum = schema.enum.filter((phase) => phase !== "Degraded");
    }],
  ]) {
    const root = await fixture();
    const openApiPath = path.join(root, "packages/t4-api-contract/openapi.json");
    const openApi = JSON.parse(await readFile(openApiPath, "utf8"));
    mutate(openApi.components.schemas[schemaName]);
    await writeFile(openApiPath, `${JSON.stringify(openApi, null, 2)}\n`);
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) =>
        failure.includes(`portableLifecycleContracts OpenAPI ${schemaName} registry`),
      ),
      `missing lifecycle OpenAPI ${schemaName} registry diagnostic`,
    );
  }
});

test("rejects portable authorization-contract manifest and ADR digest drift", async () => {
  const manifestRoot = await fixture((manifest) => {
    manifest.portableAuthorizationContracts.documentationSha256 = "a".repeat(64);
  });
  const manifestResult = await checkPortablePlatformBaseline(manifestRoot);
  assert(
    manifestResult.failures.some((failure) => failure.includes("portableAuthorizationContracts")),
    "missing portable authorization-contract manifest drift diagnostic",
  );

  const adrRoot = await fixture();
  await writeFile(path.join(adrRoot, "docs/adr/022-portable-identity-authorization-contract.md"), "drift\n");
  const adrResult = await checkPortablePlatformBaseline(adrRoot);
  assert(
    adrResult.failures.some((failure) =>
      failure.includes("portableAuthorizationContracts.documentationSha256"),
    ),
    "missing portable authorization-contract ADR digest diagnostic",
  );
});

const weakenedAuthorizationContractCases = [
  ["adapter proves principal", (contract) => {
    contract.interfaces.IdentityAdapter.provesOnly = "principal";
  }],
  ["client principal authority", (contract) => {
    contract.serverDerivedAuthorities.shift();
  }],
  ["unknown action fail open", (contract) => {
    contract.policy.unknownAction = "allow";
  }],
  ["missing capability intersection factor", (contract) => {
    contract.capabilities.formula.splice(2, 1);
  }],
  ["client capability widening", (contract) => {
    contract.capabilities.clientRequestMayOnlyNarrow = false;
  }],
  ["trusted proxy immediate-peer shortcut", (contract) => {
    contract.trustedProxy.immediatePeerTrustRequired = false;
  }],
  ["trusted proxy scope shortcut", (contract) => {
    contract.trustedProxy.neverSupplies = ["principalId"];
  }],
  ["implicit owner role grant", (contract) => {
    contract.roles.implicitOwnerGrantAllowed = true;
  }],
  ["implicit admin role grant", (contract) => {
    contract.roles.implicitAdminGrantAllowed = true;
  }],
  ["authority collapse", (contract) => {
    contract.distinctAuthorities = ["identityEvidence", "authorization"];
  }],
  ["grant invalidation omission", (contract) => {
    contract.grantInvalidation.pop();
  }],
  ["connection descriptor omission weakening", (contract) => {
    contract.connectionDescriptors.omitUnauthorizedTransports = false;
  }],
  ["cross-scope existence disclosure", (contract) => {
    contract.concealment.existenceLeakAllowed = true;
  }],
  ["confirmation without current reauthorization", (contract) => {
    contract.confirmation.consume = "accept-cached-confirmation";
  }],
  ["WSS frame bypass", (contract) => {
    contract.ompAppWss.authorizeEveryFrame = false;
  }],
  ["SSH shell escape", (contract) => {
    contract.ssh.shell = "allow";
  }],
  ["internal workload authority collapse", (contract) => {
    contract.internalRoute.workloadIdentityImpliesEdgeAuthority = true;
  }],
  ["unbounded decision logging", (contract) => {
    delete contract.decisionLog.maximumRecordBytes;
  }],
  ["audit persistence scope expansion", (contract) => {
    contract.decisionLog.persistenceRequiredByP006 = true;
  }],
  ["required identity adapter category omission", (contract) => {
    contract.identityAdapters.categories.pop();
  }],
  ["Tailscale-only identity contract", (contract) => {
    contract.identityAdapters.tailscaleOnlyContractAllowed = true;
  }],
  ["provider subject escapes adapter", (contract) => {
    contract.identityAdapters.stableProviderSubjectVisibility = "portable-principal";
  }],
  ["principal resolution metadata omission", (contract) => {
    contract.interfaces.PrincipalResolver.output.pop();
  }],
  ["authorization decision output weakening", (contract) => {
    contract.interfaces.AuthorizationChecker.output = ["allow", "deny"];
  }],
  ["canonical minimum action omission", (contract) => {
    contract.canonicalActions.pop();
  }],
  ["REST canonical action mapping omission", (contract) => {
    contract.rest.operations.putRuntime.canonicalActions = [];
  }],
  ["command canonical mapping drift", (contract) => {
    delete contract.ompAppWss.commandCanonicalActions["settings.write"];
  }],
  ["confirmation action omission", (contract) => {
    contract.confirmation.requiredActions.shift();
  }],
  ["trusted proxy duplicate-header shortcut", (contract) => {
    contract.trustedProxy.duplicateIdentityHeader = "first-wins";
  }],
  ["trusted proxy unknown-adapter shortcut", (contract) => {
    contract.trustedProxy.unknownOrDisabledAdapter = "accept";
  }],
  ["direct cmux semantic translation", (contract) => {
    contract.directCmuxWss.semanticTranslationAllowed = true;
  }],
  ["direct cmux per-frame action protocol", (contract) => {
    contract.directCmuxWss.perFrameActionDecodingAllowed = true;
  }],
  ["SSH optional command advertised while disabled", (contract) => {
    contract.ssh.disabledOptionalCommand = "advertise";
  }],
  ["SSH attach PTY weakening", (contract) => {
    contract.ssh.optionalCommands["omperator attach <runtime-id>"].pty = "optional";
  }],
  ["provider control connection-time grant", (contract) => {
    contract.ssh.providerControl.authorizeEveryRequest = false;
  }],
  ["provider control lifecycle mapping omission", (contract) => {
    delete contract.ssh.providerControl.methodCanonicalActions.delete_machine;
  }],
  ["runtime patch desired-state action drift", (contract) => {
    contract.rest.operations.patchRuntime.canonicalActionResolver.desiredStateActions.Running = ["scope.admin"];
  }],
  ["runtime patch administrative field omission", (contract) => {
    delete contract.rest.operations.patchRuntime.canonicalActionResolver.fieldActions.browserPolicy;
  }],
  ["runtime patch multi-field union weakening", (contract) => {
    contract.rest.operations.patchRuntime.canonicalActionResolver.multiField = "first-match";
  }],
  ["runtime patch unknown field fail open", (contract) => {
    contract.rest.operations.patchRuntime.canonicalActionResolver.unknownField = "ignore";
  }],
  ["runtime patch unknown value fail open", (contract) => {
    contract.rest.operations.patchRuntime.canonicalActionResolver.unknownValue = "ignore";
  }],
  ["runtime patch finer action omission", (contract) => {
    contract.rest.operations.patchRuntime.action = "scope.admin";
  }],
  ["command confirmation registry omission", (contract) => {
    contract.ompAppWss.challengeCommandDescriptorKeys.pop();
  }],
  ["non-challenge confirmation fail open", (contract) => {
    contract.ompAppWss.nonChallengeConfirmation = "challenge";
  }],
];

for (const [name, weaken] of weakenedAuthorizationContractCases) {
  test(`rejects weakened portable authorization contract: ${name}`, async () => {
    const root = await fixture((manifest) => weaken(manifest.portableAuthorizationContracts));
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) =>
        failure.includes(`portableAuthorizationContracts semantic invariant "${name}"`),
      ),
      `missing specific semantic diagnostic for ${name}`,
    );
  });
}

test("rejects identity-provider and backend-specific authorization fields", async () => {
  const root = await fixture((manifest) => {
    manifest.portableAuthorizationContracts.identityProvider = "tailscale";
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("backend or identity-provider-specific contract field"),
    ),
  );
});

test("rejects OpenAPI operationId registry drift", async () => {
  const root = await fixture();
  const openApiPath = path.join(root, "packages/t4-api-contract/openapi.json");
  const openApi = JSON.parse(await readFile(openApiPath, "utf8"));
  openApi.paths["/v1/drift"] = {
    get: { operationId: "driftOperation" },
  };
  await writeFile(openApiPath, `${JSON.stringify(openApi, null, 2)}\n`);
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("operationId registry")),
    "missing OpenAPI authorization-registry drift diagnostic",
  );
});

test("rejects COMMAND_DESCRIPTORS catalog drift", async () => {
  const root = await fixture();
  const commandPath = path.join(root, "packages/host-wire/src/command-descriptors/sessions.ts");
  const source = await readFile(commandPath, "utf8");
  await writeFile(
    commandPath,
    source.replace(
      "\n};",
      '\n  "drift.command": descriptor("sessions.read", "session", "none", "none", "none"),\n};',
    ),
  );
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("commandDescriptorKeys")),
    "missing command authorization-registry drift diagnostic",
  );
});

test("rejects client-frame catalog drift", async () => {
  const root = await fixture();
  const envelopePath = path.join(root, "packages/host-wire/src/envelope.ts");
  const source = await readFile(envelopePath, "utf8");
  const marker = "\t\tcase \"hello\":";
  await writeFile(envelopePath, source.replace(marker, `\t\tcase "drift.frame":\n${marker}`));
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("frameActions")),
    "missing client-frame authorization-registry drift diagnostic",
  );
});

test("rejects machine-provider control method drift", async () => {
  const root = await fixture();
  const providerPath = path.join(
    root,
    "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs",
  );
  const source = await readFile(providerPath, "utf8");
  const marker = "pub enum ProviderRequest {";
  await writeFile(providerPath, source.replace(marker, `${marker}\n    Drift(HelloParams),`));
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("methodCanonicalActions")),
    "missing provider-control authorization-registry drift diagnostic",
  );
});

test("rejects COMMAND_DESCRIPTORS confirmation drift", async () => {
  const root = await fixture();
  const commandPath = path.join(root, "packages/host-wire/src/command-descriptors/sessions.ts");
  const source = await readFile(commandPath, "utf8");
  await writeFile(
    commandPath,
    source.replace('    "challenge",\n    true,\n  ),', '    "none",\n    true,\n  ),'),
  );
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("challengeCommandDescriptorKeys")),
    "missing command confirmation-registry drift diagnostic",
  );
});

test("rejects RuntimePatch property registry drift", async () => {
  const root = await fixture();
  const openApiPath = path.join(root, "packages/t4-api-contract/openapi.json");
  const openApi = JSON.parse(await readFile(openApiPath, "utf8"));
  openApi.components.schemas.RuntimePatch.properties.futureField = {
    $ref: "#/components/schemas/DisplayName",
  };
  await writeFile(openApiPath, `${JSON.stringify(openApi, null, 2)}\n`);
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("RuntimePatch schema property registry")),
    "missing RuntimePatch property-registry drift diagnostic",
  );
});

test("rejects DesiredState enum registry drift", async () => {
  const root = await fixture();
  const openApiPath = path.join(root, "packages/t4-api-contract/openapi.json");
  const openApi = JSON.parse(await readFile(openApiPath, "utf8"));
  openApi.components.schemas.DesiredState.enum.push("Paused");
  await writeFile(openApiPath, `${JSON.stringify(openApi, null, 2)}\n`);
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) => failure.includes("DesiredState registry")),
    "missing DesiredState authorization-registry drift diagnostic",
  );
});

test("rejects portable threat-model manifest and ADR digest drift", async () => {
  const manifestRoot = await fixture((manifest) => {
    manifest.portableThreatModel.documentationSha256 = "a".repeat(64);
  });
  const manifestResult = await checkPortablePlatformBaseline(manifestRoot);
  assert(
    manifestResult.failures.some((failure) => failure.includes("portableThreatModel")),
    "missing portable threat-model manifest drift diagnostic",
  );

  const adrRoot = await fixture();
  await writeFile(path.join(adrRoot, "docs/adr/024-portable-threat-model.md"), "drift\n");
  const adrResult = await checkPortablePlatformBaseline(adrRoot);
  assert(
    adrResult.failures.some((failure) =>
      failure.includes("portableThreatModel.documentationSha256"),
    ),
    "missing portable threat-model ADR digest diagnostic",
  );
});

const weakenedThreatModelCases = [
  ["ticket replay", (contract) => {
    contract.ticketReplay.maximumTtlSeconds = 61;
  }],
  ["sender identity", (contract) => {
    contract.senderIdentity.clientClaimsAuthoritative = true;
  }],
  ["shell/path injection", (contract) => {
    contract.shellPathInjection.shellEnabled = true;
  }],
  ["credential exposure", (contract) => {
    contract.credentialExposure.surfaces =
      contract.credentialExposure.surfaces.filter((surface) => surface !== "logs");
  }],
  ["cross-scope access", (contract) => {
    contract.crossScopeAccess.existenceLeakAllowed = true;
  }],
  ["duplicate writers", (contract) => {
    contract.duplicateWriters.writerCapableProcessGroupsPerRuntimeMaximum = 2;
  }],
  ["runtime isolation", (contract) => {
    contract.runtimeIsolation.cdpExternalReachability = "allow";
  }],
  ["audit leakage", (contract) => {
    contract.auditLeakage.loggingFailureMayAllow = true;
  }],
];

for (const [name, weaken] of weakenedThreatModelCases) {
  test(`rejects weakened portable threat model: ${name}`, async () => {
    const root = await fixture((manifest) => weaken(manifest.portableThreatModel));
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) =>
        failure.includes(`portableThreatModel semantic invariant "${name}"`),
      ),
      `missing independent portable threat-model diagnostic for ${name}`,
    );
  });
}

test("rejects weakened portable threat model: backend object and storage admission", async () => {
  const root = await fixture((manifest) => {
    manifest.portableThreatModel.runtimeIsolation.workspaceMountAuthorization = "client-claimed";
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(
    result.failures.some((failure) =>
      failure.includes('portableThreatModel semantic invariant "runtime isolation"'),
    ),
    "missing independent backend object and storage admission diagnostic",
  );
});

const weakenedThreatCrossContractCases = [
  ["ticket controls must strengthen control and authorization bindings", (manifest) => {
    manifest.portableControlContracts.tickets.consumption = "read-then-delete";
  }],
  ["sender and scope authority must remain server-derived", (manifest) => {
    manifest.portableAuthorizationContracts.interfaces.ResourceScopeResolver.clientClaimsAuthoritative = true;
  }],
  ["scope-qualified records and concealment must agree", (manifest) => {
    manifest.portableControlContracts.idempotency.lookupKey =
      manifest.portableControlContracts.idempotency.lookupKey.filter((field) => field !== "scopeId");
  }],
  ["shell controls must retain the SSH deny contract", (manifest) => {
    manifest.portableAuthorizationContracts.ssh.shell = "allow";
  }],
  ["writer controls must retain topology and lifecycle fencing", (manifest) => {
    manifest.portableLifecycleContracts.generationMachine.fenceUncertainBlocks.pop();
  }],
  ["runtime isolation must retain internal RPC and generation fencing", (manifest) => {
    manifest.runtimeTopology.rawRpcNetworkExposureAllowed = true;
  }],
  ["browser isolation must retain lifecycle fencing", (manifest) => {
    manifest.portableLifecycleContracts.snapshotRestore.oneSnapshotAttachedToTwoLiveRuntimesAllowed = true;
  }],
  ["credential and audit exclusions must retain authorization redaction", (manifest) => {
    manifest.portableAuthorizationContracts.decisionLog.excluded.pop();
  }],
];

for (const [name, weaken] of weakenedThreatCrossContractCases) {
  test(`rejects weakened portable threat-model relationship: ${name}`, async () => {
    const root = await fixture(weaken);
    const result = await checkPortablePlatformBaseline(root);
    assert(
      result.failures.some((failure) =>
        failure.includes(`portableThreatModel cross-contract invariant "${name}"`),
      ),
      `missing portable threat-model cross-contract diagnostic for ${name}`,
    );
  });
}
