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
  await mkdir(path.join(root, "packages/t4-api-contract"), { recursive: true });
  await mkdir(path.join(root, "packages/host-wire/src"), { recursive: true });
  await mkdir(
    path.join(root, "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src"),
    { recursive: true },
  );
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
  await writeFile(
    path.join(root, "docs/adr/022-portable-identity-authorization-contract.md"),
    await readFile(path.join(repositoryRoot, "docs/adr/022-portable-identity-authorization-contract.md")),
  );
  await writeFile(
    path.join(root, "packages/t4-api-contract/openapi.json"),
    await readFile(path.join(repositoryRoot, "packages/t4-api-contract/openapi.json")),
  );
  await writeFile(
    path.join(root, "packages/host-wire/src/command.ts"),
    await readFile(path.join(repositoryRoot, "packages/host-wire/src/command.ts")),
  );
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
  const commandPath = path.join(root, "packages/host-wire/src/command.ts");
  const source = await readFile(commandPath, "utf8");
  const marker = "export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {";
  await writeFile(commandPath, source.replace(marker, `${marker}\n\t"drift.command": {\n\t},`));
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
  const commandPath = path.join(root, "packages/host-wire/src/command.ts");
  const source = await readFile(commandPath, "utf8");
  await writeFile(commandPath, source.replace('\t\tconfirmation: "challenge",', '\t\tconfirmation: "none",'));
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
