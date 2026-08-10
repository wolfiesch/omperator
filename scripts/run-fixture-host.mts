import { createInterface } from "node:readline";
import { FixtureWebSocketServer } from "../packages/fixture-server/src/index.ts";
const port = Number(process.argv[2] ?? 18788);
const scenario = (process.argv[3] ?? "basic-v1") as any;
const server = new FixtureWebSocketServer({ scenario, port, realTime: true });
const address = await server.start();
console.log(`fixture host listening: ${address} (scenario=${scenario})`);
const control = createInterface({ input: process.stdin, crlfDelay: Infinity });
control.on("line", (line) => {
  const [command, requestId = "unlabeled"] = line.trim().split(/\s+/, 2);
  if (command === "drop") {
    server.dropConnections();
    console.log(`fixture control: dropped ${requestId}`);
  } else if (command === "status") {
    console.log(
      `fixture control: status ${requestId} connections=${server.connectionCount} clients=${server.clientCount}`,
    );
  }
});
process.on("SIGINT", async () => { await server.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });
