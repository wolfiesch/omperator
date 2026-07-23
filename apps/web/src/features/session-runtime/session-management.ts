import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  hostId,
  projectId,
  revision,
  sessionId,
  type ConfirmationChallenge,
  type SessionRef,
} from "@t4-code/protocol";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";

import type { LiveProjectAddress, LiveSessionAddress } from "../../platform/live-workspace.ts";
import { commandSupport } from "./session-controls.ts";
import { sessionActionRejectionReason } from "./command-errors.ts";
import { pendingPromptsFromRef } from "./pending-prompts.ts";
import { sessionWriteLink } from "./session-inventory.ts";
import { presentSessionControl, readSessionControl } from "./session-observer.ts";

export type SessionManagementCommand =
  | "session.rename"
  | "session.archive"
  | "session.restore"
  | "session.close"
  | "session.delete";

export interface SessionManagementSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

export type SessionCreateSnapshot = Pick<
  DesktopRuntimeSnapshot,
  "connections" | "targetHosts" | "hosts" | "catalogs"
>;

/** Finder reveal is a host-native action and is never offered for remote targets. */
export function projectRevealSupport(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveProjectAddress,
): SessionManagementSupport {
  if (snapshot.targets.get(address.targetId)?.kind !== "local") {
    return { supported: false, reason: "Reveal in Finder is available only on this Mac" };
  }
  if (snapshot.connections.get(address.targetId) !== "connected") {
    return { supported: false, reason: "Connect to this host to reveal the project" };
  }
  if (snapshot.targetHosts.get(address.targetId) !== address.hostId) {
    return { supported: false, reason: "Project host binding is no longer available." };
  }
  const granted = snapshot.hosts.get(address.hostId)?.grantedCapabilities ?? [];
  if (!granted.includes("sessions.manage")) {
    return { supported: false, reason: "Project actions are not granted on this host" };
  }
  const catalog = commandSupport(snapshot.catalogs.get(address.hostId), granted, "project.reveal");
  return catalog.supported
    ? { supported: true, reason: null }
    : {
        supported: false,
        reason:
          catalog.reason === "This host can't change this from here yet — use the terminal"
            ? "Update the local OMP runtime to reveal projects in Finder"
            : catalog.reason,
      };
}

export async function revealLiveProject(
  controller: DesktopRuntimeController,
  address: LiveProjectAddress,
): Promise<void> {
  const support = projectRevealSupport(controller.getSnapshot(), address);
  if (!support.supported) throw new Error(support.reason ?? "Project reveal is unavailable.");
  const response = await controller.command(address.targetId, {
    hostId: hostId(address.hostId),
    command: "project.reveal",
    args: { projectId: projectId(address.projectId) },
  });
  if (!response.accepted) {
    throw new Error(sessionActionRejectionReason(response.error, "manage"));
  }
  const result = response.result;
  if (
    result === null ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).revealed !== true
  ) {
    throw new Error("The host returned an invalid project reveal result.");
  }
}

const CONVERGENCE_TIMEOUT_MS = 10_000;
const challengedManagementRuns = new Map<string, Promise<void>>();

/**
 * One shared freshness reason for the whole management surface: the support
 * gate below and the dispatch-time recheck use the same words so the UI
 * never promises an action that dispatch would immediately reject.
 */
const MANAGEMENT_SYNCING_REASON =
  "This session is still syncing from the host. Try again in a moment.";

export function sessionCreateSupport(
  snapshot: SessionCreateSnapshot,
  address: LiveProjectAddress,
): SessionManagementSupport {
  if (snapshot.connections.get(address.targetId) !== "connected") {
    return { supported: false, reason: "Connect to this host to create a session" };
  }
  if (snapshot.targetHosts.get(address.targetId) !== address.hostId) {
    return { supported: false, reason: "Project host binding is no longer available." };
  }
  const host = snapshot.hosts.get(address.hostId);
  const granted = host?.grantedCapabilities ?? [];
  if (!granted.includes("sessions.manage")) {
    return { supported: false, reason: "Session creation is not granted on this host" };
  }
  const catalog = commandSupport(snapshot.catalogs.get(address.hostId), granted, "session.create");
  if (!catalog.supported) {
    return {
        supported: false,
        reason:
          catalog.reason === "This host can't change this from here yet — use the terminal"
            ? "This host does not offer session creation yet"
            : catalog.reason,
    };
  }
  const catalogFrame = snapshot.catalogs.get(address.hostId);
  const modelItems = catalogFrame?.items.filter((item) => item.kind === "model") ?? [];
  if (modelItems.length > 0 && !modelItems.some((item) => item.supported !== false)) {
    return {
      supported: false,
      reason: "Configure a model for this OMP profile before creating a session",
    };
  }
  return { supported: true, reason: null };
}

