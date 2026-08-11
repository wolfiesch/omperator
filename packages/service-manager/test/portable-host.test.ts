import { describe, expect, test } from "vite-plus/test";
import {
  PortableHostService,
  ServiceCommandError,
  ServiceFileError,
  createPortableHostServiceManager,
  type ServiceFileSystem,
  type ServiceRunner,
  type ServiceRunnerResult,
} from "../src/index.ts";

class MemoryFileSystem implements ServiceFileSystem {
  readonly files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async writeAtomic(path: string, content: string) { this.files.set(path, content); }
  async mkdir(_path: string) {}
  async chmod(_path: string, _mode: number) {}
  async remove(path: string) { this.files.delete(path); }
}

class MemoryRunner implements ServiceRunner {
  readonly calls: readonly string[][] = [];
  results: ServiceRunnerResult[] = [];
  async run(argv: readonly string[]) {
    (this.calls as string[][]).push([...argv]);
    return this.results.shift() ?? { exitCode: 0, stdout: "active", stderr: "" };
  }
}

function manager(platform: "linux" | "macos", fs: MemoryFileSystem, runner: MemoryRunner) {
  return createPortableHostServiceManager({
    mode: platform === "linux" ? "single-host" : "local",
    platform,
    profileId: "portable",
    executable: "/opt/omperator/bin/t4-host",
    homeDirectory: "/Users/portable",
    logsDirectory: "/Users/portable/Library/Logs/T4 Code",
    stateRoot: "/Users/portable/.t4-code/portable",
    ompExecutable: "/opt/omperator/runtime/omp",
    uid: 501,
    fs,
    runner,
  });
}

describe("portable LocalDriver service packaging", () => {
  test("uses the existing lifecycle manager and rolls back a partial first install", async () => {
    const fs = new MemoryFileSystem();
    const runner = new MemoryRunner();
    runner.results = [
      { exitCode: 3, stdout: "inactive", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed to enable" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const serviceManager = manager("linux", fs, runner);

    await expect(serviceManager.install()).rejects.toBeInstanceOf(ServiceCommandError);

    expect(await fs.read("/Users/portable/.config/systemd/user/dev.oh-my-pi.appserver.profile.portable.service")).toBeNull();
    expect(runner.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dev.oh-my-pi.appserver.profile.portable"]);
  });

  test("fails closed when a partial-install rollback cannot be proven", async () => {
    const fs = new MemoryFileSystem();
    const runner = new MemoryRunner();
    runner.results = [
      { exitCode: 3, stdout: "inactive", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed to enable" },
      { exitCode: 1, stdout: "", stderr: "daemon reload failed during rollback" },
    ];
    const failure = await manager("linux", fs, runner).install().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceFileError);
    expect((failure as Error).message).toContain("rollback");
  });

  test("advertises truthful non-HA status and delegates safe lifecycle operations", async () => {
    const fs = new MemoryFileSystem();
    const runner = new MemoryRunner();
    const portable = new PortableHostService("local", manager("macos", fs, runner));

    expect(await portable.inspect()).toMatchObject({
      mode: "local",
      highAvailability: { gateway: false, runtime: false },
      writableOmpAuthoritiesPerRuntime: 1,
    });
    await portable.install();
    await portable.start();
    await portable.stop();
    await portable.restart();
    expect(runner.calls.some(call => call[0] === "launchctl" && call.includes("bootstrap"))).toBe(true);
    expect(runner.calls.some(call => call[0] === "launchctl" && call.includes("bootout"))).toBe(true);
    expect(runner.calls.some(call => call[0] === "launchctl" && call.includes("kickstart"))).toBe(true);
  });
});
