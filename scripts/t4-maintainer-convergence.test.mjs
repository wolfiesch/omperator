// Convergence: pending state, Sol handoff, deferral markers, and notification.
import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertRestored,
  changedT4MainCommit,
  createRunnerFixture,
  forgedOmpPublicProof,
  mainCommit,
  pathExists,
  t4Commit,
  writeSolDeferral,
} from "./t4-maintainer-fixtures.mjs";

test("repeated pending retries retain state and never invoke Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  await fixture.seedPending();
  const pendingBefore = await readFile(fixture.pending);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = fixture.runRunner();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(await readFile(fixture.pending), pendingBefore);
    assert.equal(await pathExists(fixture.processed), false);
  }

  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    2,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("Tailnet-only convergence retains local apply and never redeploys or invokes Sol", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  await writeFile(join(fixture.state, "tailnet-health"), "unhealthy");

  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.localApplied), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const pendingAfterFirst = await readFile(fixture.pending);
  const appliedAfterFirst = await readFile(fixture.localApplied);
  assert.equal(
    JSON.parse(appliedAfterFirst).localDeployment.gateway.tailnetHealth,
    "pending",
  );

  const callsAfterFirst = await fixture.callsText();
  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(await readFile(fixture.pending), pendingAfterFirst);
  assert.deepEqual(await readFile(fixture.localApplied), appliedAfterFirst);
  assert.equal(await pathExists(fixture.processed), false);

  const callsAfterSecond = await fixture.callsText();
  assert.ok(callsAfterSecond.length > callsAfterFirst.length);
  await writeFile(join(fixture.state, "tailnet-health"), "healthy");
  const third = fixture.runRunner();
  assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
  const processed = JSON.parse(await readFile(fixture.processed, "utf8"));
  assert.equal(processed.localDeployment.gateway.tailnetHealth, "healthy");

  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  const thirdRunCalls = calls.slice(callsAfterSecond.length);
  const upstreamResolution = thirdRunCalls.indexOf(
    "gh\tapi\trepos/can1357/oh-my-pi/commits/v1.2.3",
  );
  const tailnetProof = thirdRunCalls.indexOf("https://mock.tailnet.ts.net/healthz");
  assert.ok(upstreamResolution >= 0, thirdRunCalls);
  assert.ok(tailnetProof > upstreamResolution, thirdRunCalls);
});

test("receipt-bound local drift redeploys the exact pending publication without Sol", async (t) => {
  const driftTargets = [
    ["OMP executable", (fixture) => fixture.ompTarget],
    ["gateway script", (fixture) => join(fixture.runtimeRoot, "scripts", "tailnet-gateway.mjs")],
    ["web tree", (fixture) => join(fixture.runtimeRoot, "apps", "web", "dist", "index.html")],
    ["ws tree", (fixture) => join(fixture.runtimeRoot, "node_modules", "ws", "package.json")],
    ["gateway config", (fixture) => fixture.gatewayConfig],
    ["gateway unit", (fixture) => fixture.gatewayUnit],
  ];

  for (const [name, resolveTarget] of driftTargets) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture();
      subtest.after(() => fixture.cleanup());
      await writeFile(join(fixture.state, "tailnet-health"), "unhealthy");
      const first = fixture.runRunner();
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(await pathExists(fixture.localApplied), true, await fixture.callsText());

      await appendFile(resolveTarget(fixture), "drift\n");
      const second = fixture.runRunner();
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.equal(await pathExists(fixture.pending), true);
      assert.equal(await pathExists(fixture.localApplied), true);
      assert.equal(await pathExists(fixture.processed), false);
      const calls = await fixture.callsText();
      assert.equal(
        calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
        2,
        calls,
      );
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
    });
  }
});