function sessionKey(address: LiveSessionAddress): string {
  return `${address.hostId}\u0000${address.sessionId}`;
}

export function sessionRefForAddress(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveSessionAddress,
): SessionRef | undefined {
  return snapshot.projection.sessionIndex.get(sessionKey(address));
}

/** Canonical archive authority is the optional ISO timestamp on SessionRef. */
export function sessionArchivedAt(ref: SessionRef | undefined): string | null {
  if (ref === undefined) return null;
  const value = ref.archivedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function sessionIsArchived(ref: SessionRef | undefined): boolean {
  return sessionArchivedAt(ref) !== null;
}

export function sessionIsClosed(ref: SessionRef | undefined): boolean {
  return ref?.status === "closed";
}

export function sessionIsWorking(ref: SessionRef | undefined): boolean {
  if (ref === undefined) return false;
  if (pendingPromptsFromRef(ref).length > 0) return true;
  const rawRef = ref as unknown as Record<string, unknown>;
  if (
    ref.status === "active" ||
    ref.pendingApproval === true ||
    ref.pendingUserInput === true ||
    rawRef.working === true ||
    rawRef.isWorking === true ||
    rawRef.turnActive === true ||
    rawRef.inFlight === true ||
    (typeof rawRef.queuedMessageCount === "number" && rawRef.queuedMessageCount > 0) ||
    (Array.isArray(rawRef.queuedMessages) && rawRef.queuedMessages.length > 0)
  ) {
    return true;
  }
  const liveState = ref?.liveState;
  if (liveState === undefined || liveState === null || typeof liveState !== "object") return false;
  const live = liveState as Record<string, unknown>;
  const phase = live.phase;
  return (
    phase === "working" ||
    phase === "running" ||
    phase === "active" ||
    phase === "streaming" ||
    phase === "compacting" ||
    phase === "queued" ||
    phase === "waiting" ||
    phase === "awaiting-input" ||
    phase === "awaiting_input" ||
    live.working === true ||
    live.isWorking === true ||
    live.isRunning === true ||
    live.turnActive === true ||
    live.inFlight === true ||
    live.isStreaming === true ||
    live.isCompacting === true ||
    live.pendingApproval === true ||
    live.pendingUserInput === true ||
    (typeof live.queuedMessageCount === "number" && live.queuedMessageCount > 0) ||
    (typeof live.queue === "number" && live.queue > 0) ||
    (Array.isArray(live.queuedMessages) && live.queuedMessages.length > 0) ||
    (Array.isArray(live.queue) && live.queue.length > 0)
  );
}

export function managementCommandSupport(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveSessionAddress,
  command: SessionManagementCommand,
): SessionManagementSupport {
  const link = sessionWriteLink(snapshot, address.targetId, address.hostId, address.sessionId);
  if (link === "offline") {
    return { supported: false, reason: "Connect to this host to manage the session" };
  }
  // Mirror assertSessionWritableNow(): this specific ref must come from the
  // current connection and any warm transcript must be fresh. Global list
  // truncation does not invalidate a row the host actually returned.
  if (link === "cached") {
    return { supported: false, reason: MANAGEMENT_SYNCING_REASON };
  }
  const host = snapshot.hosts.get(address.hostId);
  const granted = host?.grantedCapabilities ?? [];
  if (!granted.includes("sessions.manage")) {
    return { supported: false, reason: "Session management is not granted on this host" };
  }
  const catalog = commandSupport(snapshot.catalogs.get(address.hostId), granted, command);
  if (!catalog.supported) {
    return {
      supported: false,
      reason:
        catalog.reason === "This host can't change this from here yet — use the terminal"
          ? "This host does not offer this session action yet"
          : catalog.reason,
    };
  }
  const ref = sessionRefForAddress(snapshot, address);
  // A reconciling archived session is waiting on a missing/stale lock and may
  // ask the host to re-check it. Concrete observer lock states remain blocked;
  // the host is final authority and performs a fresh lock inspection.
  const control = readSessionControl(ref);
  const canProbeArchivedRestore =
    command === "session.restore" && sessionIsArchived(ref) && control?.mode === "reconciling";
  if (control !== null && !canProbeArchivedRestore) {
    return { supported: false, reason: presentSessionControl(control).managementReason };
  }
  if (command === "session.rename" && sessionIsArchived(ref)) {
    return { supported: false, reason: "Restore this session before renaming it" };
  }
  if (command === "session.close" && sessionIsArchived(ref)) {
    return { supported: false, reason: "Restore this session before terminating its runtime" };
  }
  if ((command === "session.archive" || command === "session.delete") && sessionIsWorking(ref)) {
    return { supported: false, reason: "Terminate the runtime before archiving or deleting it" };
  }
  return { supported: true, reason: null };
}

function assertAccepted(
  response: Pick<CommandResult, "accepted" | "result" | "error">,
  resultKey: "renamed" | "archived" | "restored" | "closed" | "deleted" | null,
): void {
  if (!response.accepted) {
    throw new Error(
      sessionActionRejectionReason(response.error, resultKey === "closed" ? "terminate" : "manage"),
    );
  }
  if (resultKey === null) return;
  const result = response.result;
  if (
    result === null ||
    typeof result !== "object" ||
    (result as Record<string, unknown>)[resultKey] !== true
  ) {
    throw new Error("The host returned an invalid session action result.");
  }
}

interface ConvergenceWaiter {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

function waitForAuthority(
  controller: DesktopRuntimeController,
  predicate: (snapshot: DesktopRuntimeSnapshot) => boolean,
): ConvergenceWaiter {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveWait: () => void = () => undefined;
  let rejectWait: (error: Error) => void = () => undefined;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (timeout !== undefined) clearTimeout(timeout);
    if (error === undefined) resolveWait();
    else rejectWait(error);
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const inspect = (snapshot: DesktopRuntimeSnapshot) => {
    if (predicate(snapshot)) finish();
  };
  unsubscribe = controller.subscribe(inspect);
  timeout = setTimeout(
    () => finish(new Error("The host accepted the action, but the session list did not refresh.")),
    CONVERGENCE_TIMEOUT_MS,
  );
  inspect(controller.getSnapshot());
  return { promise, cancel: () => finish() };
}

async function refreshSessionList(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  predicate: (snapshot: DesktopRuntimeSnapshot) => boolean,
): Promise<void> {
  const waiter = waitForAuthority(controller, predicate);
  try {
    const response = await controller.command(address.targetId, {
      hostId: hostId(address.hostId),
      command: "session.list",
      args: {},
    });
    assertAccepted(response, null);
    await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
}

function currentRevision(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): string {
  const ref = sessionRefForAddress(controller.getSnapshot(), address);
  if (ref === undefined) throw new Error("This session is no longer available.");
  return String(ref.revision);
}

/**
 * Fail-closed recheck run against CURRENT truth immediately before every
 * lifecycle mutation leaves — including after queue waits, lease
 * acquisition, and confirmation dialogs. Full freshness first (offline and
 * cached both explain themselves), then the strict ownership reader; the
 * server remains final authority either way.
 */
function assertSessionManagementFreshNow(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): void {
  const snapshot = controller.getSnapshot();
  const link = sessionWriteLink(snapshot, address.targetId, address.hostId, address.sessionId);
  if (link === "offline") {
    throw new Error("Connect to this host to manage the session.");
  }
  if (link === "cached") {
    throw new Error(MANAGEMENT_SYNCING_REASON);
  }
}

function assertSessionWritableNow(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): void {
  assertSessionManagementFreshNow(controller, address);
  const snapshot = controller.getSnapshot();
  const control = readSessionControl(sessionRefForAddress(snapshot, address));
  if (control !== null) {
    throw new Error(presentSessionControl(control).managementReason);
  }
}

export async function renameLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("Enter a session name.");
  if (sessionIsArchived(sessionRefForAddress(controller.getSnapshot(), address))) {
    throw new Error("Restore this session before renaming it.");
  }
  assertSessionWritableNow(controller, address);
  const expectedRevision = currentRevision(controller, address);
  const response = await controller.commandWithControllerLease(
    address.targetId,
    {
      hostId: hostId(address.hostId),
      sessionId: sessionId(address.sessionId),
      command: "session.rename",
      expectedRevision: revision(expectedRevision),
      args: { name: trimmed },
    },
    undefined,
    // Re-read after the controller-lease acquisition wait inside the client.
    () => assertSessionWritableNow(controller, address),
  );
  assertAccepted(response, "renamed");
  await refreshSessionList(controller, address, (snapshot) => {
    const ref = sessionRefForAddress(snapshot, address);
    return ref?.title === trimmed && String(ref.revision) !== expectedRevision;
  });
}

async function runUnchallengedManagementCommand(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  command: "session.archive" | "session.restore",
): Promise<void> {
  const initialRef = sessionRefForAddress(controller.getSnapshot(), address);
  const control = readSessionControl(initialRef);
  if (
    command === "session.restore" &&
    sessionIsArchived(initialRef) &&
    control?.mode === "reconciling"
  ) {
    assertSessionManagementFreshNow(controller, address);
  } else {
    assertSessionWritableNow(controller, address);
  }
  const expectedRevision = currentRevision(controller, address);
  const ref = sessionRefForAddress(controller.getSnapshot(), address);
  if (command === "session.archive" && sessionIsWorking(ref)) {
    throw new Error("Terminate the runtime before archiving or deleting it.");
  }
  const response = await controller.command(address.targetId, {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command,
    expectedRevision: revision(expectedRevision),
    args: {},
  });
  assertAccepted(response, command === "session.archive" ? "archived" : "restored");
  await refreshSessionList(controller, address, (snapshot) => {
    const next = sessionRefForAddress(snapshot, address);
    if (next === undefined) return false;
    return command === "session.archive" ? sessionIsArchived(next) : !sessionIsArchived(next);
  });
}

export async function archiveLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runUnchallengedManagementCommand(controller, address, "session.archive");
}

export async function restoreLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runUnchallengedManagementCommand(controller, address, "session.restore");
}

