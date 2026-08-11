import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  allocateCmuxRuntimePaths,
  CMUX_GHOSTTY_COMMIT,
  CMUX_RUST_TOOLCHAIN,
  CMUX_ZIG_TOOLCHAIN,
  CMUX_SOURCE_COMMIT,
  CMUX_SOURCE_REPOSITORY,
  CMUX_SOURCE_TREE,
  CMUX_TUI_SOURCE_TREE,
  CmuxRuntimeError,
  MAX_CMUX_SOCKET_PATH_BYTES,
  startCmuxRuntime,
  verifyCmuxBinary,
} from "../src/index.ts";

const temporaryRoots: string[] = [];
const expectedVersion = `cmux-tui 0.0.0 (${CMUX_SOURCE_COMMIT}; ghostty ${CMUX_GHOSTTY_COMMIT})`;
function processCanExecute(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}


interface FixtureOptions {
  readonly protocol?: number;
  readonly exitAfterIdentify?: boolean;
  readonly version?: string;
  readonly stubbornDescendant?: boolean;
  readonly detachedDescendant?: boolean;
  readonly versionSideEffect?: string;
}

interface FixtureArtifact {
  readonly binaryPath: string;
  readonly buildManifestPath: string;
}

async function temporaryRoot(): Promise<string> {
  const base = process.env.T4_HOST_RUNTIME_DIR ?? (process.platform === "darwin" ? "/tmp" : tmpdir());
  const path = await mkdtemp(join(base, "t4c-"));
  temporaryRoots.push(path);
  return path;
}

