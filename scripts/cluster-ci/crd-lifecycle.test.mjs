import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const lifecycle = resolve(import.meta.dirname, "crd-lifecycle.sh");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t4-crd-lifecycle-"));
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  await mkdir(bin);
  await writeFile(
    join(bin, "kubectl"),
    `#!/bin/sh
set -eu
printf 'kubectl' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
for argument in "$@"; do
  if [ "$argument" = "--dry-run=server" ] && [ "\${FAIL_DRY_RUN:-0}" = 1 ]; then
    exit 42
  fi
done
if [ "\${1:-}" = patch ] && [ "\${FAIL_REAL_PATCH:-}" = "\${2:-}" ]; then
  is_dry=false
  for argument in "$@"; do if [ "$argument" = "--dry-run=server" ]; then is_dry=true; fi; done
  if [ "$is_dry" = false ]; then exit 47; fi
fi
if [ "\${1:-}" = get ]; then
  for argument in "$@"; do
    case "$argument" in
      --raw|--raw=*)
        if [ -n "\${RAW_RESULTS:-}" ]; then
          raw_counter_file="\${RAW_COUNTER_FILE:-$COMMAND_LOG.raw-count}"
          raw_count=0
          if [ -f "$raw_counter_file" ]; then raw_count=$(cat "$raw_counter_file"); fi
          raw_count=$((raw_count + 1))
          printf '%s' "$raw_count" >"$raw_counter_file"
          raw_result=$(printf '%s' "$RAW_RESULTS" | awk -F, -v field_index="$raw_count" '{print $field_index}')
          if [ "$raw_result" = timeout ]; then exit 46; fi
        fi
        printf '%s' '{}'
        exit 0
        ;;
    esac
  done
  case "\${2:-}" in
    crd/*)
      for argument in "$@"; do
        if [ "$argument" = "--ignore-not-found" ]; then
          if [ "\${FAIL_CRD_READ:-}" = "\${2:-}" ]; then exit 45; fi
          if [ "\${MISSING_LIVE_CRDS:-0}" = 1 ]; then exit 0; fi
          resource_name=\${2#crd/}
          printf 'apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: %s\n  uid: 11111111-2222-3333-4444-555555555555\n  resourceVersion: "42"\n' "$resource_name"
          exit 0
        fi
      done
      ;;
  esac
  case "\${2:-}" in
    t4clusterhosts.cluster.t4.dev|t4workspaces.cluster.t4.dev|t4sessions.cluster.t4.dev)
      if [ "\${FAIL_LIVE_LIST:-}" = "\${2:-}" ]; then exit 44; fi
      if [ "\${TERMINATE_DURING_LIVE_READ:-}" = "\${2:-}" ]; then
        kill -TERM "$PPID"
        sleep 1
      fi
      printf '%s' '{"apiVersion":"v1","kind":"List","items":[]}'
      exit 0
      ;;
  esac
  printf '%s' "\${STORED_VERSIONS:-v1alpha1}"
fi
`,
  );
  await writeFile(
    join(bin, "crd-preflight"),
    `#!/bin/sh
set -eu
printf 'validator' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
case "\${1:-}:\${FAIL_PROPOSED_VALIDATION:-}" in
  fixtures:spec|fixtures:status|objects:live|served:stale) exit 43 ;;
esac
if [ "\${1:-}" = patch ]; then
  printf '%s' '{"metadata":{"resourceVersion":"42","uid":"11111111-2222-3333-4444-555555555555"},"spec":{}}'
  exit 0
fi
if [ "\${1:-}" = served ] && [ -n "\${SERVED_RESULTS:-}" ]; then
  served_counter_file="\${SERVED_COUNTER_FILE:-$COMMAND_LOG.served-count}"
  served_count=0
  if [ -f "$served_counter_file" ]; then served_count=$(cat "$served_counter_file"); fi
  served_count=$((served_count + 1))
  printf '%s' "$served_count" >"$served_counter_file"
  served_result=$(printf '%s' "$SERVED_RESULTS" | awk -F, -v field_index="$served_count" '{print $field_index}')
  if [ "$served_result" = stale ]; then exit 43; fi
fi
cat >/dev/null
`,
  );
  await writeFile(
    join(bin, "helm"),
    `#!/bin/sh
set -eu
printf 'helm' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
`,
  );
  await chmod(join(bin, "kubectl"), 0o755);
  await chmod(join(bin, "helm"), 0o755);
  await chmod(join(bin, "crd-preflight"), 0o755);
  return {
    root,
    log,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, T4_CRD_VALIDATOR: join(bin, "crd-preflight"), T4_DISCOVERY_INTERVAL_SECONDS: "0" },
  };
}

