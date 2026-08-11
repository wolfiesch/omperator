import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { NodeProcessRunner, runProcess, ProcessTimeoutError, type ProcessResult, type ProcessRunner } from "../src/process.ts";
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
class FakeClock implements Clock {
  current = 0;
  now(): number { return this.current; }
  sleep(ms: number): Promise<void> { this.current += ms; return Promise.resolve(); }
}

it("builds direct SSH argv and quotes hostile paths without shell execution", () => {
  const argv = buildSshArgv(target, { platform: "win32", identityFile: "/tmp/key with spaces;$(touch pwned)", remoteCommandArgs: ["printf", "a'b"] });
  expect(argv.command).toBe("ssh.exe");
  expect(argv.args).toContain("/tmp/key with spaces;$(touch pwned)");
  expect(buildSshShellCommand({ command: "ssh", args: ["a'b", "space path"] })).toBe("'ssh' 'a'\\''b' 'space path'");
});

it("decides auth without treating host identity as authorization and redacts secrets", () => {
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
it("accepts structured SSH health only when child stays alive and identity matches", async () => {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  let killed = 0;
  const runner: ProcessRunner = { spawn: async () => ({ result: promise, kill: () => { killed += 1; resolve(result({ exitCode: 143 })); } }) };
  const handle = await startSshTunnel({ target, localPort: 4879, expectedHostId: "host-a", runner, readinessTimeoutMs: 10, probe: async () => ({ ready: true, protocolVersion: 1, hostId: "host-a" }), clock: new FakeClock() });
  await handle.stop();
  expect(killed).toBe(1);
});
