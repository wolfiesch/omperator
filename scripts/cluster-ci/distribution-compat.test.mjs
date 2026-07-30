import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHART_DIRECTORY,
  DISTRIBUTION_PATH,
  REQUIRED_PROOF_HARNESSES,
  REQUIRED_RUNBOOKS,
  collectDistributionFailures,
  loadDistributionContext,
  summarizeDistribution,
} from "./distribution-compat.mjs";

const context = await loadDistributionContext(CHART_DIRECTORY);
const ledger = JSON.parse(await readFile(DISTRIBUTION_PATH, "utf8"));

function mutated(apply) {
  const copy = structuredClone(ledger);
  apply(copy);
  return collectDistributionFailures(copy, context);
}

function adapter(document, id) {
  const entry = document.deploymentAdapters.find((item) => item.id === id);
  assert.ok(entry, `deploymentAdapters is missing ${id}`);
  return entry;
}

test("the committed distribution ledger is fully backed by this repository", async () => {
  assert.deepEqual(await collectDistributionFailures(ledger, context), []);
});

test("every harness and runbook the ledger names resolves to a file", () => {
  assert.deepEqual(Object.keys(ledger.proofHarnesses).sort(), [...REQUIRED_PROOF_HARNESSES]);
  assert.deepEqual(Object.keys(ledger.runbooks).sort(), [...REQUIRED_RUNBOOKS]);
  for (const runbook of context.runbookFiles) {
    assert.ok(
      Object.values(ledger.runbooks).includes(runbook),
      `${runbook} is not reachable from the ledger`,
    );
  }
});

test("a null with no stated reason fails closed", async () => {
  const failures = await mutated((document) => {
    delete document.platform.kubernetesMaximumTestedReason;
  });
  assert.ok(
    failures.some((failure) => failure.includes("kubernetesMaximumTestedReason")),
    failures.join("\n"),
  );
});

test("a recorded image set must be complete and digest-pinned", async () => {
  const tagged = await mutated((document) => {
    document.images.digestSet = {
      controller: "registry.example.test/t4-cluster-operator:0.2.1",
      "cluster-server": "registry.example.test/t4-cluster-server:0.2.1",
      "session-runtime": "registry.example.test/t4-session-runtime:0.2.1",
      "model-gateway": "registry.example.test/t4-model-gateway:0.2.1",
      "ssh-gateway": "registry.example.test/t4-ssh-gateway:0.2.1",
    };
  });
  assert.equal(tagged.filter((failure) => failure.includes("never a tag")).length, 5, tagged.join("\n"));

  const partial = await mutated((document) => {
    document.images.digestSet = {
      controller: `registry.example.test/t4-cluster-operator@sha256:${"a".repeat(64)}`,
    };
  });
  assert.ok(
    partial.some((failure) => failure.includes("omits cluster-server")),
    partial.join("\n"),
  );
});

test("claiming publication without a digest set fails closed", async () => {
  const failures = await mutated((document) => {
    document.chart.published = true;
  });
  assert.ok(
    failures.some((failure) => failure.includes("must record the immutable digest set")),
    failures.join("\n"),
  );
  assert.ok(
    failures.some((failure) => failure.includes("chart.publication record")),
    failures.join("\n"),
  );
});

test("an unpublished chart must say what has not happened", async () => {
  const failures = await mutated((document) => {
    delete document.chart.publicationNote;
  });
  assert.ok(failures.some((failure) => failure.includes("publicationNote")), failures.join("\n"));
});

test("chart identity must match Chart.yaml", async () => {
  const failures = await mutated((document) => {
    document.chart.version = "9.9.9";
  });
  assert.ok(failures.some((failure) => failure.includes("chart.version")), failures.join("\n"));
});

test("the API surface must match the shipped CRDs", async () => {
  const kinds = await mutated((document) => {
    document.api.kinds = ["T4ClusterHost", "T4Workspace"];
  });
  assert.ok(kinds.some((failure) => failure.includes("api.kinds")), kinds.join("\n"));

  const storage = await mutated((document) => {
    document.api.storageVersion = "v1beta1";
  });
  assert.ok(storage.some((failure) => failure.includes("api.storageVersion")), storage.join("\n"));
});

test("CRD ordering may not be folded into the Helm release", async () => {
  const flag = await mutated((document) => {
    document.chart.crdInstallFlag = "--include-crds";
  });
  assert.ok(flag.some((failure) => failure.includes("crdInstallFlag")), flag.join("\n"));

  const ordering = await mutated((document) => {
    adapter(document, "flux").crdOrdering = "the HelmRelease installs everything in one pass";
  });
  assert.ok(
    ordering.some((failure) => failure.includes("keeps CRDs out of the Helm release")),
    ordering.join("\n"),
  );
});

test("an adapter directory that is not declared fails closed", async () => {
  const failures = await mutated((document) => {
    document.deploymentAdapters = document.deploymentAdapters.filter((entry) => entry.id !== "argo");
  });
  assert.ok(
    failures.some((failure) => failure.includes("deploy/examples/argo")),
    failures.join("\n"),
  );
});

test("exactly one adapter may be the reference path", async () => {
  const failures = await mutated((document) => {
    adapter(document, "terraform").reference = true;
  });
  assert.ok(failures.some((failure) => failure.includes("reference path")), failures.join("\n"));
});

test("an adapter may not mandate a provider", async () => {
  const failures = await mutated((document) => {
    adapter(document, "terraform").mandatoryProvider = "aws";
  });
  assert.ok(
    failures.some((failure) => failure.includes("mandates no provider")),
    failures.join("\n"),
  );
});

test("a carried upstream delta needs a removal condition and a resolvable artifact", async () => {
  const condition = await mutated((document) => {
    document.upstreamPatchLedger.entries[0].removalCondition = "later";
  });
  assert.ok(condition.some((failure) => failure.includes("removalCondition")), condition.join("\n"));

  const artifact = await mutated((document) => {
    document.upstreamPatchLedger.entries[2].pinnedArtifact = "vendor/app-wire/does-not-exist.tgz";
  });
  assert.ok(artifact.some((failure) => failure.includes("does not exist")), artifact.join("\n"));
});

test("a harness reference that does not resolve fails closed", async () => {
  const failures = await mutated((document) => {
    document.proofHarnesses.sloMeasurement = "scripts/cluster-ci/not-a-harness.sh";
  });
  assert.ok(failures.some((failure) => failure.includes("does not exist")), failures.join("\n"));
});

test("dropping a required harness or runbook key fails closed", async () => {
  const harness = await mutated((document) => {
    delete document.proofHarnesses.distributionCompatibility;
  });
  assert.ok(
    harness.some((failure) => failure.includes("proofHarnesses must declare exactly")),
    harness.join("\n"),
  );

  const runbook = await mutated((document) => {
    delete document.runbooks.fencing;
  });
  assert.ok(runbook.some((failure) => failure.includes("runbooks must declare exactly")), runbook.join("\n"));
  assert.ok(
    runbook.some((failure) => failure.includes("docs/runbooks/cluster-fencing.md")),
    runbook.join("\n"),
  );
});

test("the summary never implies a measurement or a publication", () => {
  const summary = summarizeDistribution(ledger);
  assert.match(summary, /unpublished/u);
  assert.doesNotMatch(summary, /\bms\b|latenc|p9[59]|uptime|availability/iu);
});
