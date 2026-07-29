// Seed one staging session per macOS showcase scenario (showcase/index.html,
// "macOS" section) on the local t4-host over host-wire (omp-app/1). Sessions
// are created in reverse order so the rail reads shot 01 → shot 12 top-down
// (the app sorts sessions by updatedAt descending).
//
// Usage: node scripts/seed-t4-shots.mjs [ws-url]
//   default url: ws+unix://$HOME/.omp/run/appserver.sock:/ws
//   T4_PROJECT_ROOT overrides the project the sessions attach to.
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const projectRoot = realpathSync(process.env.T4_PROJECT_ROOT ?? `${process.env.HOME}/dev/omperator`);
const projectId = `project-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 24)}`;

const url = process.argv[2] ?? `ws+unix://${join(homedir(), ".omp", "run", "appserver.sock")}:/ws`;
const ws = new WebSocket(url);
const pending = new Map();
let reqN = 0;
let hostId;

function command(command, args = {}, sessionId, expectedRevision) {
  return new Promise((resolve, reject) => {
    const requestId = `req-shots-${++reqN}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "command", requestId, commandId: `cmd-shots-${reqN}`,
      hostId, command,
      ...(sessionId ? { sessionId } : {}),
      ...(expectedRevision ? { expectedRevision } : {}),
      args,
    }));
  });
}

async function revisionOf(sessionId) {
  const list = await command("session.list");
  return list.sessions.find((s) => s.sessionId === sessionId)?.revision;
}

// One row per macOS carousel slide in showcase/index.html. `mode: "plan"`
// drives the plan panel / inbox scenarios (a proposed plan is attention).
const specs = [
  { shot: "01", title: "shot 01 · session", prompt: "Give a three-bullet summary of what this repository ships, based on README.md. Keep each bullet under ten words." },
  { shot: "02", title: "shot 02 · files", prompt: "List the top-level directories of this project with one short line on each. Be brief." },
  { shot: "03", title: "shot 03 · agents", prompt: "Spawn a subagent to scan the scripts/ directory and report the three scripts most useful for demo screenshots. Keep the final answer to three lines." },
  { shot: "04", title: "shot 04 · terminal", prompt: "What single shell command prints the last five git commits, one per line? Answer with just the command." },
  { shot: "05", title: "shot 05 · browser", prompt: "Which file in this repo renders the showcase page? Answer with the path only." },
  { shot: "06", title: "shot 06 · floating tiles", prompt: "In one short sentence, what can the right dock of the desktop app contain?" },
  { shot: "07", title: "shot 07 · searchdiff", prompt: "Find which source file renders the macOS session composer and answer with just the path." },
  { shot: "08", title: "shot 08 · plan", mode: "plan", prompt: "Plan a small change: add a footer note to showcase/index.html crediting the palette. Produce the plan only — do not implement anything." },
  { shot: "09", title: "shot 09 · ask", prompt: "What is 2 + 2? Answer with just the number." },
  { shot: "10", title: "shot 10 · usage", prompt: "Write a five-line limerick about a tailnet that never drops a packet." },
  { shot: "11", title: "shot 11 · settings", prompt: "In one line, which model is answering this question?" },
  { shot: "12", title: "shot 12 · inbox", mode: "plan", prompt: "Plan adding a light/dark toggle to the showcase page. Produce the plan only — do not implement anything." },
];

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
    else slot.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ws.on("open", async () => {
  try {
    ws.send(JSON.stringify({
      v: "omp-app/1", type: "hello",
      protocol: { min: "omp-app/1", max: "omp-app/1" },
      client: { name: "t4-seed-shots", version: "0.1", build: "dev", platform: "macos" },
      requestedFeatures: ["resume", "prompt.lease", "controller.lease"], savedCursors: [],
    }));
    await new Promise((resolve) => {
      const check = (data) => {
        if (JSON.parse(data.toString()).type === "welcome") { ws.off("message", check); resolve(); }
      };
      ws.on("message", check);
    });

    // Reverse order: shot 12 first, shot 01 last — updatedAt-desc sorting then
    // places shot 01 at the top of the rail.
    for (const spec of [...specs].reverse()) {
      const created = await command("session.create", { projectId, title: spec.title });
      const session = created.session;
      console.log(`created ${session.sessionId} "${spec.title}"`);
      try {
        await command("session.model.set", { selector: "deepseek/deepseek-v4-flash", persistence: "session" },
          session.sessionId, session.revision);
      } catch (error) {
        console.log(`  model.set failed (${error.message}) — using host default`);
      }
      if (spec.mode) {
        try {
          let rev = await revisionOf(session.sessionId);
          let leaseId;
          try {
            leaseId = (await command("controller.lease.acquire", { ownerId: "t4-seed-shots" }, session.sessionId, rev)).leaseId;
          } catch { leaseId = undefined; }
          rev = await revisionOf(session.sessionId);
          await command("session.mode.set", { mode: spec.mode, ...(leaseId ? { leaseId } : {}) }, session.sessionId, rev);
          console.log(`  mode set to ${spec.mode}`);
        } catch (error) {
          console.log(`  mode.set failed (${error.message})`);
        }
      }
      await command("session.prompt", { message: spec.prompt }, session.sessionId);
      console.log("  prompt sent");
    }

    // Wait for turns to settle: poll until every seeded session is idle.
    const titles = new Set(specs.map((s) => s.title));
    const deadline = Date.now() + 240_000;
    let settled = false;
    while (Date.now() < deadline && !settled) {
      await sleep(5_000);
      const list = await command("session.list");
      const mine = list.sessions.filter((s) => titles.has(s.title));
      settled = mine.length === specs.length && mine.every((s) => s.status === "idle" || s.status === "attention");
      const active = mine.filter((s) => s.status !== "idle" && s.status !== "attention").length;
      console.log(`  … ${mine.length - active}/${mine.length} settled`);
    }

    const list = await command("session.list");
    console.log("\nscenario sessions:");
    for (const s of list.sessions.filter((s) => titles.has(s.title)).sort((a, b) => a.title.localeCompare(b.title))) {
      console.log(`  ${s.sessionId} ${s.status} "${s.title}"`);
    }
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error("seed failed:", error);
    process.exit(1);
  }
});
ws.on("error", (error) => { console.error("ws error:", error.message); process.exit(1); });