async function runLifecycle(args, env = {}) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(lifecycle, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return result;
}

async function commands(log) {
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
}

function findCommand(log, predicate, description) {
  const index = log.findIndex(predicate);
  assert.notEqual(index, -1, `missing ${description}:\n${log.join("\n")}`);
  return index;
}

function isClusterMutation(line) {
  return /^kubectl\t(?:patch|create|apply)\t/u.test(line) && !line.includes("--dry-run=server");
}

test("upgrade validates proposed schemas, proves served convergence, verifies storage, then upgrades workloads", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    value.env,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const log = await commands(value.log);
  const proposedPreflight = findCommand(log, (line) => line.startsWith("validator\tfixtures\t"), "local proposed-schema fixture preflight");
  const crdReads = log.map((line, index) => ({ line, index })).filter(({ line }) => /^kubectl\tget\tcrd\/t4(?:clusterhosts|workspaces|sessions)\.cluster\.t4\.dev\t--ignore-not-found\t-o\tyaml$/u.test(line));
  const liveLists = log.map((line, index) => ({ line, index })).filter(({ line }) => /^kubectl\tget\tt4(?:clusterhosts|workspaces|sessions)\.cluster\.t4\.dev\t--all-namespaces\t-o\tjson$/u.test(line));
  const liveValidations = log.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("validator\tobjects\t"));
  const structuralCompatibility = findCommand(log, (line) => line.startsWith("validator\tcompatible\t"), "installed-schema additive compatibility gate");
  const patchGeneration = log.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("validator\tpatch\t"));
  const crdPreflight = findCommand(log, (line) => line.startsWith("kubectl\tpatch\tcrd/") && line.includes("--dry-run=server"), "resource-version-guarded CRD preflight");
  const crdApply = findCommand(log, (line) => line.startsWith("kubectl\tpatch\tcrd/") && !line.includes("--dry-run=server"), "resource-version-guarded CRD patch");
  const established = findCommand(log, (line) => line.includes("wait") && line.includes("condition=Established") && line.includes("t4clusterhosts.cluster.t4.dev") && line.includes("t4workspaces.cluster.t4.dev") && line.includes("t4sessions.cluster.t4.dev"), "Established wait");
  const servedChecks = log.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("validator\tserved\t"));
  const admissionPreflight = findCommand(log, (line) => line.includes("apply") && line.includes("--dry-run=server") && line.includes("testdata/compat"), "converged admission preflight");
  const storageChecks = log.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("kubectl\tget\tcrd/") && line.includes("status.storedVersions"));
  assert.deepEqual(storageChecks.length, 3);
  assert.equal(servedChecks.length, 3);
  assert.equal(crdReads.length, 3);
  assert.equal(liveLists.length, 3);
  assert.equal(liveValidations.length, 3);
  assert.equal(patchGeneration.length, 3);
  const workload = findCommand(log, (line) => line.startsWith("helm\tupgrade\t"), "Helm workload upgrade");
  assert.ok(proposedPreflight < crdPreflight);
  assert.ok(proposedPreflight < crdReads[0].index);
  assert.ok(crdReads[0].index < liveLists[0].index);
  assert.ok(liveLists[0].index < liveValidations[0].index);
  assert.ok(liveValidations[0].index < crdReads[1].index);
  assert.ok(crdReads[1].index < liveLists[1].index);
  assert.ok(liveLists[1].index < liveValidations[1].index);
  assert.ok(liveValidations[1].index < crdReads[2].index);
  assert.ok(crdReads[2].index < liveLists[2].index);
  assert.ok(liveLists[2].index < liveValidations[2].index);
  assert.ok(liveValidations[2].index < structuralCompatibility);
  assert.ok(structuralCompatibility < patchGeneration[0].index);
  assert.ok(patchGeneration.at(-1).index < crdPreflight);
  assert.ok(crdPreflight < crdApply);
  assert.ok(crdApply < established);
  assert.ok(established < servedChecks[0].index);
  assert.ok(servedChecks.at(-1).index < admissionPreflight);
  assert.ok(admissionPreflight < storageChecks[0].index);
  assert.ok(storageChecks.every(({ index }) => index < workload));
  const crdPatches = log.filter((line) => line.startsWith("kubectl\tpatch\tcrd/"));
  assert.equal(crdPatches.length, 6, log.join("\n"));
  assert.ok(crdPatches.every((line) => line.includes("--type=merge") && line.includes("--field-manager=t4-crd-lifecycle") && line.includes("--patch-file=")), log.join("\n"));
  assert.ok(log.every((line) => !line.includes("--force-conflicts") && !line.includes("replace") && !line.includes("delete\tcrd")), log.join("\n"));
});

