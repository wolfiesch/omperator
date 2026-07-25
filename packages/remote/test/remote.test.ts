
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { NodeProcessRunner, runProcess, ProcessTimeoutError, type ProcessResult, type ProcessRunner, type PathProbe } from "../src/process.ts";
import {
  buildTailscaleEndpointCandidates,
  discoverTailscaleExecutable,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  parseTailscaleStatus,
  suggestTailscaleServe,
  TailscaleCliNotFoundError,
  TailscaleCommandError,
  TailscaleServeSuggestionError,
  TailscaleStatusParseError,
  readTailscaleStatus,
} from "../src/tailscale.ts";
import {
  buildSshArgv,
  buildSshShellCommand,
  decideSshAuthMethod,
  redactSshOutput,
  runSshCommand,
  type SshTarget,
  SshCommandError,
  SshInvalidTargetError,
} from "../src/ssh.ts";
import { type Clock, resolveLoopbackSshHttpBaseUrl, startSshTunnel, waitForHttpReady, SshTunnelError } from "../src/tunnel.ts";

const statusJson = JSON.stringify({ Self: { DNSName: "desktop.tail.ts.net.", TailscaleIPs: ["100.100.100.100", "fd7a:115c:a1e0::1", "192.168.1.4"] } });
const target: SshTarget = { alias: "devbox", hostname: "devbox.example.com", username: "julius", port: 2222 };

function result(value: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, ...value };
}
function fakeRunner(output: ProcessResult | Error): ProcessRunner {
  return { spawn: async () => {
    if (output instanceof Error) throw output;
    return { result: Promise.resolve(output), kill: () => undefined };
  } };
}
class FakeProbe implements PathProbe {
  readonly files: readonly string[];
  readonly pathCommand: string | null;
  constructor(files: readonly string[] = [], pathCommand: string | null = null) {
    this.files = files;
    this.pathCommand = pathCommand;
  }
  exists(path: string): Promise<boolean> { return Promise.resolve(this.files.includes(path)); }
  which(): Promise<string | null> { return Promise.resolve(this.pathCommand); }
}
function abortableRunner(): ProcessRunner {
  return {
    spawn: async (_spec, signal) => {
      const { promise, resolve } = Promise.withResolvers<ProcessResult>();
      const kill = () => resolve(result({ exitCode: 143 }));
      if (signal?.aborted) kill();
      else signal?.addEventListener("abort", kill, { once: true });
      return { result: promise, kill };
    },
  };
}
class FakeClock implements Clock {
  current = 0;
  now(): number { return this.current; }
  sleep(ms: number): Promise<void> { this.current += ms; return Promise.resolve(); }
}

it("parses MagicDNS, strict tailnet IPv4, and status facts", () => {
  expect(parseTailscaleMagicDnsName(statusJson)).toBe("desktop.tail.ts.net");
  expect(parseTailscaleMagicDnsName("{}")).toBeNull();
  expect(parseTailscaleStatus(statusJson)).toEqual({ magicDnsName: "desktop.tail.ts.net", tailnetIpv4Addresses: ["100.100.100.100"] });
  expect(isTailscaleIpv4Address("100.64.0.1")).toBe(true);
  expect(isTailscaleIpv4Address("100.64.0.1oops")).toBe(false);
  expect(isTailscaleIpv4Address("100.128.0.1")).toBe(false);
  expect(() => parseTailscaleStatus("not-json")).toThrow(TailscaleStatusParseError);
});

it("builds explicit direct and Serve WebSocket endpoint candidates", () => {
  const status = parseTailscaleStatus(statusJson);
  expect(buildTailscaleEndpointCandidates({ status })).toEqual([
    { transport: "direct", kind: "magicdns", host: "desktop.tail.ts.net", url: "ws://desktop.tail.ts.net:4879/" },
    { transport: "direct", kind: "ipv4", host: "100.100.100.100", url: "ws://100.100.100.100:4879/" },
  ]);
  expect(buildTailscaleEndpointCandidates({ status, transport: "serve" })).toEqual([
    { transport: "serve", kind: "magicdns", host: "desktop.tail.ts.net", url: "wss://desktop.tail.ts.net:8445/" },
  ]);
});

