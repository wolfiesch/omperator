// Seed three real sessions on the local t4-host over host-wire (omp-app/1).
// Usage: node scripts/seed-t4-demo.mjs [ws-url]
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

const projectRoot = realpathSync(process.env.T4_PROJECT_ROOT ?? `${process.env.HOME}/dev/omperator`);
const projectId = `project-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 24)}`;

const url = process.argv[2] ?? "ws://127.0.0.1:8787/v1/ws";
const ws = new WebSocket(url);
const pending = new Map();
let reqN = 0;
let cmdN = 0;
let hostId;
const entries = [];
const runId = Date.now().toString(36);

function command(command, args = {}, sessionId, expectedRevision) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${runId}-${++reqN}`;
    const commandId = `cmd-${runId}-${++cmdN}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "command", requestId, commandId, hostId, command,
      ...(sessionId ? { sessionId } : {}),
      ...(expectedRevision ? { expectedRevision } : {}),
      args,
    }));
  });
}

ws.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === "welcome") {
    hostId = frame.hostId;
    console.log(`welcome: host=${hostId} auth=${frame.authentication}`);
  } else if (frame.type === "response") {
    const slot = pending.get(frame.requestId);
    if (!slot) return;
    pending.delete(frame.requestId);
    if (frame.ok) slot.resolve(frame.result ?? {});
    else slot.reject(new Error(`${frame.error?.code}: ${frame.error?.message} ${JSON.stringify(frame.error?.details ?? {})}`));
  } else if (frame.type === "entry") {
    entries.push(frame.entry);
    const kind = frame.entry?.kind ?? "?";
    const headline = frame.entry?.data?.title ?? frame.entry?.data?.tool ?? frame.entry?.data?.role ?? "";
    console.log(`  entry [${frame.sessionId}] ${kind} ${headline}`);
  } else if (frame.type === "error") {
    console.error("host error frame:", frame);
  }
});

ws.on("open", async () => {
  try {
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "hello",
      protocol: { min: "omp-app/1", max: "omp-app/1" },
      client: { name: "t4-seed", version: "0.1", build: "dev", platform: "macos" },
      requestedFeatures: [], savedCursors: [],
    }));
    await new Promise((resolve) => {
      const check = (data) => {
        if (JSON.parse(data.toString()).type === "welcome") { ws.off("message", check); resolve(); }
      };
      ws.on("message", check);
    });

    const specs = process.env.SEED_LIST_ONLY ? [] : [
      { title: "DeepSeek: explain backoff", prompt: "In one short paragraph, explain why exponential backoff with jitter beats fixed retries." },
      { title: "DeepSeek: haiku", prompt: "Write a haiku about a websocket that never gives up." },
      { title: "DeepSeek: quick math", prompt: "What is 17 * 23? Answer with just the number." },
    ];

    for (const spec of specs) {
      const created = await command("session.create", { projectId, title: spec.title });
      const session = created.session;
      console.log(`created ${session.sessionId} rev=${session.revision} title="${spec.title}"`);
      try {
        await command("session.model.set", { selector: "deepseek/deepseek-v4-flash", persistence: "session" },
          session.sessionId, session.revision);
        console.log("  model set to deepseek/deepseek-v4-flash");
      } catch (error) {
        console.log(`  model.set failed (${error.message}) — using host default`);
      }
      await command("session.prompt", { message: spec.prompt }, session.sessionId);
      console.log("  prompt sent");
    }

    // Let the turns run; entries stream as they land.
    if (specs.length > 0) await new Promise((resolve) => setTimeout(resolve, 60_000));
    const list = await command("session.list");
    console.log(`\nfinal inventory: ${list.sessions.length} session(s)`);
    for (const s of list.sessions) console.log(`  ${s.sessionId} ${s.status} "${s.title}"`);
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error("seed failed:", error);
    process.exit(1);
  }
});
ws.on("error", (error) => { console.error("ws error:", error.message); process.exit(1); });
