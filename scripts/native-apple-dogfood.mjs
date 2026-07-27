#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "dev.oh-my-pi.appserver";
const PROFILE = "default";
const REMOTE_PORT = 8_787;
const REMOTE_TLS_PORT = 8_788;
const help = `Usage: pnpm dogfood:native:apple <start|status|restore> [--omp <absolute-path>] [--address <tailscale-ipv4>]

start    Back up the normal appserver LaunchAgent and install the current
         compatibility-bridge host with private Tailnet listeners.
status   Inspect the active LaunchAgent and local host health.
restore  Restore the exact LaunchAgent saved by the first start.

The command never uses official OMP authority and never points it at ~/.omp.
The compatible OMP bridge remains the owner of existing CLI session access.`;

export function parseNativeAppleDogfoodArguments(args) {
  const command = args[0];
  if (command === "--help" || command === "-h") return { help: true, command: "status" };
  if (command !== "start" && command !== "status" && command !== "restore") {
    throw new Error("command must be start, status, or restore");
  }
  const options = { help: false, command };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--omp" && flag !== "--address") throw new Error(`unknown option: ${flag}`);
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--omp") {
      if (!isAbsolute(value)) throw new Error("--omp must be an absolute path");
      options.omp = resolve(value);
    } else {
      options.address = validateTailnetIpv4(value);
    }
  }
  if (command !== "start" && (options.omp || options.address)) {
    throw new Error("--omp and --address are start-only options");
  }
  return options;
}

export function validateTailnetIpv4(value) {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    parts[0] !== 100 ||
    parts[1] < 64 ||
    parts[1] > 127
  ) {
    throw new Error("address must be a Tailscale IPv4 address in 100.64.0.0/10");
  }
  return value;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildNativeAppleLaunchAgent(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new Error(`${name} is invalid`);
    }
  }
  const args = [
    options.host,
    "serve",
    "--omp",
    options.omp,
    "--profile",
    PROFILE,
    "--state-root",
    options.stateRoot,
    "--remote-mode",
    "direct",
    "--remote-address",
    validateTailnetIpv4(options.address),
    "--remote-port",
    String(REMOTE_PORT),
    "--remote-tls-port",
    String(REMOTE_TLS_PORT),
  ];
  const programArguments = args.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    programArguments,
    "    </array>",
    "    <key>RunAtLoad</key><true/>",
    "    <key>KeepAlive</key>",
    "    <dict><key>SuccessfulExit</key><false/></dict>",
    "    <key>Umask</key><integer>63</integer>",
    `    <key>StandardOutPath</key><string>${xml(join(options.logs, "appserver.log"))}</string>`,
    `    <key>StandardErrorPath</key><string>${xml(join(options.logs, "appserver.error.log"))}</string>`,
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>OMP_PROFILE</key>",
    `      <string>${PROFILE}</string>`,
    "    </dict>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n")}`;
}

export function ompExecutableFromProgramArguments(args) {
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf("--omp");
  const value = index === -1 ? undefined : args[index + 1];
  return typeof value === "string" && isAbsolute(value) ? resolve(value) : undefined;
}

function paths(home = homedir()) {
  const root = join(repoRoot, ".artifacts", "native-dogfood");
  return Object.freeze({
    root,
    host: join(repoRoot, "packages", "host-daemon", "dist", "t4-host"),
    stateRoot: join(root, "compat-state"),
    backup: join(root, "original-launch-agent.plist"),
    manifest: join(root, "service.json"),
    plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    socket: join(home, ".omp", "run", "appserver.sock"),
    logs: join(home, "Library", "Logs", "T4 Code", "appserver"),
    macApp: join(
      repoRoot,
      "apps",
      "ios",
      ".build",
      "macos-derived",
      "Build",
      "Products",
      "Debug",
      "T4CodeMac.app",
    ),
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(result.stderr?.trim() || `${command} exited ${result.status ?? "unknown"}`);
  }
  return result;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function plistArguments(path) {
  const result = run("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path], {
    allowFailure: true,
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function tailscaleIpv4() {
  for (const executable of [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]) {
    const result = run(executable, ["ip", "-4"], { allowFailure: true });
    const candidate = result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] : undefined;
    if (candidate) {
      try {
        return validateTailnetIpv4(candidate);
      } catch {}
    }
  }
  throw new Error("Tailscale is not connected or has no IPv4 address");
}

function launchctl(action, path, allowFailure = false) {
  const domain = `gui/${process.getuid()}`;
  const args =
    action === "bootout"
      ? ["bootout", `${domain}/${LABEL}`]
      : ["bootstrap", domain, path];
  return run("launchctl", args, { allowFailure });
}

async function waitForLaunchAgentRemoval(timeoutMs = 5_000) {
  const domain = `gui/${process.getuid()}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = run("launchctl", ["print", `${domain}/${LABEL}`], { allowFailure: true });
    if (result.status !== 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("launchctl did not finish removing the previous appserver");
}