it("discovers platform-specific CLI candidates without spawning", async () => {
  await expect(discoverTailscaleExecutable({ platform: "darwin", probe: new FakeProbe(["/opt/homebrew/bin/tailscale"]) })).resolves.toBe("/opt/homebrew/bin/tailscale");
  await expect(discoverTailscaleExecutable({ platform: "linux", probe: new FakeProbe([], "/custom/bin/tailscale") })).resolves.toBe("/custom/bin/tailscale");
  await expect(discoverTailscaleExecutable({ platform: "darwin", probe: new FakeProbe() })).rejects.toBeInstanceOf(TailscaleCliNotFoundError);
});

it("keeps Tailscale command diagnostics bounded and secret-free", async () => {
  const syntheticToken = `${["ts", "key"].join("")}-${["auth", "secret", "token", "value"].join("-")}`;
  const error = await readTailscaleStatus({ runner: fakeRunner(result({ exitCode: 7, stderr: syntheticToken })), executable: "tailscale", timeoutMs: 20 }).catch((cause) => cause);
  expect(error).toBeInstanceOf(TailscaleCommandError);
  expect((error as TailscaleCommandError).message).toBe("tailscale status exited with code 7.");
  expect((error as TailscaleCommandError).message).not.toContain(syntheticToken);
  expect((error as TailscaleCommandError).message).not.toContain("tskey");
});
it("aborts stalled status processes on timeout and cancellation", async () => {
  const timeout = await readTailscaleStatus({ runner: abortableRunner(), executable: "tailscale", timeoutMs: 1 }).catch((cause) => cause);
  expect(timeout).toMatchObject({ kind: "timeout", details: { timeoutMs: 1 } });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await readTailscaleStatus({ runner: abortableRunner(), executable: "tailscale", signal: controller.signal }).catch((cause) => cause);
  expect(cancelled).toMatchObject({ kind: "cancelled" });
});

it("suggests loopback Serve only and never Funnel or wildcard bind", () => {
  expect(suggestTailscaleServe({ localPort: 4879, servePort: 8445 })).toEqual({ executable: "tailscale", args: ["serve", "--bg", "--https=8445", "http://127.0.0.1:4879"], sideEffect: "manual-only" });
  expect(() => suggestTailscaleServe({ localPort: 4879, mode: "funnel" })).toThrow(TailscaleServeSuggestionError);
  expect(() => suggestTailscaleServe({ localPort: 4879, localHost: "0.0.0.0" })).toThrow(TailscaleServeSuggestionError);
});

it("builds direct SSH argv and quotes hostile paths without shell execution", () => {
  const argv = buildSshArgv(target, { platform: "win32", identityFile: "/tmp/key with spaces;$(touch pwned)", remoteCommandArgs: ["printf", "a'b"] });
  expect(argv.command).toBe("ssh.exe");
  expect(argv.args).toContain("/tmp/key with spaces;$(touch pwned)");
  expect(buildSshShellCommand({ command: "ssh", args: ["a'b", "space path"] })).toBe("'ssh' 'a'\\''b' 'space path'");
});

it("decides auth without treating Tailscale identity as authorization and redacts secrets", () => {
  expect(decideSshAuthMethod()).toBe("batch");
  expect(decideSshAuthMethod({ interactiveAuth: true })).toBe("interactive");
  expect(decideSshAuthMethod({ authSecret: "pairing-secret" })).toBe("askpass");
  expect(redactSshOutput('{"credential":"pairing-secret"}')).toBe('{"credential":"[redacted]"}');
});

it("rejects untrusted SSH option-like and whitespace targets", () => {
  expect(() => buildSshArgv({ ...target, alias: "-oProxyCommand=evil" })).toThrow(SshInvalidTargetError);
  expect(() => buildSshArgv({ ...target, hostname: "host name" })).toThrow(SshInvalidTargetError);
  expect(() => buildSshArgv({ ...target, username: "bad\nuser" })).toThrow(SshInvalidTargetError);
});
it("returns structured SSH nonzero failures without running a real command", async () => {
  const error = await runSshCommand({ target, runner: fakeRunner(result({ exitCode: 1, stderr: "credential: pairing-secret" })), remoteCommandArgs: ["sh", "-s"], timeoutMs: 20 }).catch((cause) => cause);
  expect(error).toBeInstanceOf(SshCommandError);
  expect((error as SshCommandError).message).not.toContain("pairing-secret");
});

it("bounds readiness and preserves diagnostics", async () => {
  const clock = new FakeClock();
  await expect(waitForHttpReady({ baseUrl: "http://127.0.0.1:4879", expectedHostId: "host-a", timeoutMs: 20, intervalMs: 10, probe: async () => false, clock })).rejects.toMatchObject({ tag: "SshReadinessError", diagnostics: { timeoutMs: 20 } });
  expect(() => resolveLoopbackSshHttpBaseUrl("http://0.0.0.0:4879")).toThrow();
  expect(() => resolveLoopbackSshHttpBaseUrl("https://127.0.0.1:4879")).toThrow();
});

