import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const help = `Usage: node scripts/t4-doctor.mjs [--json]

Run read-only, redacted checks for the T4 Code source toolchain, compatible
OMP authority bridge, local T4 host, profiles, and optional Tailscale access.

Options:
  --json  Print a machine-readable report suitable for a redacted bug report
  --help  Show this help`;

export function parseDoctorArguments(args) {
  let json = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") return { help: true, json: false };
    else throw new Error(`unknown option: ${argument}`);
  }
  return { help: false, json };
}

export async function runDoctorCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseDoctorArguments(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid doctor option");
    console.error(help);
    return 2;
  }
  if (options.help) {
    console.log(help);
    return 0;
  }

  const jiti = createJiti(import.meta.url);
  const doctor = await jiti.import("../apps/desktop/src/doctor.ts");
  const report = await doctor.collectDoctorReport();
  console.log(options.json ? JSON.stringify(report, null, 2) : doctor.formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runDoctorCli();
}
