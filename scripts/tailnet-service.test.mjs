import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_GATEWAY_PORT,
  SERVICE_LABEL,
  parseCli,
  renderLaunchAgent,
  renderSystemdUnit,
  servicePaths,
  supervisorCommands,
  validateServiceConfig,
} from "./tailnet-service.mjs";

const CONFIG = {
  version: 1,
  sourceRoot: "/home/alice/t4-code",
  nodeExecutable: "/opt/node/bin/node",
  gatewayScript: "/home/alice/t4-code/scripts/tailnet-gateway.mjs",
  webRoot: "/home/alice/t4-code/apps/web/dist",
  appSocket: "/run/user/1000/omp/appserver.sock",
  allowedOrigin: "https://workstation.example-tailnet.ts.net:8445",
  nativeAllowedOrigins: ["https://localhost", "capacitor://localhost"],
  port: DEFAULT_GATEWAY_PORT,
  label: "Alice's workstation",
};

test("service config requires an exact Tailnet HTTPS origin and absolute local paths", () => {
  assert.deepEqual(validateServiceConfig(CONFIG), CONFIG);
  const legacyConfig = { ...CONFIG };
  delete legacyConfig.nativeAllowedOrigins;
  assert.deepEqual(validateServiceConfig(legacyConfig), CONFIG);
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, allowedOrigin: "https://public.example.com" }),
    /Tailscale HTTPS origin/u,
  );
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, nativeAllowedOrigins: ["*"] }),
    /must contain exactly/u,
  );
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, webRoot: "apps/web/dist" }),
    /absolute path/u,
  );
  assert.throws(() => validateServiceConfig({ ...CONFIG, port: 80 }), /1024 through 65535/u);
  assert.throws(() => validateServiceConfig({ ...CONFIG, port: "4194oops" }), /1024 through 65535/u);
});

test("Linux paths are user-scoped and the systemd unit is shell-free and loopback-only", () => {
  const paths = servicePaths({ platform: "linux", homeDirectory: "/home/alice", uid: 1000 });
  assert.equal(
    paths.definition,
    `/home/alice/.config/systemd/user/${SERVICE_LABEL}.service`,
  );
  assert.equal(paths.config, "/home/alice/.config/t4-code/tailnet-gateway.json");

  const unit = renderSystemdUnit({ ...CONFIG, label: 'host "$(touch /tmp/nope)" 100%' });
  assert.match(unit, /ExecStart="\/opt\/node\/bin\/node" "\/home\/alice\/t4-code\/scripts\/tailnet-gateway\.mjs"/u);
  assert.match(unit, /Environment="T4_GATEWAY_HOST=127\.0\.0\.1"/u);
  assert.match(
    unit,
    /Environment="T4_NATIVE_ALLOWED_ORIGINS=https:\/\/localhost,capacitor:\/\/localhost"/u,
  );
  assert.match(unit, /Environment="T4_HOST_LABEL=host \\"\\\$\(touch \/tmp\/nope\)\\" 100%%"/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectHome=read-only/u);
  assert.doesNotMatch(unit, /\/bin\/(?:ba)?sh|sh -c/u);
});

test("generated Linux definition passes systemd's native verifier", async (context) => {
  if (process.platform !== "linux") {
    context.skip("systemd verification runs on Linux");
    return;
  }
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    context.skip("systemd-analyze is unavailable");
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), "t4-tailnet-unit-"));
  const definition = join(scratch, `${SERVICE_LABEL}.service`);
  try {
    await writeFile(
      definition,
      renderSystemdUnit({
        ...CONFIG,
        nodeExecutable: process.execPath,
        gatewayScript: resolve("scripts/tailnet-gateway.mjs"),
      }),
    );
    const result = spawnSync("systemd-analyze", ["verify", definition], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("macOS paths and launch agent preserve argv and environment as XML data", () => {
  const paths = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.equal(paths.domain, "gui/501");
  assert.equal(
    paths.definition,
    `/Users/alice/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
  );
  const plist = renderLaunchAgent({ ...CONFIG, label: "A&B <host>" }, paths);
  assert.match(plist, /<key>ProgramArguments<\/key>/u);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/u);
  assert.match(plist, /<key>T4_GATEWAY_HOST<\/key>\s+<string>127\.0\.0\.1<\/string>/u);
  assert.match(
    plist,
    /<key>T4_NATIVE_ALLOWED_ORIGINS<\/key>\s+<string>https:\/\/localhost,capacitor:\/\/localhost<\/string>/u,
  );
  assert.match(plist, /<string>A&amp;B &lt;host&gt;<\/string>/u);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/u);
});

test("supervisor command plans never use a shell and include durable enablement", () => {
  const linux = servicePaths({ platform: "linux", homeDirectory: "/home/alice", uid: 1000 });
  assert.deepEqual(supervisorCommands("install", linux), [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", `${SERVICE_LABEL}.service`] },
    { argv: ["systemctl", "--user", "restart", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("uninstall", linux), [
    {
      argv: ["systemctl", "--user", "disable", "--now", `${SERVICE_LABEL}.service`],
      allowFailure: true,
    },
  ]);

  const mac = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.deepEqual(supervisorCommands("install", mac), [
    { argv: ["launchctl", "bootout", `gui/501/${SERVICE_LABEL}`], allowFailure: true },
    { argv: ["launchctl", "bootstrap", "gui/501", mac.definition] },
    { argv: ["launchctl", "kickstart", "-k", `gui/501/${SERVICE_LABEL}`] },
  ]);
  for (const command of [
    ...supervisorCommands("install", linux),
    ...supervisorCommands("install", mac),
  ]) {
    assert.notEqual(command.argv[0], "sh");
    assert.notEqual(command.argv[0], "bash");
  }
});

test("CLI parser rejects ambiguous values and accepts the documented install shape", () => {
  assert.deepEqual(parseCli(["--help"]), { command: "help", options: {} });
  assert.deepEqual(
    parseCli([
      "install",
      "--origin",
      CONFIG.allowedOrigin,
      "--port",
      "4194",
      "--label",
      "Workstation",
    ]),
    {
      command: "install",
      options: { origin: CONFIG.allowedOrigin, port: "4194", label: "Workstation" },
    },
  );
  assert.throws(() => parseCli(["install", "--origin"]), /requires a value/u);
  assert.throws(
    () => parseCli(["install", "--origin", CONFIG.allowedOrigin, "--origin", CONFIG.allowedOrigin]),
    /more than once/u,
  );
});
