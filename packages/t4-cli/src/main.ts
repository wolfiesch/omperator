// main.ts — t4: terminal UI for a T4 Code host.
//
//   t4                          # local host via ~/.omp/run/appserver.sock
//   t4 --remote ws://host:8787  # remote host (needs --device-id/--device-token
//                               #   or T4_DEVICE_ID/T4_DEVICE_TOKEN env)
//   t4 --remote wss://host:8788 # pinned-TLS (self-signed; fingerprint printed
//                               #   on first connect for out-of-band checking)
import { homedir } from "node:os";
import { join } from "node:path";
import { T4Client } from "./client.ts";
import { Tui } from "./tui.ts";

function arg(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const remote = arg("--remote");
const endpoint = remote
	? remote.replace(/\/$/, "") + "/v1/ws"
	: `ws+unix://${join(homedir(), ".omp", "run", "appserver.sock")}:/ws`;

const auth = remote
	? {
			deviceId: arg("--device-id") ?? process.env.T4_DEVICE_ID ?? "",
			deviceToken: arg("--device-token") ?? process.env.T4_DEVICE_TOKEN ?? "",
		}
	: undefined;
if (remote && (!auth!.deviceId || !auth!.deviceToken)) {
	console.error("t4: --remote needs --device-id/--device-token (or T4_DEVICE_ID/T4_DEVICE_TOKEN)");
	process.exit(2);
}

const tui = new Tui();
const client = new T4Client(endpoint, auth, tui);
tui.setClient(client);
await tui.run();
