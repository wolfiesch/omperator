import { describe, expect, it } from "vite-plus/test";
import {
  LinuxSystemdUserManager,
  MacLaunchAgentManager,
  ServiceCommandError,
  ServiceValidationError,
  renderLinuxSystemdDefinition,
  renderMacLaunchAgentDefinition,
  serviceLabelForProfile,
  validateProfileId,
  type ServiceFileSystem,
  type ServiceRunner,
  type ServiceRunnerResult,
  type ServiceSpec,
} from "../src/index.ts";
import { validateAbsolutePath } from "../src/rendering.ts";

class MemoryFs implements ServiceFileSystem {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  failWrite = false;
  async read(path: string) {
    this.calls.push(`read:${path}`);
    return this.files.get(path) ?? null;
  }
  async writeAtomic(path: string, content: string) {
    this.calls.push(`write:${path}`);
    if (this.failWrite) throw new Error("write failed");
    this.files.set(path, content);
  }
  async mkdir(path: string) {
    this.calls.push(`mkdir:${path}`);
  }
  async chmod(path: string) {
    this.calls.push(`chmod:${path}`);
  }
  async remove(path: string) {
    this.calls.push(`remove:${path}`);
    this.files.delete(path);
  }
}
class MemoryRunner implements ServiceRunner {
  readonly calls: string[][] = [];
  results: ServiceRunnerResult[] = [];
  async run(argv: readonly string[]) {
    this.calls.push([...argv]);
    return this.results.shift() ?? { exitCode: 0, stdout: "active\n", stderr: "" };
  }
}
const spec: ServiceSpec = {
  profileId: "default",
  executable: "/opt/t4/bin/t4-host",
  argv: ["serve", "--omp", "/opt/omp/bin/omp", "--profile", "default"],
  logsDirectory: "/home/alice/.omp/logs",
};
const options = (fs: MemoryFs, runner: MemoryRunner) => ({
  homeDirectory: "/home/alice",
  fs,
  runner,
});
describe("extracted rendering contract", () => {
  it("accepts absolute paths and rejects control characters", () => {
    expect(validateAbsolutePath("/home/alice/.omp/logs", "logs")).toBe("/home/alice/.omp/logs");
    expect(() => validateAbsolutePath("relative", "logs")).toThrow(ServiceValidationError);
    expect(() => validateAbsolutePath("/home/alice/\u0007logs", "logs")).toThrow(
      ServiceValidationError,
    );
  });
});

describe("service-manager definitions", () => {
  it("renders systemd with exact argv semantics, child OOM isolation, restart, umask, network ordering and logs", () => {
    const definitionPath = "/home/alice/.config/systemd/user/dev.oh-my-pi.appserver.service";
    const content = renderLinuxSystemdDefinition(spec);
    expect(definitionPath).toBe("/home/alice/.config/systemd/user/dev.oh-my-pi.appserver.service");
    expect(content).toContain(
      'ExecStart="/opt/t4/bin/t4-host" "serve" "--omp" "/opt/omp/bin/omp" "--profile" "default"',
    );
    expect(content).toContain("Wants=network-online.target");
    expect(content).toContain("OOMPolicy=continue");
    expect(content).toContain("Restart=on-failure");
    expect(content).toContain("UMask=0077");
    expect(content).toContain("StandardOutput=append:/home/alice/.omp/logs/appserver.log");
    expect(content).toContain('Environment="OMP_PROFILE=default"');
  });
  it("renders the host runtime override into the launch agent environment", () => {
    // The override relocates the host socket. If the renderer drops it, the
    // daemon binds under a deep sandbox HOME and the app cannot reach it.
    const content = renderMacLaunchAgentDefinition({
      ...spec,
      environment: { ...spec.environment, T4_HOST_RUNTIME_DIR: "/private/tmp/t4-501-abcdef" },
    });
    expect(content).toContain("<key>T4_HOST_RUNTIME_DIR</key>");
    expect(content).toContain("<string>/private/tmp/t4-501-abcdef</string>");
  });

  it("renders plist as XML-safe ProgramArguments without shell", () => {
    const definitionPath = "/home/alice/Library/LaunchAgents/dev.oh-my-pi.appserver.plist";
    const content = renderMacLaunchAgentDefinition(spec);
    expect(definitionPath).toBe("/home/alice/Library/LaunchAgents/dev.oh-my-pi.appserver.plist");
    expect(content).toContain("<key>ProgramArguments</key>");
    expect(content).toContain("<string>--omp</string>");
    expect(content).toContain("<string>serve</string>");
    expect(content).toContain("<key>Umask</key><integer>63</integer>");
    expect(content).toContain("<key>OMP_PROFILE</key>");
    expect(content).toContain("<string>default</string>");
  });
  it("isolates development service identity and path-valued environment", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const developmentSpec: ServiceSpec = {
      ...spec,
      argv: [...spec.argv, "--state-root", "/tmp/omperator-dev/host-state"],
      logsDirectory: "/tmp/omperator-dev/logs/host",
      environment: {
        HOME: "/tmp/omperator-dev/home",
        OMP_PROFILE: "default",
        XDG_RUNTIME_DIR: "/tmp/omperator-dev/run",
      },
    };
    const manager = new MacLaunchAgentManager(developmentSpec, {
      homeDirectory: "/tmp/omperator-dev/home",
      label: "dev.oh-my-pi.appserver.development.watch-loop",
      uid: 501,
      fs,
      runner,
    });

    await manager.install();
    expect(manager.label).toBe("dev.oh-my-pi.appserver.development.watch-loop");
    expect(manager.definitionPath).toBe(
      "/tmp/omperator-dev/home/Library/LaunchAgents/dev.oh-my-pi.appserver.development.watch-loop.plist",
    );
    const definition = fs.files.get(manager.definitionPath);
    expect(definition).toContain("<key>HOME</key>");
    expect(definition).toContain("<string>/tmp/omperator-dev/run</string>");
    expect(definition).toContain("<string>--state-root</string>");
  });

  it("rejects path, argv, profile, uid and secret-bearing env injection", () => {
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, executable: "omp" },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    for (const profileId of ["UPPER", "..", "work.", "con", "lpt9.logs", "a".repeat(65)]) {
      expect(() => validateProfileId(profileId)).toThrow(ServiceValidationError);
    }
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, argv: ["bad\narg"] },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, profileId: "../bad" },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, environment: { API_TOKEN: "secret" } },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new MacLaunchAgentManager(spec, {
          ...options(new MemoryFs(), new MemoryRunner()),
          uid: -1,
        }),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new MacLaunchAgentManager(spec, {
          ...options(new MemoryFs(), new MemoryRunner()),
          label: "dev.oh-my-pi.appserver.bad/value",
          uid: 501,
        }),
    ).toThrow(ServiceValidationError);
  });
  it("isolates named profiles while preserving the legacy default identity", () => {
    expect(serviceLabelForProfile("default")).toBe("dev.oh-my-pi.appserver");
    expect(serviceLabelForProfile("claude-fable")).toBe(
      "dev.oh-my-pi.appserver.profile.claude-fable",
    );
    const named: ServiceSpec = {
      ...spec,
      profileId: "claude-fable",
      logsDirectory: "/home/alice/.omp/logs/claude-fable",
      environment: { OMP_PROFILE: "claude-fable" },
      argv: ["serve", "--omp", "/opt/omp/bin/omp", "--profile", "claude-fable"],
    };
    const linux = new LinuxSystemdUserManager(named, options(new MemoryFs(), new MemoryRunner()));
    const mac = new MacLaunchAgentManager(named, {
      ...options(new MemoryFs(), new MemoryRunner()),
      uid: 501,
    });
    expect(linux.label).toBe("dev.oh-my-pi.appserver.profile.claude-fable");
    expect(linux.definitionPath).toBe(
      "/home/alice/.config/systemd/user/dev.oh-my-pi.appserver.profile.claude-fable.service",
    );
    expect(mac.label).toBe("dev.oh-my-pi.appserver.profile.claude-fable");
    expect(mac.definitionPath).toBe(
      "/home/alice/Library/LaunchAgents/dev.oh-my-pi.appserver.profile.claude-fable.plist",
    );
    expect(renderLinuxSystemdDefinition(named)).toContain('Environment="OMP_PROFILE=claude-fable"');
    expect(renderMacLaunchAgentDefinition(named)).toContain("<key>OMP_PROFILE</key>");
  });
});

