// Binding model for the live settings screen. It owns the store lifecycle
// that LiveSettingsScreen renders: resolve the active host — the user's
// explicit choice first, else local-first — build one store per target+host
// as soon as BOTH live frames exist, keep every store (and its drafts) alive
// across A→B→A switching, feed newer host revisions into the right store,
// and turn silence or broken payloads into named states instead of an
// eternal spinner. The active host's account-broker status rides along.
// Pure TypeScript over the runtime port so every transition is testable
// headless.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import { hostId as brandHostId, type CatalogFrame } from "@t4-code/protocol";

import {
  createBrokerStatusModel,
  type BrokerStatusView,
} from "./broker-status.ts";
import {
  agentChoicesFromCatalog,
  buildLiveSettingsCatalog,
  modelChoicesFromCatalog,
  type AgentCatalog,
  type ModelChoice,
} from "./live-catalog.ts";
import {
  createLiveSettingsController,
  type LiveSettingsRuntimePort,
  type SaveChallenge,
} from "./live-controller.ts";
import {
  NO_ROLE_TAGS,
  roleTagsFromFrames,
  type CatalogExplorerInput,
  type RoleTags,
} from "./settings-presentation.ts";
import { createSettingsStore, type SettingsStoreApi } from "./settings-store.ts";

export interface ActiveHost {
  readonly targetId: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly isLocal: boolean;
}

/** One host the user can open settings against, right now. */
export interface HostChoice {
  readonly targetId: string;
  readonly hostId: string;
  readonly label: string;
  readonly isLocal: boolean;
}

/** The choice list stays renderable at any size. */
const MAX_HOST_CHOICES = 16;

/** Why the screen is not showing settings yet. Every value is renderable. */
export type SettingsWaitDetail =
  /** No host is configured or connected at all. */
  | "no-host"
  /** A candidate target is actively connecting. */
  | "connecting"
  /** The explicitly chosen host is not connected right now. */
  | "disconnected"
  /** Connected, but the host has not published catalog+settings frames. */
  | "not-published";

export type LiveSettingsScreenState =
  | {
      readonly phase: "waiting";
      readonly detail: SettingsWaitDetail;
      readonly hostLabel: string | null;
      readonly hosts: readonly HostChoice[];
      readonly activeTargetId: string | null;
    }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly hostLabel: string | null;
      readonly hosts: readonly HostChoice[];
      readonly activeTargetId: string | null;
    }
  | {
      readonly phase: "ready";
      readonly api: SettingsStoreApi;
      readonly active: ActiveHost;
      readonly catalog: CatalogFrame;
      readonly models: readonly ModelChoice[];
      readonly agents: AgentCatalog;
      readonly roleTags: RoleTags;
      readonly hosts: readonly HostChoice[];
      readonly broker: BrokerStatusView;
    };

/** Derive the explorer input from the same live state and host projection. */
export function catalogExplorerInputForLiveState(
  runtime: Pick<LiveSettingsRuntimePort, "getSnapshot">,
  state: LiveSettingsScreenState,
): CatalogExplorerInput | undefined {
  if (state.phase === "ready") {
    return {
      host: { hostLabel: state.active.hostLabel, hostId: state.active.hostId },
      catalog: state.catalog,
    };
  }
  if (state.hostLabel === null || state.activeTargetId === null) return undefined;
  const snapshot = runtime.getSnapshot();
  const hostId = snapshot.targetHosts.get(state.activeTargetId);
  if (hostId === undefined) return undefined;
  return {
    host: { hostLabel: state.hostLabel, hostId },
    phase: state.phase === "waiting" && (state.detail === "connecting" || state.detail === "not-published") ? "waiting" : "unavailable",
  };
}