test("normal recovery adopts a compatible in-flight main publication before Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("sequential publication gate race defers before Sol and preserves local state", async (t) => {
  const fixture = await createRunnerFixture({ prSequential: true, workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({ T4_MAINTAINER_TEST_PUBLICATION_GATE: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
  assert.equal((await readFile(join(fixture.state, "t4-pr-queries"), "utf8")).trim(), "2");
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.pending), false);
  await assertRestored(fixture);
});

test("a changed T4 main identity defers on the second gate without a stale Sol context", async (t) => {
  const fixture = await createRunnerFixture({
    t4MainCommitChangeAfter: 4,
    workflowsTerminal: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({ T4_MAINTAINER_TEST_PUBLICATION_GATE: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal((await readFile(join(fixture.state, "t4-main-queries"), "utf8")).trim(), "5");
  const runEntries = await readdir(join(fixture.maintainerRoot, "runs"));
  for (const entry of runEntries) {
    assert.equal(await pathExists(join(fixture.maintainerRoot, "runs", entry, "context.json")), false);
  }
});

test("a corroborated post-Sol main change records collaborator defer without publication state", async (t) => {
  const fixture = await createRunnerFixture({
    publicIncompatible: true,
    t4MainCommitChangeAfter: 6,
  });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "t4-main-changed",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: changedT4MainCommit,
    prNumber: null,
  });
  const notifier = join(fixture.root, "successful-deferral-notifier");
  const secret = join(fixture.root, "hermes-secret");
  const notificationPayload = join(fixture.root, "notification-payload.json");
  await writeFile(notifier, `#!/usr/bin/env bash\ncat >"${notificationPayload}"\n`);
  await chmod(notifier, 0o700);
  await writeFile(secret, "test-secret\n", { mode: 0o600 });
  const historicalProcessed = `${JSON.stringify({
    upstream: { tag: "v0.9.0", commit: "9".repeat(40) },
    t4: { version: "0.9.0", tag: "v0.9.0", commit: "8".repeat(40) },
    publicVerification: "complete",
    sentinel: "preserve-independent-history",
  })}\n`;
  await writeFile(fixture.processed, historicalProcessed, { mode: 0o600 });
  t.after(() => fixture.cleanup());

  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_DEFERRAL_SOURCE: marker,
    T4_MAINTAINER_NOTIFY_HELPER: notifier,
    T4_MAINTAINER_HERMES_SECRET_FILE: secret,
  });
  const mainQueryCount = (await readFile(join(fixture.state, "t4-main-queries"), "utf8")).trim();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nmain queries: ${mainQueryCount}`);
  assert.match(result.stdout, /Valid collaborator deferral marker accepted \(t4-main-changed\)/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("setpriv\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
  const runEntry = (await readdir(join(fixture.maintainerRoot, "runs"))).find((entry) =>
    entry.startsWith("1.2.3-"),
  );
  assert.ok(runEntry);
  const runDirectory = join(fixture.maintainerRoot, "runs", runEntry);
  const contextPath = join(runDirectory, "context.json");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  assert.equal(context.deferralFile, join(runDirectory, "deferral.json"));
  assert.equal(context.resultFile, join(runDirectory, "result.json"));
  const deferralStat = await lstat(context.deferralFile);
  assert.equal(deferralStat.isFile(), true);
  assert.equal(deferralStat.isSymbolicLink(), false);
  assert.equal(deferralStat.mode & 0o777, 0o600);
  assert.ok(
    calls.split("\n").includes(`sol-env\t${contextPath}\t${context.resultFile}\t${context.deferralFile}`),
    calls,
  );
  assert.equal(await pathExists(notificationPayload), true);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await readFile(fixture.processed, "utf8"), historicalProcessed);
  assert.equal(await pathExists(fixture.localApplied), false);
  const notificationState = JSON.parse(
    await readFile(join(fixture.maintainerRoot, "state", "notification-state.json"), "utf8"),
  );
  assert.equal(notificationState.blockers["t4-main-race"], true);
});

test("post-Sol PR and classification deferrals require live corroboration", async (t) => {
  const cases = [
    {
      name: "release-critical PR",
      options: { publicIncompatible: true, prChangeAfter: 2 },
      marker: {
        schemaVersion: 1,
        reason: "release-critical-pr",
        expectedT4MainSha: t4Commit,
        observedT4MainSha: t4Commit,
        prNumber: 42,
      },
      blockerKey: "t4-pr-42",
    },
    {
      name: "classification incomplete",
      options: { publicIncompatible: true, prFailAfter: 2 },
      marker: {
        schemaVersion: 1,
        reason: "classification-incomplete",
        expectedT4MainSha: t4Commit,
        observedT4MainSha: t4Commit,
        prNumber: null,
      },
      blockerKey: `t4-classification-${t4Commit}`,
    },
  ];
  for (const { name, options, marker: markerBody, blockerKey } of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture(options);
      const marker = await writeSolDeferral(fixture, markerBody);
      const notifier = join(fixture.root, "successful-deferral-notifier");
      const secret = join(fixture.root, "hermes-secret");
      await writeFile(notifier, "#!/usr/bin/env bash\ncat >/dev/null\n");
      await chmod(notifier, 0o700);
      await writeFile(secret, "test-secret\n", { mode: 0o600 });
      subtest.after(() => fixture.cleanup());

      const result = fixture.runRunner({
        T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
        MOCK_SOL_STATUS: "0",
        MOCK_SOL_DEFERRAL_SOURCE: marker,
        T4_MAINTAINER_NOTIFY_HELPER: notifier,
        T4_MAINTAINER_HERMES_SECRET_FILE: secret,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Valid collaborator deferral marker accepted \\(${markerBody.reason}\\)`, "u"));
      assert.equal(await pathExists(fixture.pending), false);
      assert.equal(await pathExists(fixture.processed), false);
      assert.equal(await pathExists(fixture.localApplied), false);
      const notificationState = JSON.parse(
        await readFile(join(fixture.maintainerRoot, "state", "notification-state.json"), "utf8"),
      );
      assert.equal(notificationState.blockers[blockerKey], true);
    });
  }
});

