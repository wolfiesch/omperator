// Send session.prompt to a session as a paired device, with the prompt-lease
// flow remote mutation commands require (acquire → mutate with leaseId +
// expectedRevision → release). Streams entry frames to stdout.
// Usage: node scripts/prompt-t4-session.mjs <ws-url> <deviceId> <token> <sessionId> <message>
import WebSocket from "ws";

const [url, deviceId, deviceToken, sessionId, ...words] = process.argv.slice(2);
const message = words.join(" ");
if (!url || !deviceId || !deviceToken || !sessionId || !message) {
  console.error("usage: prompt-t4-session.mjs <ws-url> <deviceId> <token> <sessionId> <message>");
  process.exit(2);
}

const ws = new WebSocket(url);
const pending = new Map();
let reqN = 0;
let hostId;

function command(command, args = {}, sessionIdArg, expectedRevision) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${Date.now()}-${++reqN}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "command", requestId, commandId: `cmd-${requestId}`,
      hostId, command, args,
      ...(sessionIdArg ? { sessionId: sessionIdArg } : {}),
      ...(expectedRevision ? { expectedRevision } : {}),
    }));
  });
}

const idle = (() => { let timer; return (ms) => { clearTimeout(timer); timer = setTimeout(() => { console.log("idle — done"); process.exit(0); }, ms); }; })();

ws.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === "welcome") {
    hostId = frame.hostId;
    run().catch((e) => { console.error("failed:", e.message); process.exit(1); });
  } else if (frame.type === "response" && pending.has(frame.requestId)) {
    const slot = pending.get(frame.requestId);
    pending.delete(frame.requestId);
    frame.ok ? slot.resolve(frame.result ?? {}) : slot.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
  } else if (frame.type === "entry" && frame.sessionId === sessionId) {
    console.log(`entry ${frame.entry.kind} ${JSON.stringify(frame.entry.data).slice(0, 140)}`);
    idle(30_000);
  } else if (frame.type === "error") {
    console.error("error frame:", JSON.stringify(frame));
  }
});

async function run() {
  console.log(`welcome auth ok, host=${hostId}`);
  const list = await command("session.list");
  const session = list.sessions.find((s) => s.sessionId === sessionId);
  if (!session) throw new Error("session not in inventory");
  const lease = await command("prompt.lease.acquire", { ownerId: "prompt-script" }, sessionId, session.revision);
  console.log(`lease ${lease.leaseId}`);
  await command("session.prompt", { message, leaseId: lease.leaseId }, sessionId, session.revision);
  console.log("prompt accepted — streaming");
  idle(45_000);
}

ws.on("open", () => {
  ws.send(JSON.stringify({
    v: "omp-app/1", type: "hello",
    protocol: { min: "omp-app/1", max: "omp-app/1" },
    client: { name: "t4-seed", version: "0.1", build: "dev", platform: "macos" },
    requestedFeatures: [], savedCursors: [],
    authentication: { deviceId, deviceToken },
  }));
});
ws.on("close", (code, reason) => { console.error(`closed ${code}: ${reason}`); process.exit(1); });
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
