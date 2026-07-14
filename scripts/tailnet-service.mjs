#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SERVICE_LABEL = "com.lycaonsolutions.t4code.tailnet-gateway";
export const DEFAULT_GATEWAY_PORT = 4_194;
const CONFIG_VERSION = 1;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TEXT = 4_096;
const CAPACITOR_NATIVE_ORIGINS = Object.freeze(["https://localhost", "capacitor://localhost"]);

function fail(message) {
  throw new Error(message);
}

function cleanText(value, name, maximum = MAX_TEXT) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Cc}\r\n]/u.test(value)
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function absolutePath(value, name) {
  const path = cleanText(value, name);
  if (!isAbsolute(path) || path.includes("\0")) fail(`${name} must be an absolute path`);
  return resolve(path);
}

function gatewayPort(value) {
  if (typeof value !== "number" && !/^\d{1,5}$/u.test(String(value))) {
    fail("gateway port must be an integer from 1024 through 65535");
  }
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    fail("gateway port must be an integer from 1024 through 65535");
  }
  return port;
}

function platformName(platform) {
  if (platform === "linux" || platform === "darwin") return platform;
  fail("the Tailnet gateway service supports Linux systemd and macOS launchd only");
}

// Kept dependency-free so `status` and `uninstall` still work if a checkout's
// package install is damaged. The gateway enforces the same policy at startup.
function normalizeServiceOrigin(value) {
  const text = cleanText(value, "Tailnet HTTPS origin", 2_048);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("T4_ALLOWED_ORIGIN must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(".ts.net")
  ) {
    fail("T4_ALLOWED_ORIGIN must be a Tailscale HTTPS origin ending in .ts.net");
  }
  return url.origin;
}

function normalizeServiceNativeOrigins(value = CAPACITOR_NATIVE_ORIGINS) {
  if (!Array.isArray(value)) fail("native allowed origins must be an array");
  const origins = value.map((origin) => cleanText(origin, "native allowed origin", 128));
  const unique = new Set(origins);
  if (
    unique.size !== CAPACITOR_NATIVE_ORIGINS.length ||
    !CAPACITOR_NATIVE_ORIGINS.every((origin) => unique.has(origin))
  ) {
    fail(`native allowed origins must contain exactly ${CAPACITOR_NATIVE_ORIGINS.join(", ")}`);
  }
  return [...CAPACITOR_NATIVE_ORIGINS];
}

