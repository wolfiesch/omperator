import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const developmentEndpoint = process.env.T4_DEVELOPMENT_ENDPOINT?.trim();
if (
  developmentEndpoint &&
  !args.some((argument) =>
    argument.startsWith("--dart-define=T4_DEVELOPMENT_ENDPOINT="),
  )
) {
  args.push(`--dart-define=T4_DEVELOPMENT_ENDPOINT=${developmentEndpoint}`);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostBuild = spawnSync("pnpm", ["build:host"], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (hostBuild.status !== 0) {
  process.exitCode = hostBuild.status ?? 1;
  process.exit();
}
const hostExecutable = resolve(repositoryRoot, "packages/host-daemon/dist/t4-host");
const child = spawn("flutter", ["run", ...args], {
  cwd: resolve(repositoryRoot, "apps/flutter"),
  env: {
    ...process.env,
    T4_HOST_EXECUTABLE: process.env.T4_HOST_EXECUTABLE ?? hostExecutable,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Unable to launch Flutter: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
