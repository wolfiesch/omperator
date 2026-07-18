// Account usage feature: bounded wire decoding, provider/account presentation,
// live profile selection, exact `usage.read` commands, and last-good-data
// preservation when a refresh fails.
import { describe, expect, it } from "vite-plus/test";

import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";

import {
  readUsage,
  resolveUsageTargets,
  type UsageRuntimePort,
} from "../src/features/usage/controller.ts";
import {
  ageLabel,
  capacityLabel,
  limitDisplayName,
  resetLabel,
  usageAmountLabel,
} from "../src/features/usage/format.ts";
import {
  decodeUsageSnapshot,
  reportStatus,
  resolveUsedFraction,
  usageProviderGroups,
} from "../src/features/usage/model.ts";
import { createUsageStore, selectedUsageState } from "../src/features/usage/store.ts";

const NOW = 1_800_000_000_000;

function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: NOW,
    reports: [
      {
        provider: "anthropic",
        fetchedAt: NOW - 30_000,
        limits: [
          {
            id: "five-hour",
            label: "Claude",
            scope: {
              provider: "anthropic",
              accountId: "account-1",
              tier: "Fable",
              windowId: "5h",
            },
            window: {
              id: "5h",
              label: "5 Hour",
              durationMs: 18_000_000,
              resetsAt: NOW + 3_600_000,
            },
            amount: {
              used: 72,
              limit: 100,
              usedFraction: 0.72,
              remainingFraction: 0.28,
              unit: "percent",
            },
            status: "ok",
            notes: ["Shared with Claude Code"],
          },
        ],
        resetCredits: {
          availableCount: 1,
          credits: [{ expiresAt: "2027-01-01T00:00:00.000Z", status: "available" }],
        },
        notes: ["Provider data can lag briefly"],
        metadata: {
          email: "dev@example.com",
          orgName: "Stoneworks",
          planType: "max",
          secretProviderBlob: "must-not-survive",
        },
      },
    ],
    accountsWithoutUsage: [
      {
        provider: "google",
        type: "oauth",
        email: "scout@example.com",
        enterpriseUrl: "https://accounts.example.com/team",
      },
    ],
    capacity: {
      anthropic: [
        {
          window: "5h",
          durationMs: 18_000_000,
          accounts: 2,
          usedAccounts: 0.8,
          remainingAccounts: 1.2,
        },
      ],
    },
    ...overrides,
  };
}

function catalog(hostId: string, capability = "usage.read"): Record<string, unknown> {
  return {
    v: "omp-app/1",
    type: "catalog",
    hostId,
    revision: "catalog-rev-1",
    items: [
      {
        id: "usage.read",
        kind: "command",
        name: "usage.read",
        capabilities: [capability],
        supported: true,
      },
    ],
  };
}

interface SnapshotTarget {
  readonly targetId: string;
  readonly hostId: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  readonly state?: "connected" | "connecting" | "disconnected";
  readonly usage?: boolean;
  readonly granted?: readonly string[];
}

function runtimeSnapshot(targets: readonly SnapshotTarget[]): DesktopRuntimeSnapshot {
  const targetMap = new Map<string, Record<string, unknown>>();
  const connections = new Map<string, string>();
  const targetHosts = new Map<string, string>();
  const hosts = new Map<string, Record<string, unknown>>();
  const catalogs = new Map<string, Record<string, unknown>>();
  for (const target of targets) {
    const state = target.state ?? "connected";
    targetMap.set(target.targetId, {
      targetId: target.targetId,
      label: target.label,
      kind: target.kind,
      state,
      paired: true,
    });
    connections.set(target.targetId, state);
    if (state === "connected") {
      targetHosts.set(target.targetId, target.hostId);
      hosts.set(target.hostId, {
        targetId: target.targetId,
        hostId: target.hostId,
        grantedCapabilities: target.granted ?? ["usage.read"],
        grantedFeatures: [],
      });
      if (target.usage !== false) catalogs.set(target.hostId, catalog(target.hostId));
    }
  }
  return {
    version: 1,
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    targets: targetMap,
    connections,
    targetHosts,
    hosts,
    catalogs,
    settings: new Map(),
    projection: {},
    runtimeErrors: [],
  } as unknown as DesktopRuntimeSnapshot;
}

class FakeUsageRuntime implements UsageRuntimePort {
  snapshot: DesktopRuntimeSnapshot;
  result: CommandResult;
  error: Error | null = null;
  readonly calls: { readonly targetId: string; readonly intent: CommandRequest["intent"] }[] = [];
  private readonly listeners = new Set<(snapshot: DesktopRuntimeSnapshot) => void>();

