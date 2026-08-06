import { FixtureWebSocketServer } from "../packages/fixture-server/src/index.ts";
const port = Number(process.argv[2] ?? 18788);
const scenario = (process.argv[3] ?? "basic-v1") as any;
const server = new FixtureWebSocketServer({ scenario, port, realTime: true });
const address = await server.start();
console.log(`fixture host listening: ${address} (scenario=${scenario})`);
process.on("SIGINT", async () => { await server.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });
