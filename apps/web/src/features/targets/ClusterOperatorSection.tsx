import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  AppWireError,
  CI_TRIGGER_CAPABILITY,
  CLUSTER_MAX_REFERENCE_BYTES,
  CLUSTER_MAX_REPOSITORY_ID_BYTES,
  decodeClusterSessionCreateArguments,
  type ClusterSessionCreateArguments,
  type SessionRef,
} from "@t4-code/protocol";
import { Button, cn, Spinner } from "@t4-code/ui";
import { useMemo, useState } from "react";

import { FIELD_CLASS } from "../settings/controls.tsx";
import { deriveWorkspaceData, sessionViewId } from "../../platform/live-workspace.ts";
import type { WorkspaceSession } from "../../lib/workspace-data.ts";
import {
  clusterCiAvailability,
  clusterCreationTargets,
  clusterGuiAvailability,
  clusterOperatorAvailability,
  createClusterSession,
  createClusterWorkspace,
  runClusterCi,
} from "./cluster-operator.ts";

const CLUSTER_FIELD_CLASS = `${FIELD_CLASS} min-h-11 sm:min-h-8`;

export interface ClusterSessionCiDraft {
  readonly repositoryId: string;
  readonly ref: string;
  readonly commit: string;
}

type ClusterSessionCiInvalidField = keyof ClusterSessionCiDraft | "correlation";

export type ClusterSessionCreationPreparation =
  | {
      readonly args: ClusterSessionCreateArguments;
      readonly error: null;
      readonly invalidField: null;
    }
  | {
      readonly args: null;
      readonly error: string;
      readonly invalidField: ClusterSessionCiInvalidField;
    };

const EMPTY_SESSION_CI_DRAFT: ClusterSessionCiDraft = Object.freeze({
  repositoryId: "",
  ref: "",
  commit: "",
});
const WOODPECKER_PARTIAL_REASON =
  "Enter repository ID, ref, and commit together, or leave all three Woodpecker correlation fields empty.";
const WOODPECKER_COMMIT_REASON =
  "Woodpecker commit must be exactly 40 lowercase hexadecimal characters.";
const WOODPECKER_REPOSITORY_REASON =
  "Woodpecker repository ID must be 1 to 128 UTF-8 bytes, start with a letter or number, and otherwise use only letters, numbers, '.', '_', ':', '/', or '-' without '..' or '://'.";
const WOODPECKER_REF_REASON =
  "Woodpecker ref must be 1 to 256 UTF-8 bytes and contain no control characters.";
const WOODPECKER_UNAVAILABLE_REASON =
  "Woodpecker correlation is unavailable because this host did not grant CI trigger access.";

function rejectedSessionCreation(
  error: string,
  invalidField: ClusterSessionCiInvalidField,
): ClusterSessionCreationPreparation {
  return { args: null, error, invalidField };
}

export function prepareClusterSessionCreation(
  workspaceId: string,
  title: string | undefined,
  ciDraft: ClusterSessionCiDraft,
): ClusterSessionCreationPreparation {
  const normalizedTitle = title?.trim();
  const args: ClusterSessionCreateArguments = {
    workspaceId,
    ...(normalizedTitle === undefined || normalizedTitle === "" ? {} : { title: normalizedTitle }),
    runtimeProfile: "default",
    guiEnabled: true,
  };
  const hasRepository = ciDraft.repositoryId !== "";
  const hasRef = ciDraft.ref !== "";
  const hasCommit = ciDraft.commit !== "";
  if (!hasRepository && !hasRef && !hasCommit) {
    return { args, error: null, invalidField: null };
  }
  if (!hasRepository || !hasRef || !hasCommit) {
    return rejectedSessionCreation(WOODPECKER_PARTIAL_REASON, "correlation");
  }

  let ci: ClusterSessionCreateArguments["ci"];
  try {
    ci = decodeClusterSessionCreateArguments({
      workspaceId: "workspace",
      runtimeProfile: "default",
      guiEnabled: true,
      ci: {
        provider: "woodpecker",
        repositoryId: ciDraft.repositoryId,
        ref: ciDraft.ref,
        commit: ciDraft.commit,
      },
    }).ci;
  } catch (error) {
    if (error instanceof AppWireError && error.path === "args.ci.repositoryId") {
      return rejectedSessionCreation(WOODPECKER_REPOSITORY_REASON, "repositoryId");
    }
    if (error instanceof AppWireError && error.path === "args.ci.ref") {
      return rejectedSessionCreation(WOODPECKER_REF_REASON, "ref");
    }
    if (error instanceof AppWireError && error.path === "args.ci.commit") {
      return rejectedSessionCreation(WOODPECKER_COMMIT_REASON, "commit");
    }
    return rejectedSessionCreation("Woodpecker correlation is invalid.", "correlation");
  }
  if (!/^[0-9a-f]{40}$/u.test(ciDraft.commit)) {
    return rejectedSessionCreation(WOODPECKER_COMMIT_REASON, "commit");
  }
  if (ci === undefined) {
    return rejectedSessionCreation("Woodpecker correlation is invalid.", "correlation");
  }
  return { args: { ...args, ci }, error: null, invalidField: null };
}

