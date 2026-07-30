import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const lifecycle = new URL("./release-lifecycle.sh", import.meta.url);
const packaging = new URL("./package-chart.sh", import.meta.url);

const UNREACHABLE_TOOLS = {
  KUBECTL: "/definitely/not/a/kubectl",
  HELM: "/definitely/not/a/helm",
  NODE: "/definitely/not/a/node",
};

function run(script, args, env = {}) {
  return spawnSync(script.pathname, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const PACKAGE_MEMBERS = [
  "Chart.yaml",
  "values.yaml",
  "values.schema.json",
  "capabilities.yaml",
  "templates/NOTES.txt",
  "crds/t4clusterhosts.cluster.t4.dev.yaml",
  "crds/t4workspaces.cluster.t4.dev.yaml",
  "crds/t4sessions.cluster.t4.dev.yaml",
];

async function createPackagingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "t4-package-chart-"));
  const output = join(root, "output");
  const helm = join(root, "fake-helm.mjs");
  const log = join(root, "helm.log");
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeHelm = `#!${process.execPath}
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_HELM_LOG, command + "\\n");

if (command === "lint") {
  process.exit(0);
}
if (command === "template") {
  process.stdout.write(process.env.FAKE_HELM_RENDER ?? "\\n");
  process.exit(0);
}
if (command !== "package") {
  console.error("unexpected fake Helm command: " + command);
  process.exit(90);
}

const chartDirectory = args[0];
const destinationIndex = args.indexOf("--destination");
if (destinationIndex < 0 || !args[destinationIndex + 1]) {
  console.error("fake Helm package requires --destination");
  process.exit(91);
}
const destination = args[destinationIndex + 1];
const chartYaml = readFileSync(join(chartDirectory, "Chart.yaml"), "utf8");
const chartName = /^name:\\s*(.+)$/mu.exec(chartYaml)?.[1]?.trim();
const chartVersion = /^version:\\s*(.+)$/mu.exec(chartYaml)?.[1]?.trim();
if (!chartName || !chartVersion) {
  console.error("fake Helm could not read chart identity");
  process.exit(92);
}

const stagingRoot = mkdtempSync(join(tmpdir(), "fake-helm-package-"));
const chartRoot = join(stagingRoot, chartName);
const members = ${JSON.stringify(PACKAGE_MEMBERS)};
const variant = process.env.FAKE_HELM_ARCHIVE_VARIANT ?? "";
const omitted = variant.startsWith("missing:") ? variant.slice("missing:".length) : undefined;
const packagedMembers = [];
try {
  for (const member of members) {
    if (member === omitted) continue;
    const target = join(chartRoot, member);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(chartDirectory, member), target);
    packagedMembers.push(chartName + "/" + member);
  }
  if (variant === "extra-crd") {
    const member = "crds/unexpected.cluster.t4.dev.yaml";
    const target = join(chartRoot, member);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "apiVersion: apiextensions.k8s.io/v1\\nkind: CustomResourceDefinition\\n");
    packagedMembers.push(chartName + "/" + member);
  }
  mkdirSync(destination, { recursive: true });
  const archive = join(destination, chartName + "-" + chartVersion + ".tgz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", stagingRoot, ...packagedMembers], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (tar.status !== 0) {
    process.stderr.write(tar.stderr);
    process.exit(tar.status ?? 93);
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
`;
  await writeFile(helm, fakeHelm, { mode: 0o700 });

  const runPackage = (extraEnv = {}) =>
    run(packaging, ["--package"], {
      HELM: helm,
      NODE: process.execPath,
      TMPDIR: root,
      HOME: root,
      T4_CHART_OUTPUT_DIR: output,
      FAKE_HELM_LOG: log,
      ...extraEnv,
    });

  return { log, output, runPackage };
}

async function readHelmCommands(log) {
  return (await readFile(log, "utf8")).trimEnd().split("\n");
}

const lifecycleSource = await readFile(lifecycle, "utf8");
const packagingSource = await readFile(packaging, "utf8");