test("malformed and uncorroborated post-Sol deferral markers fail closed", async (t) => {
  const cases = [
    ["malformed", { schemaVersion: 1 }],
    [
      "extra field",
      {
        schemaVersion: 1,
        reason: "classification-incomplete",
        expectedT4MainSha: t4Commit,
        observedT4MainSha: t4Commit,
        prNumber: null,
        unexpected: true,
      },
    ],
    [
      "uppercase identity",
      {
        schemaVersion: 1,
        reason: "classification-incomplete",
        expectedT4MainSha: t4Commit.toUpperCase(),
        observedT4MainSha: t4Commit,
        prNumber: null,
      },
    ],
    [
      "out-of-range PR number",
      {
        schemaVersion: 1,
        reason: "release-critical-pr",
        expectedT4MainSha: t4Commit,
        observedT4MainSha: t4Commit,
        prNumber: 1_000_001,
      },
    ],
    [
      "reason-field mismatch",
      {
        schemaVersion: 1,
        reason: "release-critical-pr",
        expectedT4MainSha: t4Commit,
        observedT4MainSha: t4Commit,
        prNumber: null,
      },
    ],
    [
      "uncorroborated",
      {
        schemaVersion: 1,
        reason: "t4-main-changed",
        expectedT4MainSha: mainCommit,
        observedT4MainSha: changedT4MainCommit,
        prNumber: null,
      },
    ],
  ];
  for (const [name, markerBody] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture({ publicIncompatible: true });
      const marker = await writeSolDeferral(fixture, markerBody);
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner({
        T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
        MOCK_SOL_STATUS: "0",
        MOCK_SOL_DEFERRAL_SOURCE: marker,
      });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /invalid or uncorroborated deferral marker/u);
      const calls = await fixture.callsText();
      assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
      assert.equal(await pathExists(fixture.pending), false);
      assert.equal(await pathExists(fixture.processed), false);
      assert.equal(await pathExists(fixture.localApplied), false);
    });
  }
});

