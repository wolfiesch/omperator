import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  IconButton,
  StatusPill,
} from "@t4-code/ui";
import type {
  BrowserMethod,
  BrowserProfile,
  BrowserSurfaceState,
  SurfaceId,
} from "@t4-code/protocol/browser-ipc";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bug,
  Camera,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Focus,
  Globe2,
  Layers3,
  LoaderCircle,
  Minus,
  PanelRightOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useActionRegistry } from "../../actions/index.ts";
import type { WorkspaceProject, WorkspaceSession } from "../../lib/workspace-data.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "../../state/store-instance.ts";
import { selectSessionView } from "../../state/workspace-store.ts";
import { useComposer } from "../composer/composer-store.ts";
import {
  captureBrowserSnapshotContext,
  type BrowserPageContextSnapshot,
  type ContextPacketItem,
} from "../context-packet/context-packet.ts";
import {
  applyBrowserEvent,
  browserCall,
  browserProfileFromOption,
  browserProfileTrustLabel,
  consoleFromBrowserResult,
  downloadsFromBrowserResult,
  errorsFromBrowserResult,
  formatBrowserResult,
  initialBrowserWorkspaceModel,
  ISOLATED_BROWSER_PROFILE,
  liveBrowserSurfaces,
  MAX_BROWSER_ADDRESS_LENGTH,
  MAX_BROWSER_EVAL_LENGTH,
  nativeBoundsFromRect,
  normalizeBrowserAddress,
  profileOptionsFromBrowserResult,
  reconcileBrowserSurfaces,
  safeBrowserActionError,
  selectBrowserSurface,
  surfaceFromBrowserResult,
  surfacesFromBrowserResult,
  type BrowserProfileOption,
  type BrowserWorkspaceModel,
} from "./browser-model.ts";

const FIELD_CLASS =
  "min-h-11 min-w-0 rounded-md border border-input bg-popover px-3 text-base text-foreground outline-none transition-shadow duration-(--motion-duration-fast) placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:min-h-8 sm:text-sm";

const EMPTY_CONTEXT_ITEMS = [] as const;
export const BROWSER_CONTEXT_CAPTURE_METHOD = "browser.snapshot" as const;

interface PendingTrustAction {
  readonly option: BrowserProfileOption;
  readonly surface?: BrowserSurfaceState;
}

function activeTitle(surface: BrowserSurfaceState): string {
  if (surface.title.trim().length > 0) return surface.title;
  if (surface.url === "about:blank" || surface.url.trim().length === 0) return "New tab";
  try {
    return new URL(surface.url).hostname || surface.url;
  } catch {
    return "Browser tab";
  }
}

function updateSurfaceResult(
  model: BrowserWorkspaceModel,
  value: unknown,
  preferred?: SurfaceId | null,
): BrowserWorkspaceModel {
  const surface = surfaceFromBrowserResult(value);
  return surface === null
    ? model
    : reconcileBrowserSurfaces(model, [surface], preferred ?? surface.surfaceId);
}
function discardBrowserWorkspaceCall(call: Promise<unknown>): void {
  void call.catch(() => undefined);
}

export function settleBrowserWorkspaceCall<T>(
  call: Promise<T>,
  isCurrent: () => boolean,
  onFulfilled: (value: T) => void,
  onRejected: (error: unknown) => void,
): Promise<void> {
  return call
    .then(
      (value) => {
        if (isCurrent()) onFulfilled(value);
      },
      (error: unknown) => {
        if (isCurrent()) onRejected(error);
      },
    )
    .catch(() => undefined);
}

function browserPageContextSnapshot(value: unknown): BrowserPageContextSnapshot | null {
  if (typeof value !== "object" || value === null || !("snapshot" in value)) return null;
  const snapshot = (value as { readonly snapshot?: unknown }).snapshot;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("url" in snapshot) ||
    typeof snapshot.url !== "string" ||
    !("title" in snapshot) ||
    typeof snapshot.title !== "string" ||
    !("elements" in snapshot) ||
    !Array.isArray(snapshot.elements)
  ) {
    return null;
  }
  const elements = snapshot.elements.filter(
    (element): element is BrowserPageContextSnapshot["elements"][number] =>
      typeof element === "object" &&
      element !== null &&
      "role" in element &&
      typeof element.role === "string" &&
      "name" in element &&
      typeof element.name === "string" &&
      (!("text" in element) || element.text === undefined || typeof element.text === "string") &&
      (!("visible" in element) ||
        element.visible === undefined ||
        typeof element.visible === "boolean"),
  );
  return {
    url: snapshot.url,
    title: snapshot.title,
    elements,
    ...("truncated" in snapshot && snapshot.truncated === true ? { truncated: true } : {}),
  };
}

export function captureBrowserPageResult(
  sessionId: string,
  surfaceId: SurfaceId,
  result: unknown,
): ContextPacketItem | null {
  const snapshot = browserPageContextSnapshot(result);
  return snapshot === null
    ? null
    : captureBrowserSnapshotContext(sessionId, surfaceId, snapshot);
}