  constructor(snapshot: DesktopRuntimeSnapshot, result: unknown = usagePayload()) {
    this.snapshot = snapshot;
    this.result = {
      targetId: "local",
      requestId: "request-1",
      commandId: "command-1",
      accepted: true,
      result,
    };
  }

  getSnapshot(): DesktopRuntimeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.calls.push({ targetId, intent });
    if (this.error !== null) throw this.error;
    return { ...this.result, targetId };
  }

  publish(snapshot: DesktopRuntimeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

describe("usage result decoder", () => {
  it("keeps normalized account data while dropping arbitrary provider metadata", () => {
    const decoded = decodeUsageSnapshot(usagePayload());
    expect(decoded.reports[0]?.identity).toEqual({
      email: "dev@example.com",
      orgName: "Stoneworks",
      planType: "max",
    });
    expect(decoded.accountsWithoutUsage[0]?.enterpriseUrl).toBe("https://accounts.example.com/team");
    expect(JSON.stringify(decoded)).not.toContain("must-not-survive");
    expect(JSON.stringify(decoded)).not.toContain("credential=drop-this");
  });

  it("refuses provider raw payloads, control text, and oversized collections", () => {
    const withRaw = usagePayload();
    const report = (withRaw.reports as Record<string, unknown>[])[0]!;
    report.raw = { accessToken: "nope" };
    expect(() => decodeUsageSnapshot(withRaw)).toThrow(/raw payloads are forbidden/u);

    const withControl = usagePayload({
      accountsWithoutUsage: [{ provider: "google\nother", type: "oauth" }],
    });
    expect(() => decodeUsageSnapshot(withControl)).toThrow(/control characters/u);

    expect(() =>
      decodeUsageSnapshot(usagePayload({ reports: Array.from({ length: 65 }, () => ({})) })),
    ).toThrow(/more than 64/u);
  });

  it("bounds capacity accounts by possible report limits, not report count", () => {
    expect(() =>
      decodeUsageSnapshot(
        usagePayload({
          capacity: {
            anthropic: [
              { window: "5h", accounts: 2_049, usedAccounts: 0, remainingAccounts: 2_049 },
            ],
          },
        }),
      ),
    ).toThrow(/bounded non-negative number/u);

    expect(() =>
      decodeUsageSnapshot(
        usagePayload({
          capacity: {
            anthropic: [
              { window: "5h", accounts: 2, usedAccounts: 2.1, remainingAccounts: 0 },
            ],
          },
        }),
      ),
    ).toThrow(/bounded non-negative number/u);
  });

  it("keeps provider ids inert inside the capacity lookup", () => {
    const capacity = Object.fromEntries([
      [
        "__proto__",
        [{ window: "weekly", accounts: 1, usedAccounts: 0, remainingAccounts: 1 }],
      ],
    ]);
    const decoded = decodeUsageSnapshot(usagePayload({ capacity }));
    expect(Object.getPrototypeOf(decoded.capacity)).toBeNull();
    expect(Object.hasOwn(decoded.capacity, "__proto__")).toBe(true);
    expect(decoded.capacity.__proto__?.[0]?.window).toBe("weekly");
  });

  it("groups providers and resolves OMP's usage-status precedence", () => {
    const decoded = decodeUsageSnapshot(usagePayload());
    expect(usageProviderGroups(decoded).map((group) => group.provider)).toEqual([
      "anthropic",
      "google",
    ]);
    const limit = decoded.reports[0]!.limits[0]!;
    expect(resolveUsedFraction(limit)).toBe(0.72);
    expect(reportStatus(decoded.reports[0]!)).toBe("ok");
  });
});

describe("usage presentation", () => {
  it("formats amounts, reset windows, capacity, and account age without raw JSON", () => {
    const decoded = decodeUsageSnapshot(usagePayload());
    const limit = decoded.reports[0]!.limits[0]!;
    expect(limitDisplayName(limit)).toBe("Claude (Fable) (5 Hour)");
    expect(usageAmountLabel(limit)).toBe("72.0% used");
    expect(resetLabel(limit, NOW)).toBe("Resets in 1 hour");
    expect(capacityLabel(decoded.capacity.anthropic![0]!)).toBe("1.2 of 2 accounts left");
    expect(ageLabel(NOW - 30_000, NOW)).toBe("30 seconds ago");
  });
});

describe("usage targets and controller", () => {
  it("offers connected supported profiles in default, named, then remote order", () => {
    const snapshot = runtimeSnapshot([
      { targetId: "remote-z", hostId: "host-z", label: "Michael Mac", kind: "remote" },
      { targetId: "local:fable", hostId: "host-f", label: "Fable swarm", kind: "local" },
      { targetId: "local", hostId: "host-d", label: "Local OMP", kind: "local" },
      {
        targetId: "remote-no-grant",
        hostId: "host-n",
        label: "No grant",
        kind: "remote",
        granted: ["sessions.read"],
      },
      {
        targetId: "local:starting",
        hostId: "host-s",
        label: "Starting",
        kind: "local",
        state: "connecting",
      },
    ]);
    const resolution = resolveUsageTargets(snapshot);
    expect(resolution.availability).toBe("ready");
    expect(resolution.targets.map((target) => target.targetId)).toEqual([
      "local",
      "local:fable",
      "remote-z",
    ]);
    expect(resolution.targets.map((target) => target.detail)).toEqual([
      "Default OMP profile",
      "OMP profile",
      "Remote host",
    ]);
  });

  it("names connecting, catalog-wait, unsupported, and no-host availability", () => {
    expect(
      resolveUsageTargets(
        runtimeSnapshot([
          {
            targetId: "local",
            hostId: "host-d",
            label: "Local",
            kind: "local",
            state: "connecting",
          },
        ]),
      ).availability,
    ).toBe("connecting");
    expect(
      resolveUsageTargets(
        runtimeSnapshot([
          {
            targetId: "local",
            hostId: "host-d",
            label: "Local",
            kind: "local",
            usage: false,
          },
        ]),
      ).availability,
    ).toBe("waiting-catalog");
    const unsupported = runtimeSnapshot([
      {
        targetId: "local",
        hostId: "host-d",
        label: "Local",
        kind: "local",
        granted: ["sessions.read"],
      },
    ]);
    expect(resolveUsageTargets(unsupported).availability).toBe("unsupported");
    expect(resolveUsageTargets(runtimeSnapshot([])).availability).toBe("no-host");
  });

  it("sends the exact host-scoped usage command and validates the result", async () => {
    const runtime = new FakeUsageRuntime(
      runtimeSnapshot([{ targetId: "local", hostId: "host-d", label: "Local", kind: "local" }]),
    );
    const target = resolveUsageTargets(runtime.getSnapshot()).targets[0]!;
    const result = await readUsage(runtime, target);
    expect(result.reports[0]?.provider).toBe("anthropic");
    expect(runtime.calls).toEqual([
      {
        targetId: "local",
        intent: { hostId: "host-d", command: "usage.read", args: {} },
      },
    ]);

    runtime.result = { ...runtime.result, result: { generatedAt: NOW } };
    await expect(readUsage(runtime, target)).rejects.toThrow(/result\.reports/u);
  });
});

describe("usage store", () => {
  it("loads the selected profile and keeps its last good snapshot after a failed refresh", async () => {
    const runtime = new FakeUsageRuntime(
      runtimeSnapshot([{ targetId: "local", hostId: "host-d", label: "Local", kind: "local" }]),
    );
    const store = createUsageStore(runtime, { now: () => NOW + 1_000 });
    await store.getState().refresh();
    let selected = selectedUsageState(store.getState());
    expect(selected.snapshot?.reports[0]?.provider).toBe("anthropic");
    expect(selected.receivedAt).toBe(NOW + 1_000);
    expect(selected.error).toBeNull();

    runtime.error = new Error("broker failed at /home/lycaon/.omp/auth.json token=secret-value");
    await store.getState().refresh();
    selected = selectedUsageState(store.getState());
    expect(selected.snapshot?.reports[0]?.provider).toBe("anthropic");
    expect(selected.loading).toBe(false);
    expect(selected.error).toContain("[redacted]");
    expect(selected.error).not.toContain("lycaon");
    expect(selected.error).not.toContain("secret-value");
  });

  it("switches to a newly connected supported profile and loads it", async () => {
    const runtime = new FakeUsageRuntime(runtimeSnapshot([]));
    const store = createUsageStore(runtime);
    expect(store.getState().availability).toBe("no-host");

    runtime.publish(
      runtimeSnapshot([
        {
          targetId: "local:fable",
          hostId: "host-f",
          label: "Fable swarm",
          kind: "local",
        },
      ]),
    );
    store.getState().syncTargets();
    await store.getState().refresh();
    expect(store.getState().selectedTargetId).toBe("local:fable");
    expect(selectedUsageState(store.getState()).snapshot?.generatedAt).toBe(NOW);
  });
});