test("a symlinked post-Sol deferral marker fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true, prFailAfter: 2 });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "classification-incomplete",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: t4Commit,
    prNumber: null,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_DEFERRAL_SYMLINK_SOURCE: marker,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /invalid or uncorroborated deferral marker/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a permissive post-Sol deferral marker mode fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true, prFailAfter: 2 });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "classification-incomplete",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: t4Commit,
    prNumber: null,
  });
  await chmod(marker, 0o644);
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_DEFERRAL_SOURCE: marker,
    MOCK_SOL_DEFERRAL_MODE: "0644",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /invalid or uncorroborated deferral marker/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a deferral marker cannot convert a failed Sol child into a retry success", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true, prFailAfter: 2 });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "classification-incomplete",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: t4Commit,
    prNumber: null,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "7",
    MOCK_SOL_DEFERRAL_SOURCE: marker,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Sol maintainer exited with status 7/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a successful Sol child without a result or deferral marker fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /without a verified result or valid deferral marker/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a simultaneous Sol result and deferral marker fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "classification-incomplete",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: t4Commit,
    prNumber: null,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_RESULT_SOURCE: fixture.result,
    MOCK_SOL_DEFERRAL_SOURCE: marker,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /both a result and a deferral marker/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a dangling deferral symlink plus a result is contradictory and fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  const missingMarkerTarget = join(fixture.root, "missing-deferral-target");
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_RESULT_SOURCE: fixture.result,
    MOCK_SOL_DEFERRAL_SYMLINK_SOURCE: missingMarkerTarget,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /both a result and a deferral marker/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("a dangling result symlink plus a deferral marker is contradictory and fails closed", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true, prFailAfter: 2 });
  const marker = await writeSolDeferral(fixture, {
    schemaVersion: 1,
    reason: "classification-incomplete",
    expectedT4MainSha: t4Commit,
    observedT4MainSha: t4Commit,
    prNumber: null,
  });
  const missingResultTarget = join(fixture.root, "missing-result-target");
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    MOCK_SOL_STATUS: "0",
    MOCK_SOL_RESULT_SYMLINK_SOURCE: missingResultTarget,
    MOCK_SOL_DEFERRAL_SOURCE: marker,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /both a result and a deferral marker/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  assert.equal(await pathExists(fixture.localApplied), false);
});

test("test mode cannot escape the canonical root through the Sol privilege runner", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_SETPRIV: "/usr/bin/setpriv",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /privilege runner/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("setpriv\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
});

test("test mode cannot bypass publication gates from a production root", async (t) => {
  const fixture = await createRunnerFixture({
    prSequential: true,
    workflowsTerminal: true,
    useHostPrivilegeTools: true,
  });
  const productionTemporaryRoot = await realpath("/var/tmp");
  const productionRoot = await realpath(
    await mkdtemp(join(productionTemporaryRoot, "t4-maintainer-production-")),
  );
  t.after(async () => {
    await fixture.cleanup();
    await rm(productionRoot, { recursive: true, force: true });
  });
  const result = fixture.runRunner({
    T4_MAINTAINER_ROOT: productionRoot,
    T4_MAINTAINER_TEST_PROC_ROOT: "/proc",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(
    calls.split("\n").filter((line) => line.includes("gh\tapi\trepos/wolfiesch/omperator/pulls\\?state")).length,
    2,
    calls,
  );
});

test("notification failure cannot alter defer, deployment, or failure semantics", async (t) => {
  const cases = [
    ["collaborator defer", { prSequential: true, workflowsTerminal: true }, 0, false],
    ["local deployment defer", {}, 0, true],
    ["main failure", { publicIncompatible: true }, 1, false],
  ];
  for (const [name, options, expectedStatus, localDefer] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture(options);
      subtest.after(() => fixture.cleanup());
      if (localDefer) await writeFile(join(fixture.state, "tailnet-health"), "unhealthy");
      const result = fixture.runRunner({
        T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
        T4_MAINTAINER_NOTIFY_HELPER: join(fixture.root, "missing-notifier"),
        T4_MAINTAINER_HERMES_SECRET_FILE: join(fixture.root, "missing-secret"),
      });
      assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
      const notificationState = join(fixture.state, "notification-state.json");
      const calls = await fixture.callsText();
      if (name === "collaborator defer") {
        assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
        assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
        assert.equal(
          await pathExists(notificationState),
          false,
          "failed collaborator notification must not persist blocker dedupe",
        );
      }
      if (name === "local deployment defer") {
        assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 1, calls);
      }
    });
  }
});

