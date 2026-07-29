import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkPortablePlatformBaseline } from "./check-portable-platform-baseline.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "compat/portable-agent-platform-v1.json");

async function fixture(mutator = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-platform-baseline-"));
  await mkdir(path.join(root, "compat"), { recursive: true });
  await mkdir(path.join(root, "provenance"), { recursive: true });
  await mkdir(path.join(root, "docs/adr"), { recursive: true });
  await writeFile(
    path.join(root, "provenance/cmux-machine-provider-v1.json"),
    await readFile(path.join(repositoryRoot, "provenance/cmux-machine-provider-v1.json")),
  );
  await writeFile(
    path.join(root, "docs/adr/020-portable-runtime-single-authority.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/020-portable-runtime-single-authority.md")),
  );
  await writeFile(
    path.join(root, "docs/adr/021-portable-driver-control-contracts.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/021-portable-driver-control-contracts.md")),
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
    "cmuxMachineProviderImport.manifestSha256",
    "cmuxMachineProviderImport.fixtureCorpusSha256",
  ]) {
    assert(result.failures.some((failure) => failure.includes(field)), `missing diagnostic for ${field}`);
  }
});

test("rejects removing the fail-closed OMP pin resolution", async () => {
  const root = await fixture((manifest) => {
    manifest.ompPinResolution.strategy = "use-current-package";
    manifest.ompPinResolution.portableRuntimeAdmission = "allowed";
    manifest.compatibilitySetPolicy.independentComponentRollsAllowed = true;
  });
  const result = await checkPortablePlatformBaseline(root);
  assert(result.failures.some((failure) => failure.includes("replace-before-portable-runtime")));
  assert(result.failures.some((failure) => failure.includes("requires-descendant-integration-proof")));
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
  await writeFile(path.join(root, "docs/adr/020-portable-runtime-single-authority.md"), "drift\n");
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
