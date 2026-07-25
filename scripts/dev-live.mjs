import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  prepareDevelopmentSandbox,
  sandboxEnvironment,
} from "./dev-sandbox.mjs";
import { pnpmProcessInvocation } from "./pnpm-process.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: node scripts/dev-live.mjs [--runtime pinned|system] [--sandbox <name>]

Start Omperator with project-owned disposable development state.

Options:
  --runtime   Use the repository-pinned OMP runtime or a compatible system runtime
  --sandbox   Select the disposable sandbox name (default: local)
  --help      Show this help`;

export function parseLiveDevelopmentArguments(args) {
  let runtime = "pinned";
  let sandbox = "local";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { help: true, runtime, sandbox };
    if (argument !== "--runtime" && argument !== "--sandbox") {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--runtime") {
      if (value !== "pinned" && value !== "system") {
        throw new Error("--runtime must be pinned or system");
      }
      runtime = value;
    } else {
      sandbox = value;
    }
  }
  return { help: false, runtime, sandbox };
}

function run(command, args, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: environment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}


export async function runLiveDevelopmentCli(args = process.argv.slice(2), environment = process.env) {
  let options;
  try {
    options = parseLiveDevelopmentArguments(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid live development option");
    console.error(help);
    return 2;
  }
  if (options.help) {
    console.log(help);
    return 0;
  }

  const paths = await prepareDevelopmentSandbox(options.sandbox);
  const developmentEnvironment = sandboxEnvironment(paths, environment);
  let ompExecutable = developmentEnvironment.OMP_EXECUTABLE;
  if (options.runtime === "pinned") {
    const staged = await run(
      process.execPath,
      [resolve(repoRoot, "scripts", "stage-omp-runtime.mjs")],
      developmentEnvironment,
    );
    if (staged.code !== 0 || staged.signal !== null) return staged.code ?? 1;
    ompExecutable = resolve(repoRoot, ".artifacts", "omp-runtime", "omp");
    await access(ompExecutable);
  }
  if (ompExecutable !== undefined) developmentEnvironment.OMP_EXECUTABLE = ompExecutable;

  const doctor = await run(
    process.execPath,
    [resolve(repoRoot, "scripts", "t4-doctor.mjs")],
    developmentEnvironment,
  );
  if (doctor.code !== 0 || doctor.signal !== null) return doctor.code ?? 1;

  console.log(`Development sandbox: ${paths.name}`);
  console.log(`Structured logs: ${paths.processLogs}`);
  console.log(
    `Reset command: pnpm dev:sandbox reset --sandbox ${paths.name}`,
  );

  const invocation = pnpmProcessInvocation(["dev"], environment.npm_execpath);
  const result = await run(
    invocation.command,
    invocation.args,
    developmentEnvironment,
  );
  return result.code ?? (result.signal === "SIGINT" ? 130 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLiveDevelopmentCli();
}