function BrowserUnsupported({
  session,
  project,
}: {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BrowserHeader project={project} session={session} status="Unavailable" />
      <Empty className="min-h-0 flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Globe2 aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Native browser unavailable</EmptyTitle>
          <EmptyDescription className="max-w-md">
            Browser workspaces require the T4 Code desktop app. This runtime cannot embed a
            native browser view, but the existing host-backed Preview workspace is still
            available from the session.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() =>
              void navigate({ params: { sessionId: session.id }, to: "/sessions/$sessionId" })
            }
            variant="outline"
          >
            <ArrowLeft aria-hidden="true" />
            Return to session
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function BrowserHeader({
  session,
  project,
  status,
}: {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
  readonly status: string;
}) {
  const navigate = useNavigate();
  return (
    <header className="surface-subheader gap-2 px-2 sm:px-3">
      <Button
        className="min-h-11 sm:min-h-7"
        onClick={() =>
          void navigate({ params: { sessionId: session.id }, to: "/sessions/$sessionId" })
        }
        size="sm"
        variant="ghost"
      >
        <ArrowLeft aria-hidden="true" />
        <span className="hidden sm:inline">Session</span>
      </Button>
      <div className="min-w-0">
        <h1 className="truncate font-medium text-sm">Browser</h1>
        <p className="truncate text-muted-foreground text-xs sm:hidden">{session.title}</p>
      </div>
      <span className="hidden min-w-0 truncate text-muted-foreground text-xs sm:inline">
        {session.title} · {project.name}
      </span>
      <span className="flex-1" />
      {session.status === null ? (
        <Badge className="capitalize" variant="outline">
          {session.freshness}
        </Badge>
      ) : (
        <StatusPill status={session.status} />
      )}
      <Badge className="hidden sm:inline-flex" variant="outline">
        {status}
      </Badge>
    </header>
  );
}

export function BrowserWorkspace({
  session,
  project,
}: {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
}) {
  const actionRegistry = useActionRegistry();
  const port = rendererPlatform.browser;
  const callBrowser = useCallback(
    (method: BrowserMethod, request: Readonly<Record<string, unknown>>) =>
      browserCall(method, request, session.id),
    [session.id],
  );
  const rememberedSurfaceId = useWorkspace(
    (state) => selectSessionView(state, session.id).browserSurfaceId,
  );
  const [model, setModel] = useState<BrowserWorkspaceModel>(initialBrowserWorkspaceModel);
  const [profiles, setProfiles] = useState<readonly BrowserProfileOption[]>([
    { profileId: "isolated-session", label: "OMP session", kind: "isolated-session" },
  ]);
  const [selectedProfile, setSelectedProfile] = useState<BrowserProfile>(
    ISOLATED_BROWSER_PROFILE,
  );
  const [pendingTrust, setPendingTrust] = useState<PendingTrustAction | null>(null);
  const [address, setAddress] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [automationResult, setAutomationResult] = useState("Run an automation action to inspect its result.");
  const [expression, setExpression] = useState("document.title");
  const [designMode, setDesignMode] = useState<boolean | "checking" | "unavailable">("checking");
  const [focusMode, setFocusMode] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [zoomBySurface, setZoomBySurface] = useState<Readonly<Record<string, number>>>({});
  const stagedContext = useComposer(
    (state) => state.contextItemsBySessionId[session.id] ?? EMPTY_CONTEXT_ITEMS,
  );
  const modelRef = useRef(model);
  const lifecycleRef = useRef(0);
  const boundsLifecycleRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastBoundsRef = useRef<BrowserSurfaceState["bounds"] | null>(null);
  const confirmedProfileIdRef = useRef<string | null>(null);
  const rememberedSurfaceIdRef = useRef(rememberedSurfaceId);
  rememberedSurfaceIdRef.current = rememberedSurfaceId;

  const commitModel = useCallback(
    (update: (current: BrowserWorkspaceModel) => BrowserWorkspaceModel) => {
      setModel((current) => {
        const next = update(current);
        modelRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    if (port === null) return;
    const generation = ++lifecycleRef.current;
    let subscribed = true;
    modelRef.current = initialBrowserWorkspaceModel();
    setModel(modelRef.current);
    setSelectedProfile(ISOLATED_BROWSER_PROFILE);
    confirmedProfileIdRef.current = null;
    setPendingTrust(null);
    setActionError(null);
    workspaceStore.getState().setSessionBrowserProfile(session.id, null);

    const unsubscribe = port.subscribe((event) => {
      if (!subscribed || lifecycleRef.current !== generation || event.ownerSessionId !== session.id) return;
      if (
        event.type === "state" &&
        event.surface.profile.kind === "authenticated-profile" &&
        confirmedProfileIdRef.current !== event.surface.profile.profileId
      ) {
        commitModel((current) =>
          applyBrowserEvent(current, {
            ...event,
            surface: { ...event.surface, visible: false, focused: "none" },
          }),
        );
        if (event.surface.visible) {
          discardBrowserWorkspaceCall(
            port.call(
              callBrowser("surface.setBounds", {
                surfaceId: event.surface.surfaceId,
                bounds: event.surface.bounds,
                visible: false,
              }),
            ),
          );
        }
        return;
      }
      commitModel((current) => applyBrowserEvent(current, event));
      if (event.type === "error") setActionError(safeBrowserActionError(event.error));
    });

    settleBrowserWorkspaceCall(
      port.call(callBrowser("browser.profiles.list", {})),
      () => subscribed && lifecycleRef.current === generation,
      (result) => setProfiles(profileOptionsFromBrowserResult(result)),
      (error) => setActionError(safeBrowserActionError(error)),
    );

    settleBrowserWorkspaceCall(
      port.call(callBrowser("surface.list", {})),
      () => subscribed && lifecycleRef.current === generation,
      (result) => {
        const surfaces = surfacesFromBrowserResult(result);
        const remembered = surfaces.find(
          (surface) =>
            surface.surfaceId === rememberedSurfaceIdRef.current &&
            surface.lifecycle !== "closed" &&
            surface.profile.kind === "isolated-session",
        );
        const safeSurface =
          remembered ??
          surfaces.find(
            (surface) =>
              surface.visible &&
              surface.lifecycle !== "closed" &&
              surface.profile.kind === "isolated-session",
          ) ??
          surfaces.find(
            (surface) =>
              surface.lifecycle !== "closed" && surface.profile.kind === "isolated-session",
          );
        const selectedId = safeSurface?.surfaceId ?? null;
        commitModel((current) => reconcileBrowserSurfaces(current, surfaces, selectedId));
        workspaceStore.getState().setSessionBrowserSurface(session.id, selectedId);

        // A restored authenticated surface is host state, not fresh consent. Keep it hidden
        // until the user explicitly confirms that exact profile in this workspace mount.
        for (const surface of surfaces) {
          if (surface.visible && surface.profile.kind === "authenticated-profile") {
            discardBrowserWorkspaceCall(
              port.call(
                callBrowser("surface.setBounds", {
                  surfaceId: surface.surfaceId,
                  bounds: surface.bounds,
                  visible: false,
                }),
              ),
            );
          }
        }
      },
      (error) => setActionError(safeBrowserActionError(error)),
    );

    return () => {
      lifecycleRef.current += 1;
      subscribed = false;
      confirmedProfileIdRef.current = null;
      unsubscribe();
      workspaceStore.getState().setSessionBrowserProfile(session.id, null);
    };
  }, [callBrowser, commitModel, port, session.id]);

  const surfaces = liveBrowserSurfaces(model);
  const activeSurface =
    surfaces.find((surface) => surface.surfaceId === model.activeSurfaceId) ?? null;

  useEffect(() => {
    setAddress(activeSurface?.url === "about:blank" ? "" : (activeSurface?.url ?? ""));
  }, [activeSurface?.surfaceId, activeSurface?.url]);

  useEffect(() => {
    setDesignMode("checking");
    if (port === null || activeSurface === null) return;
    const generation = lifecycleRef.current;
    const surfaceId = activeSurface.surfaceId;
    let disposed = false;
    settleBrowserWorkspaceCall(
      port.call(callBrowser("browser.design_mode.status", { surfaceId })),
      () =>
        !disposed &&
        lifecycleRef.current === generation &&
        modelRef.current.activeSurfaceId === surfaceId,
      (result) => {
        if (typeof result !== "object" || result === null) return;
        const enabled = (result as { readonly enabled?: unknown }).enabled;
        if (typeof enabled === "boolean") setDesignMode(enabled);
      },
      () => setDesignMode("unavailable"),
    );
    return () => {
      disposed = true;
    };
  }, [activeSurface?.surfaceId, callBrowser, port]);

  useEffect(() => {
    if (port === null || activeSurface === null) return;
    const generation = lifecycleRef.current;
    const surfaceId = activeSurface.surfaceId;
    let disposed = false;
    settleBrowserWorkspaceCall(
      Promise.all([
        port.call(callBrowser("surface.downloads", { surfaceId })),
        port.call(callBrowser("browser.console.list", { surfaceId })),
        port.call(callBrowser("browser.errors.list", { surfaceId })),
      ]),
      () =>
        !disposed &&
        lifecycleRef.current === generation &&
        modelRef.current.activeSurfaceId === surfaceId,
      ([downloadResult, consoleResult, errorResult]) => {
        const downloads = downloadsFromBrowserResult(downloadResult);
        const consoleMessages = consoleFromBrowserResult(consoleResult);
        const runtimeErrors = errorsFromBrowserResult(errorResult);
        commitModel((current) => ({
          ...current,
          downloads: [
            ...current.downloads.filter((entry) => entry.surfaceId !== surfaceId),
            ...downloads,
          ].slice(-64),
          consoleMessages: [
            ...current.consoleMessages.filter((entry) => entry.surfaceId !== surfaceId),
            ...consoleMessages,
          ].slice(-100),
          runtimeErrors: [
            ...current.runtimeErrors.filter((entry) => entry.surfaceId !== surfaceId),
            ...runtimeErrors,
          ].slice(-50),
        }));
      },
      (error) => setActionError(safeBrowserActionError(error)),
    );
    return () => {
      disposed = true;
    };
  }, [activeSurface?.surfaceId, callBrowser, commitModel, port]);

  useEffect(() => {
    if (port === null || activeSurface === null || viewportRef.current === null) return;
    const generation = lifecycleRef.current;
    const boundsGeneration = ++boundsLifecycleRef.current;
    const surfaceId = activeSurface.surfaceId;
    const element = viewportRef.current;
    let frame = 0;
    let disposed = false;

    const isCurrent = () =>
      !disposed &&
      lifecycleRef.current === generation &&
      boundsLifecycleRef.current === boundsGeneration;
    const sendBounds = (visible: boolean) => {
      if (!isCurrent()) return;
      const measured = nativeBoundsFromRect(element.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      const bounds = measured ?? lastBoundsRef.current ?? activeSurface.bounds;
      lastBoundsRef.current = bounds;
      settleBrowserWorkspaceCall(
        port.call(
          callBrowser("surface.setBounds", { surfaceId, bounds, visible: visible && measured !== null }),
        ),
        isCurrent,
        () => undefined,
        (error) => setActionError(safeBrowserActionError(error)),
      );
    };
    const scheduleBounds = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        sendBounds(!document.hidden);
      });
    };
    const onVisibilityChange = () => sendBounds(!document.hidden);
    const observer = new ResizeObserver(scheduleBounds);
    observer.observe(element);
    window.addEventListener("resize", scheduleBounds);
    window.addEventListener("scroll", scheduleBounds, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleBounds();

    return () => {
      boundsLifecycleRef.current += 1;
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      window.removeEventListener("scroll", scheduleBounds, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const bounds = lastBoundsRef.current ?? activeSurface.bounds;
      discardBrowserWorkspaceCall(
        port.call(callBrowser("surface.setBounds", { surfaceId, bounds, visible: false })),
      );
    };
  }, [activeSurface?.surfaceId, callBrowser, port]);

  const runAction = useCallback(
    async (
      label: string,
      method: BrowserMethod,
      request: Readonly<Record<string, unknown>>,
    ): Promise<unknown | null> => {
      if (port === null) return null;
      const generation = lifecycleRef.current;
      setBusyAction(label);
      setActionError(null);
      try {
        const result = await port.call(callBrowser(method, request));
        if (lifecycleRef.current !== generation) return null;
        const surface = surfaceFromBrowserResult(result);
        if (surface !== null) {
          commitModel((current) =>
            reconcileBrowserSurfaces(current, [surface], surface.surfaceId),
          );
        }
        return result;
      } catch (error) {
        if (lifecycleRef.current === generation) setActionError(safeBrowserActionError(error));
        return null;
      } finally {
        if (lifecycleRef.current === generation) setBusyAction(null);
      }
    },
    [callBrowser, commitModel, port],
  );

  const switchSurface = useCallback(
    async (surface: BrowserSurfaceState) => {
      const result = await runAction("Switching tab", "browser.tab.switch", {
        surfaceId: surface.surfaceId,
      });
      if (result === null) return;
      commitModel((current) => selectBrowserSurface(current, surface.surfaceId));
      workspaceStore.getState().setSessionBrowserSurface(session.id, surface.surfaceId);
    },
    [commitModel, runAction, session.id],
  );

  const activateSurface = useCallback(
    async (surface: BrowserSurfaceState) => {
      if (
        surface.profile.kind === "authenticated-profile" &&
        selectedProfile.profileId !== surface.profile.profileId
      ) {
        const option = profiles.find((entry) => entry.profileId === surface.profile.profileId) ?? {
          profileId: surface.profile.profileId,
          label: "Authenticated profile",
          kind: "authenticated-profile" as const,
        };
        setPendingTrust({ option, surface });
        return;
      }
      await switchSurface(surface);
    },
    [profiles, selectedProfile.profileId, switchSurface],
  );

  const createTab = useCallback(async () => {
    const bounds = lastBoundsRef.current ?? { x: 0, y: 0, width: 800, height: 600 };
    const result = await runAction("Opening tab", "surface.create", {
      profile: selectedProfile,
      url: "about:blank",
      bounds,
      visible: true,
    });
    if (result === null) return;
    const surface = surfaceFromBrowserResult(result);
    if (surface === null) return;
    commitModel((current) => updateSurfaceResult(current, result, surface.surfaceId));
    workspaceStore.getState().setSessionBrowserSurface(session.id, surface.surfaceId);
  }, [commitModel, runAction, selectedProfile, session.id]);

  const closeSurface = useCallback(
    async (surface: BrowserSurfaceState) => {
      const index = surfaces.findIndex((entry) => entry.surfaceId === surface.surfaceId);
      const fallback = surfaces[index + 1] ?? surfaces[index - 1] ?? null;
      const result = await runAction("Closing tab", "surface.close", {
        surfaceId: surface.surfaceId,
      });
      if (result === null) return;
      commitModel((current) => updateSurfaceResult(current, result, fallback?.surfaceId ?? null));
      if (fallback === null) {
        workspaceStore.getState().setSessionBrowserSurface(session.id, null);
      } else {
        await activateSurface(fallback);
      }
    },
    [activateSurface, commitModel, runAction, session.id, surfaces],
  );

  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    if (activeSurface === null) return;
    let url: string;
    try {
      url = normalizeBrowserAddress(address);
    } catch (error) {
      setActionError(safeBrowserActionError(error));
      return;
    }
    await runAction("Navigating", "surface.navigate", {
      surfaceId: activeSurface.surfaceId,
      url,
    });
  };

  const runAutomation = async (
    label: string,
    method: BrowserMethod,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown | null> => {
    if (activeSurface === null) return null;
    const generation = lifecycleRef.current;
    const surfaceId = activeSurface.surfaceId;
    const result = await runAction(label, method, {
      surfaceId,
      ...request,
    });
    if (
      result === null ||
      lifecycleRef.current !== generation ||
      modelRef.current.activeSurfaceId !== surfaceId
    ) {
      return null;
    }
    setAutomationResult(formatBrowserResult(result));
    return result;
  };

  const capturePageContext = async () => {
    if (activeSurface === null) return;
    const result = await runAutomation("Capturing page context", BROWSER_CONTEXT_CAPTURE_METHOD, {});
    if (result === null) return;
    const item = captureBrowserPageResult(session.id, activeSurface.surfaceId, result);
    if (item === null) {
      setActionError("The browser did not return readable page context.");
      return;
    }
    actionRegistry.execute({ id: "context.capture", args: { sessionId: session.id, item } });
  };

  const setZoom = async (next: number) => {
    if (activeSurface === null) return;
    const generation = lifecycleRef.current;
    const surfaceId = activeSurface.surfaceId;
    const zoom = Math.max(0.25, Math.min(5, Math.round(next * 4) / 4));
    const result = await runAction("Changing zoom", "browser.zoom.set", {
      surfaceId,
      zoom,
    });
    if (
      result !== null &&
      lifecycleRef.current === generation &&
      modelRef.current.activeSurfaceId === surfaceId
    ) {
      setZoomBySurface((current) => ({ ...current, [surfaceId]: zoom }));
    }
  };

  const activeDownloads = useMemo(
    () => model.downloads.filter((entry) => entry.surfaceId === activeSurface?.surfaceId),
    [activeSurface?.surfaceId, model.downloads],
  );
  const activeConsole = useMemo(
    () => model.consoleMessages.filter((entry) => entry.surfaceId === activeSurface?.surfaceId),
    [activeSurface?.surfaceId, model.consoleMessages],
  );
  const activeErrors = useMemo(
    () => model.runtimeErrors.filter((entry) => entry.surfaceId === activeSurface?.surfaceId),
    [activeSurface?.surfaceId, model.runtimeErrors],
  );
  const currentZoom = activeSurface === null ? 1 : (zoomBySurface[activeSurface.surfaceId] ?? 1);
  const contextAlreadyAdded =
    activeSurface !== null &&
    stagedContext.some(
      (item) =>
        item.source.kind === "browser" && item.source.surfaceId === activeSurface.surfaceId,
    );

  if (port === null) return <BrowserUnsupported project={project} session={session} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <BrowserHeader
        project={project}
        session={session}
        status={activeSurface?.loading ? "Loading" : activeSurface === null ? "No tab" : "Ready"}
      />

      <div className="flex min-h-11 shrink-0 items-end gap-1 border-border border-b bg-sidebar px-2 pt-1 sm:min-h-9">
        <div
          aria-label="Browser tabs"
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (surfaces.length === 0) return;
            const currentIndex = surfaces.findIndex(
              (surface) => surface.surfaceId === activeSurface?.surfaceId,
            );
            let nextIndex: number | null = null;
            if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % surfaces.length;
            else if (event.key === "ArrowLeft") {
              nextIndex = (currentIndex - 1 + surfaces.length) % surfaces.length;
            } else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = surfaces.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = surfaces[nextIndex];
            if (next === undefined) return;
            void activateSurface(next)
              .then(() => {
                document
                  .querySelector<HTMLButtonElement>(`[data-browser-tab="${next.surfaceId}"]`)
                  ?.focus();
              })
              .catch(() => undefined);
          }}
          role="tablist"
        >
          {surfaces.map((surface) => {
            const active = surface.surfaceId === activeSurface?.surfaceId;
            return (
              <div
                className={cn(
                  "group/tab flex min-h-11 max-w-56 shrink-0 items-center rounded-t-md border border-b-0 sm:min-h-9",
                  active
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                )}
                key={surface.surfaceId}
              >
                <button
                  aria-controls="browser-native-viewport"
                  aria-selected={active}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  data-browser-tab={surface.surfaceId}
                  onClick={() => void activateSurface(surface)}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  title={activeTitle(surface)}
                  type="button"
                >
                  {surface.loading ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Globe2 aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{activeTitle(surface)}</span>
                  {surface.profile.kind === "authenticated-profile" && (
                    <ShieldCheck aria-label="Authenticated profile" className="size-3.5 shrink-0 text-warning-foreground" />
                  )}
                </button>
                <IconButton
                  aria-label={`Close ${activeTitle(surface)}`}
                  className="me-1 size-7 sm:size-6"
                  onClick={() => void closeSurface(surface)}
                  size="icon-xs"
                >
                  <X aria-hidden="true" />
                </IconButton>
              </div>
            );
          })}
        </div>
        <IconButton
          aria-label="New browser tab"
          className="mb-1"
          disabled={busyAction !== null}
          onClick={() => void createTab()}
          size="icon-sm"
          variant="ghost"
        >
          <Plus aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-border border-b bg-background p-2 md:flex-row md:items-center">
        <div aria-label="Page navigation" className="flex items-center gap-1" role="group">
          <IconButton
            aria-label="Go back"
            disabled={activeSurface === null || !activeSurface.canGoBack || busyAction !== null}
            onClick={() =>
              activeSurface === null
                ? undefined
                : void runAction("Going back", "surface.goBack", {
                    surfaceId: activeSurface.surfaceId,
                  })
            }
            size="icon-lg"
          >
            <ChevronLeft aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="Go forward"
            disabled={activeSurface === null || !activeSurface.canGoForward || busyAction !== null}
            onClick={() =>
              activeSurface === null
                ? undefined
                : void runAction("Going forward", "surface.goForward", {
                    surfaceId: activeSurface.surfaceId,
                  })
            }
            size="icon-lg"
          >
            <ChevronRight aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label={activeSurface?.loading ? "Stop loading" : "Reload page"}
            disabled={activeSurface === null || busyAction !== null}
            onClick={() =>
              activeSurface === null
                ? undefined
                : void runAction(
                    activeSurface.loading ? "Stopping" : "Reloading",
                    activeSurface.loading ? "surface.stop" : "surface.reload",
                    { surfaceId: activeSurface.surfaceId },
                  )
            }
            size="icon-lg"
          >
            {activeSurface?.loading ? <X aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          </IconButton>
        </div>

        <form className="flex min-w-0 flex-1 gap-1" onSubmit={(event) => void navigate(event)}>
          <label className="sr-only" htmlFor="browser-address">Web address</label>
          <input
            autoCapitalize="none"
            autoComplete="off"
            className={cn(FIELD_CLASS, "w-full flex-1 rounded-full font-mono")}
            disabled={activeSurface === null}
            id="browser-address"
            maxLength={MAX_BROWSER_ADDRESS_LENGTH}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="Search or enter address"
            spellCheck={false}
            type="text"
            value={address}
          />
          <Button
            aria-label="Navigate"
            className="min-h-11 px-3 sm:min-h-8"
            disabled={activeSurface === null || address.trim().length === 0 || busyAction !== null}
            size="sm"
            type="submit"
          >
            Go
          </Button>
        </form>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:max-w-72">
          <label className="sr-only" htmlFor="browser-profile">Browser profile</label>
          <select
            className={cn(FIELD_CLASS, "w-full min-w-0")}
            id="browser-profile"
            onChange={(event) => {
              const option = profiles.find((entry) => entry.profileId === event.target.value);
              if (option === undefined) return;
              if (option.kind === "authenticated-profile") {
                setPendingTrust({ option });
              } else {
                setSelectedProfile(ISOLATED_BROWSER_PROFILE);
                confirmedProfileIdRef.current = null;
                workspaceStore.getState().setSessionBrowserProfile(session.id, null);
              }
            }}
            value={selectedProfile.profileId}
          >
            {profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.kind === "isolated-session" ? "Isolated" : "Authenticated"} · {profile.label}
              </option>
            ))}
          </select>
          <span className="truncate px-1 text-muted-foreground text-xs">
            {browserProfileTrustLabel(selectedProfile)}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-48 min-w-0 flex-1 flex-col p-2">
          <div
            aria-label={activeSurface === null ? "No browser tab selected" : `Web page: ${activeTitle(activeSurface)}`}
            className="relative flex min-h-48 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-background"
            id="browser-native-viewport"
            ref={viewportRef}
            role="tabpanel"
            tabIndex={activeSurface === null ? 0 : -1}
          >
            {activeSurface === null ? (
              <div className="max-w-sm p-6 text-center">
                <Globe2 aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
                <h2 className="mt-3 font-medium text-sm">Open a browser tab</h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  New tabs use the selected profile. Authenticated profiles always require confirmation.
                </p>
                <Button className="mt-4" onClick={() => void createTab()} size="sm">
                  <Plus aria-hidden="true" />
                  New tab
                </Button>
              </div>
            ) : (
              <span className="sr-only">Native browser content is displayed in this area.</span>
            )}
          </div>
        </main>

        {automationOpen && (
          <aside
            aria-label="Browser automation"
            className="max-h-96 w-full shrink-0 overflow-y-auto border-border border-t bg-sidebar p-3 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="font-medium text-sm">Automation</h2>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  Actions target only the selected tab.
                </p>
              </div>
              <IconButton
                aria-label="Close automation drawer"
                onClick={() => setAutomationOpen(false)}
                size="icon-sm"
              >
                <X aria-hidden="true" />
              </IconButton>
            </div>

            <section className="mt-4 border-border border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium text-xs">Accessibility snapshot</h3>
                  <p className="text-muted-foreground text-xs">Roles, names, and element refs.</p>
                </div>
                <Button
                  disabled={activeSurface === null || busyAction !== null}
                  onClick={() => void runAutomation("Taking snapshot", "browser.snapshot", {})}
                  size="sm"
                  variant="outline"
                >
                  <Camera aria-hidden="true" />
                  Capture
                </Button>
              </div>
            </section>

            <section className="mt-4 border-border border-t pt-3">
              <label className="font-medium text-xs" htmlFor="browser-eval-expression">
                Evaluate expression
              </label>
              <textarea
                className={cn(FIELD_CLASS, "mt-1 min-h-24 w-full resize-y py-2 font-mono text-xs")}
                id="browser-eval-expression"
                maxLength={MAX_BROWSER_EVAL_LENGTH}
                onChange={(event) => setExpression(event.target.value)}
                spellCheck={false}
                value={expression}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {expression.length}/{MAX_BROWSER_EVAL_LENGTH}
                </span>
                <Button
                  disabled={activeSurface === null || expression.trim().length === 0 || busyAction !== null}
                  onClick={() =>
                    void runAutomation("Evaluating", "browser.eval", { expression })
                  }
                  size="sm"
                >
                  <Code2 aria-hidden="true" />
                  Evaluate
                </Button>
              </div>
            </section>

            <section className="mt-4 border-border border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium text-xs">Design mode</h3>
                  <p className="text-muted-foreground text-xs">Edit page content in place.</p>
                </div>
                <button
                  aria-checked={designMode === true}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 rounded-full border outline-none transition-colors duration-(--motion-duration-fast) after:absolute after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring",
                    designMode === true ? "border-primary bg-primary" : "border-input bg-secondary",
                  )}
                  disabled={
                    activeSurface === null ||
                    busyAction !== null ||
                    designMode === "checking" ||
                    designMode === "unavailable"
                  }
                  onClick={() => {
                    if (typeof designMode !== "boolean") return;
                    const enabled = !designMode;
                    void runAutomation("Changing design mode", "browser.design_mode.set", {
                      enabled,
                    })
                      .then((result) => {
                        if (typeof result !== "object" || result === null) return;
                        const confirmed = (result as { readonly enabled?: unknown }).enabled;
                        if (typeof confirmed === "boolean") setDesignMode(confirmed);
                      })
                      .catch(() => undefined);
                  }}
                  role="switch"
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 block size-4.5 rounded-full bg-primary-foreground shadow-xs transition-transform duration-(--motion-duration-fast)",
                      designMode === true
                        ? "translate-x-5.5"
                        : "translate-x-0.5 bg-muted-foreground",
                    )}
                  />
                </button>
              </div>
              {designMode === "checking" && (
                <p className="mt-2 text-muted-foreground text-xs">Checking this tab’s state…</p>
              )}
              {designMode === "unavailable" && (
                <p className="mt-2 text-warning text-xs">
                  Design Mode status is unavailable. Switch tabs or reload to retry.
                </p>
              )}
            </section>

            <section className="mt-4 border-border border-t pt-3">
              <h3 className="font-medium text-xs">Result</h3>
              <pre
                aria-live="polite"
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs"
                tabIndex={0}
              >
                {automationResult}
              </pre>
            </section>
          </aside>
        )}
      </div>

      <footer className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-border border-t bg-sidebar px-2 py-1 sm:min-h-9">
        <div aria-label="Browser view controls" className="flex items-center gap-0.5" role="group">
          <IconButton
            aria-label="Zoom out"
            disabled={activeSurface === null || currentZoom <= 0.25 || busyAction !== null}
            onClick={() => void setZoom(currentZoom - 0.25)}
            size="icon-sm"
          >
            <Minus aria-hidden="true" />
          </IconButton>
          <Button
            aria-label="Reset zoom"
            className="min-w-14 tabular-nums"
            disabled={activeSurface === null || busyAction !== null}
            onClick={() => void setZoom(1)}
            size="xs"
            variant="ghost"
          >
            {Math.round(currentZoom * 100)}%
          </Button>
          <IconButton
            aria-label="Zoom in"
            disabled={activeSurface === null || currentZoom >= 5 || busyAction !== null}
            onClick={() => void setZoom(currentZoom + 0.25)}
            size="icon-sm"
          >
            <Plus aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="Focus web page"
            disabled={activeSurface === null || busyAction !== null}
            onClick={() =>
              activeSurface === null
                ? undefined
                : void runAction("Focusing page", "surface.focusWebView", {
                    surfaceId: activeSurface.surfaceId,
                  })
            }
            size="icon-sm"
          >
            <Focus aria-hidden="true" />
          </IconButton>
          <Button
            aria-pressed={focusMode}
            disabled={activeSurface === null || busyAction !== null}
            onClick={() => {
              if (activeSurface === null) return;
              const generation = lifecycleRef.current;
              const surfaceId = activeSurface.surfaceId;
              const enabled = !focusMode;
              void runAction("Changing focus mode", "browser.focus_mode.set", {
                surfaceId,
                enabled,
              })
                .then((result) => {
                  if (
                    result !== null &&
                    lifecycleRef.current === generation &&
                    modelRef.current.activeSurfaceId === surfaceId
                  ) {
                    setFocusMode(enabled);
                  }
                })
                .catch(() => undefined);
            }}
            size="xs"
            variant={focusMode ? "secondary" : "ghost"}
          >
            Focus mode
          </Button>
          <IconButton
            aria-label={devtoolsOpen ? "Close developer tools" : "Open developer tools"}
            aria-pressed={devtoolsOpen}
            disabled={activeSurface === null || busyAction !== null}
            onClick={() => {
              if (activeSurface === null) return;
              const generation = lifecycleRef.current;
              const surfaceId = activeSurface.surfaceId;
              void runAction("Toggling developer tools", "browser.devtools.toggle", {
                surfaceId,
              })
                .then((result) => {
                  if (
                    result !== null &&
                    lifecycleRef.current === generation &&
                    modelRef.current.activeSurfaceId === surfaceId
                  ) {
                    setDevtoolsOpen((open) => !open);
                  }
                })
                .catch(() => undefined);
            }}
            size="icon-sm"
          >
            <Bug aria-hidden="true" />
          </IconButton>
        </div>

        <Button
          disabled={activeSurface === null || busyAction !== null}
          onClick={() => void capturePageContext()}
          size="xs"
          variant={contextAlreadyAdded ? "secondary" : "outline"}
        >
          <Layers3 aria-hidden="true" />
          {contextAlreadyAdded ? "Refresh page" : "Add page"}
        </Button>
        <span className="flex-1" />
        <Button
          onClick={() => {
            setAutomationResult(
              formatBrowserResult({
                downloads: activeDownloads.map((download) => ({
                  downloadId: download.downloadId,
                  filename: download.filename,
                  state: download.state,
                  receivedBytes: download.receivedBytes,
                  totalBytes: download.totalBytes,
                  failure:
                    download.failure === undefined
                      ? undefined
                      : safeBrowserActionError({
                          code: "internal",
                          message: download.failure,
                        }),
                })),
              }),
            );
            setAutomationOpen(true);
          }}
          size="xs"
          variant="ghost"
        >
          <Download aria-hidden="true" />
          <span className="hidden sm:inline">Downloads</span> {activeDownloads.length}
        </Button>
        <Button
          onClick={() => {
            setAutomationResult(formatBrowserResult({ console: activeConsole }));
            setAutomationOpen(true);
          }}
          size="xs"
          variant="ghost"
        >
          <SquareTerminal aria-hidden="true" />
          <span className="hidden sm:inline">Console</span> {activeConsole.length}
        </Button>
        <Button
          className={activeErrors.length > 0 ? "text-destructive-foreground" : undefined}
          onClick={() => {
            setAutomationResult(
              formatBrowserResult({
                errors: activeErrors.map((error) => ({
                  kind: error.kind,
                  code: error.code,
                  message: safeBrowserActionError(error),
                  fatal: error.fatal,
                  timestamp: error.timestamp,
                })),
              }),
            );
            setAutomationOpen(true);
          }}
          size="xs"
          variant="ghost"
        >
          <TriangleAlert aria-hidden="true" />
          <span className="hidden sm:inline">Errors</span> {activeErrors.length}
        </Button>
        <Button
          aria-expanded={automationOpen}
          onClick={() => setAutomationOpen((open) => !open)}
          size="xs"
          variant={automationOpen ? "secondary" : "outline"}
        >
          <PanelRightOpen aria-hidden="true" />
          Automation
        </Button>
      </footer>

      {actionError !== null && (
        <div
          className="flex items-start gap-2 border-destructive/30 border-t bg-destructive/10 px-3 py-2 text-destructive-foreground text-sm"
          role="alert"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <IconButton aria-label="Dismiss browser error" onClick={() => setActionError(null)} size="icon-sm">
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}

      <div aria-live="polite" className="sr-only" role="status">
        {busyAction ??
          (actionError ??
            (activeSurface === null
              ? "No browser tab selected"
              : `${activeTitle(activeSurface)}, ${activeSurface.lifecycle}`))}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingTrust(null);
        }}
        open={pendingTrust !== null}
      >
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Use authenticated browser profile?</DialogTitle>
            <DialogDescription>
              {pendingTrust === null
                ? ""
                : `${pendingTrust.option.label} can access its signed-in sites, cookies, and saved sessions. Confirm only when this task needs that identity.`}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warning/30 bg-warning/8 p-3 text-sm">
            This choice applies only to the current Browser workspace mount. T4 Code will not
            select an authenticated profile from last-used state.
          </div>
          <DialogFooter>
            <Button onClick={() => setPendingTrust(null)} variant="outline">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingTrust === null) return;
                const confirmed = browserProfileFromOption(pendingTrust.option);
                const surface = pendingTrust.surface;
                setSelectedProfile(confirmed);
                confirmedProfileIdRef.current =
                  confirmed.kind === "authenticated-profile" ? confirmed.profileId : null;
                workspaceStore.getState().setSessionBrowserProfile(
                  session.id,
                  confirmed.kind === "authenticated-profile" ? confirmed.profileId : null,
                );
                setPendingTrust(null);
                if (surface !== undefined) void switchSurface(surface);
              }}
            >
              <ShieldCheck aria-hidden="true" />
              Confirm profile
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