async function createFixture(
  root: string,
  options: FixtureOptions = {},
): Promise<FixtureArtifact> {
  const binaryPath = join(root, "cmux-fixture");
  const buildManifestPath = join(root, "cmux-fixture.manifest.json");
  const protocol = options.protocol ?? 10;
  const exitAfterIdentify = options.exitAfterIdentify ?? false;
  const stubbornDescendant = options.stubbornDescendant ?? false;
  const detachedDescendant = options.detachedDescendant ?? false;
  const version = options.version ?? expectedVersion;
  const versionSideEffect = options.versionSideEffect ?? "";
  const source = `#!${process.execPath}
import { spawn } from "node:child_process";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
const argv = process.argv.slice(2);
const value = flag => argv[argv.indexOf(flag) + 1];
if (argv.includes("--version")) { ${versionSideEffect} process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }
if (argv.includes("identify")) {
  const socket = value("--socket");
  const pid = Number(readFileSync(socket + ".pid", "utf8"));
  process.stdout.write(JSON.stringify({ session: "fixture", protocol: ${protocol}, pid }) + "\\n");
  ${exitAfterIdentify ? `process.kill(pid, "SIGUSR1");` : ""}
  process.exit(0);
}
const socket = value("--socket");
const server = createServer(() => {});
if (${stubbornDescendant ? "true" : "false"}) {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
    { stdio: "ignore", detached: ${detachedDescendant ? "true" : "false"}, cwd: ${detachedDescendant ? `value("--state")` : "undefined"} },
  );
  if (${detachedDescendant ? "true" : "false"}) descendant.unref();
  writeFileSync(socket + ".descendant.pid", String(descendant.pid));
}
server.listen(socket, () => {
  writeFileSync(socket + ".pid", String(process.pid));
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGUSR1", () => process.exit(23));
`;
  await writeFile(binaryPath, source, { mode: 0o755 });
  await chmod(binaryPath, 0o755);
  const binarySha256 = createHash("sha256").update(await readFile(binaryPath)).digest("hex");
  await writeFile(buildManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    artifact: "cmux-tui-headless",
    sourceRepository: CMUX_SOURCE_REPOSITORY,
    sourceCommit: CMUX_SOURCE_COMMIT,
    sourceTree: CMUX_SOURCE_TREE,
    cmuxTuiSourceTree: CMUX_TUI_SOURCE_TREE,
    ghosttyCommit: CMUX_GHOSTTY_COMMIT,
    rustToolchain: CMUX_RUST_TOOLCHAIN,
    zigToolchain: CMUX_ZIG_TOOLCHAIN,
    target: "fixture-target",
    binaryFile: "cmux-fixture",
    binarySha256,
    versionOutput: expectedVersion,
  })}\n`);
  return { binaryPath, buildManifestPath };
}

function runtimeConfig(
  root: string,
  artifact: FixtureArtifact,
  generation = "generation-1",
) {
  return {
    ...artifact,
    runtimeId: "runtime-1",
    generation,
    runtimeDirectory: join(root, "run"),
    stateDirectory: join(root, "state"),
    startTimeoutMs: 2_000,
    stopTimeoutMs: 300,
  } as const;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("cmux private runtime paths", () => {
  it("uses a generation-bound opaque directory and enforces Darwin's socket bound", async () => {
    const root = await temporaryRoot();
    const first = allocateCmuxRuntimePaths({
      runtimeId: "runtime-1",
      generation: "one",
      runtimeDirectory: join(root, "r"),
      stateDirectory: join(root, "s"),
    });
    const second = allocateCmuxRuntimePaths({
      runtimeId: "runtime-1",
      generation: "two",
      runtimeDirectory: join(root, "r"),
      stateDirectory: join(root, "s"),
    });
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(Buffer.byteLength(first.socketPath)).toBeLessThanOrEqual(MAX_CMUX_SOCKET_PATH_BYTES);
    expect(() => allocateCmuxRuntimePaths({
      runtimeId: "runtime-1",
      generation: "one",
      runtimeDirectory: `/${"x".repeat(MAX_CMUX_SOCKET_PATH_BYTES)}`,
      stateDirectory: join(root, "s"),
    })).toThrow(CmuxRuntimeError);
  });
});

describe("cmux artifact and durable writer boundary", () => {
  it("rejects a binary whose embedded source identity differs from its signed manifest", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, { version: "cmux-tui 0.0.0 (wrong source)" });
    await expect(verifyCmuxBinary(artifact.binaryPath, artifact.buildManifestPath)).rejects.toMatchObject({
      code: "binaryMismatch",
    });
  });

  it("runs an immutable verified copy when the supplied symlink is retargeted", async () => {
    const root = await temporaryRoot();
    const artifactRoot = join(root, "artifact");
    await mkdir(artifactRoot, { mode: 0o700 });
    const binaryLink = join(root, "cmux-link");
    const replacement = join(root, "replacement");
    await writeFile(replacement, `#!${process.execPath}\nprocess.exit(97);\n`, { mode: 0o755 });
    await chmod(replacement, 0o755);
    const retarget = `unlinkSync(${JSON.stringify(binaryLink)}); symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(binaryLink)});`;
    const artifact = await createFixture(artifactRoot, { versionSideEffect: retarget });
    await symlink(artifact.binaryPath, binaryLink);
    const runtime = await startCmuxRuntime(runtimeConfig(root, { ...artifact, binaryPath: binaryLink }));
    expect(await realpath(binaryLink)).toBe(await realpath(replacement));
    await runtime.stop();
  });

  it("excludes a second writer until the supervised process has stopped", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root);
    const first = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-1"));
    await expect(startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"))).rejects.toMatchObject({
      code: "duplicateWriter",
    });
    await first.stop();
    const replacement = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"));
    await replacement.stop();
  }, 15_000);

  it("shares complete containment shutdown across concurrent stop callers", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, { stubbornDescendant: true });
    const runtime = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-1"));
    const descendantPid = Number(await readFile(`${runtime.socketPath}.descendant.pid`, "utf8"));
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(processCanExecute(descendantPid)).toBe(false);
    const replacement = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"));
    await replacement.stop();
  }, 15_000);

  it("kills every process-group descendant before releasing the writer lock", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, { stubbornDescendant: true });
    const runtime = await startCmuxRuntime(runtimeConfig(root, artifact));
    const descendantPid = Number(await readFile(`${runtime.socketPath}.descendant.pid`, "utf8"));
    await runtime.stop();
    expect(processCanExecute(descendantPid)).toBe(false);
    const replacement = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"));
    await replacement.stop();
  }, 15_000);

  it("kills detached terminal-host descendants before releasing durable state", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, {
      stubbornDescendant: true,
      detachedDescendant: true,
    });
    const runtime = await startCmuxRuntime(runtimeConfig(root, artifact));
    const descendantPid = Number(await readFile(`${runtime.socketPath}.descendant.pid`, "utf8"));
    await runtime.stop();
    expect(processCanExecute(descendantPid)).toBe(false);
    const replacement = await startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"));
    await replacement.stop();
  }, 15_000);

  it("fails closed before launch when durable state metadata is corrupt", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(join(stateDirectory, ".t4-cmux-state.json"), "not-json\n");
    await expect(startCmuxRuntime(runtimeConfig(root, artifact))).rejects.toMatchObject({
      code: "corruptState",
    });
  });

  it("rejects identify responses other than protocol v10 and fences the failed child", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, { protocol: 9 });
    await expect(startCmuxRuntime(runtimeConfig(root, artifact))).rejects.toMatchObject({
      code: "protocolMismatch",
    });
    const replacementArtifact = await createFixture(root);
    const replacement = await startCmuxRuntime(runtimeConfig(root, replacementArtifact, "generation-2"));
    await replacement.stop();
  }, 15_000);

  it("reports unexpected child death and retains the writer lock fail closed", async () => {
    const root = await temporaryRoot();
    const artifact = await createFixture(root, { exitAfterIdentify: true });
    const runtime = await startCmuxRuntime(runtimeConfig(root, artifact));
    await expect(runtime.exited).resolves.toEqual({
      code: 23,
      signal: null,
      expected: false,
      writerLockRetained: true,
    });
    await expect(startCmuxRuntime(runtimeConfig(root, artifact, "generation-2"))).rejects.toMatchObject({
      code: "duplicateWriter",
    });
  });
});