test("successful blocker delivery warns when durable dedupe persistence fails", async (t) => {
  const fixture = await createRunnerFixture({ prSequential: true, workflowsTerminal: true });
  const notifier = join(fixture.root, "successful-notifier");
  const notifyMarker = join(fixture.root, "notify-delivered");
  const secret = join(fixture.root, "hermes-secret");
  const failingSync = join(fixture.root, "notification-failing-sync");
  const syncMarker = join(fixture.root, "notification-sync-temp-seen");
  await writeFile(notifier, `#!/usr/bin/env bash
cat >/dev/null
: >"${notifyMarker}"
exit 0
`);
  await chmod(notifier, 0o700);
  await writeFile(secret, "test-secret\n", { mode: 0o600 });
  await writeFile(
    failingSync,
    `#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    *notification-state.json.*)
      : >"${syncMarker}"
      exec /bin/sync "$@"
      ;;
    ${fixture.state})
      [[ -e ${syncMarker} ]] && exit 1
      ;;
  esac
done
exec /bin/sync "$@"
`,
  );
  await chmod(failingSync, 0o700);
  await writeFile(
    join(fixture.state, "notification-state.json"),
    '{"schemaVersion":1,"blockers":{"existing-blocker":true}}\n',
  );
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    T4_MAINTAINER_NOTIFY_HELPER: notifier,
    T4_MAINTAINER_HERMES_SECRET_FILE: secret,
    T4_MAINTAINER_SYNC: failingSync,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(notifyMarker), true);
  assert.equal(await pathExists(syncMarker), true);
  const notificationState = JSON.parse(await readFile(join(fixture.state, "notification-state.json"), "utf8"));
  assert.equal(notificationState.blockers["existing-blocker"], true);
});

test("existing blocker dedupe survives a pre-mv persistence failure", async (t) => {
  const fixture = await createRunnerFixture({ prSequential: true, workflowsTerminal: true });
  const notifier = join(fixture.root, "successful-notifier");
  const secret = join(fixture.root, "hermes-secret");
  const failingSync = join(fixture.root, "notification-failing-sync");
  await writeFile(notifier, "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n");
  await chmod(notifier, 0o700);
  await writeFile(secret, "test-secret\n", { mode: 0o600 });
  await writeFile(
    failingSync,
    `#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    *notification-state.json.*) exit 1 ;;
  esac
done
exec /bin/sync "$@"
`,
  );
  await chmod(failingSync, 0o700);
  const notificationStatePath = join(fixture.state, "notification-state.json");
  await writeFile(notificationStatePath, '{"schemaVersion":1,"blockers":{"existing-blocker":true}}\n');
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_TEST_PUBLICATION_GATE: "1",
    T4_MAINTAINER_NOTIFY_HELPER: notifier,
    T4_MAINTAINER_HERMES_SECRET_FILE: secret,
    T4_MAINTAINER_SYNC: failingSync,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const notificationState = JSON.parse(await readFile(notificationStatePath, "utf8"));
  assert.equal(notificationState.blockers["existing-blocker"], true);
  assert.equal(notificationState.blockers["t4-pr-42"], undefined);
});

test("normal recovery adopts the compatible latest public release before Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true, mainIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.match(calls, /gh\tapi\trepos\/wolfiesch\/omperator\/releases\/latest/mu);
  assert.match(
    calls,
    /contents\/compat\/omp-app-matrix\.json\\\?ref=v1\.2\.3/mu,
  );
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("terminal compatible publication resumes through Sol instead of waiting forever", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ready for completion through the positive Sol release workflow/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.doesNotMatch(
    calls,
    /gh\tapi\trepos\/wolfiesch\/omperator\/releases\/latest/mu,
    "an older public release cannot supersede compatible main work that is ready to resume",
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.match(
    calls.replaceAll("\\ ", " "),
    /Continue and complete the compatible T4 publication/u,
  );
});

test("a fresh Sol result cannot forge the wrapper-owned OMP asset proof", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const forgedResult = join(fixture.root, "forged-sol-result.json");
  const publication = JSON.parse(await readFile(fixture.result, "utf8"));
  publication.publicProof = { ompRelease: forgedOmpPublicProof() };
  await writeFile(forgedResult, `${JSON.stringify(publication)}\n`);

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: forgedResult,
    MOCK_SOL_STATUS: "0",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.match(
    calls,
    /curl\t[^\n]*mock:\/\/omp-linux-x64\t-o\t/mu,
    "an untrusted prepopulated proof must still trigger the initial full download",
  );
});

test("fresh verification downloads OMP assets once across later convergence retries", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const solResult = join(fixture.root, "sol-result.json");
  await writeFile(solResult, await readFile(fixture.result));

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: solResult,
    MOCK_SOL_STATUS: "0",
    MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL: "1",
    T4_MAINTAINER_VERIFY_ATTEMPTS: "2",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("setpriv\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 1, calls);
  const downloads = calls
    .split("\n")
    .filter(
      (line) => line.startsWith("curl\t") && line.includes("mock://omp-") && line.includes("\t-o\t"),
    );
  assert.equal(downloads.length, 5, downloads.join("\n"));
});

