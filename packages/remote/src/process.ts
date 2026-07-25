import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export interface ProcessSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: string;
}
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessHandle {
  readonly result: Promise<ProcessResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface ProcessRunner {
  spawn(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle>;
}

const MAX_CAPTURE_BYTES = 64 * 1024;

function appendOutput(
  state: { readonly chunks: Buffer[]; capturedBytes: number; truncated: boolean },
  chunk: string | Buffer,
): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - state.capturedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const captured = bytes.subarray(0, remaining);
  state.chunks.push(captured);
  state.capturedBytes += captured.byteLength;
  if (bytes.byteLength > remaining) state.truncated = true;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export class NodeProcessRunner implements ProcessRunner {
  spawn(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
    const child = nodeSpawn(spec.command, [...(spec.args ?? [])], {
      shell: false,
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutState = { chunks: [] as Buffer[], capturedBytes: 0, truncated: false };
    const stderrState = { chunks: [] as Buffer[], capturedBytes: 0, truncated: false };
    child.stdout?.on("data", (chunk: string | Buffer) => appendOutput(stdoutState, chunk));
    child.stderr?.on("data", (chunk: string | Buffer) => appendOutput(stderrState, chunk));
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.end(spec.stdin);
    } else {
      child.stdin?.end();
    }

    const { promise: result, resolve, reject } = Promise.withResolvers<ProcessResult>();
    let escalationTimer: NodeJS.Timeout | undefined;
    let exitGraceTimer: NodeJS.Timeout | undefined;
    let resolved = false;

    const clearEscalation = () => {
      clearTimeout(escalationTimer);
      clearTimeout(exitGraceTimer);
      escalationTimer = undefined;
      exitGraceTimer = undefined;
    };

    const finish = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      clearEscalation();
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode,
        signal: signalCode,
        stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
        stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
      });
    };

    const onAbort = () => {
      terminate(child);
      escalationTimer = setTimeout(() => terminate(child, "SIGKILL"), 100);
      exitGraceTimer = setTimeout(() => finish(child.exitCode, child.signalCode), 150);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (cause) => {
      if (resolved) return;
      resolved = true;
      clearEscalation();
      signal?.removeEventListener("abort", onAbort);
      reject(cause);
    });
    child.once("close", (exitCode, signalCode) => {
      finish(exitCode, signalCode);
    });
    return Promise.resolve({
      result,
      kill: (killSignal?: NodeJS.Signals) => terminate(child, killSignal),
    });
  }
}

export class ProcessSpawnError extends Error {
  readonly tag = "ProcessSpawnError" as const;
  readonly command: string;
  constructor(command: string, cause: unknown) {
    super(`Failed to start ${command}.`, { cause });
    this.name = "ProcessSpawnError";
    this.command = command;
  }
}

export class ProcessTimeoutError extends Error {
  readonly tag = "ProcessTimeoutError" as const;
  readonly command: string;
  readonly timeoutMs: number;
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms.`);
    this.name = "ProcessTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export class ProcessCancelledError extends Error {
  readonly tag = "ProcessCancelledError" as const;
  readonly command: string;
  constructor(command: string) {
    super(`${command} was cancelled.`);
    this.name = "ProcessCancelledError";
    this.command = command;
  }
}
export interface RunProcessOptions extends ProcessSpec {
  readonly runner: ProcessRunner;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export async function runProcess(input: RunProcessOptions): Promise<ProcessResult> {
  const controller = new AbortController();
  const removeParentAbort = input.signal
    ? (() => {
        const onAbort = () => controller.abort();
        if (input.signal?.aborted) controller.abort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
        return () => input.signal?.removeEventListener("abort", onAbort);
      })()
    : () => undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const handle = await input.runner.spawn(input, controller.signal).catch((cause) => {
      throw new ProcessSpawnError(input.command, cause);
    });
    const processResult = await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => {
        const checkAbort = () => {
          if (timedOut) reject(new ProcessTimeoutError(input.command, input.timeoutMs));
          else if (controller.signal.aborted) reject(new ProcessCancelledError(input.command));
        };
        if (controller.signal.aborted) checkAbort();
        else controller.signal.addEventListener("abort", checkAbort, { once: true });
      }),
    ]);
    if (timedOut) throw new ProcessTimeoutError(input.command, input.timeoutMs);
    if (input.signal?.aborted) throw new ProcessCancelledError(input.command);
    return processResult;
  } finally {
    clearTimeout(timer);
    removeParentAbort();
  }
}

export interface PathProbe {
  exists(path: string): Promise<boolean>;
  which(command: string): Promise<string | null>;
}

export class NodePathProbe implements PathProbe {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async which(command: string): Promise<string | null> {
    if (isAbsolute(command)) return (await this.exists(command)) ? command : null;
    const pathValue = process.env.PATH ?? "";
    const names = process.platform === "win32" && !command.endsWith(".exe") ? [command, `${command}.exe`] : [command];
    for (const directory of pathValue.split(delimiter)) {
      if (!directory) continue;
      for (const name of names) {
        const candidate = join(directory, name);
        if (await this.exists(candidate)) return candidate;
      }
    }
    return null;
  }
}
