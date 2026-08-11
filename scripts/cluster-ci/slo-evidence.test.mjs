import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SLO_EVIDENCE_PATH,
  collectSloEvidenceFailures,
  checkSloEvidenceFile,
  summarizeSloEvidence,
  verifySloRawArtifact,
} from "./slo-evidence.mjs";
import {
  HARNESS,
  REPOSITORY_ROOT,
  SAMPLE_HEADER,
  buildObservations,
  createAndVerifyRunManifest,
  parseArguments,
  parseSamples,
  statisticOf,
  targetsForScenario,
  validateAgainstLedger,
} from "./summarize-slo-run.mjs";

const ledger = JSON.parse(await readFile(SLO_EVIDENCE_PATH, "utf8"));
const COMMIT = "0".repeat(39) + "1";
const DIGEST = `sha256:${"b".repeat(64)}`;
const RAW_ARTIFACT = {
  path: "artifacts/cluster-slo/controller-leader-failover/2026-01-01T00-00-00Z/run-manifest.json",
  sha256: "c".repeat(64),
  bytes: 512,
};

function mutated(apply) {
  const copy = structuredClone(ledger);
  apply(copy);
  return collectSloEvidenceFailures(copy);
}

/** A ledger that has already recorded the identity a measurement needs. */
function identifiedLedger() {
  const copy = structuredClone(ledger);
  copy.source.commit = COMMIT;
  copy.build = {
    mode: "release",
    flags: ["--locked"],
    provenanceMode: "buildkit-content",
    platform: "linux",
    architecture: "arm64",
  };
  copy.images = copy.images.map((image) => ({
    ...image,
    reference: `registry.example.test/${image.component}@${DIGEST}`,
    digest: DIGEST,
  }));
  copy.environments = [
    {
      id: "disposable-kind",
      kubernetesVersion: "1.31.2",
      nodeCount: 3,
      nodeDescription: "3 x kind worker, 4 vCPU, 8 GiB",
      storageDriver: "csi.example.test",
      workspaceStorageClass: "example-rwx",
      runtimeStateStorageClass: "example-block",
      runtimeStateAccessMode: "ReadWriteOncePod",
      imagePrePulled: false,
      fingerprint: {
        kubernetesVersion: "1.31.2",
        clusterUid: "cluster-uid-1",
        nodes: [1, 2, 3].map((index) => ({
          uid: `node-uid-${index}`,
          name: `worker-${index}`,
          architecture: "arm64",
          allocatableCpu: "4",
          allocatableMemory: "8Gi",
        })),
        storageClasses: [
          { name: "example-block", provisioner: "csi.example.test" },
          { name: "example-rwx", provisioner: "csi.example.test" },
        ],
        csiDrivers: ["csi.example.test"],
        workspacePvcAccessModes: ["ReadWriteMany"],
        runtimePvcAccessModes: ["ReadWriteOncePod"],
        release: {
          name: "t4-cluster",
          revision: 1,
          features: {},
          imagePrePull: false,
        },
      },
    },
  ];
  return copy;
}

function coldIdentifiedLedger() {
  const copy = identifiedLedger();
  const singular = copy.environments[0].fingerprint;
  copy.environments[0].fingerprint = {
    contexts: Array.from({ length: 5 }, (_, index) => ({
      context: `kind-cold-${index + 1}`,
      fingerprint: {
        ...structuredClone(singular),
        clusterUid: `cluster-uid-${index + 1}`,
      },
    })),
  };
  return copy;
}

function samples(statuses, seconds, detail = "-") {
  const rows = statuses.map(
    (status, index) => `${index + 1}\t${status}\t${seconds[index].toFixed(3)}\t${detail}`,
  );
  return parseSamples([SAMPLE_HEADER, ...rows, ""].join("\n"));
}

const OPTIONS = {
  scenario: "controller-leader-failover",
  samples: "unused",
  "observed-at": "2026-01-01T00:00:00Z",
  iterations: "5",
  "timeout-seconds": "600",
  "environment-id": "disposable-kind",
  commit: COMMIT,
  "artifact-root": "unused",
};

