import { createInterface } from "node:readline";
import {
  FixtureWebSocketServer,
  SCENARIO_IDS,
  type ScenarioId,
} from "../packages/fixture-server/src/index.ts";
const port = Number(process.argv[2] ?? 18788);
const scenarioArgument = process.argv[3] ?? "basic-v1";
const isScenarioId = (value: string): value is ScenarioId =>
  SCENARIO_IDS.some((candidate) => candidate === value);
if (!isScenarioId(scenarioArgument)) throw new RangeError(`unknown fixture scenario: ${scenarioArgument}`);
const scenario = scenarioArgument;
const autoApproveTerminal = process.argv.includes("--auto-approve-terminal");
const server = new FixtureWebSocketServer({
  scenario,
  port,
  realTime: true,
  autoApproveCommands: autoApproveTerminal ? ["term.open"] : undefined,
});
const address = await server.start();
console.log(
  `fixture host listening: ${address} (scenario=${scenario}, terminalAutoApprove=${autoApproveTerminal})`,
);
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
  } else if (command === "terminal-status") {
    console.log(
      `fixture control: terminal-status ${requestId} ${JSON.stringify(server.engine.terminalObservations)}`,
    );
  }
});
process.on("SIGINT", async () => { await server.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });
