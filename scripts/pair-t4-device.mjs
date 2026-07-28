// Pair a device against the remote t4-host with a one-time ticket code, then
// prove the credential works: reconnect with hello.authentication and list
// sessions. Prints the deviceId/deviceToken for the iOS app's Connect sheet.
// Usage: node scripts/pair-t4-device.mjs <ws-url> <code>
import WebSocket from "ws";

const [url, code, deviceName] = process.argv.slice(2);
if (!url || !code) { console.error("usage: pair-t4-device.mjs <ws-url> <code>"); process.exit(2); }
const CAPS = ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "catalog.read", "files.list", "files.read", "files.diff", "term.open", "term.input", "term.resize", "settings.read", "settings.write", "preview.control", "preview.read", "usage.read", "agents.control", "audit.read", "config.read", "config.write"];

function connect(authentication) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let reqN = 0;
    const api = { ws, hostId: undefined, authentication: undefined };
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "welcome") { api.hostId = frame.hostId; api.authentication = frame.authentication; }
      if (frame.type === "response" && pending.has(frame.requestId)) {
        const slot = pending.get(frame.requestId);
        pending.delete(frame.requestId);
        if (frame.ok) slot.resolve(frame.result ?? {});
        else slot.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
      }
    });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        v: "omp-app/1", type: "hello",
        protocol: { min: "omp-app/1", max: "omp-app/1" },
        client: { name: "t4-ios", version: "0.1", build: "dev", platform: "ios" },
        requestedFeatures: [], savedCursors: [],
        ...(authentication ? { authentication } : {}),
      }));
      api.command = (command, args = {}, sessionId) => new Promise((res, rej) => {
        const requestId = `req-p${++reqN}`;
        pending.set(requestId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({
          v: "omp-app/1", type: "command", requestId, commandId: `cmd-p${reqN}`,
          hostId: api.hostId, command, ...(sessionId ? { sessionId } : {}), args,
        }));
      });
      resolve(api);
    });
  });
}

const first = await connect();
await new Promise((r) => first.ws.once("message", r)); // welcome
console.log(`hello: host=${first.hostId} auth=${first.authentication}`);
first.ws.send(JSON.stringify({
  v: "omp-app/1", type: "pair.start", requestId: "req-pair-1",
  code, deviceId: (deviceName ?? "iphone-17-pro-sim").toLowerCase().replace(/[^a-z0-9]+/g, "-"), deviceName: deviceName ?? "iPhone 17 Pro (Simulator)",
  platform: "ios", requestedCapabilities: CAPS,
}));
const pairOk = await new Promise((resolve, reject) => {
  first.ws.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "pair.ok") resolve(frame);
    if (frame.type === "pair.error") reject(new Error(`${frame.code}: ${frame.message}`));
  });
});
console.log(`paired: deviceId=${pairOk.deviceId} granted=${pairOk.grantedCapabilities.join(",")}`);
first.ws.close();

const second = await connect({ deviceId: pairOk.deviceId, deviceToken: pairOk.deviceToken });
await new Promise((r) => second.ws.once("message", r));
console.log(`reconnect: auth=${second.authentication}`);
const list = await second.command("session.list");
console.log(`session.list: ${list.sessions.length} session(s)`);
for (const s of list.sessions) console.log(`  ${s.status} "${s.title}"`);
console.log(`\nCREDENTIALS\nendpoint:  ${url.replace("ws://", "ws://")}\ndeviceId:  ${pairOk.deviceId}\ntoken:     ${pairOk.deviceToken}`);
second.ws.close();
process.exit(0);
