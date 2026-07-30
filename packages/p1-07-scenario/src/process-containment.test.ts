import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  listProcessesHoldingPath,
  terminateProcessesHoldingPath,
} from "./process-containment.js";

const LSOF = "/usr/sbin/lsof";

test("fails closed when process containment cannot be inspected", () => {
  expect(() => listProcessesHoldingPath(tmpdir(), "/missing/lsof")).toThrow("failed to inspect");
});

if (existsSync(LSOF)) {
  test("terminates detached processes that retain the scenario root", async () => {
    const root = mkdtempSync(join(tmpdir(), "p107-containment-test-"));
    const child = Bun.spawn(
      ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"],
      { cwd: root, stdout: "ignore", stderr: "ignore" },
    );

    try {
      // This platform integration waits for lsof to observe a real spawned process;
      // fake timers cannot advance kernel process-table visibility.
      const deadline = Date.now() + 2_000;
      while (!listProcessesHoldingPath(root, LSOF).includes(child.pid)) {
        if (Date.now() >= deadline) throw new Error("child never appeared in lsof containment set");
        await Bun.sleep(20);
      }

      await terminateProcessesHoldingPath(root, LSOF);

      expect(listProcessesHoldingPath(root, LSOF)).toEqual([]);
      expect(await child.exited).not.toBe(0);
    } finally {
      child.kill(9);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
