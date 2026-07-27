import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";

export interface UnixSocketPolicy {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly overrideDirectory?: string;
  readonly profileId?: string;
}


/**
 * A deep HOME (a development sandbox nested in a worktree) produced a socket
 * path long enough that connect(2) failed with EINVAL on every attempt.
 * T4_HOST_RUNTIME_DIR relocates the socket to a short absolute directory; the
 * desktop app and the host service both honor it and must agree on the result.
 */

export function localSocketPath(policy: UnixSocketPolicy = {}): string {
  const platform = policy.platform ?? process.platform;
  const home = policy.homeDirectory ?? homedir();
  const profileId = decodeLocalProfileId(policy.profileId ?? "default");
  const name = profileId === "default"
    ? "appserver.sock"
    : `appserver-profile-${createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 24)}.sock`;
  // An explicit override wins on every platform, matching the host service.
  // A deep sandbox HOME cannot otherwise produce a connectable socket path.
  const override = policy.overrideDirectory ?? process.env.T4_HOST_RUNTIME_DIR;
  if (override !== undefined && override.length > 0) {
    if (!override.startsWith("/")) throw new Error("T4_HOST_RUNTIME_DIR must be an absolute path");
    return join(override, name);
  }
  if (platform === "darwin") return join(home, ".omp", "run", name);
  if (platform !== "linux") throw new Error("the local T4 host is supported only on Linux and macOS");
  const configuredRuntime = policy.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR;
  const runtime = configuredRuntime === undefined || configuredRuntime.length === 0
    ? join(home, ".omp", "run")
    : configuredRuntime;
  if (!runtime.startsWith("/")) throw new Error("XDG_RUNTIME_DIR must be an absolute path");
  return join(runtime, "omp", name);
}
