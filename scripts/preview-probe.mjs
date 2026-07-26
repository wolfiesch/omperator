// Probe: preview.launch + preview.capture on the debug host (8899).
import WebSocket from "ws";

const ws = new WebSocket("ws+unix:///Users/alexis/.omp/run/appserver.sock:/ws");
let hostId, cmd = 0, sid;
const send = (command, args = {}) =>
  ws.send(JSON.stringify({
    v: "omp-app/1", type: "command", requestId: `r${++cmd}`, commandId: `c${cmd}${Date.now()}`,
    hostId, command, args, ...(sid ? { sessionId: sid } : {}),
  }));

ws.on("message", (d) => {
  const f = JSON.parse(d.toString());
  if (f.type === "confirmation") {
    console.log("challenge — approving");
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "confirm", requestId: `rc${Date.now()}`,
      confirmationId: f.confirmationId, commandId: f.commandId,
      hostId, sessionId: f.sessionId, decision: "approve",
    }));
    return;
  }
  if (f.type === "welcome") { hostId = f.hostId; send("session.list"); return; }
  if (f.command === "session.list") {
    sid = process.env.PREVIEW_SID ?? f.result.sessions[0].sessionId;
    console.log("sid", sid);
    send("preview.launch", { url: "http://localhost:3000" });
    return;
  }
  if (f.type === "response") {
    console.log(f.command ?? f.requestId, f.ok, JSON.stringify(f.result ?? f.error).slice(0, 220));
    if (cmd === 2) send("preview.capture");
    if (cmd === 3) process.exit(0);
  }
});
ws.on("open", () =>
  ws.send(JSON.stringify({
    v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" },
    client: { name: "t4-seed", version: "0.1", build: "dev", platform: "macos" },
    requestedFeatures: ["preview.control", "preview.read"], savedCursors: [],
  })));
ws.on("close", (c, r) => console.log("CLOSED", c, r?.toString()));
setTimeout(() => process.exit(1), 300_000);
