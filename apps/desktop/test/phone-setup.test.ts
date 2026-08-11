import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import { PhoneSetupService } from "../src/phone-setup.ts";

const GATEWAY = "/Applications/Omperator.app/Contents/MacOS/Omperator";

describe("phone setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubPairCode(code: string | undefined): void {
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (!url.startsWith("http://127.0.0.1:4194/v1/pair-code")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      const body = code === undefined
        ? { ok: false, error: "relay control is not enabled" }
        : { ok: true, hostId: "sha256:synthetic", code };
      return new Response(JSON.stringify(body), {
        status: code === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  async function setupResources(): Promise<string> {
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    return resourcesPath;
  }

  it("configures public phone access through the rendezvous relay", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "https://rdv.override.example.com");
    const resourcesPath = await setupResources();
    const calls: ProcessSpec[] = [];
    let gatewayInstalled = false;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isGatewayStatus = spec.command === GATEWAY && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command === GATEWAY && spec.args?.[1] === "install";
        if (isGatewayInstall) gatewayInstalled = true;
        return {
          kill: () => {},
          result: Promise.resolve(isGatewayStatus
            ? gatewayInstalled
              ? { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
              : { exitCode: 1, signal: null, stdout: "", stderr: "not installed", stdoutTruncated: false, stderrTruncated: false }
            : { exitCode: 0, signal: null, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    expect(await service.inspect()).toEqual({
      phase: "not-configured",
      message: "Set up private phone access, then open Omperator on your phone; it will find this computer automatically.",
      url: "https://rdv.override.example.com/",
    });
    stubPairCode("123456");
    const configured = await service.configure();
    expect(configured).toMatchObject({
      phase: "ready",
      url: "https://rdv.override.example.com/",
      pairCode: "123456",
    });
    expect(configured.message).toBe("Phone access is ready — enter the code on your phone: 123456");
    const install = calls.find((call) => call.command === GATEWAY && call.args?.includes("install"));
    expect(install?.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" });
    expect(install?.args).toContain("--electron-run-as-node");
    expect(install?.args).toContain("--origin");
    expect(install?.args).toContain("https://rdv.override.example.com/");
    expect(install?.args).toContain("--rendezvous-url");
    expect(install?.args).toContain("https://rdv.override.example.com");
    expect(install?.args).not.toContain("https://wickrunner.com:8445");
    expect(install?.args).toContain("--relay-url");
    expect(install?.args).toContain("wss://wickrunner.com:8443");
    const installCount = calls.filter((call) => call.args?.[1] === "install").length;
    expect(await service.restore()).toMatchObject({ phase: "ready", pairCode: "123456" });
    expect(calls.filter((call) => call.args?.[1] === "install")).toHaveLength(installCount);
  });

  it("reports ready with the rendezvous URL even without a relay pairing endpoint", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    const resourcesPath = await setupResources();
    stubPairCode(undefined);
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.command === GATEWAY && spec.args?.[1] === "status"
          ? { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
          : { exitCode: 1, signal: null, stdout: "", stderr: "not installed", stdoutTruncated: false, stderrTruncated: false }),
      }),
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    const state = await service.inspect();
    expect(state).toMatchObject({ phase: "ready", url: "https://wickrunner.com:8445/" });
    expect(state.pairCode).toBeUndefined();
    expect(state.message).toBe("Phone access is ready — open Omperator on your phone; it will find this computer automatically.");
  });

  it("restarts previously configured phone access when the desktop app opens", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    vi.stubEnv("T4_RELAY_URL", "wss://relay.override.example.com");
    stubPairCode("246810");
    const resourcesPath = await setupResources();
    const calls: ProcessSpec[] = [];
    let gatewayInstalled = false;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isGatewayStatus = spec.command === GATEWAY && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command === GATEWAY && spec.args?.[1] === "install";
        if (isGatewayInstall) gatewayInstalled = true;
        return {
          kill: () => {},
          result: Promise.resolve(isGatewayStatus
            ? gatewayInstalled
              ? { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
              : { exitCode: 1, signal: null, stdout: "", stderr: "not installed", stdoutTruncated: false, stderrTruncated: false }
            : { exitCode: isGatewayInstall ? 0 : 1, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    const restoring = service.restore();
    expect(service.inspect()).toBe(restoring);
    expect(await restoring).toMatchObject({ phase: "ready", pairCode: "246810" });
    expect(calls.some((call) => call.args?.[1] === "install")).toBe(true);
    const restoredInstall = calls.find((call) => call.args?.[1] === "install");
    expect(restoredInstall?.args).toContain("--rendezvous-url");
    expect(restoredInstall?.args).toContain("https://wickrunner.com:8445");
    expect(restoredInstall?.args).toContain("--relay-url");
    expect(restoredInstall?.args).toContain("wss://relay.override.example.com");
    expect(restoredInstall?.args).not.toContain("wss://wickrunner.com:8443");
  });

  it("upgrades a stale gateway against the public rendezvous origin", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    const resourcesPath = await setupResources();
    stubPairCode(undefined);
    const calls: ProcessSpec[] = [];
    let gatewayInstalled = false;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isGatewayStatus = spec.command === GATEWAY && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command === GATEWAY && spec.args?.[1] === "install";
        if (isGatewayInstall) gatewayInstalled = true;
        return {
          kill: () => {},
          result: Promise.resolve(isGatewayStatus
            ? gatewayInstalled
              ? { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
              : {
                  exitCode: 1,
                  signal: null,
                  stdout: [
                    "definition: current",
                    "supervisor: running",
                    "health: healthy",
                    "allowed origin: https://wickrunner.com:8445",
                    "deployment identity: stale",
                  ].join("\n"),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
            : { exitCode: isGatewayInstall ? 0 : 1, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    expect(await service.restore()).toEqual({
      phase: "ready",
      message: "Phone access is ready — open Omperator on your phone; it will find this computer automatically.",
      url: "https://wickrunner.com:8445/",
    });
    const install = calls.find((call) => call.args?.[1] === "install");
    expect(install?.args).toContain("https://wickrunner.com:8445/");
    expect(install?.args).toContain("--electron-run-as-node");
    expect(install?.args).toContain("--rendezvous-url");
    expect(install?.args).toContain("https://wickrunner.com:8445");
    expect(install?.args).toContain("--relay-url");
    expect(install?.args).toContain("wss://wickrunner.com:8443");
  });

  it("does not call phone access ready while the local OMP runtime is unreachable", async () => {
    const resourcesPath = await setupResources();
    stubPairCode(undefined);
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.command === GATEWAY && spec.args?.[1] === "status"
          ? { exitCode: 0, signal: null, stdout: "health: unhealthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
          : { exitCode: 1, signal: null, stdout: "", stderr: "not installed", stdoutTruncated: false, stderrTruncated: false }),
      }),
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    expect(await service.inspect()).toEqual({
      phase: "error",
      message: "Phone access is installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
      url: "https://wickrunner.com:8445/",
    });
  });

  it("rejects unsupported platforms before touching the gateway", async () => {
    const resourcesPath = await setupResources();
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return {
          kill: () => {},
          result: Promise.resolve({ exitCode: 0, signal: null, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "linux",
      arch: "x64",
      resourcesPath,
      electronExecutable: GATEWAY,
      runner,
    });

    expect(await service.inspect()).toEqual({
      phase: "unsupported",
      message: "One-click phone setup currently requires the Apple Silicon Mac app.",
    });
    expect(calls).toHaveLength(0);
  });
});