test("the committed SLO ledger is internally consistent", () => {
  assert.deepEqual(collectSloEvidenceFailures(ledger), []);
});

test("unmeasured ledgers may retain null build and live-environment identity", () => {
  const unmeasured = identifiedLedger();
  unmeasured.build = null;
  unmeasured.environments[0].fingerprint = null;
  assert.deepEqual(collectSloEvidenceFailures(unmeasured), []);
});

test("the committed ledger claims nothing: every observation is unmeasured", () => {
  assert.equal(summarizeSloEvidence(ledger), "7 targets (0 set, 7 unset), 7 observations (0 measured, 7 unmeasured)");
  for (const observation of ledger.observations) {
    assert.equal(observation.status, "unmeasured", observation.targetId);
    assert.equal(Object.hasOwn(observation, "value"), false, observation.targetId);
  }
});

test("an unmeasured entry that smuggles in a number fails closed", () => {
  const failures = mutated((document) => {
    document.observations[0].value = 12.5;
  });
  assert.ok(failures.some((failure) => failure.startsWith("schema ")), failures.join("\n"));
});

test("the committed draft-2020-12 schema rejects unknown fields and declared maxima", () => {
  const unknown = structuredClone(ledger);
  unknown.observations[0].inventedResult = 1;
  const unknownFailures = collectSloEvidenceFailures(unknown);
  assert.ok(unknownFailures.some((failure) => failure.startsWith("schema ")), unknownFailures.join("\n"));

  const oversized = structuredClone(ledger);
  oversized.note = "x".repeat(2049);
  const oversizedFailures = collectSloEvidenceFailures(oversized);
  assert.ok(oversizedFailures.some((failure) => failure.includes("must NOT have more than 2048 characters")), oversizedFailures.join("\n"));
});

test("image evidence is the exact component set with one consistent reference and digest", () => {
  const missing = structuredClone(ledger);
  missing.images[2] = { ...missing.images[2], component: "controller" };
  assert.ok(collectSloEvidenceFailures(missing).some((failure) => failure.startsWith("schema ")));

  const halfIdentified = identifiedLedger();
  halfIdentified.images[0].reference = null;
  assert.ok(collectSloEvidenceFailures(halfIdentified).some((failure) => failure.startsWith("schema ")));

  const mismatch = identifiedLedger();
  mismatch.images[0].reference = `registry.example.test/controller@sha256:${"d".repeat(64)}`;
  const mismatchFailures = collectSloEvidenceFailures(mismatch);
  assert.ok(mismatchFailures.some((failure) => failure.includes("reference digest does not match")), mismatchFailures.join("\n"));
});

test("cold measurements require an exact context-keyed environment fleet", () => {
  const observations = buildObservations({
    targets: targetsForScenario(ledger, "control-plane-cold-start"),
    scenario: "control-plane-cold-start",
    samples: samples(Array(5).fill("ok"), [1, 2, 3, 4, 5]),
    options: { ...OPTIONS, scenario: "control-plane-cold-start" },
    rawArtifact: RAW_ARTIFACT,
  });
  assert.deepEqual(validateAgainstLedger(coldIdentifiedLedger(), observations, COMMIT), []);
  const singularFailures = validateAgainstLedger(identifiedLedger(), observations, COMMIT);
  assert.ok(
    singularFailures.some((failure) => failure.includes("wrong environment fingerprint shape")),
    singularFailures.join("\n"),
  );

  const duplicateContext = coldIdentifiedLedger();
  duplicateContext.environments[0].fingerprint.contexts[1].context = "kind-cold-1";
  const duplicateFailures = collectSloEvidenceFailures(duplicateContext);
  assert.ok(
    duplicateFailures.some((failure) => failure.includes("contexts must be unique and sorted")),
    duplicateFailures.join("\n"),
  );
});

