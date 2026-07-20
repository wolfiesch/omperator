import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import type { SessionRef } from "@t4-code/protocol";
import { Button, Spinner } from "@t4-code/ui";
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
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const title = sessionTitle[workspaceKey]?.trim();
                    void act(`session:${workspaceKey}`, () =>
                      createClusterSession(controller, workspaceTargetId, hostId, {
                        workspaceId: infrastructure.id,
                        ...(title === undefined || title === "" ? {} : { title }),
                        runtimeProfile: "default",
                        guiEnabled: true,
                      }),
                    );
                  }}
                >
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">New session title for {infrastructure.displayName}</span>
                    <input
                      className={CLUSTER_FIELD_CLASS}
                      onChange={(event) => setSessionTitle((current) => ({ ...current, [workspaceKey]: event.target.value }))}
                      placeholder="Optional session title"
                      value={sessionTitle[workspaceKey] ?? ""}
                    />
                  </label>
                  <Button className="min-h-11" disabled={!workspaceAvailability.enabled || pending !== null} type="submit" variant="outline">
                    {pending === `session:${workspaceKey}` && <Spinner />}
                    Create session with GUI
                  </Button>
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
