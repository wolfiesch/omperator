import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createServer } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createStructuredDevelopmentLogger } from "./dev-log.mjs";
import { pnpmProcessInvocation } from "./pnpm-process.mjs";

const HOST = "127.0.0.1";
const READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_KILL_WAIT_MS = 1_000;
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostExecutable = resolve(rootDirectory, "packages", "host-daemon", "dist", "t4-host");
const requestedRendererPort = parseRequestedPort(process.env.T4_DEV_RENDERER_PORT);


const WATCH_DEBOUNCE_MS = 150;
const WATCH_TARGETS = [
  { path: resolve(rootDirectory, "apps", "desktop", "src"), desktop: true, host: false },
  { path: resolve(rootDirectory, "packages", "client", "src"), desktop: true, host: false },
  { path: resolve(rootDirectory, "packages", "remote", "src"), desktop: true, host: false },
  { path: resolve(rootDirectory, "packages", "service-manager", "src"), desktop: true, host: false },
  { path: resolve(rootDirectory, "packages", "host-daemon", "src"), desktop: false, host: true },
  { path: resolve(rootDirectory, "packages", "host-service", "src"), desktop: false, host: true },
  { path: resolve(rootDirectory, "packages", "host-wire", "src"), desktop: false, host: true },
  { path: resolve(rootDirectory, "packages", "protocol", "src"), desktop: true, host: true },
];
const logDirectory =
  process.env.T4_DEV_LOG_DIR ?? resolve(rootDirectory, ".artifacts", "dev", "system", "logs");
const devLog = await createStructuredDevelopmentLogger({ directory: logDirectory });
devLog.info(`Structured events: ${devLog.path}`);

const managedProcesses = new Set();
const sourceWatchers = [];
let shuttingDown = false;
let shutdownPromise;
let resolveShutdownStarted;
const shutdownStarted = new Promise((resolvePromise) => {
  resolveShutdownStarted = resolvePromise;
});
let exitCode = 0;
let rendererUrl;
let desktopProcess;
let rebuildTimer;
let rebuildChain = Promise.resolve();
let pendingDesktopBuild = false;
let pendingHostBuild = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    devLog.info(`Received ${signal}; stopping dev processes.`);
    void shutdown({ signal });
  });
}

async function main() {
  for (const [label, args] of [
    ["desktop build", ["--filter", "@t4-code/desktop", "build"]],
    ["host build", ["build:host"]],
  ]) {
    if (!(await runBuild(label, args))) throw new Error(`${label} failed.`);
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }
  }

  let reservation = await reservePort(requestedRendererPort);
  rendererUrl = `http://${HOST}:${reservation.port}/`;

  try {
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }

    devLog.info(`Renderer URL: ${rendererUrl}`);
    await reservation.release();
    reservation = undefined;

    const web = startPnpm("web dev server", [
      "--filter",
      "@t4-code/web",
      "exec",
      "vp",
      "dev",
      "--host",
      HOST,
      "--port",
      String(portFromUrl(rendererUrl)),
      "--strictPort",
    ]);
    supervise(web);

    const rendererReady = await Promise.race([
      waitForRenderer(rendererUrl).then(() => "ready"),
      shutdownStarted.then(() => "shutdown"),
    ]);

    if (rendererReady === "shutdown") {
      await shutdownPromise;
      return;
    }

    if (shuttingDown) {
      await shutdownPromise;
      return;
    }

    desktopProcess = startDesktopProcess();
    supervise(desktopProcess);
    startSourceWatchers();

    await shutdownStarted;
    await shutdownPromise;
  } finally {
    if (reservation) await reservation.release();
  }
}

