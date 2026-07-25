// Fork-main mirroring: CI quiesce, push settlement, and recovery.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  createRunnerFixture,
  mainCommit,
  pathExists,
  upstreamCommit,
} from "./t4-maintainer-fixtures.mjs";

test("fork repository identity drift blocks every fork-main mutation", async (t) => {
  for (const option of [
    "ompOfficialIdMismatch",
    "ompOfficialCloneMismatch",
    "ompForkIdMismatch",
    "ompForkNodeMismatch",
    "ompForkParentMismatch",
    "ompForkCloneMismatch",
  ]) {
    await t.test(option, async (subtest) => {
      const fixture = await createRunnerFixture({
        forkMainBehind: true,
        localDeployFail: true,
        [option]: true,
      });
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /repository identity does not match/u);
      const calls = await fixture.callsText();
      assert.doesNotMatch(calls, /actions\/workflows\/ci\.yml\/(?:disable|enable)/u);
      assert.doesNotMatch(calls, /actions\/runs\/4242\/cancel/u);
      assert.equal(await pathExists(join(fixture.state, "fork-main-synced")), false);
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
    });
  }
});

test("wrapper fast-forwards fork main with CI quiesced before any Sol work", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRun: true,
    forkMainRunDelayPolls: 3,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const disable = calls.indexOf("actions/workflows/ci.yml/disable");
  const push = calls.indexOf("git\t-C", disable);
  const enable = calls.indexOf("actions/workflows/ci.yml/enable", push);
  const cancel = calls.indexOf("actions/runs/4242/cancel", enable);
  assert.ok(disable >= 0 && push > disable && enable > push && cancel > enable, calls);
  assert.ok(
    Number(await readFile(join(fixture.state, "fork-main-post-push-queries"), "utf8")) >= 7,
    calls,
  );
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("fork-main run settlement fails closed when the exact run cannot reach terminal state", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRun: true,
    forkMainRunCancelStuck: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /could not be restored and settled/u);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    true,
  );
  const calls = await fixture.callsText();
  assert.match(calls, /actions\/runs\/4242\/cancel/u);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("a cancellation response race is accepted only after the exact run is terminal", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRun: true,
    forkMainRunCancelRace: true,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /changed while cancellation was requested/u);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), true);
});

test("an older exact-SHA push rerun is outside the mirror transaction and remains untouched", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRun: true,
    forkMainRunPreexisting: true,
    localDeployFail: true,
  });

  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /actions\/runs\/4242\/cancel/u);
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), false);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
});

test("a human rerun attempt is never treated as the wrapper-created mirror run", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRun: true,
    forkMainRunAttempt: 2,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();

  assert.doesNotMatch(calls, /actions\/runs\/4242\/cancel/u);
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), false);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
});

test("malformed fork-main run state retains crash recovery and prevents Sol", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRunMalformed: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    true,
  );
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("wrapper retries a moving fork-main snapshot within its bounded window", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRaceOnce: true,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /moved while its exact snapshot was being proved/u);
  assert.equal(await pathExists(join(fixture.state, "fork-main-synced")), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.match(calls, /actions\/workflows\/ci\.yml\/disable/mu);
  assert.match(calls, /actions\/workflows\/ci\.yml\/enable/mu);
});

test("a mirror push accepted before a lost client response is settled and recovered", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainPushAcceptedFail: true,
    forkMainRun: true,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(join(fixture.state, "fork-main-synced")), true);
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), true);
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
});

test("fork-main divergence fails closed before Sol", async (t) => {
  const fixture = await createRunnerFixture({ forkMainDiverged: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /fork main has diverged/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
});

test("interrupted fork CI re-enable retains recovery state until active proof", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkWorkflowEnableFail: true,
    forkMainRun: true,
    forkMainRunDelayPolls: 1,
  });
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  const first = fixture.runRunner();
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(marker), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "disabled_manually");

  const second = fixture.runRunner({ MOCK_FORK_WORKFLOW_ENABLE_FAIL: "0", MOCK_LOCAL_DEPLOY_FAIL: "1" });
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /Recovered fork-main synchronization/u);
  assert.equal(await pathExists(marker), false);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), true);
});

