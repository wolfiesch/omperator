// Fork and source authority: base tags, transfer proofs, and public verification.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertRestored,
  createDeployFixture,
  createRunnerFixture,
  mockAssetSize,
  mockDebSize,
  pathExists,
} from "./t4-maintainer-fixtures.mjs";

test("public verification rejects a changed fork base-tag object", async (t) => {
  const fixture = await createRunnerFixture({ forkBaseTagMismatch: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /repos\/can1357\/oh-my-pi\/git\/ref\/tags\/v1\.2\.3/mu);
  assert.match(calls, /repos\/wolfiesch\/oh-my-pi\/git\/ref\/tags\/v1\.2\.3/mu);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("legacy atomic receipts remain valid only through the exact transfer proof", async (t) => {
  const fixture = await createRunnerFixture({ legacyAtomicReceipt: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const processed = JSON.parse(await readFile(fixture.processed, "utf8"));
  assert.equal(processed.atomicPublication.forkRepository, "lyc-aon/oh-my-pi");

  const receiptPath = join(
    fixture.maintainerRoot,
    "state",
    "atomic-publication",
    "t4code-1.2.3-appserver-1",
    "receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.forkRepository, "lyc-aon/oh-my-pi");
});

test("legacy transfer proof accepts the exact base commit without recreating the fork tag", async (t) => {
  const fixture = await createRunnerFixture({
    legacyAtomicReceipt: true,
    forkBaseTagMissing: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /repos\/wolfiesch\/oh-my-pi\/commits\/[0-9a-f]{40}/mu);
});

test("site release-manifest drift blocks public verification and local work", async (t) => {
  const cases = [
    ["schema", "schema"],
    ["version", "version"],
    ["tag", "tag"],
    ["release URL", "release-url"],
    ["asset set", "extra-asset"],
    ["asset size", "size"],
    ["asset digest", "digest"],
    ["asset URL", "asset-url"],
  ];
  for (const [name, mode] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture();
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner({ MOCK_SITE_MANIFEST_MODE: mode });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(calls, /releases\/latest\.json/mu);
      assert.equal(
        calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
        0,
      );
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
    });
  }
});

test("live Linux updater verification downloads the exact bounded public files", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());

  const downloads = (await fixture.callsText())
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("curl\t") &&
        line.includes("https://github.com/wolfiesch/omperator/releases/download/v1.2.3/") &&
        line.includes("\t-o\t"),
    );
  for (const [name, size] of [
    ["Omperator-1.2.3-linux-amd64.deb", mockDebSize],
    ["Omperator-1.2.3-linux-x86_64.AppImage", mockAssetSize],
  ]) {
    const line = downloads.find((candidate) => candidate.includes(`/${name}\t`));
    assert.ok(line, downloads.join("\n"));
    assert.match(line, new RegExp(`\\t--max-filesize\\t${size}(?:\\t|$)`, "u"));
  }
  const metadata = downloads.find((line) => line.includes("/latest-linux.yml\t"));
  assert.ok(metadata, downloads.join("\n"));
  assert.match(metadata, /\t--max-filesize\t[1-9][0-9]*(?:\t|$)/u);
  assert.match(await fixture.callsText(), /^node\t.*inspect-linux-update\.mjs\t--version\t1\.2\.3/mu);
});

test("self-consistent checksum drift in live Linux metadata still blocks deployment", async (t) => {
  for (const [name, linuxUpdateMode] of [
    ["deb name", "deb-name"],
    ["deb size", "deb-size"],
    ["deb SHA-512", "deb-sha512"],
    ["AppImage name", "appimage-name"],
    ["AppImage size", "appimage-size"],
    ["AppImage SHA-512", "appimage-sha512"],
    ["compatibility SHA-512", "compatibility-sha512"],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture({ linuxUpdateMode });
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(calls, /latest-linux\.yml\t-o\t/mu);
      assert.match(calls, /^node\t.*inspect-linux-update\.mjs\t--version\t1\.2\.3/mu);
      assert.equal(
        calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
        0,
        calls,
      );
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
    });
  }
});

test("integration tags must remain reachable from the durable fork product branch", async (t) => {
  await t.test("local source gate", async (subtest) => {
    const fixture = await createDeployFixture({ productBranchMissing: true });
    subtest.after(() => fixture.cleanup());
    const result = fixture.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await fixture.callsText();
    assert.match(calls, /refs\/remotes\/origin\/t4code\/main/mu);
    assert.doesNotMatch(calls, /^apt-get\t/mu);
    assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
    await assertRestored(fixture);
  });

  await t.test("public result gate", async (subtest) => {
    const fixture = await createRunnerFixture({ productBranchMissing: true });
    subtest.after(() => fixture.cleanup());
    const result = fixture.runRunner();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await fixture.callsText();
    assert.match(
      calls,
      /repos\/wolfiesch\/oh-my-pi\/compare\/b{40}\.\.\.t4code\/main/mu,
    );
    assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
    assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
  });
});

test("stale Tailnet deployment identity cannot finalize exact local state", async (t) => {
  const fixture = await createRunnerFixture({ staleTailnetIdentity: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true);
  assert.equal(await pathExists(fixture.localApplied), true);
  assert.equal(await pathExists(fixture.processed), false);
  const applied = JSON.parse(await readFile(fixture.localApplied, "utf8"));
  assert.match(applied.localDeployment.gateway.deploymentIdentity, /^sha256:[0-9a-f]{64}$/u);

  const second = fixture.runRunner({ MOCK_STALE_TAILNET_IDENTITY: "0" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
});

test("stale loopback deployment identity cannot validate the local receipt", async (t) => {
  const fixture = await createRunnerFixture({ staleLoopbackIdentity: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true);
  assert.equal(await pathExists(fixture.localApplied), true);
  assert.equal(await pathExists(fixture.processed), false);
  assert.match(first.stderr, /receipt did not independently match the live workstation/u);

  const second = fixture.runRunner({ MOCK_STALE_LOOPBACK_IDENTITY: "0" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
});

test("nonexistent child roots behind /tmp symlink parents fail closed before outside state", async (t) => {
  const fixture = await createRunnerFixture();
  const outsideRoot = await mkdtemp(join("/var/tmp", "t4-maintainer-outside-"));
  const tmpParent = join(tmpdir(), `t4-maintainer-root-link-${process.pid}-${Date.now()}`);
  await symlink(outsideRoot, tmpParent);
  t.after(async () => {
    await fixture.cleanup();
    await rm(tmpParent, { force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  const result = fixture.runRunner({
    T4_MAINTAINER_ROOT: join(tmpParent, "nonexistent-child"),
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /maintainer root must exist and be canonicalized/u);
  assert.equal((await readdir(outsideRoot)).length, 0);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^omp\t/mu);
  assert.doesNotMatch(calls, /^local-deploy\t/mu);
});

test("exact OMP CI and eight-asset release failures block local deployment", async (t) => {
  const cases = [
    ["missing CI", { ompWorkflowMissing: true }],
    ["failed CI", { ompWorkflowFailed: true }],
    ["wrong CI path", { ompWorkflowWrongPath: true }],
    ["missing asset", { ompAssetMissing: true }],
    ["extra asset", { ompAssetExtra: true }],
    ["zero asset", { ompAssetZero: true }],
    ["digestless asset", { ompAssetDigestless: true }],
    ["unreachable asset", { ompAssetUnreachable: true }],
    ["digest mismatch", { ompAssetDigestMismatch: true }],
    ["wrong asset origin", { ompAssetWrongOrigin: true }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
    });
  }
});

test("processed no-op rechecks public invariants without redownloading OMP binaries", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.processed), true);
  const callsBefore = await fixture.callsText();
  assert.match(callsBefore, /mock:\/\/omp-linux-x64/mu);

  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const delta = (await fixture.callsText()).slice(callsBefore.length);
  assert.match(delta, /mock:\/\/omp-linux-x64/mu);
  assert.doesNotMatch(delta, /curl\t[^\n]*mock:\/\/omp-[^\n]*\t-o\t/mu);

  const drift = fixture.runRunner({ MOCK_OMP_ASSET_MISSING: "1" });
  assert.notEqual(drift.status, 0, `${drift.stdout}\n${drift.stderr}`);
  const finalCalls = await fixture.callsText();
  assert.equal(finalCalls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 1);
  assert.equal(finalCalls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});