test("fresh install establishes and validates CRDs before Helm installs with CRD handling disabled", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["install", "--", "helm", "install", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    { ...value.env, MISSING_LIVE_CRDS: "1" },
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const log = await commands(value.log);
  assert.ok(log.every((line) => !line.startsWith("validator\tobjects\t") && !/kubectl\tget\tt4(?:clusterhosts|workspaces|sessions)\.cluster\.t4\.dev\t--all-namespaces/u.test(line)), log.join("\n"));
  const established = findCommand(log, (line) => line.includes("wait") && line.includes("condition=Established"), "Established wait");
  const fixtureValidation = findCommand(log, (line) => line.includes("--dry-run=server") && line.includes("testdata/compat"), "fixture validation");
  const storage = findCommand(log, (line) => line.includes("status.storedVersions"), "stored-version check");
  const workload = findCommand(log, (line) => line.startsWith("helm\tinstall\t"), "Helm install");
  const crdCreates = log.filter((line) => line.startsWith("kubectl\tcreate\t"));
  assert.equal(crdCreates.length, 6, log.join("\n"));
  assert.ok(crdCreates.every((line) => line.includes("--field-manager=t4-crd-lifecycle")), log.join("\n"));
  assert.ok(established < fixtureValidation && fixtureValidation < storage && storage < workload);
});

test("candidate schema tightening fails locally before any cluster or workload mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "spec" },
  );
  assert.notEqual(result.code, 0);
  assert.deepEqual(await commands(value.log), [
    `validator\tfixtures\t${join(repoRoot, "deploy/charts/t4-cluster/crds")}\t${join(repoRoot, "packages/cluster-operator/api/v1alpha1/testdata/compat")}`,
  ]);
});

test("persisted status is validated against the proposed status schema before mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "status" },
  );
  assert.notEqual(result.code, 0);
  assert.deepEqual(await commands(value.log), [
    `validator\tfixtures\t${join(repoRoot, "deploy/charts/t4-cluster/crds")}\t${join(repoRoot, "packages/cluster-operator/api/v1alpha1/testdata/compat")}`,
  ]);
});

test("live object incompatibility fails before non-dry-run CRD, object, or Helm mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "live" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.match(log.at(-1), /^validator\tobjects\t/u);
  assert.ok(log.some((line) => /^kubectl\tget\tt4clusterhosts\.cluster\.t4\.dev\t--all-namespaces\t-o\tjson$/u.test(line)), log.join("\n"));
  assert.ok(log.every((line) => !line.startsWith("helm\t") && !isClusterMutation(line)), log.join("\n"));
});

test("live object definition read or list denial fails closed before non-dry-run mutation", async () => {
  const deniedResource = "t4workspaces.cluster.t4.dev";
  for (const scenario of [
    { env: { FAIL_CRD_READ: `crd/${deniedResource}` }, expected: `kubectl\tget\tcrd/${deniedResource}\t--ignore-not-found\t-o\tyaml` },
    { env: { FAIL_LIVE_LIST: deniedResource }, expected: `kubectl\tget\t${deniedResource}\t--all-namespaces\t-o\tjson` },
  ]) {
    const value = await fixture();
    const result = await runLifecycle(
      ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
      { ...value.env, ...scenario.env },
    );
    assert.notEqual(result.code, 0);
    const log = await commands(value.log);
    assert.ok(log.some((line) => line.startsWith(scenario.expected)), log.join("\n"));
    assert.ok(log.every((line) => !line.startsWith("helm\t") && !isClusterMutation(line)), log.join("\n"));
  }
});

test("cancellation during live enumeration cannot continue to mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, TERMINATE_DURING_LIVE_READ: "t4clusterhosts.cluster.t4.dev" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.match(log.at(-1), /^kubectl\tget\tt4clusterhosts\.cluster\.t4\.dev\t--all-namespaces\t-o\tjson$/u);
  assert.ok(log.every((line) => !line.startsWith("helm\t") && !isClusterMutation(line)), log.join("\n"));
});

test("retained Established cannot pass readiness while served OpenAPI is stale", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "stale", T4_DISCOVERY_ATTEMPTS: "3" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  const apply = findCommand(log, (line) => line.startsWith("kubectl\tpatch\tcrd/") && !line.includes("--dry-run=server"), "non-dry-run CRD patch");
  const established = findCommand(log, (line) => line.includes("condition=Established"), "Established wait");
  const served = findCommand(log, (line) => line.startsWith("validator\tserved\t"), "served-schema semantic verification");
  assert.ok(apply < established && established < served, log.join("\n"));
  assert.ok(log.every((line) => !line.startsWith("helm\t")), log.join("\n"));
});