export interface LiveSettingsScreenModel {
  getState(): LiveSettingsScreenState;
  /** First subscriber attaches the runtime subscription; the last one
   * leaving detaches it, so React StrictMode's mount/unmount/mount cycle
   * (and any re-mount) is safe without an explicit dispose. */
  subscribe(listener: () => void): () => void;
  /** Explicitly open settings against this connected target. The choice
   * sticks until the target disappears; each host keeps its own drafts. */
  selectHost(targetId: string): void;
  /** Deliberately re-query the active host's account-broker status. */
  refreshBrokerStatus(): void;
}

export interface LiveSettingsScreenModelOptions {
  readonly runtime: LiveSettingsRuntimePort;
  readonly onChallenge: (challenge: SaveChallenge) => Promise<"approve" | "deny">;
  /** How long a connected-but-silent host may stay silent before the screen
   * says so as an error instead of spinning. */
  readonly publishTimeoutMs?: number;
  /** How long a `broker.status` query may wait for its response frame. */
  readonly brokerTimeoutMs?: number;
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/** The connected target this targetId opens against, or null. */
function hostForTarget(snapshot: DesktopRuntimeSnapshot, targetId: string): ActiveHost | null {
  if (snapshot.connections.get(targetId) !== "connected") return null;
  const hostId = snapshot.targetHosts.get(targetId);
  if (hostId === undefined) return null;
  const label = snapshot.targets.get(targetId)?.label ?? hostId;
  return { targetId, hostId, hostLabel: label, isLocal: targetId === "local" };
}

/** The default target when the user has not chosen one: local first, else
 * the first connected target with a bound host. */
export function resolveActiveHost(snapshot: DesktopRuntimeSnapshot): ActiveHost | null {
  const candidates: string[] = [];
  if (snapshot.targetHosts.has("local")) candidates.push("local");
  for (const targetId of snapshot.targetHosts.keys()) {
    if (targetId !== "local") candidates.push(targetId);
  }
  for (const targetId of candidates) {
    const active = hostForTarget(snapshot, targetId);
    if (active !== null) return active;
  }
  return null;
}

/** Every connected target with a bound host, local first, bounded. */
export function connectedHostChoices(snapshot: DesktopRuntimeSnapshot): readonly HostChoice[] {
  const choices: HostChoice[] = [];
  const candidates: string[] = [];
  if (snapshot.targetHosts.has("local")) candidates.push("local");
  for (const targetId of snapshot.targetHosts.keys()) {
    if (targetId !== "local") candidates.push(targetId);
  }
  for (const targetId of candidates) {
    if (choices.length >= MAX_HOST_CHOICES) break;
    const active = hostForTarget(snapshot, targetId);
    if (active === null) continue;
    choices.push({
      targetId: active.targetId,
      hostId: active.hostId,
      label: active.hostLabel,
      isLocal: active.isLocal,
    });
  }
  return choices;
}

interface ConnectionProblem {
  detail: SettingsWaitDetail;
  error: string | null;
  label: string | null;
  targetId: string | null;
}

/** The most useful thing to say when no candidate target is connected. */
function connectionProblem(snapshot: DesktopRuntimeSnapshot): ConnectionProblem {
  let connecting: { readonly label: string; readonly targetId: string } | null = null;
  for (const [targetId, target] of snapshot.targets) {
    const state = snapshot.connections.get(targetId) ?? target.state;
    if (state === "error") {
      const runtimeError = [...snapshot.runtimeErrors].reverse().find((entry) => entry.targetId === targetId);
      const reason = runtimeError === undefined ? "" : ` ${runtimeError.message}`;
      return {
        detail: "no-host",
        error: `The connection to ${target.label} failed.${reason}`,
        label: target.label,
        targetId,
      };
    }
    if (state === "pairing-required") {
      return {
        detail: "no-host",
        error: `${target.label} needs pairing before its settings can load.`,
        label: target.label,
        targetId,
      };
    }
    if (state === "connecting") connecting = { label: target.label, targetId };
  }
  if (connecting !== null) {
    return { detail: "connecting", error: null, label: connecting.label, targetId: connecting.targetId };
  }
  return { detail: "no-host", error: null, label: null, targetId: null };
}

/** The same, scoped to the explicitly chosen target: its trouble is named,
 * never papered over by silently opening another host's settings. */
function connectionProblemFor(snapshot: DesktopRuntimeSnapshot, targetId: string): ConnectionProblem {
  const target = snapshot.targets.get(targetId);
  if (target === undefined) return { detail: "no-host", error: null, label: null, targetId: null };
  const state = snapshot.connections.get(targetId) ?? target.state;
  if (state === "error") {
    const runtimeError = [...snapshot.runtimeErrors].reverse().find((entry) => entry.targetId === targetId);
    const reason = runtimeError === undefined ? "" : ` ${runtimeError.message}`;
    return {
      detail: "no-host",
      error: `The connection to ${target.label} failed.${reason}`,
      label: target.label,
      targetId,
    };
  }
  if (state === "pairing-required") {
    return {
      detail: "no-host",
      error: `${target.label} needs pairing before its settings can load.`,
      label: target.label,
      targetId,
    };
  }
  if (state === "connecting") return { detail: "connecting", error: null, label: target.label, targetId };
  return { detail: "disconnected", error: null, label: target.label, targetId };
}

/** Everything one target+host's workspace owns; kept across host switches
 * so drafts survive A→B→A. */
interface StoreEntry {
  readonly api: SettingsStoreApi;
  settingsRevision: string;
  catalogRevision: string;
  catalog: CatalogFrame;
  models: readonly ModelChoice[];
  agents: AgentCatalog;
  /** Frame pair the roleTags were computed from; either frame can move. */
  tagsKey: string;
  roleTags: RoleTags;
}

export function createLiveSettingsScreenModel(options: LiveSettingsScreenModelOptions): LiveSettingsScreenModel {
  const { runtime, onChallenge } = options;
  const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  const listeners = new Set<() => void>();
  let state: LiveSettingsScreenState = {
    phase: "waiting",
    detail: "no-host",
    hostLabel: null,
    hosts: [],
    activeTargetId: null,
  };
  const stores = new Map<string, StoreEntry>();
  let selectedTargetId: string | null = null;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publishNudgedKey: string | null = null;
  let publishTimedOutKey: string | null = null;
  /** Reason the host rejected a publish nudge, reported instead of a guess. */
  let publishFailure: string | null = null;

  const broker = createBrokerStatusModel(runtime, options.brokerTimeoutMs);

  // Choice-array identity is the change signal for setState and React.
  let hostChoices: readonly HostChoice[] = [];
  let hostChoicesSignature = "";
  function hostChoicesFor(snapshot: DesktopRuntimeSnapshot): readonly HostChoice[] {
    const next = connectedHostChoices(snapshot);
    const signature = next
      .map((choice) => `${choice.targetId}\u0000${choice.hostId}\u0000${choice.label}`)
      .join("\u0001");
    if (signature !== hostChoicesSignature) {
      hostChoicesSignature = signature;
      hostChoices = next;
    }
    return hostChoices;
  }

  function setState(next: LiveSettingsScreenState): void {
    // waiting/error states are value-comparable; ready changes are driven by
    // identity of the store, choice arrays, and the broker view.
    if (
      state.phase === next.phase &&
      ((state.phase === "waiting" &&
        next.phase === "waiting" &&
        state.detail === next.detail &&
        state.hostLabel === next.hostLabel &&
        state.hosts === next.hosts &&
        state.activeTargetId === next.activeTargetId) ||
        (state.phase === "error" &&
          next.phase === "error" &&
          state.message === next.message &&
          state.hosts === next.hosts &&
          state.activeTargetId === next.activeTargetId) ||
        (state.phase === "ready" &&
          next.phase === "ready" &&
          state.api === next.api &&
          state.catalog === next.catalog &&
          state.models === next.models &&
          state.agents === next.agents &&
          state.roleTags === next.roleTags &&
          state.hosts === next.hosts &&
          state.broker === next.broker))
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener();
  }

  function clearPublishTimer(): void {
    if (publishTimer !== null) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
  }

  /** Connected host, frames missing: nudge once, and bound the wait. */
  function awaitPublish(active: ActiveHost, key: string, hosts: readonly HostChoice[]): void {
    if (publishTimedOutKey === key) {
      setState({
        phase: "error",
        message:
          publishFailure === null
            ? `${active.hostLabel} is connected but hasn't published its settings. The host may be running an OMP build without desktop settings support.`
            : `${active.hostLabel} is connected but rejected the settings request: ${publishFailure}`,
        hostLabel: active.hostLabel,
        hosts,
        activeTargetId: active.targetId,
      });
      return;
    }
    if (publishNudgedKey !== key) {
      publishNudgedKey = key;
      // Best effort: ask the host to (re)publish. Failures fall through to the
      // timeout below, which reports the recorded reason rather than guessing
      // that the host lacks settings support.
      const wireHostId = brandHostId(active.hostId);
      // Bind the key: a rejection can land after the active host changed, and
      // reporting host A's reason under host B's timeout is worse than no
      // reason at all.
      const nudgedKey = key;
      const recordFailure = (reason: unknown): void => {
        if (publishNudgedKey === nudgedKey) publishFailure = String(reason);
      };
      void runtime
        .command(active.targetId, { hostId: wireHostId, command: "settings.read", args: {} })
        .catch(recordFailure);
      void runtime
        .command(active.targetId, { hostId: wireHostId, command: "catalog.get", args: {} })
        .catch(recordFailure);
      clearPublishTimer();
      publishTimer = setTimeout(() => {
        publishTimer = null;
        publishTimedOutKey = key;
        evaluate();
      }, publishTimeoutMs);
    }
    setState({
      phase: "waiting",
      detail: "not-published",
      hostLabel: active.hostLabel,
      hosts,
      activeTargetId: active.targetId,
    });
  }

  function evaluate(): void {
    const snapshot = runtime.getSnapshot();
    const hosts = hostChoicesFor(snapshot);

    // A removed target releases its selection AND its parked stores.
    if (selectedTargetId !== null && !snapshot.targets.has(selectedTargetId)) {
      selectedTargetId = null;
    }
    for (const key of stores.keys()) {
      const targetId = key.slice(0, key.indexOf("\u0000"));
      if (!snapshot.targets.has(targetId)) stores.delete(key);
    }

    let active: ActiveHost | null;
    let problem: ConnectionProblem;
    if (selectedTargetId !== null) {
      active = hostForTarget(snapshot, selectedTargetId);
      problem =
        active === null
          ? connectionProblemFor(snapshot, selectedTargetId)
          : { detail: "no-host", error: null, label: null, targetId: active.targetId };
    } else {
      active = resolveActiveHost(snapshot);
      problem =
        active === null
          ? connectionProblem(snapshot)
          : { detail: "no-host", error: null, label: null, targetId: active.targetId };
    }

    broker.sync(active === null ? null : { targetId: active.targetId, hostId: active.hostId });

    if (active === null) {
      clearPublishTimer();
      publishNudgedKey = null;
      publishFailure = null;
      if (problem.error !== null) {
        setState({
          phase: "error",
          message: problem.error,
          hostLabel: problem.label,
          hosts,
          activeTargetId: problem.targetId,
        });
      } else {
        setState({
          phase: "waiting",
          detail: problem.detail,
          hostLabel: problem.label,
          hosts,
          activeTargetId: problem.targetId,
        });
      }
      return;
    }

    const key = `${active.targetId}\u0000${active.hostId}`;
    const catalogFrame = snapshot.catalogs.get(active.hostId);
    const settingsFrame = snapshot.settings.get(active.hostId);
    let entry = stores.get(key);

    if (catalogFrame === undefined || settingsFrame === undefined) {
      if (entry !== undefined) {
        // Frames vanished mid-flight (reconnect); keep the store — and its
        // drafts — and wait honestly.
        setState({
          phase: "waiting",
          detail: "not-published",
          hostLabel: active.hostLabel,
          hosts,
          activeTargetId: active.targetId,
        });
        return;
      }
      awaitPublish(active, key, hosts);
      return;
    }

    clearPublishTimer();
    publishNudgedKey = null;
    publishFailure = null;
    publishTimedOutKey = null;

    if (entry === undefined) {
      try {
        const built = buildLiveSettingsCatalog({
          catalog: catalogFrame,
          settings: settingsFrame,
          hostLabel: active.hostLabel,
        });
        const controller = createLiveSettingsController({
          runtime,
          targetId: active.targetId,
          hostId: active.hostId,
          hostLabel: active.hostLabel,
          onChallenge,
        });
        entry = {
          api: createSettingsStore(built.catalog, controller),
          settingsRevision: built.catalog.revision,
          catalogRevision: "",
          catalog: catalogFrame,
          models: [],
          agents: { agents: [], unavailableReason: null },
          tagsKey: "",
          roleTags: NO_ROLE_TAGS,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setState({
          phase: "error",
          message: `${active.hostLabel} sent settings this app can't display safely. ${detail}`.slice(0, 400),
          hostLabel: active.hostLabel,
          hosts,
          activeTargetId: active.targetId,
        });
        return;
      }
      stores.set(key, entry);
    } else if (
      String(settingsFrame.revision) !== entry.settingsRevision &&
      !entry.api.getState().saving
    ) {
      // A newer host revision landed outside a save: rebase (the store keeps
      // drafts and raises its conflict banner when dirty).
      try {
        const built = buildLiveSettingsCatalog({
          catalog: catalogFrame,
          settings: settingsFrame,
          hostLabel: active.hostLabel,
        });
        entry.settingsRevision = built.catalog.revision;
        entry.api.getState().ingestCatalog(built.catalog);
      } catch {
        // A malformed push must not eat the working screen; skip this
        // revision and keep what the user has.
        entry.settingsRevision = String(settingsFrame.revision);
      }
    }

    if (String(catalogFrame.revision) !== entry.catalogRevision) {
      entry.catalogRevision = String(catalogFrame.revision);
      entry.catalog = catalogFrame;
      entry.models = modelChoicesFromCatalog(catalogFrame);
      entry.agents = agentChoicesFromCatalog(catalogFrame);
    }

    // `modelTags` rides the settings frame (the catalog fills in for older
    // hosts), so the tags refresh whenever either frame's revision moves.
    const tagsKey = `${String(settingsFrame.revision)}\u0000${String(catalogFrame.revision)}`;
    if (tagsKey !== entry.tagsKey) {
      entry.tagsKey = tagsKey;
      entry.roleTags = roleTagsFromFrames(catalogFrame, settingsFrame);
    }

    setState({
      phase: "ready",
      api: entry.api,
      active,
      catalog: entry.catalog,
      models: entry.models,
      agents: entry.agents,
      roleTags: entry.roleTags,
      hosts,
      broker: broker.getState(),
    });
  }

  // Initial state without a runtime subscription; subscribers attach it.
  evaluate();
  let detachRuntime: (() => void) | null = null;
  let detachBroker: (() => void) | null = null;

  return {
    getState: () => state,
    selectHost(targetId) {
      if (targetId === selectedTargetId) return;
      if (!runtime.getSnapshot().targets.has(targetId)) return;
      selectedTargetId = targetId;
      evaluate();
    },
    refreshBrokerStatus() {
      broker.refresh();
      evaluate();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (detachRuntime === null) {
        detachRuntime = runtime.subscribe(() => evaluate());
        detachBroker = broker.subscribe(() => evaluate());
        evaluate();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detachRuntime !== null) {
          detachRuntime();
          detachRuntime = null;
          detachBroker?.();
          detachBroker = null;
          clearPublishTimer();
          publishNudgedKey = null;
          publishFailure = null;
        }
      };
    },
  };
}