test("prepared fork-main recovery restores CI without claiming a push was attempted", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  await writeFile(
    marker,
    `${JSON.stringify({
      schemaVersion: 2,
      startedAt: "2026-07-15T00:00:00Z",
      phase: "prepared",
      workflow: "ci.yml",
      officialCommit: mainCommit,
      previousForkCommit: upstreamCommit,
    })}\n`,
  );
  await writeFile(join(fixture.state, "fork-workflow"), "disabled_manually");
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(marker), false);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /actions\/runs\/4242\/cancel/u);
});

test("legacy fork-main recovery restores CI without touching a historic exact-SHA run", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainRun: true,
    forkMainRunPreexisting: true,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  await writeFile(
    marker,
    `${JSON.stringify({
      schemaVersion: 1,
      startedAt: "2026-07-15T00:00:00Z",
      workflow: "ci.yml",
      officialCommit: mainCommit,
      previousForkCommit: upstreamCommit,
    })}\n`,
  );
  await writeFile(join(fixture.state, "fork-workflow"), "disabled_manually");
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Recovered legacy fork-main synchronization state/u);
  assert.equal(await pathExists(marker), false);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /actions\/runs\/4242\/cancel/u);
  assert.equal(await pathExists(join(fixture.state, "fork-main-run-cancelled")), false);
});

test("invalid settlement timing restores disabled CI and retains push recovery state", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  await writeFile(
    marker,
    `${JSON.stringify({
      schemaVersion: 2,
      startedAt: "2026-07-15T00:00:00Z",
      phase: "push-attempted",
      workflow: "ci.yml",
      officialCommit: mainCommit,
      previousForkCommit: upstreamCommit,
      preexistingRunIds: [],
    })}\n`,
  );
  await writeFile(join(fixture.state, "fork-workflow"), "disabled_manually");
  const result = fixture.runRunner({
    T4_MAINTAINER_FORK_SYNC_EVENT_QUIESCE_SECONDS: "0",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(marker), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  const calls = await fixture.callsText();
  assert.match(calls, /actions\/workflows\/ci\.yml\/enable/u);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("invalid settlement timing is rejected before a fresh mirror disables CI", async (t) => {
  const fixture = await createRunnerFixture({ forkMainBehind: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner({
    T4_MAINTAINER_FORK_SYNC_RUN_MIN_OBSERVATION_POLLS: "99",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(join(fixture.state, "fork-workflow")), false);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /actions\/workflows\/ci\.yml\/disable/u);
});

test("a failed durable phase transition cannot reach the external mirror push", async (t) => {
  const fixture = await createRunnerFixture({ forkMainBehind: true });
  t.after(() => fixture.cleanup());
  const failingSync = join(fixture.root, "bin", "failing-sync");
  await writeFile(
    failingSync,
    `#!/usr/bin/env bash
set -euo pipefail
count_file="$MOCK_STATE/failing-sync-count"
count=0
[[ ! -f $count_file ]] || count=$(cat "$count_file")
count=$((count + 1))
printf '%s' "$count" >"$count_file"
[[ $count != 3 ]] || exit 1
exec /bin/sync "$@"
`,
  );
  await chmod(failingSync, 0o755);
  const result = fixture.runRunner({ T4_MAINTAINER_SYNC: failingSync });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  assert.equal(await pathExists(marker), true);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).phase, "prepared");
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "disabled_manually");
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /git\t-C.*\tpush/u);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("failed or invalid recovery marker generation cannot disable fork CI", async (t) => {
  for (const mode of ["fail", "malformed"]) {
    await t.test(mode, async (subtest) => {
      const fixture = await createRunnerFixture({ forkMainBehind: true });
      subtest.after(() => fixture.cleanup());
      const jq = join(fixture.root, "bin", `marker-jq-${mode}`);
      await writeFile(
        jq,
        `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ $argument == started_at ]]; then
    ${mode === "fail" ? "exit 1" : "printf '{}\\n'; exit 0"}
  fi
done
exec jq "$@"
`,
      );
      await chmod(jq, 0o755);
      const result = fixture.runRunner({ T4_MAINTAINER_JQ: jq });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.doesNotMatch(calls, /actions\/workflows\/ci\.yml\/disable/u);
      assert.doesNotMatch(calls, /git\t-C.*\tpush/u);
      assert.equal(
        await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
        false,
      );
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
    });
  }
});
