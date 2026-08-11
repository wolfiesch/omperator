import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_GATEWAY_PORT,
  SERVICE_LABEL,
  isTransientLaunchctlBootstrap,
  parseCli,
  parseProfileRoutesOption,
  renderLaunchAgent,
  renderSystemdUnit,
  serviceFileMode,
  servicePaths,
  supervisorCommands,
  validateServiceConfig,
  validateCliOptions,
} from "./gateway-service.mjs";

const CONFIG = {
  version: 1,
  sourceRoot: "/home/alice/t4-code",
  nodeExecutable: "/opt/node/bin/node",
  gatewayScript: "/home/alice/t4-code/scripts/tailnet-gateway.mjs",
  webRoot: "/home/alice/t4-code/apps/web/dist",
  appSocket: "/run/user/1000/omp/appserver.sock",
  allowedOrigin: "https://wickrunner.com",
  nativeAllowedOrigins: ["https://localhost", "capacitor://localhost"],
  port: DEFAULT_GATEWAY_PORT,
  label: "Alice's workstation",
  deploymentIdentity: `sha256:${"a".repeat(64)}`,
};

test("service config requires an exact HTTPS origin and absolute local paths", () => {
  assert.deepEqual(validateServiceConfig(CONFIG), CONFIG);
  const legacyConfig = { ...CONFIG };
  delete legacyConfig.nativeAllowedOrigins;
  assert.deepEqual(validateServiceConfig(legacyConfig), CONFIG);
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, allowedOrigin: "http://wickrunner.com" }),
    /plain HTTPS origin/u,
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
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, deploymentIdentity: "latest" }),
    /deployment identity must be sha256/u,
  );
});

test("host DNS name flows from config into both unit definitions when set", () => {
  const withName = validateServiceConfig({
    ...CONFIG,
    hostDnsName: "workstation.example.com.",
  });
  assert.equal(withName.hostDnsName, "workstation.example.com");
  assert.match(
    renderSystemdUnit(withName),
    /Environment="T4_HOST_DNS_NAME=workstation\.example\.com"/u,
  );
  const darwinPaths = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.match(
    renderLaunchAgent(withName, darwinPaths),
    /<key>T4_HOST_DNS_NAME<\/key>\s+<string>workstation\.example\.com<\/string>/u,
  );

  const withoutName = validateServiceConfig(CONFIG);
  assert.equal(withoutName.hostDnsName, undefined);
  assert.doesNotMatch(renderSystemdUnit(withoutName), /T4_HOST_DNS_NAME/u);
  const emptyName = validateServiceConfig({ ...CONFIG, hostDnsName: "" });
  assert.equal(emptyName.hostDnsName, undefined);
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, hostDnsName: "bad\nname" }),
    /host DNS name is invalid/u,
  );
});

test("rendezvous url flows from config into both unit definitions when set", () => {
  const withRendezvous = validateServiceConfig({
    ...CONFIG,
    rendezvousUrl: "https://wickrunner.com/rdv",
  });
  assert.equal(withRendezvous.rendezvousUrl, "https://wickrunner.com");
  assert.match(renderSystemdUnit(withRendezvous), /Environment="T4_RENDEZVOUS_URL=https:\/\/wickrunner\.com"/u);
  const darwinPaths = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.match(
    renderLaunchAgent(withRendezvous, darwinPaths),
    /<key>T4_RENDEZVOUS_URL<\/key>\s+<string>https:\/\/wickrunner\.com<\/string>/u,
  );
  const without = validateServiceConfig(CONFIG);
  assert.equal(without.rendezvousUrl, undefined);
  assert.doesNotMatch(renderSystemdUnit(without), /T4_RENDEZVOUS_URL/u);
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, rendezvousUrl: "http://public.example.com" }),
    /T4_RENDEZVOUS_URL/u,
  );
});

test("relay url flows from config into both unit definitions when set", () => {
  const withRelay = validateServiceConfig({
    ...CONFIG,
    relayUrl: "wss://wickrunner.com:8443",
  });
  assert.equal(withRelay.relayUrl, "wss://wickrunner.com:8443");
  assert.match(renderSystemdUnit(withRelay), /Environment="T4_RELAY_URL=wss:\/\/wickrunner\.com:8443"/u);
  const darwinPaths = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.match(
    renderLaunchAgent(withRelay, darwinPaths),
    /<key>T4_RELAY_URL<\/key>\s+<string>wss:\/\/wickrunner\.com:8443<\/string>/u,
  );
  const without = validateServiceConfig(CONFIG);
  assert.equal(without.relayUrl, undefined);
  assert.doesNotMatch(renderSystemdUnit(without), /T4_RELAY_URL/u);
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, relayUrl: "https://example.com" }),
    /T4_RELAY_URL/u,
  );
});

