import { spawnSync } from "node:child_process";

const delay = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

export function listProcessesHoldingPath(
  root: string,
  lsofExecutable = "/usr/sbin/lsof",
): readonly number[] {
  const result = spawnSync(lsofExecutable, ["-F", "p", "+D", root], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`failed to inspect scenario process containment: ${detail}`);
  }
  const pids = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    if (!/^p[1-9][0-9]*$/u.test(line)) continue;
    const pid = Number(line.slice(1));
    if (pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

export async function terminateProcessesHoldingPath(
  root: string,
  lsofExecutable = "/usr/sbin/lsof",
): Promise<void> {
  const signal = (pids: readonly number[], value: NodeJS.Signals): void => {
    for (const pid of pids) {
      try { process.kill(pid, value); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };

  signal(listProcessesHoldingPath(root, lsofExecutable), "SIGTERM");
  await delay(250);
  for (let attempt = 0; attempt < 10; attempt++) {
    const remaining = listProcessesHoldingPath(root, lsofExecutable);
    if (remaining.length === 0) return;
    signal(remaining, "SIGKILL");
    await delay(50);
  }

  const remaining = listProcessesHoldingPath(root, lsofExecutable);
  throw new Error(`scenario-owned processes survived cleanup: ${remaining.join(",")}`);
}
