#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(
  await readFile(join(repositoryRoot, "provenance", "cmux-runtime-v1.json"), "utf8"),
);

function fail(message) {
  process.stderr.write(`build-pinned-cmux: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let source;
  let out;
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") source = argv[++index];
    else if (flag === "--out") out = argv[++index];
    else if (flag === "--target") target = argv[++index];
    else fail(`unsupported argument ${String(flag)}`);
  }
  if (!out) fail("--out <directory> is required");
  const nativeTarget = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
    if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
    if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
    fail(`no native Rust target mapping for ${process.platform}/${process.arch}; pass --target`);
  })();
  return {
    ...(source ? { source: resolve(source) } : {}),
    out: resolve(out),
    target: target ?? nativeTarget,
  };
}

function command(executable, args, options = {}) {
  const output = execFileSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function git(source, ...args) {
  return command("git", ["-C", source, ...args]);
}

function requireIdentity(actual, expected, label) {
  if (actual !== expected) fail(`${label} mismatch: expected ${expected}, received ${actual}`);
}

const args = parseArgs(process.argv.slice(2));
const buildRoot = await mkdtemp(join(tmpdir(), "t4-cmux-build-"));
let temporaryRoot;
let source = args.source;
try {
  if (!source) {
    temporaryRoot = await mkdtemp(join(tmpdir(), "t4-cmux-source-"));
    source = join(temporaryRoot, "cmux");
    command("git", ["init", source]);
    git(source, "remote", "add", "origin", provenance.source.repository);
    git(source, "fetch", "--depth", "1", "origin", provenance.source.commit);
    git(source, "checkout", "--detach", "FETCH_HEAD");
  }
  source = await realpath(source);
  requireIdentity(git(source, "rev-parse", "HEAD"), provenance.source.commit, "source commit");
  requireIdentity(git(source, "rev-parse", "HEAD^{tree}"), provenance.source.rootGitTree, "source tree");
  requireIdentity(git(source, "rev-parse", "HEAD:cmux-tui"), provenance.source.cmuxTuiGitTree, "cmux-tui tree");
  requireIdentity(
    git(source, "rev-parse", "HEAD:cmux-tui/Cargo.lock"),
    provenance.source.cargoLockGitBlob,
    "Cargo.lock blob",
  );
  git(source, "submodule", "update", "--init", "--depth", "1", "ghostty");
  requireIdentity(git(join(source, "ghostty"), "rev-parse", "HEAD"), provenance.source.ghosttyCommit, "ghostty commit");
  if (git(source, "status", "--porcelain=v1", "--untracked-files=all") !== "")
    fail("source checkout is dirty; refusing a non-reproducible build");

  const zig = process.env.ZIG || "zig";
  requireIdentity(command(zig, ["version"]), provenance.build.zigToolchain, "Zig toolchain");
  command("rustup", ["toolchain", "install", provenance.build.rustToolchain, "--profile", "minimal"]);
  command("rustup", ["target", "add", "--toolchain", provenance.build.rustToolchain, args.target]);
  const cargoTargetDirectory = join(buildRoot, "cargo");
  const cargoTargetLinker =
    args.target === "x86_64-unknown-linux-gnu"
      ? ["CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER", "x86_64-linux-gnu-gcc"]
      : args.target === "aarch64-unknown-linux-gnu"
        ? ["CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER", "aarch64-linux-gnu-gcc"]
        : undefined;
  const buildEnvironment = {
    ...process.env,
    ...(cargoTargetLinker ? { [cargoTargetLinker[0]]: cargoTargetLinker[1] } : {}),
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: cargoTargetDirectory,
    ZIG_GLOBAL_CACHE_DIR: join(buildRoot, "zig-global"),
    ZIG_LOCAL_CACHE_DIR: join(buildRoot, "zig-local"),
    ZIG: zig,
    CMUX_GHOSTTY_VT_ZIG_CPU: "baseline",
    CMUX_TUI_BUILD_COMMIT: provenance.source.commit,
    CMUX_TUI_GHOSTTY_COMMIT: provenance.source.ghosttyCommit,
  };
  delete buildEnvironment.CMUX_GHOSTTY_SRC;
  command(
    "cargo",
    [
      `+${provenance.build.rustToolchain}`,
      "build",
      "-p", provenance.build.cargoPackage,
      "--bin", provenance.build.cargoBinary,
      "--release",
      "--locked",
      "--target", args.target,
    ],
    { cwd: join(source, "cmux-tui"), env: buildEnvironment, stdio: ["ignore", "inherit", "inherit"] },
  );

  await mkdir(args.out, { recursive: true, mode: 0o755 });
  const builtBinary = join(cargoTargetDirectory, args.target, "release", "cmux-tui");
  const outputBinary = join(args.out, `cmux-tui-${args.target}`);
  await copyFile(builtBinary, outputBinary);
  await chmod(outputBinary, 0o755);
  const binaryBytes = await readFile(outputBinary);
  const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
  const targetRuntime =
    args.target === "x86_64-unknown-linux-gnu"
      ? {
          loader: "/usr/x86_64-linux-gnu/lib/ld-linux-x86-64.so.2",
          libraryPath: "/usr/x86_64-linux-gnu/lib",
        }
      : args.target === "aarch64-unknown-linux-gnu"
        ? {
            loader: "/usr/aarch64-linux-gnu/lib/ld-linux-aarch64.so.1",
            libraryPath: "/usr/aarch64-linux-gnu/lib",
          }
        : undefined;
  const versionOutput = targetRuntime
    ? command(targetRuntime.loader, ["--library-path", targetRuntime.libraryPath, outputBinary, "--version"], { env: {} })
    : command(outputBinary, ["--version"], { env: {} });
  const expectedIdentity = `(${provenance.source.commit}; ghostty ${provenance.source.ghosttyCommit})`;
  if (!versionOutput.includes(expectedIdentity)) fail("built binary omitted the exact source identities");
  const manifest = {
    schemaVersion: 1,
    artifact: "cmux-tui-headless",
    sourceRepository: provenance.source.repository,
    sourceCommit: provenance.source.commit,
    sourceTree: provenance.source.rootGitTree,
    cmuxTuiSourceTree: provenance.source.cmuxTuiGitTree,
    ghosttyCommit: provenance.source.ghosttyCommit,
    rustToolchain: provenance.build.rustToolchain,
    zigToolchain: provenance.build.zigToolchain,
    target: args.target,
    binaryFile: basename(outputBinary),
    binarySha256,
    versionOutput,
  };
  await writeFile(join(args.out, `${basename(outputBinary)}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  process.stdout.write(`${outputBinary}\n`);
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  await rm(buildRoot, { recursive: true, force: true });
}