describe("service-manager lifecycle", () => {
  it("does not touch filesystem or runner before explicit action", () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    new LinuxSystemdUserManager(spec, options(fs, runner));
    expect(fs.calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
  it("installs transactionally, is idempotent, and rolls back a new definition", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new LinuxSystemdUserManager(spec, options(fs, runner));
    await manager.install();
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "is-active",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "dev.oh-my-pi.appserver",
    ]);
    const writes = fs.calls.filter((call) => call.startsWith("write:")).length;
    await manager.install();
    expect(fs.calls.filter((call) => call.startsWith("write:")).length).toBe(writes);
    expect(runner.calls.at(-1)).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "dev.oh-my-pi.appserver",
    ]);
    const fs2 = new MemoryFs();
    const runner2 = new MemoryRunner();
    runner2.results = [
      { exitCode: 0, stdout: "inactive", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "provider API_TOKEN=do-not-leak" },
    ];
    const manager2 = new LinuxSystemdUserManager(spec, options(fs2, runner2));
    const failure = await manager2.install().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceCommandError);
    if (!(failure instanceof Error)) throw new Error("expected install failure");
    expect(failure.message).not.toContain("do-not-leak");
  });
  it("updates a drifted running definition without stopping an unchanged service", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new LinuxSystemdUserManager(spec, options(fs, runner));
    fs.files.set(manager.definitionPath, "drifted");
    runner.results = [{ exitCode: 0, stdout: "active", stderr: "" }];
    await manager.install();
    expect(runner.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "restart",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).not.toContainEqual([
      "systemctl",
      "--user",
      "stop",
      "dev.oh-my-pi.appserver",
    ]);
  });
  it("restores an existing definition on command failure and keeps it on uninstall failure", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new LinuxSystemdUserManager(spec, options(fs, runner));
    fs.files.set(manager.definitionPath, "old definition");
    runner.results = [
      { exitCode: 0, stdout: "inactive", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed" },
    ];
    await expect(manager.install()).rejects.toBeInstanceOf(ServiceCommandError);
    expect(fs.files.get(manager.definitionPath)).toBe("old definition");
    const macFs = new MemoryFs();
    const macRunner = new MemoryRunner();
    const mac = new MacLaunchAgentManager(spec, { ...options(macFs, macRunner), uid: 501 });
    macFs.files.set(mac.definitionPath, renderMacLaunchAgentDefinition(spec));
    macRunner.results = [{ exitCode: 1, stdout: "", stderr: "cannot bootout" }];
    await expect(mac.uninstall()).rejects.toBeInstanceOf(ServiceCommandError);
    expect(macFs.files.has(mac.definitionPath)).toBe(true);
  });
  it("emits every lifecycle argv sequence", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new LinuxSystemdUserManager(spec, options(fs, runner));
    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.uninstall();
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual(["systemctl", "--user", "stop", "dev.oh-my-pi.appserver"]);
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "restart",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });
  it("uses the exact launchctl argv matrix and status domain", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new MacLaunchAgentManager(spec, { ...options(fs, runner), uid: 501 });
    await manager.install();
    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.uninstall();
    expect(runner.calls).toContainEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      manager.definitionPath,
    ]);
    expect(runner.calls).toContainEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/dev.oh-my-pi.appserver",
    ]);
    expect(runner.calls).toContainEqual(["launchctl", "bootout", "gui/501/dev.oh-my-pi.appserver"]);
    runner.results = [{ exitCode: 0, stdout: "state = running\n", stderr: "" }];
    expect((await manager.inspect()).service).toBe("running");
    expect(runner.calls.at(-1)).toEqual(["launchctl", "print", "gui/501/dev.oh-my-pi.appserver"]);
  });
  it("reports missing/current/drifted and bounded service states", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new LinuxSystemdUserManager(spec, options(fs, runner));
    runner.results = [{ exitCode: 3, stdout: "inactive\n", stderr: "" }];
    expect(await manager.inspect()).toMatchObject({ definition: "missing", service: "stopped" });
    fs.files.set(manager.definitionPath, renderLinuxSystemdDefinition(spec));
    runner.results = [{ exitCode: 0, stdout: "active\n", stderr: "" }];
    runner.results = [{ exitCode: 4, stdout: "", stderr: "unexpected status" }];
    expect((await manager.inspect()).service).toBe("unknown");
    expect(await manager.inspect()).toMatchObject({ definition: "current", service: "running" });
    fs.files.set(manager.definitionPath, "tampered");
    runner.results = [{ exitCode: 1, stdout: "failed\n", stderr: "x".repeat(1000) }];
    const status = await manager.inspect();
    expect(status.definition).toBe("drifted");
    expect(status.service).toBe("failed");
    expect(status.diagnostics.length).toBeLessThanOrEqual(512);
  });
  it("bootstraps an unloaded current Mac agent and restart recovers after stop", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new MacLaunchAgentManager(spec, { ...options(fs, runner), uid: 501 });
    fs.files.set(manager.definitionPath, renderMacLaunchAgentDefinition(spec));
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "Could not find service" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    await manager.install();
    expect(runner.calls).toContainEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      manager.definitionPath,
    ]);
    runner.calls.length = 0;
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "Could not find service" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    await manager.restart();
    expect(runner.calls[1]).toEqual(["launchctl", "bootstrap", "gui/501", manager.definitionPath]);
  });
  it("waits for launchd to finish removing an upgraded Mac agent before bootstrap", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new MacLaunchAgentManager(spec, { ...options(fs, runner), uid: 501 });
    fs.files.set(manager.definitionPath, "old definition");
    runner.results = [
      { exitCode: 0, stdout: "state = running\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 37, stdout: "", stderr: "Bootstrap failed: 37: Operation already in progress" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    await manager.install();

    expect(
      runner.calls.filter((call) => call[0] === "launchctl" && call[1] === "bootstrap"),
    ).toHaveLength(2);
    expect(fs.files.get(manager.definitionPath)).toBe(renderMacLaunchAgentDefinition(spec));
  });
  it("retries launchd's transient input/output error after replacing a Mac agent", async () => {
    const fs = new MemoryFs();
    const runner = new MemoryRunner();
    const manager = new MacLaunchAgentManager(spec, { ...options(fs, runner), uid: 501 });
    fs.files.set(manager.definitionPath, "old definition");
    runner.results = [
      { exitCode: 0, stdout: "state = running\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    await manager.install();

    expect(
      runner.calls.filter((call) => call[0] === "launchctl" && call[1] === "bootstrap"),
    ).toHaveLength(2);
    expect(fs.files.get(manager.definitionPath)).toBe(renderMacLaunchAgentDefinition(spec));
  });
  it("rejects unsupported executable argv and never emits a canary", () => {
    const canary = "API_TOKEN_CANARY";
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, argv: [...spec.argv, canary] },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new LinuxSystemdUserManager(
          { ...spec, executable: "/opt/omp/bin/omp", argv: ["appserver", "serve"] },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
    expect(
      () =>
        new LinuxSystemdUserManager(
          {
            ...spec,
            executable: "/Applications/Omperator.app/Contents/Resources/runtime/t4-host",
            argv: ["serve", "--omp", "/opt/omp/bin/omp", "--profile", "other"],
          },
          options(new MemoryFs(), new MemoryRunner()),
        ),
    ).toThrow(ServiceValidationError);
  });
  it("renders the standalone T4 host with an explicit OMP bridge executable and profile", () => {
    const hostSpec: ServiceSpec = {
      ...spec,
      executable: "/Applications/Omperator.app/Contents/Resources/runtime/t4-host",
      argv: ["serve", "--omp", "/opt/omp/bin/omp", "--profile", "default"],
    };
    const content = renderLinuxSystemdDefinition(hostSpec);
    expect(content).toContain(
      'ExecStart="/Applications/Omperator.app/Contents/Resources/runtime/t4-host" "serve" "--omp" "/opt/omp/bin/omp" "--profile" "default"',
    );
    expect(content).toContain("Description=Omperator host (default)");
  });
});

describe("official authority argv", () => {
  const OFFICIAL = [
    "--omp-authority",
    "official",
    "--omp-sessions-root",
    "/tmp/omperator-dev/host-state/official-sessions/default",
  ];
  const STATE = ["--state-root", "/tmp/omperator-dev/host-state"];
  const withArgv = (...extra: string[]): ServiceSpec => ({ ...spec, argv: [...spec.argv, ...extra] });

  // Both renderers share validateSpec, so each accepted or rejected shape is
  // checked through both service definitions rather than the validator alone.
  const render = {
    launchd: renderMacLaunchAgentDefinition,
    systemd: renderLinuxSystemdDefinition,
  };

  for (const [name, renderDefinition] of Object.entries(render)) {
    it(`accepts official authority with and without a state root on ${name}`, () => {
      expect(renderDefinition(withArgv(...OFFICIAL, ...STATE))).toContain(
        "/tmp/omperator-dev/host-state/official-sessions/default",
      );
      expect(renderDefinition(withArgv(...STATE))).toContain("--state-root");
    });

    it(`rejects malformed or reordered official argv on ${name}`, () => {
      const rejected: readonly (readonly string[])[] = [
        ["--omp-authority", "official", "--omp-sessions-root", "relative/official-sessions/default"],
        ["--omp-authority", "official"],
        ["--omp-sessions-root", "/tmp/x/official-sessions/default"],
        [...STATE, ...OFFICIAL],
        [...OFFICIAL, ...STATE, "--extra"],
        // A sessions root outside the derived location would let lockless
        // authority claim a directory the OMP TUI co-owns.
        ["--omp-authority", "official", "--omp-sessions-root", "/tmp/shared/.omp", ...STATE],
        [
          "--omp-authority",
          "official",
          "--omp-sessions-root",
          "/tmp/omperator-dev/host-state/official-sessions/other",
          ...STATE,
        ],
        // Sessions root must belong to the state root that is also declared.
        [...OFFICIAL, "--state-root", "/tmp/elsewhere"],
      ];
      for (const extra of rejected) {
        expect(() => renderDefinition(withArgv(...extra))).toThrow(ServiceValidationError);
      }
    });
  }
});