test("profile route schema and generated environment are static and start-explicit", () => {
  const config = validateServiceConfig({
    ...CONFIG,
    profileRoutes: [
      { id: "fable", appSocket: "/run/user/1000/omp/fable.sock", serviceUnit: "t4-fable.service", startEnabled: true },
    ],
    startProfiles: true,
  });
  assert.deepEqual(config.profileRoutes, [
    { id: "fable", appSocket: "/run/user/1000/omp/fable.sock", serviceUnit: "t4-fable.service", startEnabled: true },
  ]);
  const unit = renderSystemdUnit(config);
  assert.match(unit, /T4_PROFILE_ROUTES=/u);
  assert.match(unit, /T4_ENABLE_PROFILE_STARTS=1/u);
  const renderableBoundary = validateServiceConfig({
    ...CONFIG,
    profileRoutes: [{ id: "edge", appSocket: `/${"a".repeat(4_026)}` }],
  });
  const darwinPaths = servicePaths({ platform: "darwin", homeDirectory: "/Users/alice", uid: 501 });
  assert.doesNotThrow(() => renderSystemdUnit(renderableBoundary));
  assert.doesNotThrow(() => renderLaunchAgent(renderableBoundary, darwinPaths));
  assert.throws(
    () =>
      validateServiceConfig({
        ...CONFIG,
        profileRoutes: [{ id: "edge", appSocket: `/${"a".repeat(4_027)}` }],
      }),
    /profile routes are too large/u,
  );
  assert.throws(
    () => validateServiceConfig({ ...CONFIG, profileRoutes: [{ id: "fable", appSocket: "/tmp/a", serviceUnit: "foo..service" }] }),
    /profile service unit/u,
  );
  assert.throws(
    () =>
      validateServiceConfig({
        ...CONFIG,
        profileRoutes: [{ id: "oversized", appSocket: `/${"a".repeat(4_080)}` }],
      }),
    /profile routes are too large/u,
  );
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
  assert.match(unit, /Environment="T4_DEPLOYMENT_IDENTITY=sha256:a{64}"/u);
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
  assert.match(plist, /<key>T4_DEPLOYMENT_IDENTITY<\/key>\s+<string>sha256:a{64}<\/string>/u);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/u);
  assert.equal(serviceFileMode(paths, paths.definition), 0o644);
  assert.equal(serviceFileMode(paths, paths.config), 0o600);
  const linuxPaths = servicePaths({ platform: "linux", homeDirectory: "/home/alice", uid: 1000 });
  assert.equal(serviceFileMode(linuxPaths, linuxPaths.definition), 0o600);
});

