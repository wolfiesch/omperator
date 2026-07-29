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
