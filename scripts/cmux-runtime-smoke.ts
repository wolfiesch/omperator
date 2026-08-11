#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCmuxRuntime } from "../packages/cmux-runtime/src/index.ts";

function requiredArgs(argv: readonly string[]): { binaryPath: string; buildManifestPath: string } {
  let binaryPath: string | undefined;
  let buildManifestPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--binary" || flag === "--manifest") && (!value || value.startsWith("--")))
      throw new Error(`${flag} requires a value`);
    if (flag === "--binary") {
      binaryPath = resolve(value!);
      index += 1;
    } else if (flag === "--manifest") {
      buildManifestPath = resolve(value!);
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${String(flag)}`);
    }
  }
  if (!binaryPath || !buildManifestPath)
    throw new Error("usage: cmux-runtime-smoke.ts --binary <path> --manifest <path>");
  return { binaryPath, buildManifestPath };
}

const artifact = requiredArgs(process.argv.slice(2));
const runtimeRoot = process.env.T4_HOST_RUNTIME_DIR ?? (process.platform === "darwin" ? "/tmp" : tmpdir());
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(runtimeRoot, "t4c-smoke-"));
const runtimeDirectory = join(root, "r");
const stateDirectory = join(root, "s");
try {
  const first = await startCmuxRuntime({
    ...artifact,
    runtimeId: "cmux-smoke",
    generation: "smoke-1",
    runtimeDirectory,
    stateDirectory,
  });
  await first.stop();
  const second = await startCmuxRuntime({
    ...artifact,
    runtimeId: "cmux-smoke",
    generation: "smoke-2",
    runtimeDirectory,
    stateDirectory,
  });
  const result = {
    protocol: 10,
    firstPid: first.pid,
    secondPid: second.pid,
    durableStateReopened: true,
    privateSocket: second.socketPath,
  };
  await second.stop();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