test("supervisor command plans never use a shell and include durable enablement", () => {
  const linux = servicePaths({ platform: "linux", homeDirectory: "/home/alice", uid: 1000 });
  assert.deepEqual(supervisorCommands("install", linux), [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", `${SERVICE_LABEL}.service`] },
    { argv: ["systemctl", "--user", "restart", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("install-deferred", linux), [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "disable", "--now", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("stop", linux), [
    { argv: ["systemctl", "--user", "disable", "--now", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("start", linux), [
    { argv: ["systemctl", "--user", "enable", "--now", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("restart", linux), [
    { argv: ["systemctl", "--user", "enable", `${SERVICE_LABEL}.service`] },
    { argv: ["systemctl", "--user", "restart", `${SERVICE_LABEL}.service`] },
  ]);
  assert.deepEqual(supervisorCommands("enablement-status", linux), [
    {
      argv: ["systemctl", "--user", "is-enabled", `${SERVICE_LABEL}.service`],
      allowFailure: true,
    },
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
    { argv: ["launchctl", "enable", `gui/501/${SERVICE_LABEL}`] },
    { argv: ["launchctl", "bootstrap", "gui/501", mac.definition] },
    { argv: ["launchctl", "kickstart", "-k", `gui/501/${SERVICE_LABEL}`] },
  ]);
  assert.deepEqual(supervisorCommands("install-deferred", mac), [
    { argv: ["launchctl", "disable", `gui/501/${SERVICE_LABEL}`] },
    { argv: ["launchctl", "bootout", `gui/501/${SERVICE_LABEL}`], allowFailure: true },
  ]);
  assert.deepEqual(supervisorCommands("start", mac), [
    { argv: ["launchctl", "enable", `gui/501/${SERVICE_LABEL}`] },
    {
      argv: ["launchctl", "bootstrap", "gui/501", mac.definition],
      allowFailure: true,
    },
    { argv: ["launchctl", "kickstart", "-k", `gui/501/${SERVICE_LABEL}`] },
  ]);
  assert.deepEqual(supervisorCommands("stop", mac), [
    { argv: ["launchctl", "disable", `gui/501/${SERVICE_LABEL}`] },
    { argv: ["launchctl", "bootout", `gui/501/${SERVICE_LABEL}`], allowFailure: true },
  ]);
  assert.deepEqual(supervisorCommands("restart", mac), [
    { argv: ["launchctl", "enable", `gui/501/${SERVICE_LABEL}`] },
    {
      argv: ["launchctl", "bootstrap", "gui/501", mac.definition],
      allowFailure: true,
    },
    { argv: ["launchctl", "kickstart", "-k", `gui/501/${SERVICE_LABEL}`] },
  ]);
  assert.deepEqual(supervisorCommands("enablement-status", mac), [
    { argv: ["launchctl", "print-disabled", "gui/501"], allowFailure: true },
  ]);
  for (const command of [
    ...supervisorCommands("install", linux),
    ...supervisorCommands("install-deferred", linux),
    ...supervisorCommands("start", linux),
    ...supervisorCommands("stop", linux),
    ...supervisorCommands("install", mac),
    ...supervisorCommands("install-deferred", mac),
    ...supervisorCommands("start", mac),
    ...supervisorCommands("stop", mac),
  ]) {
    assert.notEqual(command.argv[0], "sh");
    assert.notEqual(command.argv[0], "bash");
  }
});

test("only launchctl bootstrap's asynchronous-removal error is retryable", () => {
  const bootstrap = { argv: ["launchctl", "bootstrap", "gui/501", "/tmp/service.plist"] };
  assert.equal(
    isTransientLaunchctlBootstrap(bootstrap, {
      code: 37,
      stdout: "",
      stderr: "Bootstrap failed: 37: Operation already in progress",
    }),
    true,
  );
  assert.equal(
    isTransientLaunchctlBootstrap(bootstrap, { code: 5, stdout: "", stderr: "Input/output error" }),
    false,
  );
  assert.equal(
    isTransientLaunchctlBootstrap(
      { argv: ["launchctl", "kickstart", "gui/501/example"] },
      { code: 37, stdout: "", stderr: "Operation already in progress" },
    ),
    false,
  );
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
      "--deployment-identity",
      CONFIG.deploymentIdentity,
      "--profile-routes",
      '[{"id":"fable","appSocket":"/run/user/1000/omp/fable.sock","serviceUnit":"t4-fable.service"}]',
      "--start-profiles",
      "--defer-start",
    ]),
    {
      command: "install",
      options: {
        origin: CONFIG.allowedOrigin,
        port: "4194",
        label: "Workstation",
        deploymentIdentity: CONFIG.deploymentIdentity,
        profileRoutes: '[{"id":"fable","appSocket":"/run/user/1000/omp/fable.sock","serviceUnit":"t4-fable.service"}]',
        startProfiles: true,
        deferStart: true,
      },
    },
  );
  validateCliOptions("install", parseCli([
    "install",
    "--origin",
    CONFIG.allowedOrigin,
    "--profile-routes",
    "[]",
    "--start-profiles",
  ]).options);
  validateCliOptions("status", parseCli([
    "status",
    "--deployment-identity",
    CONFIG.deploymentIdentity,
  ]).options);
  assert.throws(() => parseCli(["install", "--origin"]), /requires a value/u);
  assert.throws(
    () => parseCli(["install", "--origin", CONFIG.allowedOrigin, "--origin", CONFIG.allowedOrigin]),
    /more than once/u,
  );
  assert.throws(
    () => parseCli(["install", "--origin", CONFIG.allowedOrigin, "--defer-start", "--defer-start"]),
    /more than once/u,
  );
  assert.throws(() => parseProfileRoutesOption("{not-json"), /--profile-routes must be valid JSON/u);
});