test("served OpenAPI waits for three consecutive matching observations", async () => {
  for (const sequence of ["stale,fresh,fresh,fresh", "fresh,stale,fresh,fresh,fresh"]) {
    const value = await fixture();
    const result = await runLifecycle(
      ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
      { ...value.env, SERVED_RESULTS: sequence, T4_DISCOVERY_ATTEMPTS: "6" },
    );
    assert.equal(result.code, 0, `${sequence}\n${result.stdout}\n${result.stderr}`);
    const log = await commands(value.log);
    assert.equal(
      log.filter((line) => line.startsWith("validator\tserved\t")).length,
      sequence.split(",").length,
      log.join("\n"),
    );
    assert.ok(log.some((line) => line.startsWith("helm\tupgrade\t")), log.join("\n"));
  }
});

test("served OpenAPI requests are individually bounded and failed requests consume attempts", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    {
      ...value.env,
      RAW_RESULTS: "timeout,timeout,fresh,fresh,fresh",
      T4_DISCOVERY_ATTEMPTS: "5",
      T4_DISCOVERY_REQUEST_TIMEOUT: "1s",
    },
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const log = await commands(value.log);
  const rawRequests = log.filter((line) => line.includes("\tget\t") && line.includes("\t--raw\t/openapi/v3/"));
  assert.equal(rawRequests.length, 5, log.join("\n"));
  assert.ok(rawRequests.every((line) => line.includes("\t--request-timeout=1s\t")), log.join("\n"));
  assert.equal(log.filter((line) => line.startsWith("validator\tserved\t")).length, 3, log.join("\n"));
});

test("invalid discovery request timeout is rejected before cluster access", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, T4_DISCOVERY_REQUEST_TIMEOUT: "0s" },
  );
  assert.equal(result.code, 64, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /positive whole number of seconds/u);
  await assert.rejects(readFile(value.log, "utf8"), { code: "ENOENT" });
});

test("failed server preflight leaves CRDs and workloads untouched", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    { ...value.env, FAIL_DRY_RUN: "1" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.match(log[0], /^validator\tfixtures\t/u);
  assert.match(log.at(-1), /^kubectl\tpatch\tcrd\/.*--dry-run=server/u);
  assert.ok(log.every((line) => !line.startsWith("helm\t") && !isClusterMutation(line)), log.join("\n"));
});

test("a CRD changed after validation conflicts instead of being overwritten", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_REAL_PATCH: "crd/t4clusterhosts.cluster.t4.dev" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  const guardedPatch = log.find((line) => line.startsWith("kubectl\tpatch\tcrd/t4clusterhosts.cluster.t4.dev") && !line.includes("--dry-run=server"));
  assert.ok(guardedPatch?.includes("--patch-file="), log.join("\n"));
  assert.ok(log.every((line) => !line.startsWith("helm\t")), log.join("\n"));
});

test("an unexpected stored version stops workload rollout", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    { ...value.env, STORED_VERSIONS: "v1alpha1,v1beta1" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.ok(log.some((line) => line.includes("status.storedVersions")));
  assert.ok(log.every((line) => !line.startsWith("helm\t")), log.join("\n"));
});

test("force replacement and implicit Helm CRD handling are rejected before cluster access", async () => {
  const value = await fixture();
  for (const args of [
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds", "--force"],
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart"],
  ]) {
    const result = await runLifecycle(args, value.env);
    assert.equal(result.code, 64, `${result.stdout}\n${result.stderr}`);
  }
});

test("future storage migration explicitly retires the old stored version only after rewrite and dual-version reads", async () => {
  const docs = await readFile(join(repoRoot, "docs/CLUSTER_OPERATOR.md"), "utf8");
  const migration = docs.slice(docs.indexOf("### Future `v1beta1`"), docs.indexOf("### Workload rollback"));
  const storageFlip = migration.indexOf("`v1beta1` storage to true");
  const rewrite = migration.indexOf("rewrite every object");
  const verifyReads = migration.indexOf("read every rewritten object through both served versions");
  const statusUpdate = migration.indexOf("/status");
  const exactAssertion = migration.indexOf("exactly `[v1beta1]`");
  const oldStillServed = migration.indexOf("Keep `v1alpha1` served");
  assert.ok(storageFlip >= 0 && storageFlip < rewrite, migration);
  assert.ok(rewrite < verifyReads && verifyReads < statusUpdate, migration);
  assert.ok(statusUpdate < exactAssertion && exactAssertion < oldStillServed, migration);
  assert.match(migration, /patch customresourcedefinition[^\n]*--subresource=status/u);
});
