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
  await writeFile(
    path.join(root, "provenance/cmux-machine-provider-v1.json"),
    await readFile(path.join(repositoryRoot, "provenance/cmux-machine-provider-v1.json")),
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