export function servicePaths({
  platform = process.platform,
  homeDirectory = homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
  const selectedPlatform = platformName(platform);
  const home = absolutePath(homeDirectory, "home directory");
  if (selectedPlatform === "linux") {
    return {
      platform: selectedPlatform,
      label: SERVICE_LABEL,
      definition: join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`),
      config: join(home, ".config", "t4-code", "tailnet-gateway.json"),
      logs: undefined,
      domain: undefined,
    };
  }
  if (!Number.isInteger(uid) || uid < 0 || uid > 4_000_000_000) fail("user id is invalid");
  return {
    platform: selectedPlatform,
    label: SERVICE_LABEL,
    definition: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    config: join(home, "Library", "Application Support", "T4 Code", "tailnet-gateway.json"),
    logs: join(home, "Library", "Logs", "T4 Code", "tailnet-gateway"),
    domain: `gui/${uid}`,
  };
}

export function validateServiceConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("service config is invalid");
  const sourceRoot = absolutePath(input.sourceRoot, "source root");
  const config = {
    version: CONFIG_VERSION,
    sourceRoot,
    nodeExecutable: absolutePath(input.nodeExecutable, "Node executable"),
    gatewayScript: absolutePath(input.gatewayScript ?? join(sourceRoot, "scripts", "tailnet-gateway.mjs"), "gateway script"),
    webRoot: absolutePath(input.webRoot ?? join(sourceRoot, "apps", "web", "dist"), "web root"),
    appSocket: absolutePath(input.appSocket, "OMP appserver socket"),
    allowedOrigin: normalizeServiceOrigin(input.allowedOrigin),
    nativeAllowedOrigins: normalizeServiceNativeOrigins(input.nativeAllowedOrigins),
    port: gatewayPort(input.port ?? DEFAULT_GATEWAY_PORT),
    label: cleanText(input.label ?? "OMP on this Tailnet host", "host label", 128),
  };
  if (input.version !== undefined && input.version !== CONFIG_VERSION) fail("service config version is unsupported");
  return config;
}

function quoteSystemd(value) {
  return `"${cleanText(value, "systemd value").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("%", "%%")}"`;
}

function escapeXml(value) {
  return cleanText(value, "launchd value")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function gatewayEnvironment(config) {
  return {
    T4_ALLOWED_ORIGIN: config.allowedOrigin,
    T4_NATIVE_ALLOWED_ORIGINS: config.nativeAllowedOrigins.join(","),
    T4_GATEWAY_HOST: "127.0.0.1",
    T4_GATEWAY_PORT: String(config.port),
    T4_WEB_ROOT: config.webRoot,
    T4_APP_SERVER_SOCKET: config.appSocket,
    T4_HOST_LABEL: config.label,
  };
}

export function renderSystemdUnit(input) {
  const config = validateServiceConfig(input);
  const environment = Object.entries(gatewayEnvironment(config)).map(
    ([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`,
  );
  return [
    "[Unit]",
    "Description=T4 Code Tailnet web gateway",
    "Documentation=https://github.com/LycaonLLC/t4-code/blob/main/docs/TAILNET_REMOTE.md",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteSystemd(config.nodeExecutable)} ${quoteSystemd(config.gatewayScript)}`,
    ...environment,
    "Restart=on-failure",
    "RestartSec=2s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLaunchAgent(input, paths) {
  const config = validateServiceConfig(input);
  if (paths.platform !== "darwin" || paths.logs === undefined) fail("macOS service paths are required");
  const argumentsXml = [config.nodeExecutable, config.gatewayScript]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(gatewayEnvironment(config))
    .flatMap(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(value)}</string>`,
    ])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${escapeXml(SERVICE_LABEL)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argumentsXml,
    "    </array>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    environmentXml,
    "    </dict>",
    "    <key>RunAtLoad</key><true/>",
    "    <key>KeepAlive</key>",
    "    <dict><key>SuccessfulExit</key><false/></dict>",
    "    <key>ThrottleInterval</key><integer>2</integer>",
    "    <key>Umask</key><integer>63</integer>",
    `    <key>StandardOutPath</key><string>${escapeXml(join(paths.logs, "gateway.log"))}</string>`,
    `    <key>StandardErrorPath</key><string>${escapeXml(join(paths.logs, "gateway.error.log"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function supervisorCommands(action, paths) {
  const selectedAction = cleanText(action, "service action", 32);
  if (paths.platform === "linux") {
    const unit = `${SERVICE_LABEL}.service`;
    const matrix = {
      install: [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", unit] },
        { argv: ["systemctl", "--user", "restart", unit] },
      ],
      start: [{ argv: ["systemctl", "--user", "enable", "--now", unit] }],
      stop: [{ argv: ["systemctl", "--user", "stop", unit] }],
      restart: [{ argv: ["systemctl", "--user", "restart", unit] }],
      status: [{ argv: ["systemctl", "--user", "is-active", unit], allowFailure: true }],
      uninstall: [
        { argv: ["systemctl", "--user", "disable", "--now", unit], allowFailure: true },
      ],
      reload: [{ argv: ["systemctl", "--user", "daemon-reload"] }],
    };
    if (!(selectedAction in matrix)) fail(`unsupported service action: ${selectedAction}`);
    return matrix[selectedAction];
  }
  const target = `${paths.domain}/${SERVICE_LABEL}`;
  const matrix = {
    install: [
      { argv: ["launchctl", "bootout", target], allowFailure: true },
      { argv: ["launchctl", "bootstrap", paths.domain, paths.definition] },
      { argv: ["launchctl", "kickstart", "-k", target] },
    ],
    start: [
      { argv: ["launchctl", "bootstrap", paths.domain, paths.definition], allowFailure: true },
      { argv: ["launchctl", "kickstart", "-k", target] },
    ],
    stop: [{ argv: ["launchctl", "bootout", target], allowFailure: true }],
    restart: [
      { argv: ["launchctl", "bootstrap", paths.domain, paths.definition], allowFailure: true },
      { argv: ["launchctl", "kickstart", "-k", target] },
    ],
    status: [{ argv: ["launchctl", "print", target], allowFailure: true }],
    uninstall: [{ argv: ["launchctl", "bootout", target], allowFailure: true }],
    reload: [],
  };
  if (!(selectedAction in matrix)) fail(`unsupported service action: ${selectedAction}`);
  return matrix[selectedAction];
}

async function readOptional(path) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) fail(`unsafe service file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path, content) {
  const existing = await readOptional(path);
  void existing;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sanitizedOutput(value) {
  return String(value)
    .replaceAll(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? character : " "))
    .trim()
    .slice(0, 2_048);
}

async function runCommand(command) {
  return await new Promise((resolvePromise, reject) => {
    const [executable, ...args] = command.argv;
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "", overflow: false };
    const append = (key, chunk) => {
      output[key] += chunk.toString("utf8");
      if (Buffer.byteLength(output[key]) > MAX_OUTPUT_BYTES) {
        output.overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code, stdout: sanitizedOutput(output.stdout), stderr: sanitizedOutput(output.stderr) };
      if (output.overflow) {
        reject(new Error(`${executable} produced too much output`));
      } else if (code !== 0 && command.allowFailure !== true) {
        reject(new Error(`${executable} exited ${code}: ${result.stderr || result.stdout || "no diagnostics"}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function runCommands(commands) {
  const results = [];
  for (const command of commands) results.push(await runCommand(command));
  return results;
}

function supervisorIsRunning(paths, result) {
  if (paths.platform === "linux") return result?.code === 0;
  return result?.code === 0 && /\bstate\s*=\s*running\b/iu.test(result.stdout ?? "");
}

async function requireRunningSupervisor(paths) {
  const results = await runCommands(supervisorCommands("status", paths));
  const result = results.at(-1);
  if (!supervisorIsRunning(paths, result)) {
    fail(`gateway supervisor is not running: ${result?.stderr || result?.stdout || "no diagnostics"}`);
  }
}

async function fileExists(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function preflight(config) {
  const required = [
    [config.nodeExecutable, "Node executable"],
    [config.gatewayScript, "Tailnet gateway script"],
    [join(config.webRoot, "index.html"), "built web application"],
    [join(config.sourceRoot, "node_modules", "ws", "package.json"), "installed ws dependency"],
  ];
  for (const [path, label] of required) {
    if (!(await fileExists(path))) fail(`${label} is missing at ${path}`);
  }
}

async function loadConfig(paths) {
  const source = await readOptional(paths.config);
  if (source === undefined) fail(`Tailnet gateway is not installed (${paths.config} is missing)`);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail(`Tailnet gateway config is invalid: ${paths.config}`);
  }
  return validateServiceConfig(parsed);
}

function expectedDefinition(config, paths) {
  return paths.platform === "linux" ? renderSystemdUnit(config) : renderLaunchAgent(config, paths);
}

async function health(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
    const body = await response.json();
    return {
      ok: response.ok && body?.ok === true && body?.transport === "local-unix",
      status: response.status,
      web: body?.web === true,
      upstream: body?.upstream === true,
      transport: typeof body?.transport === "string" ? body.transport : undefined,
      activeSessions: Number.isSafeInteger(body?.activeSessions) ? body.activeSessions : undefined,
    };
  } catch (error) {
    return { ok: false, error: sanitizedOutput(error instanceof Error ? error.message : error) };
  }
}

async function waitForHealth(config, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let result = await health(config);
  while (!result.ok && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    result = await health(config);
  }
  if (!result.ok) {
    fail(`gateway did not become healthy: ${JSON.stringify(result)}`);
  }
  return result;
}

function defaultAppSocket(platform, environment = process.env) {
  if (platform === "darwin") return join(homedir(), ".omp", "run", "appserver.sock");
  const runtime = environment.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
  return join(runtime, "omp", "appserver.sock");
}

export function parseCli(argv) {
  const values = [...argv];
  const first = values.shift();
  const command = first === undefined || first === "--help" || first === "-h" ? "help" : first;
  const options = {};
  while (values.length > 0) {
    const flag = values.shift();
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag}`);
    const key = flag.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = values.shift();
    if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
    if (key in options) fail(`${flag} was provided more than once`);
    options[key] = value;
  }
  return { command, options };
}

function validateCliOptions(command, options) {
  const allowed =
    command === "install"
      ? new Set(["help", "origin", "port", "webRoot", "appSocket", "label"])
      : new Set(["help"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`unsupported option for ${command}: --${key}`);
  }
}

function usage() {
  return `T4 Code Tailnet gateway service

Usage:
  node scripts/tailnet-service.mjs install --origin https://HOST.TAILNET.ts.net[:PORT] [options]
  node scripts/tailnet-service.mjs start|stop|restart|status|uninstall

Install options:
  --origin URL          Exact Tailscale HTTPS origin (required)
  --port PORT           Loopback gateway port (default: 4194)
  --web-root PATH       Built T4 web directory (default: apps/web/dist)
  --app-socket PATH     OMP appserver Unix socket
  --label TEXT          Host label shown by T4 Code

This manages only the loopback gateway service. Configure Tailscale Serve separately.
`;
}

async function install(options, paths) {
  if (options.origin === undefined) fail("install requires --origin");
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = resolve(scriptDirectory, "..");
  const config = validateServiceConfig({
    sourceRoot,
    nodeExecutable: process.execPath,
    gatewayScript: join(scriptDirectory, "tailnet-gateway.mjs"),
    webRoot: options.webRoot ?? join(sourceRoot, "apps", "web", "dist"),
    appSocket: options.appSocket ?? defaultAppSocket(paths.platform),
    allowedOrigin: options.origin,
    port: options.port ?? DEFAULT_GATEWAY_PORT,
    label: options.label ?? "OMP on this Tailnet host",
  });
  await preflight(config);
  if (paths.logs !== undefined) await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  await writeAtomic(paths.definition, expectedDefinition(config, paths));
  await runCommands(supervisorCommands("install", paths));
  const result = await waitForHealth(config);
  await requireRunningSupervisor(paths);
  console.log(`installed ${SERVICE_LABEL}`);
  console.log(`gateway healthy on http://127.0.0.1:${config.port} (${result.activeSessions ?? 0} active sessions)`);
}

async function inspect(paths) {
  let config;
  try {
    config = await loadConfig(paths);
  } catch (error) {
    const definition = await readOptional(paths.definition);
    console.log(`definition: ${definition === undefined ? "missing" : "present without valid config"}`);
    console.log("supervisor: not checked");
    console.log("health: unavailable");
    throw error;
  }
  const [definition, supervisor] = await Promise.all([
    readOptional(paths.definition),
    runCommands(supervisorCommands("status", paths)),
  ]);
  const expected = expectedDefinition(config, paths);
  const healthResult = await health(config);
  const supervisorResult = supervisor.at(-1);
  const supervisorRunning = supervisorIsRunning(paths, supervisorResult);
  const supervisorState = supervisorRunning ? "running" : "stopped or failed";
  const definitionState = definition === undefined ? "missing" : definition === expected ? "current" : "drifted";
  console.log(`definition: ${definitionState}`);
  console.log(`supervisor: ${supervisorState}`);
  console.log(`health: ${healthResult.ok ? "healthy" : "unhealthy"}`);
  console.log(`local URL: http://127.0.0.1:${config.port}`);
  console.log(`allowed origin: ${config.allowedOrigin}`);
  console.log(`native origins: ${config.nativeAllowedOrigins.join(", ")}`);
  if (supervisorResult?.stderr) console.log(`diagnostics: ${supervisorResult.stderr}`);
  if (definitionState !== "current" || !supervisorRunning || !healthResult.ok) {
    process.exitCode = 1;
  }
}

async function lifecycle(action, paths) {
  if (action === "stop") {
    await runCommands(supervisorCommands(action, paths));
    console.log(`${SERVICE_LABEL} stopped`);
    return;
  }
  const config = await loadConfig(paths);
  await preflight(config);
  await runCommands(supervisorCommands(action, paths));
  await waitForHealth(config);
  await requireRunningSupervisor(paths);
  console.log(`gateway healthy on http://127.0.0.1:${config.port}`);
}

async function uninstall(paths) {
  await runCommands(supervisorCommands("uninstall", paths));
  const definition = await readOptional(paths.definition);
  const config = await readOptional(paths.config);
  if (definition !== undefined) await rm(paths.definition);
  if (config !== undefined) await rm(paths.config);
  await runCommands(supervisorCommands("reload", paths));
  console.log(`uninstalled ${SERVICE_LABEL}`);
  console.log("Tailscale Serve was not changed.");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  validateCliOptions(command, options);
  if (options.help === true || command === "help") {
    console.log(usage());
    return;
  }
  const paths = servicePaths();
  if (command === "install") await install(options, paths);
  else if (command === "status") await inspect(paths);
  else if (["start", "stop", "restart"].includes(command)) await lifecycle(command, paths);
  else if (command === "uninstall") await uninstall(paths);
  else fail(`unknown command: ${command}\n\n${usage()}`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Tailnet service command failed");
    process.exitCode = 1;
  }
}