export interface ClusterOperatorSectionProps {
  readonly controller: DesktopRuntimeController;
  readonly snapshot: DesktopRuntimeSnapshot;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenPreview: (sessionId: string, previewId: string) => void;
}

export function clusterSessionMatchesWorkspace(
  session: WorkspaceSession,
  ref: SessionRef | undefined,
  hostId: string,
  workspaceId: string,
): boolean {
  return String(ref?.hostId ?? "") === hostId && session.cluster?.workspaceId === workspaceId;
}

export function ClusterOperatorSection({
  controller,
  snapshot,
  onOpenSession,
  onOpenPreview,
}: ClusterOperatorSectionProps) {
  const [query, setQuery] = useState("");
  const [creationHostId, setCreationHostId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [capacity, setCapacity] = useState("20Gi");
  const [sessionTitle, setSessionTitle] = useState<Record<string, string>>({});
  const [sessionCi, setSessionCi] = useState<Record<string, ClusterSessionCiDraft>>({});
  const [sessionCiErrors, setSessionCiErrors] = useState<
    Record<string, Extract<ClusterSessionCreationPreparation, { readonly args: null }> | undefined>
  >({});
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = deriveWorkspaceData(snapshot);
  const creationTargets = useMemo(() => clusterCreationTargets(snapshot), [snapshot]);
  const selectedCreationTarget = creationTargets.find(
    (target) => target.hostId === creationHostId,
  );
  const creationAvailability =
    selectedCreationTarget === undefined
      ? {
          enabled: false,
          reason: "Choose an advertised cluster host for creation.",
        }
      : clusterOperatorAvailability(
          snapshot,
          selectedCreationTarget.targetId,
          selectedCreationTarget.hostId,
          "manage",
        );
  const clusterWorkspaces = data.clusterWorkspaces ?? [];
  const sessionRefs = useMemo(
    () =>
      new Map(
        [...snapshot.projection.sessionIndex.values()].map((ref) => [
          sessionViewId(String(ref.hostId), String(ref.sessionId)),
          ref,
        ]),
      ),
    [snapshot.projection.sessionIndex],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const workspaces = useMemo(
    () =>
      normalizedQuery === ""
        ? clusterWorkspaces
        : clusterWorkspaces.filter(({ infrastructure }) =>
            `${infrastructure.displayName} ${infrastructure.id} ${infrastructure.phase}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          ),
    [clusterWorkspaces, normalizedQuery],
  );

  if (snapshot.clusterOperatorEnabled !== true || creationTargets.length === 0) return null;

  const act = async (id: string, operation: () => Promise<unknown>) => {
    setPending(id);
    setMessage(null);
    try {
      await operation();
      setMessage("Request accepted. Status will update from the host projection.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setPending(null);
    }
  };

  const updateSessionCi = (
    workspaceKey: string,
    field: keyof ClusterSessionCiDraft,
    value: string,
  ) => {
    setSessionCi((current) => ({
      ...current,
      [workspaceKey]: { ...(current[workspaceKey] ?? EMPTY_SESSION_CI_DRAFT), [field]: value },
    }));
    setSessionCiErrors((current) => {
      if (current[workspaceKey] === undefined) return current;
      const next = { ...current };
      delete next[workspaceKey];
      return next;
    });
  };

  return (
    <section aria-labelledby="cluster-workspaces-heading" className="flex flex-col gap-3 border-border border-t pt-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-heading font-semibold text-foreground text-sm" id="cluster-workspaces-heading">
            Cluster workspaces
          </h2>
          <p className="text-muted-foreground text-xs">
            Infrastructure, sessions, CI, and GUI state reported by connected cluster hosts.
          </p>
        </div>
        <label className="flex min-w-0 flex-col gap-1 sm:w-64">
          <span className="font-medium text-muted-foreground text-xs">Search cluster workspaces</span>
          <input
            className={CLUSTER_FIELD_CLASS}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, id, or phase"
            type="search"
            value={query}
          />
        </label>
      </div>

      <form
        aria-label="Create cluster workspace"
        className="grid gap-2 border-border border-y py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName.trim() === "" || selectedCreationTarget === undefined) return;
          void act("create-workspace", () =>
            createClusterWorkspace(
              controller,
              selectedCreationTarget.targetId,
              selectedCreationTarget.hostId,
              {
                displayName: displayName.trim(),
                retentionPolicy: "Retain",
                capacity,
              },
            ),
          );
        }}
      >
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Creation host</span>
          <select
            className={CLUSTER_FIELD_CLASS}
            onChange={(event) => setCreationHostId(event.target.value)}
            required
            value={creationHostId}
          >
            <option disabled value="">Choose a cluster host…</option>
            {creationTargets.map((target) => (
              <option key={`${target.targetId}:${target.hostId}`} value={target.hostId}>
                {target.label} — {target.hostId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Workspace name</span>
          <input className={CLUSTER_FIELD_CLASS} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Storage capacity</span>
          <input className={CLUSTER_FIELD_CLASS} onChange={(event) => setCapacity(event.target.value)} required value={capacity} />
        </label>
        <Button className="min-h-11" disabled={!creationAvailability.enabled || pending !== null} type="submit">
          {pending === "create-workspace" && <Spinner />}
          Create cluster workspace
        </Button>
        {!creationAvailability.enabled && <p className="text-warning-foreground text-xs sm:col-span-4">{creationAvailability.reason}</p>}
      </form>

      {workspaces.length === 0 ? (
        <p className="border-border border-dashed border-y py-6 text-center text-muted-foreground text-sm">
          {normalizedQuery === ""
            ? "No cluster workspaces are projected yet. Create one to begin."
            : "No projected workspace matches this search."}
        </p>
      ) : (
        <ul className="divide-y divide-border border-border border-y">
          {workspaces.map(({ hostId, targetId: workspaceTargetId, infrastructure }) => {
            const workspaceKey = `${hostId}\u0000${infrastructure.id}`;
            const workspaceAvailability = clusterOperatorAvailability(
              snapshot,
              workspaceTargetId,
              hostId,
              "manage",
            );
            const ciDraft = sessionCi[workspaceKey] ?? EMPTY_SESSION_CI_DRAFT;
            const ciError = sessionCiErrors[workspaceKey];
            const ciCorrelationEnabled =
              snapshot.hosts
                .get(hostId)
                ?.grantedCapabilities.includes(CI_TRIGGER_CAPABILITY) === true;
            const ciReasonId = `cluster-session-ci-reason-${encodeURIComponent(workspaceKey)}`;
            const sessions = data.sessions.filter((session) =>
              clusterSessionMatchesWorkspace(
                session,
                sessionRefs.get(session.id),
                hostId,
                infrastructure.id,
              ),
            );
            const condition = infrastructure.condition;
            return (
              <li
                className="flex flex-col gap-3 py-3"
                data-cluster-host-id={hostId}
                data-cluster-workspace-id={infrastructure.id}
                key={workspaceKey}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium text-sm">{infrastructure.displayName}</h3>
                    <p className="font-mono text-muted-foreground text-xs">{infrastructure.id}</p>
                  </div>
                  <p className="text-xs">
                    <span className="font-medium">{infrastructure.phase}</span>
                    {condition === undefined ? " · Condition unknown" : ` · ${condition.reason}: ${condition.message}`}
                  </p>
                </div>
                <p className="text-muted-foreground text-xs">
                  {infrastructure.capacity ?? "Capacity unknown"} · {infrastructure.storageClass ?? "Storage class unknown"} · {infrastructure.accessMode} · {infrastructure.retentionPolicy}
                </p>
                <form
                  className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const hasCiDraft =
                      ciDraft.repositoryId !== "" || ciDraft.ref !== "" || ciDraft.commit !== "";
                    const preparation =
                      !ciCorrelationEnabled && hasCiDraft
                        ? rejectedSessionCreation(WOODPECKER_UNAVAILABLE_REASON, "correlation")
                        : prepareClusterSessionCreation(
                            infrastructure.id,
                            sessionTitle[workspaceKey],
                            ciDraft,
                          );
                    if (preparation.args === null) {
                      setMessage(null);
                      setSessionCiErrors((current) => ({
                        ...current,
                        [workspaceKey]: preparation,
                      }));
                      const invalidField =
                        preparation.invalidField === "correlation"
                          ? ciDraft.repositoryId === ""
                            ? "ciRepositoryId"
                            : ciDraft.ref === ""
                              ? "ciRef"
                              : "ciCommit"
                          : preparation.invalidField === "repositoryId"
                            ? "ciRepositoryId"
                            : preparation.invalidField === "ref"
                              ? "ciRef"
                              : "ciCommit";
                      const invalidInput = event.currentTarget.elements.namedItem(invalidField);
                      if (invalidInput instanceof HTMLInputElement) invalidInput.focus();
                      return;
                    }
                    setSessionCiErrors((current) => {
                      if (current[workspaceKey] === undefined) return current;
                      const next = { ...current };
                      delete next[workspaceKey];
                      return next;
                    });
                    void act(`session:${workspaceKey}`, () =>
                      createClusterSession(
                        controller,
                        workspaceTargetId,
                        hostId,
                        preparation.args,
                      ),
                    );
                  }}
                >
                  <label className="min-w-0">
                    <span className="sr-only">New session title for {infrastructure.displayName}</span>
                    <input
                      className={CLUSTER_FIELD_CLASS}
                      onChange={(event) =>
                        setSessionTitle((current) => ({
                          ...current,
                          [workspaceKey]: event.target.value,
                        }))
                      }
                      placeholder="Optional session title"
                      value={sessionTitle[workspaceKey] ?? ""}
                    />
                  </label>
                  <fieldset
                    aria-describedby={ciError !== undefined || !ciCorrelationEnabled ? ciReasonId : undefined}
                    className="min-w-0 sm:col-span-2"
                    disabled={!ciCorrelationEnabled}
                  >
                    <legend className="mb-1 font-medium text-muted-foreground text-xs">
                      Woodpecker correlation <span className="font-normal">(optional)</span>
                    </legend>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-muted-foreground text-xs">Repository ID</span>
                        <input
                          aria-describedby={ciError !== undefined ? ciReasonId : undefined}
                          aria-invalid={
                            ciError?.invalidField === "correlation" ||
                            ciError?.invalidField === "repositoryId" ||
                            undefined
                          }
                          autoCapitalize="none"
                          autoComplete="off"
                          autoCorrect="off"
                          className={cn(
                            CLUSTER_FIELD_CLASS,
                            "font-mono",
                            (ciError?.invalidField === "correlation" ||
                              ciError?.invalidField === "repositoryId") &&
                              "border-destructive",
                          )}
                          maxLength={CLUSTER_MAX_REPOSITORY_ID_BYTES}
                          name="ciRepositoryId"
                          onChange={(event) =>
                            updateSessionCi(workspaceKey, "repositoryId", event.target.value)
                          }
                          placeholder="t4-code"
                          spellCheck={false}
                          value={ciDraft.repositoryId}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-muted-foreground text-xs">Ref</span>
                        <input
                          aria-describedby={ciError !== undefined ? ciReasonId : undefined}
                          aria-invalid={
                            ciError?.invalidField === "correlation" ||
                            ciError?.invalidField === "ref" ||
                            undefined
                          }
                          autoCapitalize="none"
                          autoComplete="off"
                          autoCorrect="off"
                          className={cn(
                            CLUSTER_FIELD_CLASS,
                            "font-mono",
                            (ciError?.invalidField === "correlation" ||
                              ciError?.invalidField === "ref") &&
                              "border-destructive",
                          )}
                          maxLength={CLUSTER_MAX_REFERENCE_BYTES}
                          name="ciRef"
                          onChange={(event) => updateSessionCi(workspaceKey, "ref", event.target.value)}
                          placeholder="refs/heads/main"
                          spellCheck={false}
                          value={ciDraft.ref}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-muted-foreground text-xs">Commit</span>
                        <input
                          aria-describedby={ciError !== undefined ? ciReasonId : undefined}
                          aria-invalid={
                            ciError?.invalidField === "correlation" ||
                            ciError?.invalidField === "commit" ||
                            undefined
                          }
                          autoCapitalize="none"
                          autoComplete="off"
                          autoCorrect="off"
                          className={cn(
                            CLUSTER_FIELD_CLASS,
                            "font-mono",
                            (ciError?.invalidField === "correlation" ||
                              ciError?.invalidField === "commit") &&
                              "border-destructive",
                          )}
                          maxLength={40}
                          name="ciCommit"
                          onChange={(event) => updateSessionCi(workspaceKey, "commit", event.target.value)}
                          placeholder="40 lowercase hex characters"
                          spellCheck={false}
                          value={ciDraft.commit}
                        />
                      </label>
                    </div>
                  </fieldset>
                  <Button
                    className="min-h-11 sm:col-start-2 sm:row-start-1"
                    disabled={!workspaceAvailability.enabled || pending !== null}
                    type="submit"
                    variant="outline"
                  >
                    {pending === `session:${workspaceKey}` && <Spinner />}
                    Create session with GUI
                  </Button>
                  {(ciError !== undefined || !ciCorrelationEnabled) && (
                    <p
                      className={cn(
                        "text-xs sm:col-span-2",
                        ciError === undefined
                          ? "text-warning-foreground"
                          : "text-destructive-foreground",
                      )}
                      id={ciReasonId}
                      role={ciError === undefined ? undefined : "alert"}
                    >
                      {ciError?.error ?? WOODPECKER_UNAVAILABLE_REASON}
                    </p>
                  )}
                </form>
                {!workspaceAvailability.enabled && (
                  <p className="text-warning-foreground text-xs">{workspaceAvailability.reason}</p>
                )}
                {sessions.length > 0 && (
                  <ul aria-label={`Sessions in ${infrastructure.displayName}`} className="flex flex-col gap-2">
                    {sessions.map((session) => {
                      const ref = sessionRefs.get(session.id);
                      const ci = session.ci;
                      const gui = session.cluster?.gui;
                      const ciAvailability = clusterCiAvailability(
                        snapshot,
                        workspaceTargetId,
                        hostId,
                        ref?.revision,
                        ci,
                      );
                      const guiAvailability = clusterGuiAvailability(
                        snapshot,
                        workspaceTargetId,
                        hostId,
                        gui,
                      );
                      const actionReasonKey = encodeURIComponent(session.id);
                      const guiReasonId = `cluster-gui-reason-${actionReasonKey}`;
                      const ciReasonId = `cluster-ci-reason-${actionReasonKey}`;
                      return (
                        <li className="flex flex-col gap-2 bg-secondary/40 px-3 py-2 sm:flex-row sm:items-start" key={session.id}>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-sm">{session.title}</p>
                            <p className="text-muted-foreground text-xs">
                              {session.cluster?.phase ?? "Runtime phase unknown"} · GUI {gui?.state ?? "unknown"}
                              {gui?.reason === undefined || gui.reason === "" ? "" : ` · ${gui.reason}`}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {ci === undefined
                                ? "CI status unknown"
                                : `${ci.branch ?? ci.ref ?? "Branch unknown"} · ${ci.commit ?? "Commit unknown"} · ${ci.status}${ci.currentStage === undefined ? "" : ` · ${ci.currentStage}`}`}
                            </p>
                            {ci?.link !== undefined && (
                              <a className="text-(--markdown-link) text-xs underline decoration-(--markdown-link)/40 underline-offset-2 transition-colors duration-(--motion-duration-fast) hover:decoration-(--markdown-link)" href={ci.link} rel="noreferrer" target="_blank">
                                Open CI pipeline
                              </a>
                            )}
                          </div>
                          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
                            <div className="flex flex-wrap items-start gap-2">
                              <Button className="min-h-11" onClick={() => onOpenSession(session.id)} size="sm" variant="outline">Inspect and steer</Button>
                              <Button
                                aria-describedby={guiAvailability.enabled ? undefined : guiReasonId}
                                className="min-h-11"
                                disabled={!guiAvailability.enabled || pending !== null}
                                onClick={() => {
                                  if (gui?.previewId !== undefined) onOpenPreview(session.id, gui.previewId);
                                }}
                                size="sm"
                                variant="outline"
                              >
                                Open GUI
                              </Button>
                              <Button
                                aria-describedby={ciAvailability.enabled ? undefined : ciReasonId}
                                className="min-h-11"
                                disabled={!ciAvailability.enabled || pending !== null}
                                onClick={() => {
                                  if (ref === undefined || ci === undefined || ci.correlation !== "exact") return;
                                  void act(`ci:${session.id}`, () =>
                                    runClusterCi(
                                      controller,
                                      workspaceTargetId,
                                      hostId,
                                      String(ref.sessionId),
                                      ref.revision,
                                      {
                                        provider: "woodpecker",
                                        action: "run",
                                        repositoryId: ci.repositoryId,
                                        ref: ci.ref,
                                        commit: ci.commit,
                                      },
                                    ),
                                  );
                                }}
                                size="sm"
                              >
                                {pending === `ci:${session.id}` && <Spinner />}
                                Run CI
                              </Button>
                            </div>
                            {!guiAvailability.enabled && (
                              <p className="max-w-80 text-warning-foreground text-xs" id={guiReasonId}>GUI: {guiAvailability.reason}</p>
                            )}
                            {!ciAvailability.enabled && (
                              <p className="max-w-80 text-warning-foreground text-xs" id={ciReasonId}>CI: {ciAvailability.reason}</p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message !== null && <p aria-live="polite" className="text-muted-foreground text-xs" role="status">{message}</p>}
    </section>
  );
}