it("kills tunnel process on readiness timeout and cancellation", async () => {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  let killed = 0;
  const runner: ProcessRunner = { spawn: async () => ({ result: promise, kill: () => { killed += 1; resolve(result({ exitCode: 143 })); } }) };
  const clock = new FakeClock();
  await expect(startSshTunnel({ target, localPort: 4879, runner, expectedHostId: "host-a", readinessTimeoutMs: 10, clock, probe: async () => false })).rejects.toBeDefined();
  expect(killed).toBe(1);
  expect(new SshTunnelError("x").message).toBe("x");
});
it("parses peer/user suggestions, excludes self, deduplicates, and sorts online first", () => {
  const raw = JSON.stringify({
    Self: { ID: "self", DNSName: "self.tail.ts.net", TailscaleIPs: ["100.64.0.1"] },
    User: { one: { LoginName: "alice@example.com" }, two: { LoginName: "bob@example.com" } },
    Peer: {
      a: { ID: "self", UserID: "one", Online: true, Active: true, OS: "linux", DNSName: "self.tail.ts.net", TailscaleIPs: ["100.64.0.1"] },
      b: { ID: "node-b", UserID: "two", Online: false, Active: false, OS: "windows", DNSName: "b.tail.ts.net", TailscaleIPs: ["100.64.0.2", "192.168.1.1"] },
      c: { ID: "node-b", UserID: "two", Online: true, Active: true, OS: "windows", DNSName: "b.tail.ts.net", TailscaleIPs: ["100.64.0.2"] },
    },
  });
  expect(parseTailscaleStatus(raw).peers).toEqual([{ nodeId: "node-b", login: "bob@example.com", os: "windows", online: true, active: true, magicDnsName: "b.tail.ts.net", tailnetIpv4Addresses: ["100.64.0.2"] }]);
});

it("accounts bounded process capture in linear time and marks truncation", async () => {
  const handle = await new NodeProcessRunner().spawn({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(200000))"] });
  const value = await handle.result;
  expect(Buffer.byteLength(value.stdout)).toBe(64 * 1024);
  expect(value.stdoutTruncated).toBe(true);
});
it("drains stdout completely on fast exit without truncating untruncated output", async () => {
  const handle = await new NodeProcessRunner().spawn({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello world')"],
  });
  const value = await handle.result;
  expect(value.stdout).toBe("hello world");
  expect(value.stdoutTruncated).toBe(false);
});

it("throws ProcessTimeoutError promptly when a process or grandchild holds stdio pipes open", async () => {
  const runner = new NodeProcessRunner();
  const start = Date.now();
  const pidFile = join(tmpdir(), `t4-test-grandchild-pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    const error = await runProcess({
      runner,
      command: process.execPath,
      args: [
        "-e",
        `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.exit(0);`,
      ],
      timeoutMs: 150,
    }).catch((cause) => cause);

    const duration = Date.now() - start;
    expect(error).toBeInstanceOf(ProcessTimeoutError);
    expect(duration).toBeLessThan(1000);
  } finally {
    try {
      const pidText = await readFile(pidFile, "utf8");
      const grandchildPid = Number(pidText.trim());
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        process.kill(grandchildPid, "SIGKILL");
      }
    } catch {}
    await unlink(pidFile).catch(() => {});
  }
});
it("rejects truncated status output before JSON parsing", async () => {
  const error = await readTailscaleStatus({ executable: "tailscale", runner: fakeRunner(result({ stdout: "{}", stdoutTruncated: true })) }).catch((cause) => cause);
  expect(error).toMatchObject({ tag: "TailscaleCommandError", kind: "truncated", details: { stream: "stdout" } });
});
it("accepts structured SSH health only when child stays alive and identity matches", async () => {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  let killed = 0;
  const runner: ProcessRunner = { spawn: async () => ({ result: promise, kill: () => { killed += 1; resolve(result({ exitCode: 143 })); } }) };
  const handle = await startSshTunnel({ target, localPort: 4879, expectedHostId: "host-a", runner, readinessTimeoutMs: 10, probe: async () => ({ ready: true, protocolVersion: 1, hostId: "host-a" }), clock: new FakeClock() });
  await handle.stop();
  expect(killed).toBe(1);
});
