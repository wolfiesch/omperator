import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  createStructuredDevelopmentLogger,
  redactDevelopmentLogMessage,
} from "./dev-log.mjs";

function outputCollector() {
  let value = "";
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }),
    value: () => value,
  };
}

test("development log redaction removes credential-shaped values", () => {
  assert.equal(
    redactDevelopmentLogMessage("Authorization=private-value Bearer live-token"),
    "Authorization=[redacted] Bearer [redacted]",
  );
});

test("structured logger records process lifecycle and redacted line output", async () => {
  const root = await mkdtemp(join(tmpdir(), "omperator-dev-log-"));
  const stdout = outputCollector();
  const stderr = outputCollector();
  try {
    const logger = await createStructuredDevelopmentLogger({
      directory: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      now: () => "2026-07-24T00:00:00.000Z",
    });
    const childOut = new PassThrough();
    const childError = new PassThrough();
    logger.attach("fixture", { pid: 42, stdout: childOut, stderr: childError });
    childOut.end("ready\nAPI_TOKEN=private-value\npartial");
    childError.end("warning\n");
    await Promise.all([once(childOut, "end"), once(childError, "end")]);
    logger.processCompleted("fixture", { code: 0, signal: null });
    await logger.close();

    const events = (await readFile(logger.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].phase, "started");
    assert.ok(events.some((event) => event.message === "API_TOKEN=[redacted]"));
    assert.ok(events.some((event) => event.message === "partial"));
    assert.equal(events.at(-1).phase, "completed");
    assert.match(stdout.value(), /ready/);
    assert.match(stderr.value(), /warning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
