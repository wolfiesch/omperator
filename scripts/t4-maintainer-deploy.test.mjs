// Local deployment: preflight, atomic drain, cutover faults, and rollback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  assertRestored,
  bashPath,
  createDeployFixture,
  createRunnerFixture,
  deployScript,
  mockDispatcher,
  mockLocalDeploy,
  pathExists,
  t4Commit,
} from "./t4-maintainer-fixtures.mjs";

test("busy preflight performs no mutation or artifact staging", async (t) => {
  for (const [name, options] of [
    ["desktop", { desktopBusy: true }],
    ["gateway session", { activeSessions: 2 }],
    ["appserver child", { childBusy: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(fixture.deployments), false);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("missing noninteractive sudo authority rejects before staging", async (t) => {
  const fixture = await createDeployFixture({ noSudo: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /^sudo\t-n\ttrue$/mu);
  assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(fixture.deployments), false);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("expired sudo authority rejects at the second guard before transaction mutation", async (t) => {
  const fixture = await createDeployFixture({ sudoExpires: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line === "sudo\t-n\ttrue").length, 2, calls);
  assert.match(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("missing or generic atomic-drain help rejects before staging", async (t) => {
  for (const [name, options] of [
    ["nonzero unsupported command", { drainCapabilityMissing: true }],
    ["exit-zero generic appserver help", { drainGenericHelp: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(calls, /^omp-target\tappserver\tdrain-if-idle\t--help$/mu);
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("atomic-drain sentinel probe requires exit 75 and the running identity", async (t) => {
  for (const [name, options] of [
    ["wrong exit status", { drainProbeWrongStatus: true }],
    ["wrong returned identity", { drainProbeWrongIdentity: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(
        calls,
        /^omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tt4-maintainer-capability-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-capability-epoch-[0-9a-f]{64}$/mu,
      );
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("atomic drain protects the appserver identity window before stop", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const drain = calls.indexOf(
    "omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\told-host\t--expected-epoch\told-epoch",
  );
  const stop = calls.indexOf("systemctl\t--user\tstop\tmock-omp.service");
  assert.ok(drain >= 0, calls);
  assert.ok(stop > drain, calls);
});

test("installed candidate proves its drain contract against the exact live executable", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(
    calls,
    /^omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tt4-maintainer-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-epoch-[0-9a-f]{64}$/mu,
  );
  const expectedProcRoot = process.platform === "linux" ? "/proc" : fixture.procRoot;
  const executableHashPrefix = `sha256sum\t${expectedProcRoot}/`;
  const executableHashes = calls.split("\n").filter((line) => {
    if (!line.startsWith(executableHashPrefix) || !line.endsWith("/exe")) return false;
    return /^[1-9][0-9]*$/u.test(line.slice(executableHashPrefix.length, -"/exe".length));
  });
  assert.ok(executableHashes.length >= 2, calls);
});

test("malformed, unsupported, and false live drain proofs never complete deployment", async (t) => {
  for (const [name, options, preservesNewState] of [
    ["unsupported", { newAppDrainUnsupported: true }, true],
    ["malformed", { newAppDrainMalformed: true }, false],
    ["wrong status", { newAppDrainWrongStatus: true }, false],
    ["wrong identity", { newAppDrainWrongIdentity: true }, false],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(await pathExists(fixture.receipt), false);
      const calls = await fixture.callsText();
      assert.match(calls, /^omp-candidate\tappserver\tdrain-if-idle\t--json/mu);
      assert.match(
        calls,
        /^omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tmock-host\t--expected-epoch\tmock-epoch$/mu,
      );
      if (preservesNewState) {
        const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
        assert.equal(await pathExists(marker), true);
        assert.equal(JSON.parse(await readFile(marker, "utf8")).status, "rollback-blocked-active-work");
        assert.notDeepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
        assert.equal((await readFile(join(fixture.state, "app-service"), "utf8")).trim(), "active");
        assert.equal(
          (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
          "disabled",
        );
      } else {
        await assertRestored(fixture);
      }
    });
  }
});

test("a failed appserver start that became active is drained before rollback", async (t) => {
  const fixture = await createDeployFixture({ appStartFailsActive: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const start = calls.indexOf("systemctl\t--user\tstart\tmock-omp.service");
  const drain = calls.indexOf(
    "omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tmock-host\t--expected-epoch\tmock-epoch",
  );
  assert.ok(start >= 0 && drain > start, calls);
  await assertRestored(fixture);
});

test("gateway installation stays dark until the final exposure step", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const callLines = calls.split("\n");
  const installLine = callLines
    .findIndex((line) => line.startsWith("node\t") && line.includes("\tinstall\t--defer-start"));
  const startLine = callLines
    .findIndex((line) => line.startsWith("node\t") && line.endsWith("\tstart"));
  assert.ok(installLine >= 0, calls);
  assert.ok(startLine > installLine, calls);
  assert.match(calls, /\t--deployment-identity\tsha256:[0-9a-f]{64}(?:\t|\n)/u);
});

test("busy or identity-changed atomic drain rolls back before package mutation", async (t) => {
  for (const [name, options] of [
    ["busy", { drainBusy: true }],
    ["identity mismatch", { drainIdentityMismatch: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(
        calls,
        /^omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\told-host\t--expected-epoch\told-epoch$/mu,
      );
      assert.match(calls, /^git\t.*clone/mu);
      assert.equal(
        calls
          .split("\n")
          .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"))
          .length,
        0,
        calls,
      );
      if (name === "busy") {
        assert.doesNotMatch(calls, /^systemctl\t--user\tstop\tmock-omp\.service$/mu);
      } else {
        assert.match(calls, /^systemctl\t--user\tstop\tmock-omp\.service$/mu);
        assert.match(calls, /^systemctl\t--user\trestart\tmock-omp\.service$/mu);
      }
      await assertRestored(fixture);
    });
  }
});

test("stopped or unhealthy baseline services are repairable", async (t) => {
  for (const [name, options] of [
    [
      "disabled/stopped gateway and stopped appserver",
      { gatewayActive: false, gatewayEnabled: false, appActive: false },
    ],
    ["unhealthy active gateway", { gatewayHealthy: false }],
    ["active appserver with MainPID zero", { mainPidZero: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(await pathExists(fixture.receipt), true);
      assert.equal(
        await pathExists(join(fixture.maintainerRoot, "state", "deployment-blocked.json")),
        false,
      );
      const receipt = JSON.parse(await readFile(fixture.receipt, "utf8"));
      assert.equal(receipt.status, "complete");
      assert.equal(receipt.gateway.runtimeCommit, t4Commit);
      assert.match(receipt.gateway.deploymentIdentity, /^sha256:[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.gatewayScriptSha256, /^[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.webTreeSha256, /^[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.wsTreeSha256, /^[0-9a-f]{64}$/u);
      assert.equal(receipt.gateway.tailnetHealth, "pending");
      assert.equal((await readFile(join(fixture.state, "package-version"), "utf8")).trim(), "1.2.3");
      assert.equal(
        (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
        "enabled",
      );
      assert.match(await fixture.callsText(), /^apt-get\t.*--reinstall/mu);
    });
  }
});

test("local deployment preserves named Tailnet routes and their start policy", async (t) => {
  const profileRoutes = [
    {
      id: "fast",
      appSocket: "/run/user/1000/omp/fast.sock",
      serviceUnit: "t4-fast.service",
      startEnabled: true,
    },
  ];
  const fixture = await createDeployFixture({ profileRoutes, startProfiles: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const installedConfig = JSON.parse(await readFile(fixture.gatewayConfig, "utf8"));
  assert.deepEqual(installedConfig.profileRoutes, profileRoutes);
  assert.equal(installedConfig.startProfiles, true);
});

test("same-version package repair is an effective reinstall", async (t) => {
  const fixture = await createDeployFixture({ sameVersion: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const aptCalls = (await fixture.callsText())
    .split("\n")
    .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"));
  assert.equal(aptCalls.length, 1);
  assert.match(aptCalls[0], /--reinstall/u);
  assert.match(aptCalls[0], /Omperator-1\.2\.3-linux-amd64\.deb/u);
});

test("same-version repair accepts the explicit local-unreleased-candidate manifest kind", async (t) => {
  const fixture = await createDeployFixture({
    sameVersion: true,
    manifestKind: "local-unreleased-candidate",
  });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const aptCalls = (await fixture.callsText())
    .split("\n")
    .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"));
  assert.equal(aptCalls.length, 1);
  assert.match(aptCalls[0], /--reinstall/u);
});

test("same-version deployment rejects a missing or mismatched current overlay receipt", async (t) => {
  for (const [name, options, mutate] of [
    ["missing", { sameVersion: true, overlayReceipt: "missing" }, undefined],
    ["unexpected manifest kind", { sameVersion: true, manifestKind: "not-a-maintainer-deployment" }, undefined],
    ["mismatched", { sameVersion: true }, async (fixture) => {
      const receipt = JSON.parse(await readFile(fixture.overlayReceipt, "utf8"));
      receipt.artifact.gateway.deploymentIdentity = `sha256:${"f".repeat(64)}`;
      await writeFile(fixture.overlayReceipt, `${JSON.stringify(receipt)}\n`);
    }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      if (mutate) await mutate(fixture);
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.doesNotMatch(calls, /^apt-get\t.*--reinstall(?!.*--simulate)/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
    });
  }
});

test("same-version rollback uses the sealed overlay when its original changes", async (t) => {
  const fixture = await createDeployFixture({ sameVersion: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run({
    T4_MAINTAINER_TEST_FAULT: "after-desktop-install",
    MOCK_MUTATE_OVERLAY_AFTER_APT: "1",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(await fixture.callsText(), /^apt-get\t.*operator-overlays.*\.deb/mu);
  assert.equal(await pathExists(join(fixture.maintainerRoot, "state", "deployment-blocked.json")), false);
});

test("same-version rollback rejects a tampered sealed overlay", async (t) => {
  const fixture = await createDeployFixture({ sameVersion: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run({
    T4_MAINTAINER_TEST_FAULT: "after-desktop-install",
    MOCK_TAMPER_SEALED_AFTER_APT: "1",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  assert.equal(await pathExists(marker), true, `${result.stdout}\n${result.stderr}\n${await fixture.callsText()}`);
  assert.ok(["rollback-incomplete", "rollback-drained-after-exposure"].includes(JSON.parse(await readFile(marker, "utf8")).status));
  const aptCalls = (await fixture.callsText())
    .split("\n")
    .filter((line) => line.startsWith("apt-get\t") && line.includes("operator-overlays") && !line.includes("--simulate"));
  assert.equal(aptCalls.length, 0, await fixture.callsText());
});

test("the second idle guard catches a session opened during preparation", async (t) => {
  const fixture = await createDeployFixture({ busyAfterStage: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("every named cutover fault verifies rollback and clears the transaction", async (t) => {
  const checkpoints = [
    "after-transaction-marker",
    "after-gateway-stop",
    "after-appserver-stop",
    "after-omp-install",
    "after-appserver-start",
    "before-desktop-install",
    "after-desktop-install",
    "after-gateway-install",
    "before-gateway-exposure",
    "after-gateway-start",
    "after-loopback-health",
    "before-receipt",
    "after-receipt-write",
  ];
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async (subtest) => {
      const fixture = await createDeployFixture(
        checkpoint === "after-gateway-install"
          ? { appActive: false, gatewayActive: false, gatewayEnabled: false }
          : {},
      );
      subtest.after(() => fixture.cleanup());
      const pending = join(fixture.maintainerRoot, "state", "pending.json");
      await mkdir(dirname(pending), { recursive: true });
      await writeFile(pending, "pending-must-survive\n");
      const result = fixture.run({ T4_MAINTAINER_TEST_FAULT: checkpoint });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      await assertRestored(fixture);
      assert.equal(await readFile(pending, "utf8"), "pending-must-survive\n");
      const calls = (await fixture.callsText()).split("\n").filter(Boolean);
      const aptCalls = calls.filter(
        (line) => line.startsWith("apt-get\t") && !line.includes("--simulate"),
      );
      for (const call of aptCalls) assert.match(call, /--reinstall/u);
      if ([
        "after-desktop-install",
        "after-gateway-install",
        "before-gateway-exposure",
        "after-gateway-start",
        "after-loopback-health",
        "before-receipt",
        "after-receipt-write",
      ].includes(checkpoint)) {
        assert.equal(aptCalls.length, 2, `target and rollback apt calls missing at ${checkpoint}`);
      }
    });
  }
});

test("post-exposure busy or changed appserver preserves new state behind a durable block", async (t) => {
  for (const [name, options, expectedStatus] of [
    ["busy", { newAppDrainBusy: true }, "rollback-blocked-active-work"],
    [
      "identity mismatch",
      { newAppDrainIdentityMismatch: true },
      "rollback-blocked-invalid-drain-proof",
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const first = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-gateway-start" });
      assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);

      const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
      assert.equal(await pathExists(marker), true);
      assert.equal(JSON.parse(await readFile(marker, "utf8")).status, expectedStatus);
      assert.equal((await readFile(join(fixture.state, "package-version"), "utf8")).trim(), "1.2.3");
      assert.notDeepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
      assert.notDeepEqual(await readFile(fixture.gatewayConfig), fixture.initial.gatewayConfig);
      assert.notDeepEqual(await readFile(fixture.gatewayUnit), fixture.initial.gatewayUnit);
      assert.equal((await readFile(join(fixture.state, "app-service"), "utf8")).trim(), "active");
      assert.equal(
        (await readFile(join(fixture.state, "gateway-service"), "utf8")).trim(),
        "inactive",
      );
      assert.equal(
        (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
        "disabled",
      );
      assert.equal(await pathExists(fixture.receipt), false);

      const callsBefore = await fixture.callsText();
      const effectiveAptBefore = callsBefore
        .split("\n")
        .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"));
      assert.equal(effectiveAptBefore.length, 1, callsBefore);
      assert.doesNotMatch(
        callsBefore,
        /^apt-get\t.*previous-Omperator-1\.2\.2-linux-amd64\.deb/mu,
      );

      const second = fixture.run();
      assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
      const callsAfter = await fixture.callsText();
      const beforeLines = callsBefore.trimEnd().split("\n");
      const afterLines = callsAfter.trimEnd().split("\n");
      assert.deepEqual(
        afterLines.slice(beforeLines.length),
        [`realpath\t-e\t--\t${fixture.maintainerRoot}`],
        callsAfter,
      );
    });
  }
});

test("rollback failure leaves a durable block that prevents a second mutation", async (t) => {
  const fixture = await createDeployFixture({ rollbackAptFail: true });
  t.after(() => fixture.cleanup());
  const first = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-desktop-install" });
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  assert.equal(await pathExists(marker), true);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).status, "rollback-incomplete");
  const callsBefore = await fixture.callsText();
  const second = fixture.run();
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const callsAfter = await fixture.callsText();
  assert.equal(
    callsAfter.split("\n").filter((line) => line.startsWith("apt-get\t")).length,
    callsBefore.split("\n").filter((line) => line.startsWith("apt-get\t")).length,
  );
  assert.equal(
    callsAfter.split("\n").filter((line) => /^systemctl\t.*(?:stop|start|restart)/u.test(line)).length,
    callsBefore.split("\n").filter((line) => /^systemctl\t.*(?:stop|start|restart)/u.test(line)).length,
  );
});

test("a crash-left transaction marker blocks rerun before staging or mutation", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  await mkdir(dirname(marker), { recursive: true });
  const markerBytes = '{"schemaVersion":1,"status":"deployment-in-progress"}\n';
  await writeFile(marker, markerBytes);

  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(marker, "utf8"), markerBytes);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture, { blocked: true });
});

test("maintainer fixtures resolve Node from the active test runtime", async (t) => {
  assert.doesNotMatch(`${mockDispatcher}\n${mockLocalDeploy}`, /\/usr\/bin\/node/u);
  assert.match(mockDispatcher, /\$MOCK_NODE_EXECUTABLE/u);

  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const nodeProxy = join(fixture.root, "portable node");
  await symlink(process.execPath, nodeProxy);

  const result = fixture.runRunner({ MOCK_NODE_EXECUTABLE: nodeProxy });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const gatewayConfig = JSON.parse(await readFile(fixture.gatewayConfig, "utf8"));
  assert.equal(gatewayConfig.nodeExecutable, nodeProxy);
});

test("runtime dependency symlinks must remain inside the exact tagged runtime", async (t) => {
  const fixture = await createDeployFixture({ wsEscape: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /T4 gateway ws runtime resolves outside the exact tagged checkout/u);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("test process roots cannot weaken the production executable proof", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run({
    T4_MAINTAINER_TEST_MODE: "0",
    T4_MAINTAINER_TEST_PROC_ROOT: join(fixture.maintainerRoot, "mock-proc"),
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /process-root override is restricted to an explicit temporary test root/u,
  );
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("test process roots reject canonical escapes before mutation", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const externalProcRoot = join(fixture.root, "external-proc");
  const escapedProcRoot = join(fixture.maintainerRoot, "escaped-proc");
  await mkdir(externalProcRoot, { recursive: true });
  await symlink(externalProcRoot, escapedProcRoot);
  const result = fixture.run({ T4_MAINTAINER_TEST_PROC_ROOT: escapedProcRoot });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /test process root must be canonical/u);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("test process roots must remain inside the canonical maintainer root", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const externalProcRoot = join(fixture.root, "external-proc");
  await mkdir(externalProcRoot, { recursive: true });
  const result = fixture.run({ T4_MAINTAINER_TEST_PROC_ROOT: externalProcRoot });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /test process root must be a child of the maintainer root/u);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("test maintainer roots must be canonical before process overrides", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const maintainerAlias = join(fixture.root, "maintainer-alias");
  await symlink(fixture.maintainerRoot, maintainerAlias);
  const result = spawnSync(
    bashPath,
    [
      deployScript,
      join(maintainerAlias, "runs", "fixture", "result.json"),
      join(maintainerAlias, "runs", "fixture", "local-deployment.json"),
      join(maintainerAlias, "runs", "fixture", "local-work"),
    ],
    {
      encoding: "utf8",
      env: {
        ...fixture.env,
        T4_MAINTAINER_ROOT: maintainerAlias,
        T4_MAINTAINER_TEST_PROC_ROOT: join(maintainerAlias, "mock-proc"),
      },
      timeout: 20_000,
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /maintainer root must be canonical/u);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("direct deployer rejects a /tmp symlink-root escape before staging or mutation", async (t) => {
  const fixture = await createDeployFixture();
  const outsideRoot = await mkdtemp(join("/var/tmp", "t4-deploy-outside-"));
  const tmpParent = join(tmpdir(), `t4-deploy-root-link-${process.pid}-${Date.now()}`);
  await symlink(outsideRoot, tmpParent);
  t.after(async () => {
    await fixture.cleanup();
    await rm(tmpParent, { force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  const escapedRoot = join(tmpParent, "nonexistent-child");
  const result = spawnSync(
    bashPath,
    [
      deployScript,
      join(escapedRoot, "runs", "fixture", "result.json"),
      join(escapedRoot, "runs", "fixture", "local-deployment.json"),
      join(escapedRoot, "runs", "fixture", "local-work"),
    ],
    {
      encoding: "utf8",
      env: { ...fixture.env, T4_MAINTAINER_ROOT: escapedRoot },
      timeout: 20_000,
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /maintainer root must exist and be canonical/u);
  assert.equal((await readdir(outsideRoot)).length, 0);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
});

test("a divergent fork main is retried and rejected before source staging", async (t) => {
  const fixture = await createDeployFixture({ forkMainDiverged: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.includes("repos/wolfiesch/oh-my-pi/commits/main"))
      .length,
    2,
    calls,
  );
  assert.doesNotMatch(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("a missing or recreated fork base tag is rejected before source staging", async (t) => {
  for (const [name, options] of [
    ["missing", { forkBaseTagMissing: true }],
    ["different tag object", { forkBaseTagMismatch: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.equal(
        calls
          .split("\n")
          .filter((line) => line.includes("repos/wolfiesch/oh-my-pi/git/ref/tags/v1.2.3"))
          .length,
        2,
        calls,
      );
      assert.doesNotMatch(calls, /^git\t.*clone/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      await assertRestored(fixture);
    });
  }
});

test("a gateway quarantine failure preserves an honest block and active-ingress warning", async (t) => {
  const fixture = await createDeployFixture({ gatewayDisableFailAfterFirst: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-gateway-start" });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /gateway quarantine could not be proven/u);
  assert.match(result.stderr, /Ingress may still be active/u);
  assert.doesNotMatch(result.stderr, /gateway remains durably disabled/u);
  const blocked = JSON.parse(
    await readFile(join(fixture.maintainerRoot, "state", "deployment-blocked.json"), "utf8"),
  );
  assert.equal(blocked.status, "gateway-quarantine-incomplete");
  assert.equal(await readFile(join(fixture.state, "gateway-service"), "utf8"), "active");
});

test("derived drain probe cannot collide with the former constant sentinel", async (t) => {
  const fixture = await createDeployFixture({ drainConstantIdentity: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(
    calls,
    /--expected-host-id\tt4-maintainer-capability-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-capability-epoch-[0-9a-f]{64}/mu,
  );
});
