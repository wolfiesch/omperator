import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "@t4-code/remote";

import {
  collectDoctorReport,
  formatDoctorReport,
  inspectTailnet,
  readSourceContract,
  satisfiesCaretVersion,
  type DoctorRuntime,
  type SourceContract,
} from "../src/doctor.ts";
import { OmpAppserverCompatibilityError } from "../src/service.ts";

const contract: SourceContract = {
  nodeEngine: "^24.13.1",
  pnpmVersion: "11.10.0",
  ompVersion: "17.0.4",
  ompTag: "t4code-17.0.4-appserver-5",
  ompUrl: "https://example.test/verified-omp",
};

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.17.0",
    sourceContract: async () => contract,
    pnpmVersion: async () => "11.10.0",
    discoverOmp: async () => "/opt/omp/bin/omp",
    inspectPathOmp: async () => "compatible",
    probeOmp: async () => true,
    profileCount: async () => 3,
    inspectTailnet: async () => "ready",
    ...overrides,
  };
}

describe("T4 setup doctor", () => {
  it("uses current verified runtime metadata", async () => {
    const source = await readSourceContract();

    expect(source.ompVersion).toBe("17.0.5");
    expect(source.ompTag).toBe("t4code-17.0.5-appserver-12");
    expect(source.ompUrl).toBe(
      "https://github.com/wolfiesch/oh-my-pi/tree/t4code-17.0.5-appserver-12",
    );
  });

  it("accepts the checked-in toolchain and a healthy local runtime", async () => {
    const report = await collectDoctorReport(runtime());

    expect(report.ok).toBe(true);
    expect(report.checks.map((item) => [item.id, item.status])).toEqual([
      ["platform", "pass"],
      ["node", "pass"],
      ["pnpm", "pass"],
      ["omp", "pass"],
      ["terminal-omp", "pass"],
      ["appserver", "pass"],
      ["profiles", "pass"],
      ["tailscale", "pass"],
    ]);
    expect(formatDoctorReport(report)).toContain("Required setup checks passed.");
  });

  it("warns when shells and apps can resolve different OMP builds", async () => {
    const report = await collectDoctorReport(
      runtime({ inspectPathOmp: async () => "mixed" }),
    );
    const terminalOmp = report.checks.find((item) => item.id === "terminal-omp");

    expect(report.ok).toBe(true);
    expect(terminalOmp).toMatchObject({ status: "warning", label: "OMP commands" });
    expect(terminalOmp?.detail).toContain("look live in one app but idle or delayed in another");
    expect(terminalOmp?.action).toContain(contract.ompTag);
  });

  it("explains incompatible tools without exposing executable paths or raw errors", async () => {
    const report = await collectDoctorReport(
      runtime({
        nodeVersion: "24.17.0",
        pnpmVersion: async () => "10.0.0",
        discoverOmp: async () => {
          throw new OmpAppserverCompatibilityError();
        },
        profileCount: async () => {
          throw new Error("/private/example/.omp contains REDACT_ME");
        },
        inspectTailnet: async () => "unavailable",
      }),
    );
    const rendered = formatDoctorReport(report);
    expect(report.checks.filter((item) => item.status === "fail").map((item) => item.id)).toEqual([
      "pnpm",
      "omp",
    ]);
    expect(rendered).toContain("does not provide the versioned authority bridge");
    expect(rendered).toContain(contract.ompTag);
    expect(rendered).not.toContain("/private/example");
    expect(rendered).not.toContain("REDACT_ME");
  });

  it("skips subprocess-backed probes when Node.js is unsupported", async () => {
    let probeCalls = 0;
    const blocked = async (): Promise<never> => {
      probeCalls += 1;
      throw new Error("probe should not run");
    };
    const report = await collectDoctorReport(
      runtime({
        nodeVersion: "20.19.0",
        pnpmVersion: blocked,
        discoverOmp: blocked,
        profileCount: blocked,
        inspectTailnet: blocked,
      }),
    );

    expect(report.ok).toBe(false);
    expect(probeCalls).toBe(0);
    expect(report.checks.map((item) => item.id)).toEqual(["platform", "node"]);
    expect(formatDoctorReport(report)).not.toContain("pnpm");
  });

  it("runs the Tailscale status command with a scrubbed environment", async () => {
    let capturedEnvironment: NodeJS.ProcessEnv | undefined;
    const runner: ProcessRunner = {
      spawn(spec) {
        capturedEnvironment = spec.env;
        return Promise.resolve({
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              Self: { DNSName: "desktop.example.ts.net.", TailscaleIPs: ["100.64.0.7"] },
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
          kill: () => undefined,
        });
      },
    };

    const inspection = await inspectTailnet({
      executable: "/usr/bin/tailscale",
      environment: {
        HOME: "/tmp/t4-doctor",
        PATH: "/usr/bin",
        PROVIDER_TOKEN: "must-not-reach-tailscale",
      },
      runner,
    });
    expect(inspection).toBe("ready");
    expect(capturedEnvironment).toEqual({ HOME: "/tmp/t4-doctor", PATH: "/usr/bin" });
  });

  it("treats an optional stopped appserver and missing Tailscale as warnings", async () => {
    const report = await collectDoctorReport(
      runtime({ probeOmp: async () => false, inspectTailnet: async () => "not-installed" }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((item) => item.id === "appserver")?.status).toBe("warning");
    expect(report.checks.find((item) => item.id === "tailscale")?.status).toBe("warning");
  });

  it("keeps mobile targets out of unsupported desktop guidance", async () => {
    const report = await collectDoctorReport(runtime({ arch: "x64" }));
    const platform = report.checks.find((item) => item.id === "platform");

    expect(platform?.status).toBe("warning");
    expect(platform?.action).toBe(
      "Use Linux x86-64 or Apple Silicon macOS for a supported packaged desktop build.",
    );
    expect(platform?.action).not.toContain("Android");
  });

  it("implements the caret range used by the repository", () => {
    expect(satisfiesCaretVersion("24.13.1", "^24.13.1")).toBe(true);
    expect(satisfiesCaretVersion("24.17.0", "^24.13.1")).toBe(true);
    expect(satisfiesCaretVersion("24.12.9", "^24.13.1")).toBe(false);
    expect(satisfiesCaretVersion("25.0.0", "^24.13.1")).toBe(false);
    expect(satisfiesCaretVersion("not-a-version", "^24.13.1")).toBe(false);
  });
});
