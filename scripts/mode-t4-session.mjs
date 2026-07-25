// Plan-mode end-to-end test: set mode, prompt, verify behavior.
// Usage: node scripts/mode-t4-session.mjs <ws-url> <deviceId> <token> <sessionId> <mode> <message>
import WebSocket from "ws";

const [url, deviceId, deviceToken, sessionId, mode, ...words] = process.argv.slice(2);
const message = words.join(" ");
const ws = new WebSocket(url);
const pend = new Map();
let n = 0;
let hostId;
const raw = (obj) => new Promise((res, rej) => { pend.set(obj.requestId, { res, rej }); ws.send(JSON.stringify(obj)); });

ws.on("message", async (d) => {
  const f = JSON.parse(d.toString());
  if (f.type === "response" && pend.has(f.requestId)) {
    const s = pend.get(f.requestId); pend.delete(f.requestId);
    f.ok ? s.res(f.result ?? {}) : s.rej(new Error(`${f.error?.code}: ${f.error?.message}`));
  }
  if (f.type !== "welcome") return;
  hostId = f.hostId;
  try {
    const list = (await raw({ v: "omp-app/1", type: "command", requestId: "r1", commandId: "c1" + Date.now(), hostId, command: "session.list", args: {} })).sessions;
    const sess = list.find((s) => s.sessionId === sessionId);
    const lease = (await raw({ v: "omp-app/1", type: "command", requestId: "r2", commandId: "c2" + Date.now(), hostId, command: "prompt.lease.acquire", args: { ownerId: "mode-test" }, sessionId, expectedRevision: sess.revision })).leaseId;
    const modeResp = await raw({ v: "omp-app/1", type: "command", requestId: "r3", commandId: "c3" + Date.now(), hostId, command: "session.mode.set", args: { mode, leaseId: lease }, sessionId, expectedRevision: sess.revision });
    console.log("mode.set →", JSON.stringify(modeResp));
    await raw({ v: "omp-app/1", type: "command", requestId: "r4", commandId: "c4" + Date.now(), hostId, command: "session.prompt", args: { message, leaseId: lease }, sessionId });
    console.log(`prompt sent in ${mode} mode — waiting for turn`);
    setTimeout(() => process.exit(0), 45_000);
  } catch (e) { console.error("failed:", e.message); process.exit(1); }
});
ws.on("open", () => ws.send(JSON.stringify({
  v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" },
  client: { name: "t4-mode-test", version: "0.1", build: "dev", platform: "macos" },
  requestedFeatures: ["resume", "prompt.lease", "controller.lease"], savedCursors: [],
  authentication: { deviceId, deviceToken },
})));
ws.on("close", (c, r) => { console.error(`closed ${c}: ${r}`); process.exit(1); });
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