test("--plan is complete and never invokes a cluster tool", () => {
  const result = run(lifecycle, ["--plan"], UNREACHABLE_TOOLS);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "T4 release lifecycle plan (read-only; no cluster requests)");
  assert.equal(lines.length, 20);
  const scenarioLine = /^ {2}[A-H]\. ([a-z-]+)\./u;
  const planned = lines.flatMap((line) => {
    const match = scenarioLine.exec(line);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(planned, [
    "capability-render-matrix",
    "crd-separate-order",
    "fresh-install",
    "additive-upgrade",
    "rollback",
    "optional-adapters",
    "retained-state-reinstall",
    "clean-uninstall",
  ]);
  assert.match(result.stdout, /Live results are not implied by --plan\./u);
  assert.match(result.stdout, /nothing is deleted implicitly/u);
});

test("the plan enumerates exactly the scenarios the chart advertises", async () => {
  const { declaredScenarioIds } = await import("./chart-capabilities.mjs");
  const declared = await declaredScenarioIds();
  const planned = run(lifecycle, ["--plan"], UNREACHABLE_TOOLS)
    .stdout.split("\n")
    .flatMap((line) => {
      const match = /^ {2}[A-H]\. ([a-z-]+)\./u.exec(line);
      return match ? [match[1]] : [];
    });
  assert.deepEqual([...planned].sort(), [...declared].sort());
});

test("the harness refuses an ambiguous or missing target before any mutation", () => {
  assert.equal(run(lifecycle, [], UNREACHABLE_TOOLS).status, 64);
  assert.equal(run(lifecycle, ["--run", "--cleanup"], UNREACHABLE_TOOLS).status, 64);

  const productionNamespace = run(lifecycle, ["--run"], {
    ...UNREACHABLE_TOOLS,
    T4_LIFECYCLE_NAMESPACE: "production",
  });
  assert.equal(productionNamespace.status, 64);
  assert.match(productionNamespace.stderr, /must begin t4-lifecycle-/u);

  const cleanupWithoutTarget = run(lifecycle, ["--cleanup"], {
    ...UNREACHABLE_TOOLS,
    T4_LIFECYCLE_NAMESPACE: "",
  });
  assert.equal(cleanupWithoutTarget.status, 64);

  const missingValues = run(lifecycle, ["--run"], {
    ...UNREACHABLE_TOOLS,
    T4_LIFECYCLE_NAMESPACE: "t4-lifecycle-smoke",
    T4_LIFECYCLE_VALUES: "/definitely/not/a/values.yaml",
    T4_LIFECYCLE_UPGRADE_VALUES: "/definitely/not/a/values.yaml",
    T4_LIFECYCLE_ADAPTER_VALUES: "/definitely/not/a/values.yaml",
  });
  assert.equal(missingValues.status, 64);
  assert.match(missingValues.stderr, /must be a readable values file/u);
});

test("every Helm invocation skips CRDs except the documented refusal probe", () => {
  const invocations =
    lifecycleSource.match(/"\$helm" (?:install|upgrade|template)(?:[^\n]*\\\n)*[^\n]*/gu) ?? [];
  assert.ok(invocations.length >= 6, "expected the harness to drive Helm across the lifecycle");
  const unguarded = invocations.filter((invocation) => !invocation.includes("--skip-crds"));
  // Exactly one: scenario B deliberately feeds the lifecycle runner a Helm
  // command without --skip-crds and requires it to be refused.
  assert.equal(unguarded.length, 1, `unguarded Helm invocations:\n${unguarded.join("\n---\n")}`);
  assert.match(unguarded[0], /refused=\$\?/u);
  // helm rollback has no --skip-crds flag and must never be forced.
  assert.match(lifecycleSource, /"\$helm" rollback "\$release" 1 --namespace "\$namespace" --wait/u);
  assert.doesNotMatch(lifecycleSource, /--force\b|--replace\b|--no-hooks\b/u);
});

test("the harness proves retention, ordering, and single-writer invariants", () => {
  for (const required of [
    "the lifecycle runner accepted a Helm command without --skip-crds",
    "a refused lifecycle command must not create the namespace",
    "the portable chart must not create a PersistentVolumeClaim",
    "the portable chart must not create a Secret",
    "the upgrade values must change the digest set, otherwise rollback proves nothing",
    "rollback did not restore the baseline digest set",
    "helm uninstall removed a CustomResourceDefinition",
    "helm uninstall removed retained storage",
    "instead of re-adopting",
    "reinstall left more than one PersistentVolumeClaim",
    "Retain retention did not orphan the PersistentVolumeClaim for recovery",
    "sessions must be deleted and drained before uninstall",
    "the chart-owned T4ClusterHost survived uninstall",
    "uninstall removed a CustomResourceDefinition; retained state would be unrecoverable",
    "storedVersions is not exactly v1alpha1",
  ]) {
    assert.ok(
      lifecycleSource.includes(required),
      `release-lifecycle.sh is missing the assertion: ${required}`,
    );
  }
  assert.match(lifecycleSource, /never adopts an existing namespace/u);
  assert.match(lifecycleSource, /is already installed; run --cleanup/u);
  assert.doesNotMatch(lifecycleSource, /dockerconfigjson|password|apiKey|BEGIN [A-Z ]*PRIVATE KEY/iu);
});

test("the harness contacts no registry and publishes nothing", () => {
  const publicationCommand =
    /^\s*(?:"\$(?:helm|oras|cosign|docker)"|(?:helm|oras|cosign|docker))\s+(?:registry\s+login|push|sign)\b/mu;
  for (const source of [lifecycleSource, packagingSource]) {
    const executableSource = source.replace(/<<'([A-Z]+)'\n[\s\S]*?\n\1\n/gu, "<<'$1'\n$1\n");
    assert.doesNotMatch(executableSource, publicationCommand);
  }
});

test("packaging executes locally, validates its archive, and refuses publication", async (t) => {
  const plan = run(packaging, ["--plan"], { HELM: "/definitely/not/a/helm" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.stderr, "");
  assert.match(plan.stdout, /^T4 chart packaging plan \(local only; no registry request\)/u);
  assert.match(plan.stdout, /Not performed here:/u);

  assert.equal(run(packaging, [], {}).status, 64);

  const refused = run(packaging, ["--package"], {
    HELM: "/definitely/not/a/helm",
    NODE: "/definitely/not/a/node",
    T4_CHART_PUBLISH: "1",
  });
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /never publishes/u);

  await t.test("whitespace-only defaults produce a truthful local package manifest", async (t) => {
    const fixture = await createPackagingFixture(t);
    const result = fixture.runPackage({ FAKE_HELM_RENDER: " \n\t\r\n" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing was published\./u);
    assert.deepEqual(await readHelmCommands(fixture.log), ["lint", "template", "package"]);

    const manifestPath = join(fixture.output, "chart-package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, "t4-cluster-chart-package/1");
    assert.equal(manifest.chart, "t4-cluster");
    assert.equal(typeof manifest.version, "string");
    assert.ok(manifest.version.length > 0);
    assert.equal(typeof manifest.appVersion, "string");
    assert.ok(manifest.appVersion.length > 0);
    const archive = join(fixture.output, `${manifest.chart}-${manifest.version}.tgz`);
    assert.equal(manifest.archive, archive);
    assert.equal(manifest.published, false);

    const archiveBytes = await readFile(archive);
    assert.equal(manifest.archiveBytes, (await stat(archive)).size);
    assert.equal(manifest.archiveBytes, archiveBytes.byteLength);
    assert.equal(manifest.archiveSha256, createHash("sha256").update(archiveBytes).digest("hex"));

    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    const members = listing.stdout.trimEnd().split("\n");
    assert.deepEqual(
      [...members].sort(),
      PACKAGE_MEMBERS.map((member) => `t4-cluster/${member}`).sort(),
    );
    assert.equal(members.filter((member) => member.startsWith("t4-cluster/crds/")).length, 3);
  });

  await t.test("any rendered resource rejects the package before Helm packages it", async (t) => {
    const fixture = await createPackagingFixture(t);
    const result = fixture.runPackage({
      FAKE_HELM_RENDER: "apiVersion: v1\nkind: ConfigMap\n",
    });
    assert.equal(result.status, 65);
    assert.match(result.stderr, /default values must render nothing/u);
    assert.deepEqual(await readHelmCommands(fixture.log), ["lint", "template"]);
  });

  for (const missing of PACKAGE_MEMBERS) {
    await t.test(`a package missing ${missing} is rejected`, async (t) => {
      const fixture = await createPackagingFixture(t);
      const result = fixture.runPackage({
        FAKE_HELM_ARCHIVE_VARIANT: `missing:${missing}`,
      });
      assert.equal(result.status, 65);
      assert.match(result.stderr, new RegExp(`missing t4-cluster/${missing.replaceAll(".", "\\.")}`, "u"));
      assert.deepEqual(await readHelmCommands(fixture.log), ["lint", "template", "package"]);
    });
  }

  await t.test("a package with a fourth CRD is rejected", async (t) => {
    const fixture = await createPackagingFixture(t);
    const result = fixture.runPackage({ FAKE_HELM_ARCHIVE_VARIANT: "extra-crd" });
    assert.equal(result.status, 65);
    assert.match(result.stderr, /carries 4 CRD files, expected exactly 3/u);
    assert.deepEqual(await readHelmCommands(fixture.log), ["lint", "template", "package"]);
  });
});
