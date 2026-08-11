import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NodeProcessRunner,
  runProcess,
  type ProcessRunner,
} from "@t4-code/remote";
import type { PhoneSetupState } from "@t4-code/protocol/desktop-ipc";

const LOCAL_GATEWAY_PORT = 4_194;
const RENDEZVOUS_URL_DEFAULT = "https://wickrunner.com:8445";
const RELAY_URL_DEFAULT = "wss://wickrunner.com:8443";

export interface PhoneSetupServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly resourcesPath: string;
  readonly electronExecutable: string;
  readonly runner?: ProcessRunner;
}

export class PhoneSetupService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly resourcesPath: string;
  private readonly electronExecutable: string;
  private readonly runner: ProcessRunner;
  private configureOperation: Promise<PhoneSetupState> | undefined;
  private restoreOperation: Promise<PhoneSetupState> | undefined;

  constructor(options: PhoneSetupServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.resourcesPath = options.resourcesPath;
    this.electronExecutable = options.electronExecutable;
    this.runner = options.runner ?? new NodeProcessRunner();
  }

  inspect(): Promise<PhoneSetupState> {
    if (this.configureOperation) return this.configureOperation;
    if (this.restoreOperation) return this.restoreOperation;
    return this.inspectInternal();
  }

  configure(): Promise<PhoneSetupState> {
    if (this.configureOperation) return this.configureOperation;
    const restore = this.restoreOperation;
    const operation = (restore === undefined ? this.configureInternal() : restore.then(() => this.configureInternal())).catch((error: unknown) => ({
      phase: "error" as const,
      message: error instanceof Error ? error.message.slice(0, 512) : "Phone setup could not be completed.",
    }));
    this.configureOperation = operation;
    void operation.finally(() => { if (this.configureOperation === operation) this.configureOperation = undefined; });
    return operation;
  }

  restore(): Promise<PhoneSetupState> {
    if (this.configureOperation) return this.configureOperation;
    if (this.restoreOperation) return this.restoreOperation;
    const operation = this.restoreInternal().catch((error: unknown) => ({
      phase: "error" as const,
      message: error instanceof Error ? error.message.slice(0, 512) : "Phone access could not be restored.",
    }));
    this.restoreOperation = operation;
    void operation.finally(() => { if (this.restoreOperation === operation) this.restoreOperation = undefined; });
    return operation;
  }

  private unsupported(): PhoneSetupState | undefined {
    if (this.platform !== "darwin" || this.arch !== "arm64") {
      return { phase: "unsupported", message: "One-click phone setup currently requires the Apple Silicon Mac app." };
    }
    return undefined;
  }

  private async identity(): Promise<string> {
    const manifest = await readFile(join(this.resourcesPath, "runtime", "manifest.json"));
    return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  }

  /** Public origin the phone opens to pair through the rendezvous. */
  private publicOrigin(): string {
    const rendezvous = process.env.T4_RENDEZVOUS_URL?.trim() || RENDEZVOUS_URL_DEFAULT;
    try {
      const url = new URL(rendezvous);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return `${rendezvous.replace(/\/+$/u, "")}/`;
    }
  }

  private async runGatewayService(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return runProcess({
      runner: this.runner,
      command: this.electronExecutable,
      args: [join(this.resourcesPath, "gateway", "gateway-service.mjs"), ...args],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: 20_000,
    });
  }

  private installGateway(origin: string, deploymentIdentity: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const rendezvousUrl = process.env.T4_RENDEZVOUS_URL?.trim();
    const relayUrl = process.env.T4_RELAY_URL?.trim();
    return this.runGatewayService([
      "install",
      "--origin", origin,
      "--web-root", join(this.resourcesPath, "web"),
      "--deployment-identity", deploymentIdentity,
      "--rendezvous-url", rendezvousUrl || RENDEZVOUS_URL_DEFAULT,
      "--relay-url", relayUrl || RELAY_URL_DEFAULT,
      "--electron-run-as-node",
    ]);
  }

  private async repairStaleGateway(deploymentIdentity: string): Promise<void> {
    let status: { exitCode: number | null; stdout: string; stderr: string };
    try {
      status = await this.runGatewayService(["status", "--deployment-identity", deploymentIdentity]);
    } catch {
      return;
    }
    if (!/^deployment identity:\s*stale\s*$/imu.test(status.stdout)) return;
    const install = await this.installGateway(this.publicOrigin(), deploymentIdentity);
    if (install.exitCode !== 0) {
      throw new Error(install.stderr.trim().slice(0, 512) || "The phone gateway could not be upgraded.");
    }
  }

  private async gatewayIsHealthy(deploymentIdentity: string): Promise<boolean> {
    try {
      const service = await this.runGatewayService(["status", "--deployment-identity", deploymentIdentity]);
      return service.exitCode === 0 && /health:\s*healthy/iu.test(service.stdout);
    } catch {
      return false;
    }
  }

  private async waitForHealthyGateway(deploymentIdentity: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (await this.gatewayIsHealthy(deploymentIdentity)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
    return false;
  }

  private async fetchPairCode(): Promise<string | undefined> {
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 3_000);
      try {
        const response = await fetch(`http://127.0.0.1:${LOCAL_GATEWAY_PORT}/v1/pair-code`, { signal: abort.signal });
        if (!response.ok) return undefined;
        const body: unknown = await response.json();
        if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
        const code = (body as Record<string, unknown>).code;
        return typeof code === "string" && /^\d{6}$/u.test(code) ? code : undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    }
  }

  private readyMessage(pairCode: string | undefined): string {
    return pairCode === undefined
      ? "Phone access is ready — open Omperator on your phone; it will find this computer automatically."
      : `Phone access is ready — enter the code on your phone: ${pairCode}`;
  }

  private async inspectInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    const url = this.publicOrigin();
    try {
      const service = await this.runGatewayService(["status", "--deployment-identity", await this.identity()]);
      if (service.exitCode === 0) {
        if (/health:\s*healthy/iu.test(service.stdout)) {
          const code = await this.fetchPairCode();
          return {
            phase: "ready",
            message: this.readyMessage(code),
            url,
            ...(code === undefined ? {} : { pairCode: code }),
          };
        }
        return {
          phase: "error",
          message: "Phone access is installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
          url,
        };
      }
    } catch {}
    return {
      phase: "not-configured",
      message: "Set up private phone access, then open Omperator on your phone; it will find this computer automatically.",
      url,
    };
  }

  private async configureInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    const deploymentIdentity = await this.identity();
    const origin = this.publicOrigin();
    const service = await this.installGateway(origin, deploymentIdentity);
    if (service.exitCode !== 0) {
      return { phase: "error", message: service.stderr.trim().slice(0, 512) || "The phone gateway could not start." };
    }
    if (!await this.waitForHealthyGateway(deploymentIdentity)) {
      return {
        phase: "error",
        message: "Phone access was installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
        url: origin,
      };
    }
    const code = await this.fetchPairCode();
    return {
      phase: "ready",
      message: this.readyMessage(code),
      url: origin,
      ...(code === undefined ? {} : { pairCode: code }),
    };
  }

  private async restoreInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    const deploymentIdentity = await this.identity();
    await this.repairStaleGateway(deploymentIdentity);
    if (await this.gatewayIsHealthy(deploymentIdentity)) {
      const code = await this.fetchPairCode();
      return {
        phase: "ready",
        message: this.readyMessage(code),
        url: this.publicOrigin(),
        ...(code === undefined ? {} : { pairCode: code }),
      };
    }
    const origin = this.publicOrigin();
    const service = await this.installGateway(origin, deploymentIdentity);
    if (service.exitCode !== 0) {
      return { phase: "error", message: service.stderr.trim().slice(0, 512) || "The phone gateway could not restart." };
    }
    if (!await this.waitForHealthyGateway(deploymentIdentity)) {
      return {
        phase: "error",
        message: "Phone access restarted, but the local OMP runtime is not ready yet. Open Hosts, restart the default OMP profile, then check again.",
        url: origin,
      };
    }
    const code = await this.fetchPairCode();
    return {
      phase: "ready",
      message: this.readyMessage(code),
      url: origin,
      ...(code === undefined ? {} : { pairCode: code }),
    };
  }
}