test("a measured entry without source identity fails closed", () => {
  const failures = mutated((document) => {
    document.observations[0] = {
      targetId: "control-plane-cold-start",
      status: "measured",
      harness: `${HARNESS} --run control-plane-cold-start`,
      environmentId: "disposable-kind",
      observedAt: "2026-01-01T00:00:00Z",
      iterations: 5,
      timeoutSeconds: 600,
      statistic: "p95",
      value: 41.2,
      unit: "seconds",
      failures: 0,
      rawArtifact: RAW_ARTIFACT,
    };
  });
  assert.ok(failures.some((failure) => failure.includes("exact source commit")), failures.join("\n"));
  assert.ok(failures.some((failure) => failure.includes("immutable digest")), failures.join("\n"));
  assert.ok(failures.some((failure) => failure.includes("unknown environment")), failures.join("\n"));
});

test("measured evidence requires one sized run manifest and no failed iteration", () => {
  const document = identifiedLedger();
  document.observations[0] = {
    targetId: "control-plane-cold-start",
    status: "measured",
    harness: `${HARNESS} --run control-plane-cold-start`,
    environmentId: "disposable-kind",
    observedAt: "2026-01-01T00:00:00Z",
    iterations: 5,
    timeoutSeconds: 600,
    statistic: "p95",
    value: 41.2,
    unit: "seconds",
    failures: 1,
    rawArtifact: {
      path: "artifacts/cluster-slo/control-plane-cold-start/run/samples.tsv",
      sha256: "c".repeat(64),
    },
  };
  const failures = collectSloEvidenceFailures(document);
  assert.ok(failures.some((failure) => failure.startsWith("schema ")), failures.join("\n"));
});

test("duplicate observations and duplicate image identities fail closed", () => {
  const duplicateObservation = structuredClone(ledger);
  duplicateObservation.observations.push(structuredClone(duplicateObservation.observations[0]));
  const observationFailures = collectSloEvidenceFailures(duplicateObservation);
  assert.ok(
    observationFailures.some((failure) => failure.includes("more than one observation")),
    observationFailures.join("\n"),
  );

  const duplicateImage = structuredClone(ledger);
  duplicateImage.images[2] = structuredClone(duplicateImage.images[0]);
  const imageFailures = collectSloEvidenceFailures(duplicateImage);
  assert.ok(imageFailures.some((failure) => failure.startsWith("schema ")), imageFailures.join("\n"));
});

test("a target with no observation at all fails closed", () => {
  const failures = mutated((document) => {
    document.observations = document.observations.slice(1);
  });
  assert.ok(failures.some((failure) => failure.includes("not even an unmeasured one")), failures.join("\n"));
});

test("a run can only speak for the targets whose harness names it", () => {
  assert.deepEqual(
    targetsForScenario(ledger, "fenced-generation-replacement").map((target) => target.id),
    ["fenced-generation-replacement", "fenced-generation-replacement-correctness"],
  );
  assert.deepEqual(
    targetsForScenario(ledger, "controller-leader-failover").map((target) => target.id),
    ["controller-leader-failover"],
  );
  assert.throws(() => targetsForScenario(ledger, "invented-scenario"), /no target in the ledger/u);
});

test("nearest-rank statistics never interpolate a sample that was not taken", () => {
  const values = [1, 2, 3, 4, 100];
  assert.equal(statisticOf("p95", values), 100);
  assert.equal(statisticOf("median", values), 3);
  assert.equal(statisticOf("max", values), 100);
  assert.equal(statisticOf("min", values), 1);
  assert.equal(statisticOf("mean", values), 22);
  assert.equal(statisticOf("sum", values), 110);
  assert.throws(() => statisticOf("p95", []), /zero samples/u);
});