function health(socketPath) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { method: "GET", path: "/health", socketPath, timeout: 1_000 },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode === 200 && value?.ok === true) resolvePromise(value);
            else reject(new Error(`host health returned HTTP ${response.statusCode ?? "unknown"}`));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("host health timed out")));
    req.end();
  });
}

async function waitForHealth(socketPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await health(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError ?? new Error("host health timed out");
}

async function start(options, currentPaths) {
  await mkdir(currentPaths.root, { recursive: true, mode: 0o700 });
  const currentArguments = plistArguments(currentPaths.plist);
  const alreadyOwned = currentArguments?.[0] === currentPaths.host;
  if (!(await exists(currentPaths.backup))) {
    if (!(await exists(currentPaths.plist))) throw new Error("normal appserver LaunchAgent is missing");
    if (alreadyOwned) {
      throw new Error("current service is already dogfood-owned but its original backup is missing");
    }
    await copyFile(currentPaths.plist, currentPaths.backup);
    await chmod(currentPaths.backup, 0o600);
  } else if (!alreadyOwned) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(currentPaths.manifest, "utf8"));
    } catch {}
    if (manifest?.active === true) {
      throw new Error("saved dogfood state says active, but another service replaced its LaunchAgent");
    }
  }
  const omp =
    options.omp ??
    ompExecutableFromProgramArguments(currentArguments) ??
    ompExecutableFromProgramArguments(plistArguments(currentPaths.backup));
  if (!omp) throw new Error("could not discover the compatible OMP runtime; pass --omp");
  await stat(omp);
  const address = options.address ?? tailscaleIpv4();
  run("pnpm", ["--filter", "@t4-code/host-daemon", "build:binary"], { stdio: "inherit" });
  const definition = buildNativeAppleLaunchAgent({
    host: currentPaths.host,
    omp,
    stateRoot: currentPaths.stateRoot,
    address,
    logs: currentPaths.logs,
  });
  launchctl("bootout", currentPaths.plist, true);
  await waitForLaunchAgentRemoval();
  await atomicWrite(currentPaths.plist, definition);
  launchctl("bootstrap", currentPaths.plist);
  const currentHealth = await waitForHealth(currentPaths.socket);
  const manifest = {
    schemaVersion: 1,
    active: true,
    label: LABEL,
    profile: PROFILE,
    address,
    ports: { ws: REMOTE_PORT, wss: REMOTE_TLS_PORT },
    omp,
    host: currentPaths.host,
    stateRoot: currentPaths.stateRoot,
    originalSha256: createHash("sha256").update(await readFile(currentPaths.backup)).digest("hex"),
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(currentPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    active: true,
    health: currentHealth,
    endpoint: `ws://${address}:${REMOTE_PORT}/v1/ws`,
    secureEndpoint: `wss://${address}:${REMOTE_TLS_PORT}/v1/ws`,
    macApp: currentPaths.macApp,
    restore: "pnpm dogfood:native:apple restore",
  };
}

async function restore(currentPaths) {
  if (!(await exists(currentPaths.backup))) throw new Error("no saved LaunchAgent backup exists");
  launchctl("bootout", currentPaths.plist, true);
  await waitForLaunchAgentRemoval();
  await atomicWrite(currentPaths.plist, await readFile(currentPaths.backup));
  launchctl("bootstrap", currentPaths.plist);
  const currentHealth = await waitForHealth(currentPaths.socket);
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(currentPaths.manifest, "utf8"));
  } catch {}
  await atomicWrite(
    currentPaths.manifest,
    `${JSON.stringify({ ...manifest, active: false, restoredAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { active: false, restored: currentPaths.plist, health: currentHealth };
}

async function status(currentPaths) {
  let currentHealth;
  try {
    currentHealth = await health(currentPaths.socket);
  } catch {}
  const args = plistArguments(currentPaths.plist);
  return {
    active: args?.[0] === currentPaths.host,
    launchAgent: currentPaths.plist,
    executable: args?.[0],
    omp: ompExecutableFromProgramArguments(args),
    backupExists: await exists(currentPaths.backup),
    health: currentHealth,
  };
}

export async function runNativeAppleDogfoodCli(args = process.argv.slice(2)) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || typeof process.getuid !== "function") {
    throw new Error("native Apple dogfood requires Apple Silicon macOS");
  }
  const options = parseNativeAppleDogfoodArguments(args);
  if (options.help) {
    process.stdout.write(`${help}\n`);
    return 0;
  }
  const currentPaths = paths();
  const result =
    options.command === "start"
      ? await start(options, currentPaths)
      : options.command === "restore"
        ? await restore(currentPaths)
        : await status(currentPaths);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNativeAppleDogfoodCli().catch((error) => {
    process.stderr.write(`native-apple-dogfood: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