test("active compatible publication waits without launching duplicate Sol work", async (t) => {
  const fixture = await createRunnerFixture({ workflowsActive: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /workflows are active or recently successful/u);
  assert.equal(await pathExists(fixture.pending), false);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("same-named noncanonical T4 workflows cannot satisfy publication", async (t) => {
  const fixture = await createRunnerFixture({ t4WorkflowWrongPath: true });
  t.after(() => fixture.cleanup());
  const solResult = join(fixture.root, "sol-result.json");
  await writeFile(solResult, await readFile(fixture.result));

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: solResult,
    MOCK_SOL_STATUS: "0",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
});

test("an incompatible public matrix falls through nonfatally to Sol", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
});

test("background work from Sol cannot inherit and strand the maintainer lock", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner({ MOCK_SOL_BACKGROUND_HOLDER: "1" });
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const backgroundPid = Number(await readFile(join(fixture.state, "sol-background-pid"), "utf8"));
  t.after(() => {
    try {
      process.kill(backgroundPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  });

  const second = fixture.runRunner();
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.doesNotMatch(second.stdout, /maintainer run is already active/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 2, calls);
});

test("Sol receives the exact no-new-privileges maintainer execution argv", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const setprivCall = calls.split("\n").find((line) => line.startsWith("setpriv\t"));
  const ompCall = calls.split("\n").find((line) => line.startsWith("omp\t"));
  assert.ok(setprivCall, calls);
  assert.ok(ompCall, calls);
  assert.match(setprivCall, /^setpriv\t--no-new-privs\t--\t.*\/omp(?:\t|$)/u);
  assert.match(
    ompCall.replaceAll("\\ ", " "),
    /omp\t--profile\tt4-maintainer\t--cwd\t[^\t]+\t--model\topenai-codex\/gpt-5\.6-sol\t--thinking\tmax\t--print\t--mode\tjson\t--approval-mode\tyolo\t/u,
  );
  assert.doesNotMatch(ompCall, /--no-tools|--tools=|--no-pty|bwrap/u);
});

test("Darwin invokes the Sol child directly without the Linux privilege runner", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true, platform: "Darwin" });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("setpriv\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
});

test("default maintenance adopts a newer compatible T4 pair for the same OMP release", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  const processed = JSON.parse(await readFile(fixture.processed, "utf8"));
  processed.t4.version = "1.2.2";
  processed.t4.tag = "v1.2.2";
  processed.release.url = "https://github.com/wolfiesch/omperator/releases/tag/v1.2.2";
  processed.site.releaseTag = "v1.2.2";
  processed.localDeployment.t4.version = "1.2.2";
  processed.localDeployment.t4.tag = "v1.2.2";
  processed.localDeployment.desktop.installedVersion = "1.2.2";
  await writeFile(fixture.processed, `${JSON.stringify(processed)}\n`);
  await writeFile(join(fixture.state, "package-version"), "1.2.2");

  const callsBefore = await fixture.callsText();
  const second = fixture.runRunner({ MOCK_LOCAL_DEPLOY_FAIL: "1" });
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(
    second.stdout,
    /newer compatible publication candidate than processed v1\.2\.2/u,
  );
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  const pending = JSON.parse(await readFile(fixture.pending, "utf8"));
  assert.equal(pending.publication.upstream.tag, "v1.2.3");
  assert.equal(pending.publication.integration.tag, "t4code-1.2.3-appserver-1");
  assert.equal(pending.publication.t4.tag, "v1.2.3");

  const delta = (await fixture.callsText()).slice(callsBefore.length);
  assert.equal(
    delta.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    delta,
  );
  assert.equal(delta.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, delta);
});

test("active but durably disabled gateway is repaired from processed state without Sol", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  await writeFile(join(fixture.state, "gateway-service"), "active");
  await writeFile(join(fixture.state, "gateway-enablement"), "disabled");
  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 2, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(await readFile(join(fixture.state, "gateway-enablement"), "utf8"), "enabled");
});
