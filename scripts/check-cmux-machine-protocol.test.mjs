import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkCmuxMachineProtocol } from "./check-cmux-machine-protocol.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = "provenance/cmux-machine-provider-v1.json";

async function fixture(mutator = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cmux-machine-protocol-"));
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, manifestPath), "utf8"));
  const records = [
    ...manifest.source.files,
    manifest.workspaceEvidence,
    manifest.repositoryLicenseEvidence,
    manifest.generator,
    manifest.generator.cargoManifest,
    manifest.generator.cargoLock,
    ...manifest.fixtures.files,
  ];
  for (const record of records) {
    const destination = path.join(root, record.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(repositoryRoot, record.path)));
  }
  await mkdir(path.dirname(path.join(root, manifestPath)), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  await mutator({ manifest, root });
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("accepts the exact pinned machine-provider source and generated corpus", async (t) => {
  const copy = await fixture();
  t.after(copy.cleanup);
  assert.deepEqual((await checkCmuxMachineProtocol(copy.root)).failures, []);
});

test("rejects modified upstream schema bytes", async (t) => {
  const copy = await fixture(async ({ manifest, root }) => {
    const target = path.join(root, manifest.source.files[1].path);
    const bytes = await readFile(target);
    bytes[bytes.length - 2] ^= 1;
    await writeFile(target, bytes);
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(result.failures.some((failure) => failure.includes("source.files[1].content.sha256")));
});

test("rejects modified generated control frames", async (t) => {
  const copy = await fixture(async ({ manifest, root }) => {
    const record = manifest.fixtures.files.find(({ path: fixturePath }) => fixturePath.endsWith("hello.request.ndjson"));
    const target = path.join(root, record.path);
    await writeFile(target, (await readFile(target, "utf8")).replace("cmux-tui", "cmux-fui"));
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(result.failures.some((failure) => failure.includes("fixtures.files") && failure.includes("sha256")));
});

test("rejects untracked fixture files", async (t) => {
  const copy = await fixture(async ({ root }) => {
    await writeFile(path.join(root, "vendor/cmux-machine-provider-v1/fixtures/control/private-wire.ndjson"), "{}\n");
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(result.failures.some((failure) => failure.includes("directory membership")));
});

test("rejects provenance drift even when local files are intact", async (t) => {
  const copy = await fixture(async ({ manifest, root }) => {
    manifest.source.repository = "https://example.invalid/private-cmux";
    await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(result.failures.some((failure) => failure.includes("source.repository")));
});

test("rejects coordinated evidence path drift with identical bytes", async (t) => {
  const copy = await fixture(async ({ manifest, root }) => {
    const original = path.join(root, manifest.workspaceEvidence.path);
    const replacement = "vendor/cmux-machine-provider-v1/upstream/cmux-tui/workspace-copy.toml";
    await writeFile(path.join(root, replacement), await readFile(original));
    manifest.workspaceEvidence.path = replacement;
    await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(result.failures.some((failure) => failure.includes("workspaceEvidence.path")));
});

test("rejects Windows-style traversal before reading generator paths", async (t) => {
  const copy = await fixture(async ({ manifest, root }) => {
    manifest.generator.path = "..\\outside.rs";
    await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  });
  t.after(copy.cleanup);
  const result = await checkCmuxMachineProtocol(copy.root);
  assert.ok(
    result.failures.some(
      (failure) => failure.includes("generator.source.path") && failure.includes("normalized repository-relative path"),
    ),
  );
});
