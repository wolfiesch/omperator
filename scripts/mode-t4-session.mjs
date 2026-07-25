// Plan-mode end-to-end driver: controller-lease for session.mode.set,
// prompt-lease for the prompt (the lease-kind split the host enforces).
// Usage: node scripts/mode-t4-session.mjs <ws-url> <deviceId> <token> <sessionId> <mode> <message>
import WebSocket from "ws";

const [url, deviceId, deviceToken, sessionId, mode, ...words] = process.argv.slice(2);
const message = words.join(" ");
const ws = new WebSocket(url);
const pend = new Map();
let n = 0;
let hostId;
const raw = (command, args = {}, sid, rev) => new Promise((res, rej) => {
  const requestId = `r${++n}`;
  pend.set(requestId, { res, rej });
  ws.send(JSON.stringify({
    v: "omp-app/1", type: "command", requestId, commandId: `c${requestId}-${Date.now()}`,
    hostId, command, args, ...(sid ? { sessionId: sid } : {}), ...(rev ? { expectedRevision: rev } : {}),
  }));
});

async function revisionOf(sid) {
  const list = await raw("session.list");
  return list.sessions.find((s) => s.sessionId === sid).revision;
}

ws.on("message", async (d) => {
  const f = JSON.parse(d.toString());
  if (f.type === "response" && pend.has(f.requestId)) {
    const s = pend.get(f.requestId); pend.delete(f.requestId);
    f.ok ? s.res(f.result ?? {}) : s.rej(new Error(`${f.error?.code}: ${f.error?.message}`));
  }
  if (f.type !== "welcome") return;
  hostId = f.hostId;
  try {
    let rev = await revisionOf(sessionId);
    const cLease = (await raw("controller.lease.acquire", { ownerId: "mode-test" }, sessionId, rev)).leaseId;
    rev = await revisionOf(sessionId);
    const modeResp = await raw("session.mode.set", { mode, leaseId: cLease }, sessionId, rev);
    console.log("mode.set →", JSON.stringify(modeResp));

    rev = await revisionOf(sessionId);
    const pLease = (await raw("prompt.lease.acquire", { ownerId: "mode-test" }, sessionId, rev)).leaseId;
    await raw("session.prompt", { message, leaseId: pLease }, sessionId);
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
