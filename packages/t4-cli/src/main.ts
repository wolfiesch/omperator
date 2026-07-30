// main.ts — t4: terminal UI for a T4 Code host.
//
//   t4                          # local host via ~/.omp/run/appserver.sock
//   t4 --remote wss://host:8788 --credentials ~/.config/t4/host.json
// Credential files must be regular 0600 files containing deviceId,
// deviceToken, and (for a self-signed wss host) tlsFingerprint.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { T4Client } from "./client.ts";
import {
  MAX_CREDENTIAL_FILE_BYTES,
  normalizeRemoteEndpoint,
  parseRemoteCredentials,
} from "./remote-config.ts";
import { Tui } from "./tui.ts";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const remote = arg("--remote");
let endpoint = `ws+unix://${join(homedir(), ".omp", "run", "appserver.sock")}:/ws`;
if (remote) {
  try {
    endpoint = normalizeRemoteEndpoint(remote);
  } catch {
    console.error("t4: --remote requires a credential-free wss:// endpoint");
    process.exit(2);
  }
}

let auth: { deviceId: string; deviceToken: string } | undefined;
let tlsFingerprint: string | undefined;
if (remote) {
  const credentialPath = arg("--credentials");
  if (!credentialPath) {
    console.error("t4: --remote requires --credentials <0600-json-file>");
    process.exit(2);
  }
  let text: string;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size === 0 ||
      info.size > MAX_CREDENTIAL_FILE_BYTES
    )
      throw new Error("unsafe credential file");
    text = readFileSync(descriptor, "utf8");
  } catch {
    console.error("t4: credential file must be a non-symlink regular file with mode 0600");
    process.exit(2);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    const credentials = parseRemoteCredentials(text);
    auth = { deviceId: credentials.deviceId, deviceToken: credentials.deviceToken };
    tlsFingerprint = credentials.tlsFingerprint;
  } catch {
    console.error("t4: credential file is malformed");
    process.exit(2);
  }
}

const tui = new Tui();
// A TUI must never die on a stray rejection mid-reconnect; surface it instead.
process.on("unhandledRejection", (reason) => {
  tui.error(`internal: ${reason instanceof Error ? reason.message : reason}`);
});
const client = new T4Client(endpoint, auth, tui, !remote, tlsFingerprint);
tui.setClient(client);
await tui.run();
