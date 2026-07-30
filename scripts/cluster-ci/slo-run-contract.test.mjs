import assert from "node:assert/strict";
import test from "node:test";

import { verifyProvenance } from "./assemble-image-manifest.mjs";
import {
  SLO_COMMAND_VERSION,
  SLO_EVENT_VERSION,
  SLO_IDENTITY_VERSION,
  SLO_RUN_MANIFEST_VERSION,
  SloEventRecorder,
  parseSloCommands,
  parseSloEvents,
  parseSloIdentity,
  parseSloRunManifest,
} from "./slo-run-contract.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const RUN = { runToken: "run_token_123", scenario: "session-warm-first-attach", iterations: 2, deadlineSeconds: 10 };

function event(iteration, sequence, kind, monotonicOffsetMs, payload) {
  return {
    schemaVersion: SLO_EVENT_VERSION,
    runToken: RUN.runToken,
    scenario: RUN.scenario,
    iteration,
    sequence,
    timestamp: `2026-07-30T00:00:0${sequence}Z`,
    monotonicOffsetMs,
    kind,
    payload,
  };
}

function eventSource() {
  return [
    event(1, 1, "boundary-start", 0, {}),
    event(1, 2, "boundary-end", 1250, {}),
    event(1, 3, "proof", 1250, { status: "ok", detail: "attach proof", proof: { attached: true, sessionId: "ses_1" } }),
    event(1, 4, "cleanup", 1300, { status: "ok", detail: "resources absent", runComplete: false }),
    event(2, 5, "boundary-start", 1400, {}),
    event(2, 6, "boundary-end", 2900, {}),
    event(2, 7, "proof", 2900, { status: "ok", detail: "attach proof", proof: { attached: true, sessionId: "ses_2" } }),
    event(2, 8, "cleanup", 3000, { status: "ok", detail: "resources absent", runComplete: true }),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function commandSource() {
  return `${JSON.stringify({
    schemaVersion: SLO_COMMAND_VERSION,
    runToken: RUN.runToken,
    scenario: RUN.scenario,
    iteration: 1,
    eventSequence: 1,
    startedAt: "2026-07-30T00:00:01Z",
    durationMs: 12,
    executable: "kubectl",
    args: ["get", "pod"],
    exitCode: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
    overflow: false,
    timedOut: false,
  })}\n`;
}

test("typed event chain is the sole numeric sample authority", () => {
  const parsed = parseSloEvents(eventSource(), RUN);
  assert.deepEqual(parsed.samples.map(({ iteration, status, seconds, detail }) => ({ iteration, status, seconds, detail })), [
    { iteration: 1, status: "ok", seconds: 1.25, detail: "attach proof" },
    { iteration: 2, status: "ok", seconds: 1.5, detail: "attach proof" },
  ]);
  assert.equal(parseSloCommands(commandSource(), RUN, parsed.events).length, 1);
});

test("coordinated TSV and command fabrication cannot replace proof and cleanup", () => {
  const records = JSON.parse(`[${eventSource().trim().split("\n").join(",")}]`);
  records.splice(2, 1);
  records.forEach((record, index) => { record.sequence = index + 1; });
  const forged = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  assert.throws(() => parseSloEvents(forged, RUN), /exactly four events|missing, extra, or out of order/u);
  assert.throws(() => parseSloCommands('{"exitCode":0}\n', RUN, []), /fields are invalid/u);
});

test("event parser rejects timestamp inversion, deadline overflow, and false cleanup", () => {
  for (const mutate of [
    (records) => { records[2].timestamp = "2026-07-29T23:59:59Z"; },
    (records) => { records[1].monotonicOffsetMs = 10_001; records.slice(2, 4).forEach((record) => { record.monotonicOffsetMs = 10_001; }); },
    (records) => { records[3].payload.status = "failed"; },
    (records) => { records[7].payload.runComplete = false; },
  ]) {
    const records = JSON.parse(`[${eventSource().trim().split("\n").join(",")}]`);
    mutate(records);
    assert.throws(() => parseSloEvents(records.map((record) => JSON.stringify(record)).join("\n") + "\n", RUN));
  }
});

test("identity and run manifest schemas are versioned and closed", () => {
  const identity = {
    schemaVersion: SLO_IDENTITY_VERSION,
    scenario: RUN.scenario,
    sourceCommit: COMMIT,
    environmentId: "cluster-arm64",
    runToken: RUN.runToken,
    startedAt: "2026-07-30T00:00:00Z",
    completedAt: "2026-07-30T00:00:10Z",
    timeoutSeconds: 5,
    iterations: 2,
    warmupIterations: 0,
    deadlines: { operationSeconds: 5, iterationSeconds: 10, cleanupSeconds: 5, wholeRunSeconds: 60 },
    images: {},
    executables: {},
    source: { commit: COMMIT, headTreeHash: COMMIT, repositoryTreeHash: "b".repeat(64), harnessTreeHash: "c".repeat(64), dirty: false, retainedPatch: null },
    build: { platform: "linux", architecture: "arm64" },
    ledger: {},
    clusters: [{ context: "cluster" }, { context: "cluster" }],
    environmentIterations: [{ iteration: 1 }, { iteration: 2 }],
  };
  assert.equal(parseSloIdentity(identity), identity);
  assert.throws(() => parseSloIdentity({ ...identity, fabricated: true }), /unknown: fabricated/u);
  const files = ["samples.tsv", "identity.json", "commands.jsonl", "events.jsonl"].map((name) => ({ name, bytes: 1, sha256: "d".repeat(64) }));
  assert.doesNotThrow(() => parseSloRunManifest({ schemaVersion: SLO_RUN_MANIFEST_VERSION, files }));
  assert.throws(() => parseSloRunManifest({ schemaVersion: "t4-cluster-slo-run/1", files }), /schema/u);
});

test("recorder emits ordered boundaries, proof, cleanup, and run completion", async () => {
  const lines = [];
  let monotonic = 100;
  let second = 0;
  const recorder = new SloEventRecorder({
    ...RUN,
    append: async (line) => lines.push(line),
    wallClock: () => `2026-07-30T00:00:0${second++}Z`,
    monotonicClock: () => monotonic,
  });
  await recorder.startIteration(1);
  monotonic += 500;
  await recorder.finishIteration({ status: "ok", detail: "proof one", proof: { ready: true } });
  await recorder.recordCleanup({ detail: "cleanup one" });
  monotonic += 100;
  await recorder.startIteration(2);
  monotonic += 750;
  await recorder.finishIteration({ status: "ok", detail: "proof two", proof: { ready: true } });
  await recorder.recordCleanup({ detail: "cleanup two" });
  assert.deepEqual(recorder.finalize().samples.map((sample) => sample.seconds), [0.5, 0.75]);
  assert.equal(lines.length, 8);
});

test("verified DSSE payload semantics bind source, subject, build type, materials, and platform", () => {
  const repository = "harbor.tailb18de3.ts.net/t4/quarantine/t4-session-runtime";
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: repository, digest: { sha256: DIGEST.slice(7) } }],
    predicate: {
      buildDefinition: {
        buildType: "https://mobyproject.org/buildkit@v1",
        externalParameters: {
          frontendAttrs: {
            platform: "linux/amd64,linux/arm64",
            "build-arg:SOURCE_COMMIT": COMMIT,
            "build-arg:SOURCE_REPOSITORY": "https://github.com/usr-bin-roygbiv/t4-code",
          },
        },
        resolvedDependencies: [
          { uri: `https://github.com/usr-bin-roygbiv/t4-code.git#${COMMIT}`, digest: { sha1: COMMIT } },
          { uri: `pkg:docker/node@${DIGEST}`, digest: { sha256: DIGEST.slice(7) } },
        ],
      },
      runDetails: { builder: { id: "https://mobyproject.org/buildkit@v1" } },
    },
  };
  const signedDsse = `${JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ keyid: "", sig: Buffer.from("semantic-contract-only").toString("base64") }] })}\n`;
  assert.doesNotThrow(() => verifyProvenance(signedDsse, { repository, digest: DIGEST, commit: COMMIT, platform: "linux", architecture: "arm64" }));
  assert.throws(() => verifyProvenance(signedDsse, { repository, digest: DIGEST, commit: COMMIT, platform: "linux", architecture: "s390x" }), /platform\/architecture/u);
  const unsignedDsse = `${JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") })}\n`;
  assert.throws(() => verifyProvenance(unsignedDsse, { repository, digest: DIGEST, commit: COMMIT, platform: "linux", architecture: "arm64" }), /DSSE JSON/u);
  const fabricated = structuredClone(statement);
  fabricated.predicate.buildDefinition.resolvedDependencies[0].uri = `https://github.com/attacker/repo.git#${COMMIT}`;
  const fabricatedDsse = `${JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(fabricated)).toString("base64"), signatures: [{ keyid: "", sig: Buffer.from("semantic-contract-only").toString("base64") }] })}\n`;
  assert.throws(() => verifyProvenance(fabricatedDsse, { repository, digest: DIGEST, commit: COMMIT, platform: "linux", architecture: "arm64" }), /trusted source/u);
});
