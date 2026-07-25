import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import {
  createSafeServiceEnvironment,
  discoverOmpExecutable,
  discoverT4HostExecutable,
  inspectPathOmpCompatibility,
  NodeServiceRunner,
  OmpAppserverCompatibilityError,
  probeOmpAppserver,
  repairAppserverService,
} from "../src/service.ts";
import type { ServiceManager } from "@t4-code/service-manager";

const bridgeHelpResult = {
  exitCode: 0,
  signal: null,
  stdout:
    "Expose the private OMP authority bridge used by T4 Code\n\nFLAGS\n  --stdio  Use the versioned JSON-lines standard I/O transport\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
} as const;

const stoppedStatusResult = {
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({ state: "stopped", reason: "unreachable" }),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
} as const;

describe("desktop lifecycle boundaries", () => {
  it("discovers only an executable standalone T4 host path", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-host-discovery-"));
    const executable = join(root, "t4-host");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    expect(
      await discoverT4HostExecutable({
        environment: { T4_HOST_EXECUTABLE: executable, PATH: "" },
        homeDirectory: root,
      }),
    ).toBe(executable);
    expect(
      await discoverT4HostExecutable({
        environment: { T4_HOST_EXECUTABLE: join(root, "wrong-name"), PATH: "" },
        homeDirectory: root,
      }),
    ).toBeUndefined();
  });
  it("only discovers bounded executable candidates and honors explicit environment", async () => {
    const executable = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: "/not/a/real/omp", PATH: "" },
      homeDirectory: "/not/a/home",
    });
    expect(executable).toBe(undefined);
  });
  it("uses explicit executable before PATH and ignores renderer URL as a service candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const explicitDir = join(root, "explicit");
    const pathDir = join(root, "path");
    await mkdir(explicitDir);
    await mkdir(pathDir);
    const explicit = join(explicitDir, "omp");
    const pathCandidate = join(pathDir, "omp");
    await writeFile(explicit, "");
    await writeFile(pathCandidate, "");
    await chmod(explicit, 0o755);
    await chmod(pathCandidate, 0o755);
    const probeRunner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.args?.[0] === "bridge" ? bridgeHelpResult : stoppedStatusResult),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: {
          OMP_EXECUTABLE: explicit,
          PATH: pathDir,
          OMP_DESKTOP_RENDERER_URL: "http://127.0.0.1:5173/",
        },
        homeDirectory: root,
        runner: probeRunner,
      }),
    ).toBe(explicit);
    expect(
      await discoverOmpExecutable({
        environment: { PATH: "", OMP_DESKTOP_RENDERER_URL: explicit },
        homeDirectory: root,
        runner: probeRunner,
      }),
    ).toBeUndefined();
  });
  it("rejects an executable that does not implement appserver status", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(
          spec.args?.[0] === "bridge"
            ? bridgeHelpResult
            : {
                ...stoppedStatusResult,
                stdout: "normal agent help",
              },
        ),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner,
      }),
    ).toBeUndefined();
  });
  it("rejects a legacy appserver build that does not expose the authority bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async () => {
        calls += 1;
        return { kill: () => {}, result: Promise.resolve(stoppedStatusResult) };
      },
    };
    const error = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: executable, PATH: "" },
      homeDirectory: root,
      runner,
    }).catch((cause: unknown) => cause);
    expect(error instanceof OmpAppserverCompatibilityError).toBe(true);
    expect(calls).toBe(1);
  });
  it("reports old OMP builds that reject the required JSON status flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls += 1;
        if (spec.args?.[0] === "bridge") {
          return { kill: () => {}, result: Promise.resolve(bridgeHelpResult) };
        }
        expect(spec.args).toEqual(["appserver", "status", "--json"]);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "Error: unknown flag: --json\nRun omp --help for usage.\n",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    const error = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: executable, PATH: "" },
      homeDirectory: root,
      runner,
    }).catch((cause: unknown) => cause);
    expect(error instanceof OmpAppserverCompatibilityError).toBe(true);
    if (!(error instanceof OmpAppserverCompatibilityError))
      throw new Error("expected compatibility error");
    expect(error.code).toBe("omp_authority_bridge_required");
    expect(error.message.includes("requires the versioned `omp bridge --stdio`")).toBe(true);
    expect(calls).toBe(2);
  });
  it("detects mixed PATH candidates instead of blessing only the first compatible one", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const oldDir = join(root, "old");
    const newDir = join(root, "new");
    await mkdir(oldDir);
    await mkdir(newDir);
    await writeFile(join(oldDir, "omp"), "");
    await writeFile(join(newDir, "omp"), "");
    await chmod(join(oldDir, "omp"), 0o755);
    await chmod(join(newDir, "omp"), 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls += 1;
        if (spec.command === join(newDir, "omp") && spec.args?.[0] === "bridge") {
          return { kill: () => {}, result: Promise.resolve(bridgeHelpResult) };
        }
        if (spec.command === join(newDir, "omp")) {
          return {
            kill: () => {},
            result: Promise.resolve({
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify({ state: "stopped", reason: "unreachable" }),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          };
        }
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "Error: unknown flag: --json",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };

    expect(
      await inspectPathOmpCompatibility({ environment: { PATH: `${oldDir}:${newDir}` }, runner }),
    ).toBe("mixed");
    expect(calls).toBe(3);
  });
  it("scopes named appserver probes without inheriting provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              state: "running",
              health: { ok: true, hostId: "host-fable", epoch: "epoch-fable" },
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };

    expect(
      await probeOmpAppserver(executable, {
        profileId: "fable-swarm",
        environment: {
          HOME: "/home/test",
          PATH: "/usr/bin:/bin",
          ANTHROPIC_API_KEY: "must-not-inherit",
        },
        runner,
      }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["appserver", "status", "--json"]);
    expect(calls[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      OMP_PROFILE: "fable-swarm",
    });
  });
  it("rejects malformed, oversized, and timed-out appserver probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const malformed: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(
          spec.args?.[0] === "bridge" ? bridgeHelpResult : { ...stoppedStatusResult, stdout: "{" },
        ),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: malformed,
      }),
    ).toBeUndefined();
    const oversized: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(
          spec.args?.[0] === "bridge"
            ? bridgeHelpResult
            : { ...stoppedStatusResult, stdout: "x".repeat(17 * 1024) },
        ),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: oversized,
      }),
    ).toBeUndefined();
    const timedOut: ProcessRunner = {
      spawn: async (spec, signal) => {
        if (spec.args?.[0] === "bridge") {
          return { kill: () => {}, result: Promise.resolve(bridgeHelpResult) };
        }
        const result = Promise.withResolvers<{
          exitCode: number | null;
          signal: null;
          stdout: string;
          stderr: string;
          stdoutTruncated: boolean;
          stderrTruncated: boolean;
        }>();
        signal?.addEventListener(
          "abort",
          () =>
            result.resolve({
              exitCode: null,
              signal: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          { once: true },
        );
        return { kill: () => {}, result: result.promise };
      },
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: timedOut,
        timeoutMs: 10,
      }),
    ).toBeUndefined();
  });
  it("does not execute ompd candidates that have no status CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "ompd");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async () => {
        calls += 1;
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "{}",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner,
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("passes only desktop service environment keys and keeps argv shell-free", async () => {
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    const environment = {
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      TMPDIR: "/tmp/test",
      OMP_TOKEN: "secret",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      PROVIDER_API_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      UNRELATED: "discard",
    };

    await new NodeServiceRunner({ environment, runner }).run([
      "systemctl",
      "--user",
      "start",
      "t4-code.service",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "systemctl",
      args: ["--user", "start", "t4-code.service"],
    });
    expect(calls[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      TMPDIR: "/tmp/test",
    });
    expect("shell" in (calls[0] ?? {})).toBe(false);
    expect(calls[0]?.args?.join(" ")).not.toContain("|");
    expect(calls[0]?.args?.join(" ")).not.toContain(";");
  });

  it("kills and settles a service command that exceeds its deadline", async () => {
    let killed = 0;
    const runner: ProcessRunner = {
      spawn: async (_spec, signal) => ({
        kill: () => {
          killed += 1;
        },
        result: new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            killed += 1;
            resolve({
              exitCode: null,
              signal: "SIGTERM",
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          });
        }),
      }),
    };

    await expect(
      new NodeServiceRunner({ runner, timeoutMs: 10 }).run(["launchctl", "kickstart", "-k", "gui/501/net.t4code.app"]),
    ).rejects.toThrow("launchctl timed out after 10ms");
    expect(killed).toBe(1);
  });

  it("rejects invalid service command deadlines", () => {
    expect(() => new NodeServiceRunner({ timeoutMs: 0 })).toThrow(
      "service command timeout must be between 1 and 60000ms",
    );
    expect(() => new NodeServiceRunner({ timeoutMs: 60_001 })).toThrow(
      "service command timeout must be between 1 and 60000ms",
    );
  });

  it("omits absent service environment values", () => {
    expect(
      createSafeServiceEnvironment({
        HOME: "/home/test",
        PATH: undefined,
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: undefined,
        TMPDIR: "",
        OMP_PASSWORD: "secret",
      }),
    ).toEqual({
      HOME: "/home/test",
      XDG_RUNTIME_DIR: "/run/user/1000",
      TMPDIR: "",
    });
  });

  it("repairs a current but unregistered appserver after one transient start failure", async () => {
    const calls: string[] = [];
    let running = false;
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return {
          definition: "current",
          service: running ? "running" : "stopped",
          diagnostics: "",
        };
      },
      install: async () => {
        calls.push("install");
        running = true;
      },
      start: async () => {
        calls.push("start");
        throw new Error("launchd was still removing the old registration");
      },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect", "start", "inspect", "install", "inspect"]);
  });

  it("does not rewrite a healthy appserver service", async () => {
    const calls: string[] = [];
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return { definition: "current", service: "running", diagnostics: "ready" };
      },
      install: async () => { calls.push("install"); },
      start: async () => { calls.push("start"); },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect"]);
  });

  it("lets an appserver that is already starting finish without restarting it", async () => {
    const calls: string[] = [];
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return { definition: "current", service: "starting", diagnostics: "launching" };
      },
      install: async () => { calls.push("install"); },
      start: async () => { calls.push("start"); },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect"]);
  });
});