type ConfirmationPayload = Omit<ConfirmationChallenge, "v" | "type">;

function matchingManagementChallenge(
  payload: unknown,
  address: LiveSessionAddress,
  expectedRevision: string,
  command: "session.close" | "session.delete",
): payload is ConfirmationPayload {
  if (payload === null || typeof payload !== "object") return false;
  const challenge = payload as Partial<ConfirmationPayload>;
  return (
    String(challenge.hostId) === address.hostId &&
    String(challenge.sessionId) === address.sessionId &&
    challenge.summary === command &&
    String(challenge.revision) === expectedRevision &&
    typeof challenge.commandHash === "string" &&
    challenge.commandHash.length > 0
  );
}

async function runChallengedManagementCommandNow(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  commandName: "session.close" | "session.delete",
): Promise<void> {
  // Runs behind the per-session queue: an earlier run's dialog round-trip
  // may have spanned a takeover. Recheck before reading a revision.
  assertSessionWritableNow(controller, address);
  const expectedRevision = currentRevision(controller, address);
  const current = sessionRefForAddress(controller.getSnapshot(), address);
  if (commandName === "session.close" && sessionIsArchived(current)) {
    throw new Error("Restore this session before terminating its runtime.");
  }
  if (commandName === "session.delete" && sessionIsWorking(current)) {
    throw new Error("Terminate the runtime before archiving or deleting it.");
  }

  // Acquire before listening for the destructive-command challenge. Otherwise
  // a same-session challenge can arrive while lease acquisition is pending and
  // be mistaken for the command this call has not sent yet. Snapshot any
  // already-cached lease first: a post-acquire gate failure may only release
  // a NEWLY acquired lease, never a preexisting one other flows rely on.
  const priorLease =
    commandName === "session.close"
      ? controller.controllerLeaseFor(
          address.targetId,
          address.hostId,
          address.sessionId,
          expectedRevision,
        )
      : undefined;
  const lease =
    commandName === "session.close"
      ? await controller.acquireControllerLease(
          address.targetId,
          address.hostId,
          address.sessionId,
          expectedRevision,
        )
      : { required: false as const };
  // Lease acquisition is a wait; recheck before the command dispatches. On
  // a gate failure, best-effort release of the freshly acquired lease so it
  // cannot block peers until expiry.
  try {
    assertSessionWritableNow(controller, address);
  } catch (error) {
    if (lease.required && lease.leaseId !== undefined && lease.leaseId !== priorLease?.leaseId) {
      void controller
        .releaseControllerLease(
          address.targetId,
          address.hostId,
          address.sessionId,
          expectedRevision,
          lease.leaseId,
        )
        .catch(() => undefined);
    }
    throw error;
  }

  let stopChallengeWait = () => undefined;
  const challenge = new Promise<ConfirmationPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopChallengeWait();
      reject(
        new Error(
          `The host did not issue the expected ${commandName === "session.close" ? "runtime termination" : "delete"} confirmation.`,
        ),
      );
    }, CONVERGENCE_TIMEOUT_MS);
    let unsubscribe: () => void = () => undefined;
    unsubscribe = controller.subscribeEvents(
      {
        targetId: address.targetId,
        hostId: address.hostId,
        sessionId: address.sessionId,
        kinds: ["confirmation"],
      },
      (event) => {
        if (
          event.event.kind !== "confirmation" ||
          !matchingManagementChallenge(event.event.payload, address, expectedRevision, commandName)
        )
          return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.event.payload);
      },
    );
    stopChallengeWait = () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  });

  const intent = {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command: commandName,
    expectedRevision: revision(expectedRevision),
    args: lease.required ? { leaseId: lease.leaseId } : {},
  } as const;
  const command = controller.command(address.targetId, intent);
  try {
    const hostChallenge = await Promise.race([
      challenge,
      command.then((response) => {
        if (!response.accepted) {
          assertAccepted(response, commandName === "session.close" ? "closed" : "deleted");
        }
        throw new Error(
          `The host completed ${commandName === "session.close" ? "runtime termination" : "deletion"} without its required challenge.`,
        );
      }),
    ]);
    // The challenge round-trip is a dialog-shaped wait: ownership may have
    // moved while the host's confirmation was pending. Never approve a
    // destructive action against a session this app no longer writes to —
    // the unanswered challenge simply expires on the host.
    assertSessionWritableNow(controller, address);
    const confirmation = await controller.confirm({
      targetId: address.targetId,
      confirmationId: hostChallenge.confirmationId,
      commandId: hostChallenge.commandId,
      hostId: hostChallenge.hostId,
      ...(hostChallenge.sessionId === undefined ? {} : { sessionId: hostChallenge.sessionId }),
      decision: "approve",
    });
    if (!confirmation.accepted) {
      throw new Error(
        `The host rejected the ${commandName === "session.close" ? "runtime termination" : "delete"} confirmation.`,
      );
    }
    assertAccepted(await command, commandName === "session.close" ? "closed" : "deleted");
  } finally {
    stopChallengeWait();
  }

  await refreshSessionList(controller, address, (snapshot) => {
    const next = sessionRefForAddress(snapshot, address);
    return commandName === "session.close"
      ? sessionIsClosed(next) && !sessionIsWorking(next)
      : next === undefined;
  });
}

async function runChallengedManagementCommand(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  commandName: "session.close" | "session.delete",
): Promise<void> {
  const key = `${address.targetId}\u0000${sessionKey(address)}`;
  const previous = challengedManagementRuns.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => runChallengedManagementCommandNow(controller, address, commandName));
  challengedManagementRuns.set(key, operation);
  try {
    await operation;
  } finally {
    if (challengedManagementRuns.get(key) === operation) challengedManagementRuns.delete(key);
  }
}

export async function terminateLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runChallengedManagementCommand(controller, address, "session.close");
}

export async function deleteLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runChallengedManagementCommand(controller, address, "session.delete");
}