test("a complete run produces a measured observation the validator accepts", () => {
  const observations = buildObservations({
    targets: targetsForScenario(ledger, "controller-leader-failover"),
    scenario: "controller-leader-failover",
    samples: samples(["ok", "ok", "ok", "ok", "ok"], [3.1, 3.4, 3.9, 4.2, 9.8]),
    options: OPTIONS,
    rawArtifact: RAW_ARTIFACT,
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, "measured");
  assert.equal(observations[0].value, 9.8);
  assert.equal(observations[0].statistic, "p95");
  assert.equal(observations[0].unit, "seconds");
  assert.deepEqual(validateAgainstLedger(identifiedLedger(), observations, COMMIT), []);
});

test("a measured observation is refused when the requested commit is not the ledger identity", () => {
  const observations = buildObservations({
    targets: targetsForScenario(ledger, "controller-leader-failover"),
    scenario: "controller-leader-failover",
    samples: samples(["ok", "ok", "ok", "ok", "ok"], [3.1, 3.4, 3.9, 4.2, 9.8]),
    options: OPTIONS,
    rawArtifact: RAW_ARTIFACT,
  });
  const failures = validateAgainstLedger(ledger, observations, COMMIT);
  assert.deepEqual(failures, ["--commit must exactly equal the ledger's non-null source.commit"]);
  assert.deepEqual(
    validateAgainstLedger(identifiedLedger(), observations, "f".repeat(40)),
    ["--commit must exactly equal the ledger's non-null source.commit"],
  );
});

test("an incomplete run degrades to unmeasured instead of reporting the survivors", () => {
  const observations = buildObservations({
    targets: targetsForScenario(ledger, "controller-leader-failover"),
    scenario: "controller-leader-failover",
    samples: samples(["ok", "timeout", "ok", "ok", "ok"], [3.1, 600, 3.9, 4.2, 4.4]),
    options: OPTIONS,
    rawArtifact: RAW_ARTIFACT,
  });
  assert.equal(observations[0].status, "unmeasured");
  assert.equal(Object.hasOwn(observations[0], "value"), false);
  assert.equal(observations[0].blockedBy, "timeout");
  assert.match(observations[0].reason, /1 of 5 iterations did not complete/u);
  assert.deepEqual(validateAgainstLedger(identifiedLedger(), observations, COMMIT), []);
});

test("an unknown driver status is refused rather than becoming an unmeasured result", () => {
  assert.throws(
    () => samples(Array(5).fill("unsupported"), [0.1, 0.1, 0.1, 0.1, 0.1]),
    /unknown status/u,
  );
});

test("a correctness counter needs an explicit verdict on every iteration", () => {
  const silent = buildObservations({
    targets: targetsForScenario(ledger, "fenced-generation-replacement"),
    scenario: "fenced-generation-replacement",
    samples: samples(Array(5).fill("ok"), [7, 8, 9, 10, 11]),
    options: { ...OPTIONS, scenario: "fenced-generation-replacement" },
    rawArtifact: RAW_ARTIFACT,
  });
  const counter = silent.find((entry) => entry.targetId === "fenced-generation-replacement-correctness");
  assert.equal(counter.status, "unmeasured");
  assert.equal(counter.blockedBy, "invariant-verdict-invalid");
  assert.equal(silent.find((entry) => entry.targetId === "fenced-generation-replacement").status, "measured");

  const verdicts = buildObservations({
    targets: targetsForScenario(ledger, "fenced-generation-replacement"),
    scenario: "fenced-generation-replacement",
    samples: samples(Array(5).fill("ok"), [7, 8, 9, 10, 11], "invariant=violated"),
    options: { ...OPTIONS, scenario: "fenced-generation-replacement" },
    rawArtifact: RAW_ARTIFACT,
  });
  const counted = verdicts.find((entry) => entry.targetId === "fenced-generation-replacement-correctness");
  assert.equal(counted.status, "measured");
  assert.equal(counted.value, 5);
  assert.equal(counted.statistic, "sum");
  assert.equal(counted.unit, "count");
  assert.deepEqual(validateAgainstLedger(identifiedLedger(), verdicts, COMMIT), []);

  const ambiguous = buildObservations({
    targets: targetsForScenario(ledger, "fenced-generation-replacement"),
    scenario: "fenced-generation-replacement",
    samples: samples(
      Array(5).fill("ok"),
      [7, 8, 9, 10, 11],
      "invariant=held invariant=violated",
    ),
    options: { ...OPTIONS, scenario: "fenced-generation-replacement" },
    rawArtifact: RAW_ARTIFACT,
  });
  assert.equal(
    ambiguous.find((entry) => entry.targetId === "fenced-generation-replacement-correctness").status,
    "unmeasured",
  );

  const failed = buildObservations({
    targets: targetsForScenario(ledger, "fenced-generation-replacement"),
    scenario: "fenced-generation-replacement",
    samples: samples(
      ["ok", "ok", "failed", "ok", "ok"],
      [7, 8, 9, 10, 11],
      "invariant=violated",
    ),
    options: { ...OPTIONS, scenario: "fenced-generation-replacement" },
    rawArtifact: RAW_ARTIFACT,
  });
  assert.equal(
    failed.find((entry) => entry.targetId === "fenced-generation-replacement-correctness").status,
    "unmeasured",
  );
});

test("a discarded or short run is refused outright", () => {
  const shared = {
    targets: targetsForScenario(ledger, "controller-leader-failover"),
    scenario: "controller-leader-failover",
    options: OPTIONS,
    rawArtifact: RAW_ARTIFACT,
  };
  assert.throws(
    () => buildObservations({ ...shared, samples: samples(["ok", "ok", "ok"], [1, 2, 3]) }),
    /deleted measurement/u,
  );
  assert.throws(
    () =>
      buildObservations({
        ...shared,
        options: { ...OPTIONS, iterations: "3" },
        samples: samples(["ok", "ok", "ok"], [1, 2, 3]),
      }),
    /at least 5/u,
  );
});

test("sample iterations must be the safe unique ordered set 1..N", () => {
  const source = (iterations) => [
    SAMPLE_HEADER,
    ...iterations.map((iteration) => `${iteration}\tok\t1.000\t-`),
    "",
  ].join("\n");
  assert.throws(() => parseSamples(source([1, 1, 3, 4, 5])), /exact ordered set 1\.\.N/u);
  assert.throws(() => parseSamples(source([1, 3, 2, 4, 5])), /exact ordered set 1\.\.N/u);
  assert.throws(() => parseSamples(source([1, 2, 3, 4, "9007199254740992"])), /invalid iteration/u);
});

test("the run manifest binds every canonical raw sibling and detects tampering", async () => {
  const artifactRoot = join(REPOSITORY_ROOT, "artifacts", "cluster-slo");
  const scenarioRoot = join(artifactRoot, "test-evidence-manifest");
  await mkdir(scenarioRoot, { recursive: true });
  const runDirectory = await mkdtemp(join(scenarioRoot, "run-"));
  try {
    const samplesPath = join(runDirectory, "samples.tsv");
    await writeFile(samplesPath, `${SAMPLE_HEADER}\n1\tok\t1.000\t-\n`);
    await writeFile(join(runDirectory, "identity.json"), '{"sourceCommit":"test"}\n');
    await writeFile(join(runDirectory, "commands.jsonl"), '{"exitCode":0}\n');
    await writeFile(join(runDirectory, "events.jsonl"), '{"legacy":true}\n');
    const rawArtifact = await createAndVerifyRunManifest(samplesPath, artifactRoot);
    assert.match(rawArtifact.path, /\/run-manifest\.json$/u);
    assert.ok(rawArtifact.bytes > 0);
    await verifySloRawArtifact(rawArtifact);

    await writeFile(join(runDirectory, "identity.json"), '{"sourceCommit":"modified"}\n');
    await assert.rejects(verifySloRawArtifact(rawArtifact), /identity\.json does not match/u);
    await writeFile(join(runDirectory, "identity.json"), '{"sourceCommit":"test"}\n');
    await writeFile(join(runDirectory, "commands.jsonl"), '{"argv":["modified"]}\n');
    await assert.rejects(verifySloRawArtifact(rawArtifact), /commands\.jsonl does not match/u);
  } finally {
    await rm(scenarioRoot, { recursive: true, force: true });
  }
});

test("copied samples without the same run siblings cannot become a measured artifact", async () => {
  const artifactRoot = join(REPOSITORY_ROOT, "artifacts", "cluster-slo");
  const scenarioRoot = join(artifactRoot, "test-evidence-copy");
  await mkdir(scenarioRoot, { recursive: true });
  const runDirectory = await mkdtemp(join(scenarioRoot, "run-"));
  try {
    const samplesPath = join(runDirectory, "samples.tsv");
    await writeFile(samplesPath, `${SAMPLE_HEADER}\n1\tok\t1.000\t-\n`);
    await assert.rejects(
      createAndVerifyRunManifest(samplesPath, artifactRoot),
      /identity\.json|ENOENT/u,
    );
  } finally {
    await rm(scenarioRoot, { recursive: true, force: true });
  }
});

test("legacy coordinated TSV identity and command fixtures cannot support a measured claim", async () => {
  const artifactRoot = join(REPOSITORY_ROOT, "artifacts", "cluster-slo");
  const scenarioRoot = join(artifactRoot, "test-evidence-recompute");
  await mkdir(scenarioRoot, { recursive: true });
  const runDirectory = await mkdtemp(join(scenarioRoot, "run-"));
  try {
    const document = identifiedLedger();
    const samplesPath = join(runDirectory, "samples.tsv");
    await writeFile(samplesPath, `${SAMPLE_HEADER}\n1\tok\t1.000\t-\n2\tok\t2.000\t-\n3\tok\t3.000\t-\n4\tok\t4.000\t-\n5\tok\t5.000\t-\n`);
    await writeFile(join(runDirectory, "identity.json"), `${JSON.stringify({
      scenario: "controller-leader-failover",
      sourceCommit: COMMIT,
      environmentId: "disposable-kind",
      startedAt: "2026-01-01T00:00:00Z",
      iterations: 5,
    })}\n`);
    await writeFile(join(runDirectory, "commands.jsonl"), '{"exitCode":0}\n');
    await writeFile(join(runDirectory, "events.jsonl"), '{"exitCode":0}\n');
    const rawArtifact = await createAndVerifyRunManifest(samplesPath, artifactRoot);
    const index = document.observations.findIndex((entry) => entry.targetId === "controller-leader-failover");
    document.observations[index] = {
      targetId: "controller-leader-failover",
      status: "measured",
      harness: `${HARNESS} --run controller-leader-failover`,
      environmentId: "disposable-kind",
      observedAt: "2026-01-01T00:00:00Z",
      iterations: 5,
      timeoutSeconds: 600,
      statistic: "p95",
      value: 5,
      unit: "seconds",
      failures: 0,
      rawArtifact,
    };
    const ledgerPath = join(runDirectory, "ledger.json");
    await writeFile(ledgerPath, `${JSON.stringify(document)}\n`);
    const failures = await checkSloEvidenceFile(ledgerPath);
    assert.ok(failures.some((failure) => failure.includes("identity.json is invalid")), failures.join("\n"));
  } finally {
    await rm(scenarioRoot, { recursive: true, force: true });
  }
});

test("the samples file must have the exact header the harness writes", () => {
  assert.throws(() => parseSamples("iteration,status,seconds,detail\n"), /must start with the header/u);
  assert.throws(() => parseSamples(`${SAMPLE_HEADER}\n1\tok\tnot-a-number\t-\n`), /non-numeric duration/u);
});

test("the summarizer refuses an incomplete invocation", () => {
  assert.throws(() => parseArguments(["--scenario", "controller-leader-failover"]), /--samples is required/u);
  assert.throws(() => parseArguments(["--nope", "x"]), /unknown argument --nope/u);
});
