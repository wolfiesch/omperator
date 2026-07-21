import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@t4-code/ui";
import type { PreviewProjection } from "@t4-code/client";
import { ArrowLeft, ChevronLeft, ChevronRight, Crosshair, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { WorkspaceProject, WorkspaceSession } from "../../lib/workspace-data.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "../../platform/desktop-runtime.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import { useWorkspace, workspaceStore } from "../../state/store-instance.ts";
import { selectSessionView } from "../../state/workspace-store.ts";
import {
  choosePreview,
  defaultLaunchAuthority,
  derivePreviewWorkspaceStatus,
  displayedToNativeCoordinate,
  isProjectRelativeUploadPath,
  previewActionSupport,
  previewHostSupport,
  previewTrustLabel,
  reconcilePreviewState,
  type PreviewAction,
  type PreviewWorkspaceStatus,
} from "./preview-model.ts";
import { PreviewDesktopAdapter } from "./preview-runtime.ts";

function previewStatusLabel(status: PreviewWorkspaceStatus): string {
  return status === "cached" ? "Cached snapshot" : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function safePreviewError(error: unknown): string {
  if (error instanceof Error && error.message === "Choose a project-relative upload path.") {
    return error.message;
  }
  return "Preview operation failed. Please try again.";
}


export function PreviewWorkspace({
  session,
  project,
}: {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
}) {
  const navigate = useNavigate();
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const selectedPreviewId = useWorkspace((state) => selectSessionView(state, session.id).previewId);
  const selectedOptIn = useWorkspace((state) => selectSessionView(state, session.id).previewOptIn);
  const selectedOptInKind = useWorkspace((state) => selectSessionView(state, session.id).previewOptInKind);
  const selectedOptInAuthorityId = useWorkspace((state) => selectSessionView(state, session.id).previewOptInAuthorityId);
  const scale = useWorkspace((state) => selectSessionView(state, session.id).previewScale);
  const address = useMemo(
    () => (snapshot === null ? null : resolveLiveSession(snapshot, session.id)),
    [session.id, snapshot],
  );
  const sessionProjection =
    snapshot === null || address === null
      ? undefined
      : snapshot.projection.sessions.get(`${address.hostId}\u0000${address.sessionId}`);
  const previews = useMemo<readonly PreviewProjection[]>(
    () =>
      [...(sessionProjection?.previews.values() ?? [])].sort((left, right) =>
        left.previewId.localeCompare(right.previewId),
      ),
    [sessionProjection],
  );
  const preview = choosePreview(
    previews,
    selectedPreviewId,
    selectedOptIn,
    selectedOptInKind,
    selectedOptInAuthorityId,
  );
  const connected =
    snapshot !== null && address !== null && snapshot.connections.get(address.targetId) === "connected";
  const adapter = useMemo(
    () => (controller === null || address === null ? null : new PreviewDesktopAdapter(controller, address)),
    [
      address?.hostId,
      address?.sessionId,
      address?.targetId,
      connected,
      controller,
      preview?.authority?.id,
      preview?.authority?.kind,
      preview?.previewId,
    ],
  );
  const hostSupport =
    snapshot === null || address === null ? previewHostSupport(undefined) : previewHostSupport(snapshot.hosts.get(address.hostId));
  const status = derivePreviewWorkspaceStatus({
    preview,
    connected,
    supported: adapter !== null && hostSupport.supported,
  });
  const identity =
    preview === undefined || address === null
      ? undefined
      : { hostId: address.hostId, sessionId: address.sessionId, previewId: preview.previewId };
  const operationLifecycleKey = [
    address?.targetId ?? "",
    address?.hostId ?? "",
    address?.sessionId ?? "",
    preview?.previewId ?? "",
    preview?.authority?.kind ?? "",
    preview?.authority?.id ?? "",
    connected ? "connected" : "disconnected",
  ].join("\u0000");
  const operationGeneration = useRef(0);
  const [url, setUrl] = useState("");
  const [captureUrl, setCaptureUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");
  const [selectValue, setSelectValue] = useState("");
  const [key, setKey] = useState("Enter");
  const [uploadPath, setUploadPath] = useState("");
  const [scrollX, setScrollX] = useState("0");
  const [scrollY, setScrollY] = useState("400");


  useLayoutEffect(() => {
    operationGeneration.current += 1;
    return () => {
      operationGeneration.current += 1;
    };
  }, [operationLifecycleKey]);

  useEffect(() => {
    reconcilePreviewState({ selectedPreviewId, previews }, () => {
      workspaceStore.getState().setSessionPreview(session.id, {
        previewId: null,
        optIn: false,
      });
    });
  }, [selectedPreviewId, previews, session.id]);

  useEffect(() => {
    setUrl(preview?.url ?? "");
  }, [preview?.previewId, preview?.url]);

  useEffect(() => () => {
    if (adapter !== null) void adapter.dispose();
  }, [adapter]);

  useEffect(() => {
    if (adapter === null || identity === undefined || preview?.capture === undefined) {
      setCaptureUrl(undefined);
      return;
    }
    let active = true;
    void adapter
      .objectUrl(identity, preview.capture)
      .then((nextUrl) => {
        if (active) setCaptureUrl(nextUrl);
      })
      .catch(() => {
        if (active) setError("Preview capture could not be loaded.");
      });
    return () => {
      active = false;
      setCaptureUrl(undefined);
      adapter.releaseCapture(identity);
    };
  }, [adapter, identity?.previewId, preview?.capture?.captureId, preview?.capture?.sha256]);

  const support = (action: PreviewAction) =>
    previewActionSupport(
      preview,
      action,
      status,
      hostSupport.controlSupported,
      hostSupport.inputSupported,
    );
  const runAction = (
    action: PreviewAction,
    _label: string,
    operation: () => Promise<void>,
    requiresPreview = true,
  ) => {
    const actionSupport =
      requiresPreview
        ? support(action)
        : adapter === null || !hostSupport.supported || !hostSupport.controlSupported
          ? {
              supported: false,
              reason:
                hostSupport.reason ??
                "This host does not permit browser preview control.",
            }
          : { supported: true };
    if (!actionSupport.supported || adapter === null) {
      setError(actionSupport.reason ?? "Preview actions are unavailable.");
      return;
    }
    setError(undefined);
    const generation = operationGeneration.current;
    const requestAdapter = adapter;
    void requestAdapter
      .policy(action, identity, action === "navigate" ? url.trim() : undefined)
      .then((policy) => {
        if (generation !== operationGeneration.current) return;
        if (!policy.allowed) {
          setError("This preview action is not allowed by the host.");
          return;
        }
        return operation();
      })
      .catch((cause: unknown) => {
        if (generation === operationGeneration.current) {
          setError(safePreviewError(cause));
        }
      });
  };

  const mutate = (action: PreviewAction, args: Readonly<Record<string, unknown>> = {}) => {
    if (adapter === null || identity === undefined) return Promise.reject(new Error("Preview unavailable"));
    return adapter.mutate(action, identity, args);
  };

  const previewConfirmation = [...(sessionProjection?.confirmations.values() ?? [])].find(
    (challenge) => String(challenge.summary).startsWith("preview."),
  );

  const capture = preview?.capture;
  const captureTimestamp =
    capture === undefined ? undefined : new Date(capture.capturedAt).toLocaleString();
  const selectorPresent = selector.trim().length > 0;
  const safeUploadPath = isProjectRelativeUploadPath(uploadPath);
  const scrollDeltaX = Number(scrollX);
  const scrollDeltaY = Number(scrollY);
  const validScroll = Number.isFinite(scrollDeltaX) && Number.isFinite(scrollDeltaY);
  const advancedActions = ["fill", "type", "select", "press", "scroll", "upload"] as const;
  const showAdvanced = advancedActions.some((action) => support(action).supported);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader gap-2 px-2 sm:px-3">
        <Button className="min-h-11 sm:min-h-7" onClick={() => void navigate({ params: { sessionId: session.id }, to: "/sessions/$sessionId" })} size="sm" variant="ghost">
          <ArrowLeft aria-hidden="true" />
          <span className="hidden sm:inline">Session</span>
        </Button>
        <h1 className="min-w-0 truncate font-medium text-sm">Browser preview</h1>
        <span className="hidden min-w-0 truncate text-muted-foreground text-xs sm:inline">{project.name}</span>
        <span className="flex-1" />
        <span className="rounded-full border border-border px-2 py-1 text-xs">
          {previewStatusLabel(status)}
        </span>
      </div>

      <div aria-live="polite" className="sr-only" role="status">
        {error ?? `${previewStatusLabel(status)}${captureTimestamp === undefined ? "" : `; captured ${captureTimestamp}`}`}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:flex-row">
        <section aria-label="Preview controls" className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="rounded-lg border border-border bg-card p-2">
            <label className="block text-muted-foreground text-xs" htmlFor="preview-url">URL</label>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <input
                className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                id="preview-url"
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://localhost:3000"
                value={url}
              />
              <Button
                className="min-h-11 sm:min-h-8"
                disabled={
                  url.trim().length === 0 ||

                  !hostSupport.controlSupported ||
                  (preview !== undefined && !support("navigate").supported)
                }
                onClick={() => {
                  const target = url.trim();
                  if (preview === undefined) {
                    runAction(
                      "navigate",
                      "Launch preview",
                      () => adapter!.launch(target, defaultLaunchAuthority()),
                      false,
                    );
                    return;
                  }
                  runAction("navigate", "Navigate preview", () => mutate("navigate", { url: target }));
                }}
              >
                {preview === undefined ? "Launch" : "Navigate"}
              </Button>
            </div>
            <p className="mt-2 text-muted-foreground text-xs">Launch authority: OMP session-only authority. Authenticated profiles are never selected automatically.</p>
            {(previews.length > 1 || (previews.length === 1 && preview === undefined)) && (
              <label className="mt-3 block text-muted-foreground text-xs" htmlFor="preview-selection">
                Preview
                <select
                  className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8"
                  id="preview-selection"
                  onChange={(event) => {
                    const chosenPreview = previews.find((p) => p.previewId === event.target.value);
                    workspaceStore.getState().setSessionPreview(session.id, {
                      previewId: chosenPreview?.previewId ?? null,
                      optInKind: chosenPreview?.authority?.kind ?? null,
                      optInAuthorityId: chosenPreview?.authority?.id ?? null,
                      optIn: chosenPreview !== undefined,
                    });
                  }}
                  value={preview?.previewId ?? ""}
                >
                  <option disabled value="">Choose a preview...</option>
                  {previews.map((entry) => (
                    <option key={entry.previewId} value={entry.previewId}>
                      {entry.title ?? entry.url ?? entry.previewId}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preview navigation">
            {([
              ["activate", "Activate", Crosshair, {}],
              ["back", "Back", ChevronLeft, {}],
              ["forward", "Forward", ChevronRight, {}],
              ["reload", "Reload", RefreshCw, {}],
              ["capture", "Recapture", RotateCcw, {}],
              ["close", "Close", X, {}],
            ] as const).map(([action, label, Icon]) => {
              const actionSupport = support(action);
              return (
                <button
                  className="flex min-h-11 items-center gap-1 rounded-md border border-border px-3 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-8"
                  disabled={!actionSupport.supported || (action === "back" && preview?.canGoBack === false) || (action === "forward" && preview?.canGoForward === false)}
                  key={action}
                  onClick={() => runAction(action, `${label} preview`, () => mutate(action))}
                  title={actionSupport.reason}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 rounded-lg border border-border bg-muted/20 p-2">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm">Snapshot</span>
              <span className="text-muted-foreground text-xs">{previewTrustLabel(preview)}</span>
              <span className="flex-1" />
              <button aria-pressed={scale === "fit"} className="min-h-11 rounded-md px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8" onClick={() => workspaceStore.getState().setSessionPreviewScale(session.id, "fit")} type="button">Fit</button>
              <button aria-pressed={scale === "actual"} className="min-h-11 rounded-md px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8" onClick={() => workspaceStore.getState().setSessionPreviewScale(session.id, "actual")} type="button">Actual</button>
            </div>
            {captureTimestamp !== undefined && <p className="mb-2 text-muted-foreground text-xs">{status === "cached" ? "Cached" : "Captured"} {captureTimestamp}</p>}
            {captureUrl !== undefined && preview !== undefined && capture !== undefined ? (
              support("click").supported ? (
                <button
                  aria-label="Click snapshot"
                  className="block max-h-full max-w-full cursor-crosshair overflow-auto rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const coordinate = displayedToNativeCoordinate(
                      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
                      { width: bounds.width, height: bounds.height },
                      preview.viewport ?? { width: capture.width, height: capture.height },
                    );
                    if (coordinate !== null) {
                      runAction("click", "Click snapshot", () => mutate("click", coordinate));
                    }
                  }}
                  type="button"
                >
                  <img alt={preview.title === undefined ? "Browser preview snapshot" : `Browser preview snapshot: ${preview.title}`} className={scale === "fit" ? "max-h-[60vh] max-w-full object-contain" : "max-w-none"} height={capture.height} src={captureUrl} width={capture.width} />
                </button>
              ) : (
                <img alt={preview.title === undefined ? "Browser preview snapshot" : `Browser preview snapshot: ${preview.title}`} className={scale === "fit" ? "max-h-[60vh] max-w-full object-contain" : "max-w-none"} height={capture.height} src={captureUrl} width={capture.width} />
              )
            ) : (
              <p className="flex min-h-48 items-center justify-center text-muted-foreground text-sm">
                {status === "unsupported"
                  ? "Browser preview is not supported by this runtime."
                  : status === "empty"
                    ? "Launch a browser preview to request its first snapshot."
                    : "No snapshot has been captured yet."}
              </p>
            )}
          </div>
        </section>

        {showAdvanced && preview !== undefined && (
          <aside aria-label="Advanced preview controls" className="w-full shrink-0 rounded-lg border border-border bg-card p-3 lg:w-80">
            <h2 className="font-medium text-sm">Advanced</h2>
            <p className="mt-1 text-muted-foreground text-xs">Only controls advertised by this host are available.</p>
            <label className="mt-3 block text-xs" htmlFor="preview-selector">Selector</label>
            <input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-selector" onChange={(event) => setSelector(event.target.value)} value={selector} />
            {(support("fill").supported || support("type").supported) && <>
              <label className="mt-3 block text-xs" htmlFor="preview-text">Text</label>
              <input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-text" onChange={(event) => setText(event.target.value)} value={text} />
              <div className="mt-2 flex gap-2">
                {support("fill").supported && <Button className="min-h-11 sm:min-h-8" disabled={!selectorPresent} onClick={() => runAction("fill", "Fill selector", () => mutate("fill", { selector, text }))} size="sm">Fill</Button>}
                {support("type").supported && <Button className="min-h-11 sm:min-h-8" onClick={() => runAction("type", "Type selector", () => mutate("type", { ...(selectorPresent ? { selector } : {}), text }))} size="sm">Type</Button>}
              </div>
            </>}
            {support("select").supported && <>
              <label className="mt-3 block text-xs" htmlFor="preview-select-value">Select value</label>
              <input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-select-value" onChange={(event) => setSelectValue(event.target.value)} value={selectValue} />
              <Button className="mt-2 min-h-11 sm:min-h-8" disabled={!selectorPresent} onClick={() => runAction("select", "Select option", () => mutate("select", { selector, value: selectValue }))} size="sm">Select</Button>
            </>}
            {support("press").supported && <>
              <label className="mt-3 block text-xs" htmlFor="preview-key">Key</label>
              <input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-key" onChange={(event) => setKey(event.target.value)} value={key} />
              <Button className="mt-2 min-h-11 sm:min-h-8" onClick={() => runAction("press", "Press key", () => mutate("press", { key }))} size="sm">Press</Button>
            </>}
            {support("scroll").supported && <>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs" htmlFor="preview-scroll-x">Scroll X<input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-scroll-x" inputMode="numeric" onChange={(event) => setScrollX(event.target.value)} value={scrollX} /></label>
                <label className="text-xs" htmlFor="preview-scroll-y">Scroll Y<input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-scroll-y" inputMode="numeric" onChange={(event) => setScrollY(event.target.value)} value={scrollY} /></label>
              </div>
              <Button className="mt-2 min-h-11 sm:min-h-8" disabled={!validScroll} onClick={() => runAction("scroll", "Scroll preview", () => mutate("scroll", { selector: selector || undefined, deltaX: scrollDeltaX, deltaY: scrollDeltaY }))} size="sm">Scroll</Button>
            </>}
            {support("upload").supported && <>
              <label className="mt-3 block text-xs" htmlFor="preview-upload">Project-relative file path</label>
              <input className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:min-h-8" id="preview-upload" onChange={(event) => setUploadPath(event.target.value)} placeholder="assets/example.png" value={uploadPath} />
              <Button className="mt-2 min-h-11 sm:min-h-8" disabled={!selectorPresent || !safeUploadPath} onClick={() => runAction("upload", "Upload file", () => mutate("upload", { selector, path: uploadPath }))} size="sm">Upload</Button>
            </>}
          </aside>
        )}
      </div>

      {error !== undefined && <p className="border-destructive/30 border-t bg-destructive/10 px-3 py-2 text-destructive text-sm" role="alert">{error}</p>}
      <Dialog
        onOpenChange={(open) => {
          if (!open && previewConfirmation !== undefined && adapter !== null) {
            void adapter
              .confirm(previewConfirmation, "deny")
              .catch((cause) => setError(safePreviewError(cause)));
          }
        }}
        open={previewConfirmation !== undefined}
      >
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirm browser action</DialogTitle>
            <DialogDescription>
              {previewConfirmation === undefined ? "" : String(previewConfirmation.summary)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                if (previewConfirmation !== undefined && adapter !== null) {
                  void adapter
                    .confirm(previewConfirmation, "deny")
                    .catch((cause) => setError(safePreviewError(cause)));
                }
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (previewConfirmation !== undefined && adapter !== null) {
                  void adapter
                    .confirm(previewConfirmation, "approve")
                    .catch((cause) => setError(safePreviewError(cause)));
                }
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
