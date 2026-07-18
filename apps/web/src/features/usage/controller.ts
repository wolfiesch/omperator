// Read-only host seam for account usage. Target eligibility is derived from
// the live connection, host binding, command catalog, and granted capability;
// the renderer never shells out to `omp usage` or guesses which profile owns
// an account pool.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import { hostId as brandHostId } from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";

import { commandSupport } from "../session-runtime/session-controls.ts";
import { decodeUsageSnapshot, type UsageSnapshot } from "./model.ts";

export const USAGE_READ_COMMAND = "usage.read";

export interface UsageRuntimePort {
  getSnapshot(): DesktopRuntimeSnapshot;
  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void;
  command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult>;
}

export interface UsageTarget {
  readonly targetId: string;
  readonly hostId: string;
  readonly label: string;
  readonly detail: "Default OMP profile" | "OMP profile" | "Remote host";
  readonly isLocal: boolean;
}

export type UsageAvailability =
  | "ready"
  | "no-host"
  | "connecting"
  | "waiting-catalog"
  | "unsupported";

export interface UsageTargetResolution {
  readonly availability: UsageAvailability;
  readonly targets: readonly UsageTarget[];
}

function sameTarget(left: UsageTarget, right: UsageTarget): boolean {
  return (
    left.targetId === right.targetId &&
    left.hostId === right.hostId &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.isLocal === right.isLocal
  );
}

function sortTargets(left: UsageTarget, right: UsageTarget): number {
  const leftRank = left.targetId === "local" ? 0 : left.isLocal ? 1 : 2;
  const rightRank = right.targetId === "local" ? 0 : right.isLocal ? 1 : 2;
  return leftRank - rightRank || left.label.localeCompare(right.label) || left.targetId.localeCompare(right.targetId);
}

/** Connected, bound hosts that both publish and grant `usage.read`. */
export function resolveUsageTargets(snapshot: DesktopRuntimeSnapshot): UsageTargetResolution {
  const targets: UsageTarget[] = [];
  let connecting = false;
  let connected = false;
  let waitingCatalog = false;

  for (const [targetId, target] of snapshot.targets) {
    const state = snapshot.connections.get(targetId) ?? target.state;
    if (state === "connecting") connecting = true;
    if (state !== "connected") continue;
    connected = true;
    const hostId = snapshot.targetHosts.get(targetId);
    if (hostId === undefined) continue;
    const host = snapshot.hosts.get(hostId);
    const catalog = snapshot.catalogs.get(hostId);
    if (catalog === undefined) {
      waitingCatalog = true;
      continue;
    }
    const support = commandSupport(catalog, host?.grantedCapabilities ?? [], USAGE_READ_COMMAND);
    if (!support.supported) continue;
    const isLocal = target.kind === "local";
    targets.push(
      Object.freeze({
        targetId,
        hostId,
        label: target.label,
        detail: isLocal
          ? targetId === "local"
            ? "Default OMP profile"
            : "OMP profile"
          : "Remote host",
        isLocal,
      }),
    );
  }

  targets.sort(sortTargets);
  const frozen = Object.freeze(targets);
  if (frozen.length > 0) return { availability: "ready", targets: frozen };
  if (waitingCatalog) return { availability: "waiting-catalog", targets: frozen };
  if (connected) return { availability: "unsupported", targets: frozen };
  if (connecting) return { availability: "connecting", targets: frozen };
  return { availability: "no-host", targets: frozen };
}

export function usageTargetsEqual(
  left: readonly UsageTarget[],
  right: readonly UsageTarget[],
): boolean {
  return left.length === right.length && left.every((target, index) => sameTarget(target, right[index]!));
}

export interface ReadUsageOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function responseError(result: CommandResult): Error {
  const message = result.error?.message.trim();
  return new Error(message === undefined || message.length === 0 ? "The host did not return account usage." : message);
}

/** Execute one bounded `usage.read` and decode its returned snapshot. */
export async function readUsage(
  runtime: UsageRuntimePort,
  target: UsageTarget,
  options: ReadUsageOptions = {},
): Promise<UsageSnapshot> {
  const before = runtime.getSnapshot();
  if (
    before.connections.get(target.targetId) !== "connected" ||
    before.targetHosts.get(target.targetId) !== target.hostId
  ) {
    throw new Error("This OMP profile is no longer connected.");
  }

  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Account usage took too long to load.")), timeoutMs);
  });

  let result: CommandResult;
  try {
    result = await Promise.race([
      runtime.command(target.targetId, {
        hostId: brandHostId(target.hostId),
        command: USAGE_READ_COMMAND,
        args: {},
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!result.accepted) throw responseError(result);
  const after = runtime.getSnapshot();
  if (
    after.connections.get(target.targetId) !== "connected" ||
    after.targetHosts.get(target.targetId) !== target.hostId
  ) {
    throw new Error("The profile disconnected before usage could be confirmed.");
  }
  return decodeUsageSnapshot(result.result);
}
