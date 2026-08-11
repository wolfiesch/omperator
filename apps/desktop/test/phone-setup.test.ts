import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import { PhoneSetupService } from "../src/phone-setup.ts";

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

  it("turns a connected Mac tailnet into a private QR destination", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "https://rdv.override.example.com");
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    const calls: ProcessSpec[] = [];
    let gatewayInstalled = false;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isStatus = spec.command === "/tailscale" && spec.args?.[0] === "status";
        const isServeStatus = spec.command === "/tailscale" && spec.args?.join(" ") === "serve status --json";
        const isGatewayInspect = spec.command === "/Applications/Omperator.app/Contents/MacOS/Omperator" && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command === "/Applications/Omperator.app/Contents/MacOS/Omperator" && spec.args?.[1] === "install";
        if (isGatewayInstall) gatewayInstalled = true;
        return {
          kill: () => {},
          result: Promise.resolve(isStatus
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : isServeStatus
              ? { exitCode: 0, signal: null, stdout: JSON.stringify({ TCP: { "8445": { HTTPS: true } }, Web: { "work-mac.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:4194" } } } } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
              : isGatewayInspect
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
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => "/tailscale",
    });

    expect(await service.inspect()).toEqual({
      phase: "not-configured",
      message: "Set up private phone access, then open Omperator on your phone; it will find this computer automatically.",
      url: "https://work-mac.example.ts.net:8445/",
    });
    stubPairCode("123456");
    const configured = await service.configure();
    expect(configured).toMatchObject({
      phase: "ready",
      url: "https://work-mac.example.ts.net:8445/",
      pairCode: "123456",
    });
    expect(configured.message).toBe("Phone access is ready — enter the code on your phone: 123456");
    const serve = calls.find((call) =>
      call.command === "/tailscale"
      && call.args?.[0] === "serve"
      && call.args?.[1] === "--bg"
    );
    expect(serve?.args).toEqual(["serve", "--bg", "--https=8445", "http://127.0.0.1:4194"]);
    expect(JSON.stringify(calls)).not.toContain("funnel");
    const install = calls.find((call) => call.command.includes("Omperator") && call.args?.includes("install"));
    expect(install?.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" });
    expect(install?.args).toContain("--electron-run-as-node");
    expect(install?.args).toContain("--rendezvous-url");
    expect(install?.args).toContain("https://rdv.override.example.com");
    expect(install?.args).not.toContain("https://wickrunner.com:8445");
    expect(install?.args).toContain("--relay-url");
    expect(install?.args).toContain("wss://wickrunner.com:8443");
    const installCount = calls.filter((call) => call.args?.[1] === "install").length;
    expect(await service.restore()).toMatchObject({ phase: "ready", pairCode: "123456" });
    expect(calls.filter((call) => call.args?.[1] === "install")).toHaveLength(installCount);
  });

  it("does not show a QR code when Tailscale Serve points somewhere else", async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-stale-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    stubPairCode(undefined);
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.command === "/tailscale" && spec.args?.[0] === "status"
          ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
          : spec.command === "/tailscale"
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ TCP: { "8445": { HTTPS: true } }, Web: { "work-mac.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
      }),
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => "/tailscale",
    });

    const state = await service.inspect();
    expect(state).toMatchObject({ phase: "not-configured" });
    expect(state.pairCode).toBeUndefined();
  });

  it("restarts previously configured phone access when the desktop app opens", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    vi.stubEnv("T4_RELAY_URL", "wss://relay.override.example.com");
    stubPairCode("246810");
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-restore-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    const calls: ProcessSpec[] = [];
    let gatewayInstalled = false;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isStatus = spec.command === "/tailscale" && spec.args?.[0] === "status";
        const isServeStatus = spec.command === "/tailscale" && spec.args?.join(" ") === "serve status --json";
        const isGatewayStatus = spec.command.includes("Omperator") && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command.includes("Omperator") && spec.args?.[1] === "install";
        if (isGatewayInstall) gatewayInstalled = true;
        return {
          kill: () => {},
          result: Promise.resolve(isStatus
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : isServeStatus
              ? { exitCode: 0, signal: null, stdout: JSON.stringify({ TCP: { "8445": { HTTPS: true } }, Web: { "work-mac.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:4194" } } } } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
              : isGatewayStatus && gatewayInstalled
                ? { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }
                : { exitCode: isGatewayInstall ? 0 : 1, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => "/tailscale",
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
    expect(calls.some((call) => call.args?.[0] === "serve" && call.args?.[1] === "--bg")).toBe(false);
  });

  it("upgrades a stale gateway before requiring Tailscale", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-stale-upgrade-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isGatewayStatus = spec.command.includes("Omperator") && spec.args?.[1] === "status";
        const isGatewayInstall = spec.command.includes("Omperator") && spec.args?.[1] === "install";
        return {
          kill: () => {},
          result: Promise.resolve(isGatewayStatus
            ? {
                exitCode: 1,
                signal: null,
                stdout: [
                  "definition: current",
                  "supervisor: running",
                  "health: healthy",
                  "allowed origin: https://work-mac.example.ts.net:8445",
                  "deployment identity: stale",
                ].join("\n"),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            : {
                exitCode: isGatewayInstall ? 0 : 1,
                signal: null,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => { throw new Error("Tailscale is offline."); },
    });

    expect(await service.restore()).toEqual({
      phase: "tailscale-required",
      message: "Tailscale is offline.",
    });
    const install = calls.find((call) => call.args?.[1] === "install");
    expect(install?.args).toContain("https://work-mac.example.ts.net:8445");
    expect(install?.args).toContain("--electron-run-as-node");
    expect(install?.args).toContain("--rendezvous-url");
    expect(install?.args).toContain("https://wickrunner.com:8445");
    expect(install?.args).toContain("--relay-url");
    expect(install?.args).toContain("wss://wickrunner.com:8443");
  });

  it("does not call phone access ready while the local OMP runtime is unreachable", async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-offline-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.command === "/tailscale" && spec.args?.[0] === "status"
          ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
          : spec.command === "/tailscale"
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ TCP: { "8445": { HTTPS: true } }, Web: { "work-mac.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:4194" } } } } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : { exitCode: 1, signal: null, stdout: "health: unhealthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
      }),
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => "/tailscale",
    });

    expect(await service.inspect()).toEqual({
      phase: "error",
      message: "Phone access is installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
      url: "https://work-mac.example.ts.net:8445/",
    });
  });

  it("keeps the old ready message when the gateway has no relay pairing endpoint", async () => {
    vi.stubEnv("T4_RENDEZVOUS_URL", "");
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-no-relay-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    stubPairCode(undefined);
    const runner: ProcessRunner = {
      spawn: async (spec) => ({
        kill: () => {},
        result: Promise.resolve(spec.command === "/tailscale" && spec.args?.[0] === "status"
          ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
          : spec.command === "/tailscale"
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ TCP: { "8445": { HTTPS: true } }, Web: { "work-mac.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:4194" } } } } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : { exitCode: 0, signal: null, stdout: "health: healthy", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
      }),
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/Omperator.app/Contents/MacOS/Omperator",
      runner,
      discoverTailscale: async () => "/tailscale",
    });

    const state = await service.inspect();
    expect(state).toMatchObject({ phase: "ready", url: "https://work-mac.example.ts.net:8445/" });
    expect(state.pairCode).toBeUndefined();
    expect(state.message).toBe("Phone access is ready — open Omperator on your phone; it will find this computer automatically.");
  });
});
