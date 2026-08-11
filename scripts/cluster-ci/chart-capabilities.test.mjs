import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_DIRECTORY,
  collectCapabilityFailures,
  declaredScenarioIds,
  loadChartCapabilities,
} from "./chart-capabilities.mjs";

const loaded = await loadChartCapabilities(CHART_DIRECTORY);

function mutated(apply) {
  const copy = {
    capabilities: structuredClone(loaded.capabilities),
    values: structuredClone(loaded.values),
    chart: structuredClone(loaded.chart),
    kinds: new Set(loaded.kinds),
  };
  apply(copy);
  return collectCapabilityFailures(copy);
}

function capability(document, id) {
  const entry = document.capabilities.capabilities.find((item) => item.id === id);
  assert.ok(entry, `capabilities.yaml is missing ${id}`);
  return entry;
}

test("the packaged chart's advertised capability contract holds", () => {
  assert.deepEqual(collectCapabilityFailures(loaded), []);
});

test("every optional adapter defaults to off and is proven by the adapter scenario", () => {
  const adapters = loaded.capabilities.capabilities.filter((entry) => entry.adapter);
  assert.ok(adapters.length >= 6, "the chart advertises fewer adapters than it renders");
  for (const adapter of adapters) {
    assert.equal(adapter.optional, true, `${adapter.id} must be optional`);
    assert.ok(adapter.enablingGate, `${adapter.id} must name an enabling gate`);
    assert.ok(
      adapter.scenarios.includes("optional-adapters"),
      `${adapter.id} must be proven by the optional-adapters scenario`,
    );
  }
});

test("declared scenarios are exactly the ones the lifecycle harness implements", async () => {
  assert.deepEqual(await declaredScenarioIds(CHART_DIRECTORY), [
    "crd-separate-order",
    "fresh-install",
    "additive-upgrade",
    "rollback",
    "retained-state-reinstall",
    "clean-uninstall",
    "optional-adapters",
    "capability-render-matrix",
  ]);
});

test("a values gate the chart does not define fails closed", () => {
  const failures = mutated((document) => {
    capability(document, "model-gateway").valuesGates.push("modelGateway.notARealField");
  });
  assert.ok(failures.some((failure) => /modelGateway\.notARealField/u.test(failure)), failures.join("\n"));
});

test("an empty-string default still counts as a defined values path", () => {
  assert.equal(loaded.values.session.omp.configMap, "");
  assert.deepEqual(
    mutated((document) => {
      capability(document, "session-runtime-configuration").valuesGates = ["session.omp.configMap"];
    }),
    [],
  );
});

test("an adapter that defaults to enabled fails closed", () => {
  const failures = mutated((document) => {
    document.values.modelGateway.enabled = true;
  });
  assert.ok(
    failures.some((failure) => /model-gateway is an adapter but values\.yaml default/u.test(failure)),
    failures.join("\n"),
  );
});

test("an adapter that is not optional fails closed", () => {
  const failures = mutated((document) => {
    capability(document, "ssh-gateway").optional = false;
  });
  assert.ok(failures.includes("ssh-gateway is an adapter and must be optional"), failures.join("\n"));
});

test("a capability with no proving scenario fails closed", () => {
  const failures = mutated((document) => {
    capability(document, "image-pre-pull").scenarios = [];
  });
  assert.ok(failures.includes("image-pre-pull has no proving lifecycle scenario"), failures.join("\n"));
});

test("a scenario that proves no capability fails closed", () => {
  const failures = mutated((document) => {
    document.capabilities.scenarios.push({
      id: "unproven-scenario",
      summary: "A scenario nobody claims as evidence.",
    });
  });
  assert.ok(failures.includes("scenario unproven-scenario proves no capability"), failures.join("\n"));
});

test("a rendered kind no manifest emits fails closed", () => {
  const failures = mutated((document) => {
    capability(document, "ingress-tailscale").renders = ["Gateway"];
  });
  assert.ok(
    failures.includes("ingress-tailscale.renders names Gateway, which no chart manifest emits"),
    failures.join("\n"),
  );
});

test("an enabling gate outside valuesGates fails closed", () => {
  const failures = mutated((document) => {
    capability(document, "image-pre-pull").enablingGate = "ingress.enabled";
  });
  assert.ok(
    failures.includes("image-pre-pull.enablingGate ingress.enabled must also appear in valuesGates"),
    failures.join("\n"),
  );
});

test("a capability summary may not smuggle in a performance claim", () => {
  const failures = mutated((document) => {
    capability(document, "server-autoscaling").summary =
      "Server autoscaling keeps p99 latency under 250ms during a burst.";
  });
  assert.ok(
    failures.some((failure) => /performance or availability claim/u.test(failure)),
    failures.join("\n"),
  );
});

test("the chart annotations must stay aligned with the adapter inventory", () => {
  for (const [annotation, value] of [
    ["cluster.t4.dev/crd-install-flag", "--skip-crd"],
    ["cluster.t4.dev/crd-ordering", "bundled"],
    ["cluster.t4.dev/provider-neutral", "false"],
    ["cluster.t4.dev/capabilities-file", "capabilities.json"],
  ]) {
    const failures = mutated((document) => {
      document.chart.annotations[annotation] = value;
    });
    assert.ok(
      failures.some((failure) => failure.includes(annotation)),
      `${annotation} drift was not rejected: ${failures.join("\n")}`,
    );
  }

  const failures = mutated((document) => {
    document.chart.annotations["cluster.t4.dev/optional-adapters"] = "ssh-gateway";
  });
  assert.ok(
    failures.some((failure) => /optional-adapters must list exactly/u.test(failure)),
    failures.join("\n"),
  );
});

test("an unknown top-level or capability field fails closed", () => {
  assert.ok(
    mutated((document) => {
      document.capabilities.notes = "extra";
    }).some((failure) => /capabilities\.yaml fields must be exactly/u.test(failure)),
  );
  assert.ok(
    mutated((document) => {
      capability(document, "default-off").owner = "someone";
    }).some((failure) => /fields must be exactly/u.test(failure)),
  );
});
