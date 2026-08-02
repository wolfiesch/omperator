import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startCmuxRuntime } from "../../cmux-runtime/src/index.js";
import type { Generation, RuntimeId } from "../../portable-core/src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const runtimeId = required("T4_RUNTIME_ID") as RuntimeId;
const generation = required("T4_RUNTIME_GENERATION") as Generation;
const runtimeStatePath = required("T4_RUNTIME_STATE_ROOT");
const statusPath = join(runtimeStatePath, `p1-07-${generation}.json`);
const handle = await startCmuxRuntime({
  binaryPath: required("P107_CMUX_BINARY"),
  buildManifestPath: required("P107_CMUX_MANIFEST"),
  runtimeId,
  generation,
  runtimeDirectory: required("P107_CMUX_RUNTIME_ROOT"),
  stateDirectory: join(runtimeStatePath, "cmux-state"),
  identityTimeoutMs: 15_000,
  startTimeoutMs: 15_000,
  stopTimeoutMs: 2_000,
}).catch(async (error: unknown) => {
  const failure = error as { code?: unknown; message?: unknown };
  await writeFile(`${statusPath}.error`, `${JSON.stringify({
    code: typeof failure.code === "string" ? failure.code : "unknown",
    message: typeof failure.message === "string" ? failure.message : "runtime startup failed",
  })}\n`, { mode: 0o600 });
  throw error;
});
await writeFile(statusPath, `${JSON.stringify({
  runtimeId,
  generation,
  pid: handle.pid,
  socketPath: handle.socketPath,
  stateDirectory: handle.stateDirectory,
})}\n`, { mode: 0o600 });

let stopPromise: Promise<void> | undefined;
const stop = (): Promise<void> => {
  stopPromise ??= handle.stop();
  return stopPromise;
};
const shutdown = (): void => {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  void stop().then(() => process.exit(0), () => process.exit(1));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
const exited = await handle.exited;
if (!stopPromise || !exited.expected) process.exitCode = 1;
