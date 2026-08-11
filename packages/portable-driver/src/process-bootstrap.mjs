import { spawn } from "node:child_process";

let workload;
let started = false;
process.on("message", (message) => {
  if (started || message !== "start") return;
  started = true;
  const [executable, ...args] = process.argv.slice(2);
  if (!executable) process.exit(64);
  workload = spawn(executable, args, { cwd: process.cwd(), env: process.env, stdio: "ignore", shell: false });
  workload.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  process.disconnect?.();
});
process.on("disconnect", () => {
  if (!started) process.exit(70);
});
