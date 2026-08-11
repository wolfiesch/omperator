import { openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:net";

const stateRoot = process.env.T4_RUNTIME_STATE_ROOT;
const generation = process.env.T4_RUNTIME_GENERATION;
if (!stateRoot || !generation) process.exit(64);
const writer = openSync(join(stateRoot, "writer-open.log"), "a", 0o600);
const descendant = spawn(
  process.execPath,
  ["-e", "require('node:net').createServer().listen(0, '127.0.0.1')"],
  { stdio: "ignore" },
);
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(stateRoot, "ready.json"), JSON.stringify({ generation, descendantPid: descendant.pid }), { mode: 0o600 });
});
const stop = () => { try { process.kill(descendant.pid, "SIGTERM"); } catch {} server.close(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void writer;