function startProcess(label, command, args, environment = process.env) {
  const child = spawn(command, args, {
    cwd: rootDirectory,
    env: environment,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  let settle;
  const processRecord = {
    label,
    child,
    exited: false,
    expectedStop: false,
    completed: new Promise((resolvePromise) => {
      settle = resolvePromise;
    }),
  };
  const complete = (result) => {
    if (processRecord.exited) return;
    processRecord.exited = true;
    devLog.processCompleted(label, result);
    settle(result);
  };
  child.once("error", (error) => complete({ error }));
  child.once("exit", (code, signal) => complete({ code, signal }));
  managedProcesses.add(processRecord);
  devLog.attach(label, child);
  return processRecord;
}

function startPnpm(label, args, environment = process.env) {
  const invocation = pnpmProcessInvocation(args, environment.npm_execpath);
  return startProcess(label, invocation.command, invocation.args, environment);
}

function supervise(processRecord) {
  void processRecord.completed.then((result) => {
    managedProcesses.delete(processRecord);
    if (shuttingDown || processRecord.expectedStop) return;
    devLog.error(`${processRecord.label} ${describeCompletion(result)}; stopping dev processes.`);
    void shutdown({ unexpected: true });
  });
}

async function runBuild(label, args) {
  const build = startPnpm(label, args);
  const result = await build.completed;
  managedProcesses.delete(build);
  if (completedSuccessfully(result)) return true;
  devLog.error(`${label} ${describeCompletion(result)}.`);
  return false;
}

function startDesktopProcess() {
  if (rendererUrl === undefined) throw new Error("renderer URL is unavailable");
  const environment = {
    ...process.env,
    OMP_DESKTOP_RENDERER_URL: rendererUrl,
    T4_HOST_EXECUTABLE: hostExecutable,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return startPnpm(
    "desktop dev process",
    ["--filter", "@t4-code/desktop", "dev"],
    environment,
  );
}

function startSourceWatchers() {
  for (const target of WATCH_TARGETS) {
    const watcher = watch(target.path, { recursive: true }, (_event, filename) => {
      if (filename !== null && ![".ts", ".tsx", ".js", ".mjs", ".json"].includes(extname(filename)))
        return;
      scheduleRebuild(target);
    });
    watcher.on("error", (error) => {
      devLog.error(`Source watcher failed: ${error.message}`);
      void shutdown({ unexpected: true });
    });
    sourceWatchers.push(watcher);
  }
  devLog.info("Watching Electron main, preload, service, protocol, and host sources.");
}

function scheduleRebuild(target) {
  pendingDesktopBuild ||= target.desktop;
  pendingHostBuild ||= target.host;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    rebuildChain = rebuildChain.then(rebuildChangedSources).catch((error) => {
      devLog.error(`Rebuild failed: ${error.message}`);
    });
  }, WATCH_DEBOUNCE_MS);
}

async function rebuildChangedSources() {
  if (shuttingDown) return;
  const rebuildDesktop = pendingDesktopBuild;
  const rebuildHost = pendingHostBuild;
  pendingDesktopBuild = false;
  pendingHostBuild = false;
  if (!rebuildDesktop && !rebuildHost) return;

  if (desktopProcess !== undefined) {
    await stopManagedProcess(desktopProcess);
    desktopProcess = undefined;
  }

  let successful = true;
  if (rebuildDesktop) successful = (await runBuild("desktop rebuild", ["--filter", "@t4-code/desktop", "build"])) && successful;
  if (rebuildHost) successful = (await runBuild("host rebuild", ["build:host"])) && successful;
  if (!successful || shuttingDown) {
    devLog.error("The desktop remains stopped until the next successful source rebuild.");
    return;
  }

  if (rebuildHost) await restartDevelopmentHostService();
  if (pendingDesktopBuild || pendingHostBuild || rebuildTimer !== undefined) return;
  desktopProcess = startDesktopProcess();
  supervise(desktopProcess);
}

async function stopManagedProcess(processRecord) {
  if (processRecord.exited) return;
  processRecord.expectedStop = true;
  sendSignal(processRecord, "SIGTERM");
  await Promise.race([processRecord.completed, delay(SHUTDOWN_GRACE_MS)]);
  if (!processRecord.exited && processGroupExists(processRecord)) {
    sendSignal(processRecord, "SIGKILL");
    await Promise.race([processRecord.completed, delay(SHUTDOWN_KILL_WAIT_MS)]);
  }
  managedProcesses.delete(processRecord);
}

async function restartDevelopmentHostService() {
  const sandbox = process.env.T4_DEV_SANDBOX;
  const label =
    sandbox === undefined
      ? "dev.oh-my-pi.appserver"
      : `dev.oh-my-pi.appserver.development.${sandbox}`;
  let command;
  let args;
  if (process.platform === "darwin" && typeof process.getuid === "function") {
    command = "/bin/launchctl";
    args = ["kickstart", "-k", `gui/${process.getuid()}/${label}`];
  } else if (process.platform === "linux") {
    command = "systemctl";
    args = ["--user", "restart", label];
  } else {
    return;
  }
  const restart = startProcess("host service restart", command, args);
  const result = await restart.completed;
  managedProcesses.delete(restart);
  if (!completedSuccessfully(result)) {
    devLog.info("The development host service is not registered yet; Electron will install it.");
  }
}

function closeSourceWatchers() {
  if (rebuildTimer !== undefined) {
    clearTimeout(rebuildTimer);
    rebuildTimer = undefined;
  }
  for (const watcher of sourceWatchers.splice(0)) watcher.close();
}

function parseRequestedPort(value) {
  if (value === undefined) {
    return 0;
  }

  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error("T4_DEV_RENDERER_PORT must be an integer from 1 through 65535.");
  }

  const port = Number(value);
  if (port > 65_535) {
    throw new Error("T4_DEV_RENDERER_PORT must be an integer from 1 through 65535.");
  }

  return port;
}

