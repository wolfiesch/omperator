import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_MESSAGE_LENGTH = 16 * 1024;
const SECRET_ASSIGNMENT = /([A-Za-z0-9_-]*(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;]+/giu;

export function redactDevelopmentLogMessage(value) {
  return String(value)
    .replaceAll(/(Bearer\s+)[^\s]+/giu, "$1[redacted]")
    .replaceAll(SECRET_ASSIGNMENT, "$1[redacted]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function endStream(stream) {
  return new Promise((resolvePromise, reject) => {
    stream.end((error) => (error ? reject(error) : resolvePromise()));
  });
}

export async function createStructuredDevelopmentLogger(options) {
  const directory = options.directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "events.ndjson");
  const events = createWriteStream(path, { flags: "a", mode: 0o600 });
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;

  const record = (event) => {
    if (closed) return;
    const safe = {
      schemaVersion: 1,
      timestamp: now(),
      ...event,
      ...(event.message === undefined
        ? {}
        : { message: redactDevelopmentLogMessage(event.message) }),
    };
    events.write(`${JSON.stringify(safe)}\n`);
  };

  const parent = (level, message) => {
    const line = `[dev] ${message}\n`;
    (level === "error" ? errorOutput : output).write(line);
    record({ kind: "supervisor", level, message });
  };

  const attach = (label, child) => {
    record({ kind: "process", phase: "started", process: label, pid: child.pid ?? null });
    for (const [streamName, source, destination] of [
      ["stdout", child.stdout, output],
      ["stderr", child.stderr, errorOutput],
    ]) {
      if (source === null) continue;
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const emitLines = (final = false) => {
        const lines = pending.split("\n");
        const remainder = lines.pop() ?? "";
        pending = final ? "" : remainder;
        for (const line of lines) {
          if (line.length > 0)
            record({ kind: "output", process: label, stream: streamName, message: line });
        }
        if (final && remainder.length > 0) {
          record({ kind: "output", process: label, stream: streamName, message: remainder });
        }
      };
      source.on("data", (chunk) => {
        destination.write(chunk);
        pending += decoder.write(chunk);
        if (pending.length > MAX_MESSAGE_LENGTH * 2) {
          record({ kind: "output", process: label, stream: streamName, message: pending });
          pending = "";
        } else {
          emitLines();
        }
      });
      source.once("end", () => {
        pending += decoder.end();
        emitLines(true);
      });
    }
  };

  return Object.freeze({
    path,
    info(message) {
      parent("info", message);
    },
    error(message) {
      parent("error", message);
    },
    attach,
    processCompleted(label, result) {
      record({
        kind: "process",
        phase: "completed",
        process: label,
        exitCode: result.code ?? null,
        signal: result.signal ?? null,
        ...(result.error === undefined ? {} : { message: result.error.message }),
      });
    },
    record,
    async close() {
      if (closed) return;
      closed = true;
      await endStream(events);
    },
  });
}