async function reservePort(port) {
  const server = createServer();

  await new Promise((resolvePromise, reject) => {
    const fail = (error) => {
      server.off("listening", listen);
      reject(error);
    };
    const listen = () => {
      server.off("error", fail);
      resolvePromise();
    };

    server.once("error", fail);
    server.once("listening", listen);
    server.listen({ host: HOST, port, exclusive: true });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to reserve a TCP renderer port.");
  }

  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) {
        return;
      }

      released = true;
      await closeServer(server);
    },
  };
}

async function waitForRenderer(rendererUrl) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (shuttingDown) {
      return;
    }

    try {
      const response = await fetch(rendererUrl, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      });
      await response.body?.cancel();

      if (response.ok) {
        return;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }

  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(
    `Timed out waiting ${READINESS_TIMEOUT_MS}ms for the renderer at ${rendererUrl}${detail}.`,
  );
}

function portFromUrl(rendererUrl) {
  const port = new URL(rendererUrl).port;
  if (!port) {
    throw new Error(`Renderer URL does not contain a port: ${rendererUrl}`);
  }

  return Number(port);
}

function completedSuccessfully(result) {
  return !result.error && result.code === 0 && result.signal === null;
}

function describeCompletion(result) {
  if (result.error) {
    return `could not start (${result.error.message})`;
  }

  if (result.signal) {
    return `exited from ${result.signal}`;
  }

  return `exited with code ${result.code}`;
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

function shutdown({ signal = "SIGTERM", unexpected = false }) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  closeSourceWatchers();
  exitCode = unexpected ? 1 : signal === "SIGINT" ? 130 : 143;
  resolveShutdownStarted();
  shutdownPromise = stopManagedProcesses(signal).catch((error) => {
    devLog.error(`Failed to stop every dev process: ${error.message}`);
    exitCode = 1;
  });
  return shutdownPromise;
}

async function stopManagedProcesses(signal) {
  const processes = [...managedProcesses];

  if (process.platform === "win32") {
    for (const processRecord of processes) {
      sendSignal(processRecord, signal);
    }

    await delay(SHUTDOWN_GRACE_MS);
    await Promise.all(processes.map((processRecord) => terminateWindowsTree(processRecord)));
    return;
  }

  for (const processRecord of processes) {
    sendSignal(processRecord, signal);
  }

  const stoppedGracefully = await waitForProcessGroupsToExit(processes, SHUTDOWN_GRACE_MS);
  if (stoppedGracefully) {
    return;
  }

  for (const processRecord of processes) {
    if (processGroupExists(processRecord)) {
      sendSignal(processRecord, "SIGKILL");
    }
  }

  await waitForProcessGroupsToExit(processes, SHUTDOWN_KILL_WAIT_MS);
}

function sendSignal(processRecord, signal) {
  const { child } = processRecord;
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    if (!processRecord.exited) {
      child.kill(signal);
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessGroupsToExit(processes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (processes.every((processRecord) => !processGroupExists(processRecord))) {
      return true;
    }

    await delay(100);
  }

  return processes.every((processRecord) => !processGroupExists(processRecord));
}

function processGroupExists(processRecord) {
  const { pid } = processRecord.child;
  if (!pid) {
    return false;
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function terminateWindowsTree(processRecord) {
  const { pid } = processRecord.child;
  if (!pid) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", resolvePromise);
    taskkill.once("exit", resolvePromise);
  });
}

try {
  await main();
} catch (error) {
  if (!shuttingDown) {
    devLog.error(error.message);
    await shutdown({ unexpected: true });
  } else if (shutdownPromise) {
    await shutdownPromise;
  }
} finally {
  await devLog.close();
}

process.exitCode = exitCode;
