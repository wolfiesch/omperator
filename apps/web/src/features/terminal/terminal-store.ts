// Per-session terminal drawer store: tabs, rename, split groups (max four
// panes), output buffers with byte-order guarantees, input backpressure
// queueing, paste guarding, exit/signal/restart, error and permission
// states, connection-level offline/reconnecting, and independent
// per-session persistence.
// Tab/group layout adapted from T3 Code
// apps/web/src/components/ThreadTerminalDrawer.tsx group normalization (MIT,
// T3 Tools Inc., commit f61fa9499d96fee825492aba204593c37b27e0cb). OMP
// changes: zustand vanilla store, wire-shaped PTY bridge seam, explicit
// backpressure queue, per-session storage keys, paste guard, connection
// lifecycle.
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { assessPaste, preparePasteForPty, type PasteAssessment } from "./paste-guard.ts";
import type { PtySession, UserPtyBridge } from "./pty.ts";

export const MAX_TERMINALS_PER_GROUP = 4;
export const TERMINAL_DRAWER_HEIGHT = { min: 180, default: 280 } as const;
/** Retained scrollback per terminal; older output trims from the front. */
export const MAX_TERMINAL_BUFFER_CHARS = 200_000;
/** Rename cap; longer titles truncate rather than overflow the strip. */
export const MAX_TERMINAL_TITLE_CHARS = 48;

export type TerminalStatus =
  | "starting"
  | "running"
  | "exited"
  | "error"
  | "denied";

/** Drawer-wide transport state; tabs stay put while the wire is down. */
export type TerminalConnection = "online" | "reconnecting" | "offline";

export interface TerminalTabState {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  readonly exitCode: number | null;
  /** Signal name when the shell was killed (e.g. "TERM"); null otherwise. */
  readonly signal: string | null;
  /** Safe human-readable failure message; never raw input or secrets. */
  readonly errorMessage: string | null;
  /** Full retained output; viewports replay it on mount and on reconnect. */
  readonly buffer: string;
  /** Bumps on every buffer change; viewports diff against it. */
  readonly bufferVersion: number;
  /** True once old output has been trimmed from the front of the buffer. */
  readonly trimmed: boolean;
  readonly cols: number;
  readonly rows: number;
  /** Input held back while the transport reports saturation. */
  readonly queuedInput: string;
}

export interface TerminalGroup {
  readonly id: string;
  readonly terminalIds: readonly string[];
  readonly direction: "horizontal" | "vertical";
}

export interface TerminalHostInfo {
  /** Short display name — "This machine" or the paired host's name. */
  readonly label: string;
  readonly remote: boolean;
}

export interface PendingPaste {
  readonly terminalId: string;
  /** Original clipboard text. Kept in memory only — never logged or persisted. */
  readonly text: string;
  readonly assessment: PasteAssessment;
}

export interface TerminalDrawerState {
  readonly sampleMode: boolean;
  readonly host: TerminalHostInfo;
  /** Safe display labels for the shell and working directory. */
  readonly shellLabel: string;
  readonly cwdLabel: string | null;
  readonly connection: TerminalConnection;
  readonly tabs: readonly TerminalTabState[];
  readonly groups: readonly TerminalGroup[];
  readonly activeTerminalId: string | null;
  readonly drawerHeight: number;
  /** Bumped whenever focus should return to the active terminal. */
  readonly focusEpoch: number;
  /** A risky paste awaiting explicit confirmation; null otherwise. */
  readonly pendingPaste: PendingPaste | null;
}

export interface TerminalDrawerActions {
  openTerminal(): string;
  /** Split the active terminal's group; refused beyond four panes. */
  splitActiveGroup(direction: "horizontal" | "vertical"): string | null;
  closeTerminal(terminalId: string): void;
  setActiveTerminal(terminalId: string): void;
  renameTerminal(terminalId: string, title: string): void;
  /** Move activation within the active split group; wraps at the ends. */
  focusPane(delta: -1 | 1): void;
  setDrawerHeight(height: number): void;
  requestFocus(): void;
  /** Attach a PTY for a tab that has none (restored or reconnecting). */
  ensureOpen(terminalId: string): void;
  /** User keystrokes toward the PTY; queued in order under backpressure. */
  sendInput(terminalId: string, data: string): void;
  /** Paste path: safe text goes straight through, risky text waits. */
  requestPaste(terminalId: string, text: string): void;
  confirmPaste(): void;
  cancelPaste(): void;
  notifyResize(terminalId: string, cols: number, rows: number): void;
  /** Start a fresh shell in an exited/failed tab; scrollback is kept. */
  restartTerminal(terminalId: string): void;
  /** Transport state from the shell bridge; back online re-opens shells. */
  setConnection(connection: TerminalConnection): void;
}

export type TerminalDrawerStore = TerminalDrawerState & TerminalDrawerActions;
export type TerminalDrawerStoreApi = StoreApi<TerminalDrawerStore>;

/** One line under the panes describing the state that matters most now. */
export interface DrawerNotice {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  /** Terminal the restart/retry action targets; null for connection notices. */
  readonly restartTerminalId: string | null;
  readonly restartLabel: string | null;
}

export function resolveDrawerNotice(
  state: Pick<TerminalDrawerState, "connection" | "tabs" | "activeTerminalId">,
): DrawerNotice | null {
  if (state.connection === "offline") {
    return {
      level: "warning",
      message: "Offline — shells are read-only until the connection returns.",
      restartTerminalId: null,
      restartLabel: null,
    };
  }
  if (state.connection === "reconnecting") {
    return {
      level: "warning",
      message: "Reconnecting — your shells stay on the host. Typing waits until we're back.",
      restartTerminalId: null,
      restartLabel: null,
    };
  }
  const active = state.tabs.find((tab) => tab.id === state.activeTerminalId);
  if (active === undefined) return null;
  if (active.status === "denied") {
    return {
      level: "error",
      message: `${active.title}: ${active.errorMessage ?? "The host didn't allow this shell."} You may not have terminal access on this host.`,
      restartTerminalId: active.id,
      restartLabel: "Try again",
    };
  }
  if (active.status === "error") {
    return {
      level: "error",
      message: `${active.title} hit a problem: ${active.errorMessage ?? "the shell stopped."}`,
      restartTerminalId: active.id,
      restartLabel: "Restart shell",
    };
  }
  if (active.status === "exited") {
    const how =
      active.signal !== null
        ? `stopped by signal ${active.signal}`
        : active.exitCode !== null && active.exitCode !== 0
          ? `ended with code ${active.exitCode}`
          : "ended cleanly";
    return {
      level: active.signal !== null || (active.exitCode ?? 0) !== 0 ? "warning" : "info",
      message: `${active.title} ${how}. Its output stays above.`,
      restartTerminalId: active.id,
      restartLabel: "Restart shell",
    };
  }
  if (active.queuedInput.length > 0) {
    return {
      level: "info",
      message: "Input paused — the host is catching up. Nothing you typed is lost.",
      restartTerminalId: null,
      restartLabel: null,
    };
  }
  return null;
}

const STORAGE_PREFIX = "omp:terminal:v1:";

interface PersistedDrawer {
  readonly version: 1;
  readonly tabs: readonly { readonly id: string; readonly title: string }[];
  readonly groups: readonly TerminalGroup[];
  readonly activeTerminalId: string | null;
  readonly drawerHeight: number;
  readonly counter: number;
}

function parsePersistedDrawer(raw: string | null): PersistedDrawer | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<PersistedDrawer>;
    if (record.version !== 1 || !Array.isArray(record.tabs) || !Array.isArray(record.groups)) {
      return null;
    }
    return record as PersistedDrawer;
  } catch {
    return null;
  }
}

/** Strip control characters and middle-truncate for display in the chrome. */
export function safeLabel(raw: string, max = 40): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean.length <= max) return clean;
  const half = Math.floor((max - 1) / 2);
  return `${clean.slice(0, half)}…${clean.slice(clean.length - half)}`;
}

export interface CreateTerminalStoreOptions {
  readonly sessionId: string;
  readonly bridge: UserPtyBridge;
  readonly cwd: string | null;
  readonly shell?: string;
  /** Which host runs these shells; defaults to the local machine. */
  readonly host?: TerminalHostInfo;
  /** Injected in tests; defaults to window.localStorage when present. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export function createTerminalStore(options: CreateTerminalStoreOptions): TerminalDrawerStoreApi {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof window === "undefined"
        ? null
        : window.localStorage;
  const storageKey = `${STORAGE_PREFIX}${options.sessionId}`;
  const persisted = parsePersistedDrawer(storage?.getItem(storageKey) ?? null);
  let counter = persisted?.counter ?? 0;
  const shell = options.shell ?? "bash";

  // Live PTY handles and their unsubscribers; never persisted.
  const sessions = new Map<string, PtySession>();
  const detachById = new Map<string, () => void>();

  const freshTab = (id: string, title: string): TerminalTabState => ({
    id,
    title,
    status: "starting",
    exitCode: null,
    signal: null,
    errorMessage: null,
    buffer: "",
    bufferVersion: 0,
    trimmed: false,
    cols: 80,
    rows: 24,
    queuedInput: "",
  });

  const initialTabs: TerminalTabState[] = (persisted?.tabs ?? []).map((tab) =>
    freshTab(tab.id, safeLabel(tab.title, MAX_TERMINAL_TITLE_CHARS) || "Shell"),
  );
  const initialGroups: TerminalGroup[] = (persisted?.groups ?? []).filter((group) =>
    group.terminalIds.every((id) => initialTabs.some((tab) => tab.id === id)),
  );

  const store = createStore<TerminalDrawerStore>((set, get) => {
    const patchTab = (terminalId: string, patch: Partial<TerminalTabState>) =>
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === terminalId ? { ...tab, ...patch } : tab)),
      }));

    const appendOutput = (terminalId: string, chunk: string) =>
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== terminalId) return tab;
          let buffer = tab.buffer + chunk;
          let trimmed = tab.trimmed;
          if (buffer.length > MAX_TERMINAL_BUFFER_CHARS) {
            buffer = buffer.slice(buffer.length - MAX_TERMINAL_BUFFER_CHARS);
            trimmed = true;
          }
          return { ...tab, buffer, trimmed, bufferVersion: tab.bufferVersion + 1 };
        }),
      }));

    const releasePty = (terminalId: string) => {
      detachById.get(terminalId)?.();
      detachById.delete(terminalId);
      sessions.delete(terminalId);
    };

    const attachPty = (terminalId: string) => {
      const tab = get().tabs.find((entry) => entry.id === terminalId);
      let pty: PtySession;
      try {
        pty = options.bridge.open({
          sessionId: options.sessionId,
          terminalId,
          shell,
          cwd: options.cwd,
          cols: tab?.cols ?? 80,
          rows: tab?.rows ?? 24,
        });
      } catch {
        patchTab(terminalId, {
          status: "denied",
          errorMessage: "The host didn't allow this shell.",
        });
        return;
      }
      const offData = pty.onData((chunk) => appendOutput(terminalId, chunk));
      const offExit = pty.onExit((exit) => {
        patchTab(terminalId, { status: "exited", exitCode: exit.code, signal: exit.signal });
        releasePty(terminalId);
      });
      const offDrain = pty.onDrain(() => flushQueued(terminalId));
      const offError = pty.onError((error) => {
        patchTab(terminalId, {
          status: error.kind === "permission-denied" ? "denied" : "error",
          errorMessage: error.message,
        });
        releasePty(terminalId);
      });
      const offNotice = pty.onNotice((notice) => {
        appendOutput(
          terminalId,
          notice === "resumed" ? "\r\n[reconnected]\r\n" : "\r\n[some output was skipped]\r\n",
        );
      });
      sessions.set(terminalId, pty);
      detachById.set(terminalId, () => {
        offData();
        offExit();
        offDrain();
        offError();
        offNotice();
      });
      patchTab(terminalId, {
        status: "running",
        exitCode: null,
        signal: null,
        errorMessage: null,
      });
    };

    const flushQueued = (terminalId: string) => {
      const tab = get().tabs.find((entry) => entry.id === terminalId);
      const pty = sessions.get(terminalId);
      if (tab === undefined || pty === undefined || tab.queuedInput.length === 0) return;
      const queued = tab.queuedInput;
      patchTab(terminalId, { queuedInput: "" });
      if (!pty.write(queued)) {
        // Still saturated: put it back untouched; order is preserved because
        // sendInput always appends behind whatever is already queued.
        set((state) => ({
          tabs: state.tabs.map((entry) =>
            entry.id === terminalId
              ? { ...entry, queuedInput: queued + entry.queuedInput }
              : entry,
          ),
        }));
      }
    };

    const acceptsInput = (tab: TerminalTabState | undefined): tab is TerminalTabState =>
      tab !== undefined &&
      (tab.status === "running" || tab.status === "starting") &&
      get().connection === "online";

    const deliverInput = (terminalId: string, data: string) => {
      const tab = get().tabs.find((entry) => entry.id === terminalId);
      const pty = sessions.get(terminalId);
      if (!acceptsInput(tab) || pty === undefined) return;
      if (tab.queuedInput.length > 0) {
        // Keep byte order: nothing overtakes the queue.
        patchTab(terminalId, { queuedInput: tab.queuedInput + data });
        return;
      }
      if (!pty.write(data)) {
        patchTab(terminalId, { queuedInput: data });
      }
    };

    const nextGroupFor = (terminalId: string): TerminalGroup => ({
      id: `group-${terminalId}`,
      terminalIds: [terminalId],
      direction: "horizontal",
    });

    return {
      sampleMode: options.bridge.kind === "fixture",
      host: options.host ?? { label: "This machine", remote: false },
      shellLabel: safeLabel(shell, 24),
      cwdLabel: options.cwd === null ? "Project root" : safeLabel(options.cwd),
      connection: "online",
      tabs: initialTabs,
      groups: initialGroups,
      activeTerminalId:
        persisted?.activeTerminalId !== undefined &&
        initialTabs.some((tab) => tab.id === persisted.activeTerminalId)
          ? persisted.activeTerminalId
          : (initialTabs[0]?.id ?? null),
      drawerHeight: Math.max(
        persisted?.drawerHeight ?? TERMINAL_DRAWER_HEIGHT.default,
        TERMINAL_DRAWER_HEIGHT.min,
      ),
      focusEpoch: 0,
      pendingPaste: null,

      openTerminal: () => {
        counter += 1;
        const id = `user-term-${options.sessionId}-${counter}`;
        const tab = freshTab(id, `Shell ${counter}`);
        set((state) => ({
          tabs: [...state.tabs, tab],
          groups: [...state.groups, nextGroupFor(id)],
          activeTerminalId: id,
          focusEpoch: state.focusEpoch + 1,
        }));
        attachPty(id);
        return id;
      },

      splitActiveGroup: (direction) => {
        const state = get();
        const activeId = state.activeTerminalId;
        if (activeId === null) return null;
        const group = state.groups.find((entry) => entry.terminalIds.includes(activeId));
        if (group === undefined || group.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
          return null;
        }
        counter += 1;
        const id = `user-term-${options.sessionId}-${counter}`;
        const tab = freshTab(id, `Shell ${counter}`);
        set((current) => ({
          tabs: [...current.tabs, tab],
          groups: current.groups.map((entry) =>
            entry.id === group.id
              ? { ...entry, direction, terminalIds: [...entry.terminalIds, id] }
              : entry,
          ),
          activeTerminalId: id,
          focusEpoch: current.focusEpoch + 1,
        }));
        attachPty(id);
        return id;
      },

      closeTerminal: (terminalId) => {
        sessions.get(terminalId)?.kill();
        releasePty(terminalId);
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.id !== terminalId);
          const groups = state.groups
            .map((group) => ({
              ...group,
              terminalIds: group.terminalIds.filter((id) => id !== terminalId),
            }))
            .filter((group) => group.terminalIds.length > 0);
          const activeTerminalId =
            state.activeTerminalId === terminalId
              ? (tabs[tabs.length - 1]?.id ?? null)
              : state.activeTerminalId;
          const pendingPaste =
            state.pendingPaste?.terminalId === terminalId ? null : state.pendingPaste;
          return { tabs, groups, activeTerminalId, pendingPaste };
        });
      },

      setActiveTerminal: (terminalId) =>
        set((state) =>
          state.tabs.some((tab) => tab.id === terminalId)
            ? { activeTerminalId: terminalId, focusEpoch: state.focusEpoch + 1 }
            : state,
        ),

      renameTerminal: (terminalId, title) => {
        const clean = safeLabel(title, MAX_TERMINAL_TITLE_CHARS);
        if (clean.length === 0) return;
        patchTab(terminalId, { title: clean });
      },

      focusPane: (delta) => {
        const state = get();
        const activeId = state.activeTerminalId;
        if (activeId === null) return;
        const group = state.groups.find((entry) => entry.terminalIds.includes(activeId));
        if (group === undefined || group.terminalIds.length < 2) return;
        const index = group.terminalIds.indexOf(activeId);
        const next =
          group.terminalIds[(index + delta + group.terminalIds.length) % group.terminalIds.length];
        if (next !== undefined) get().setActiveTerminal(next);
      },

      setDrawerHeight: (height) =>
        set({ drawerHeight: Math.max(Math.round(height), TERMINAL_DRAWER_HEIGHT.min) }),

      requestFocus: () => set((state) => ({ focusEpoch: state.focusEpoch + 1 })),

      ensureOpen: (terminalId) => {
        if (sessions.has(terminalId)) return;
        const tab = get().tabs.find((entry) => entry.id === terminalId);
        if (tab === undefined || tab.status !== "starting") return;
        attachPty(terminalId);
      },

      sendInput: deliverInput,

      requestPaste: (terminalId, text) => {
        const tab = get().tabs.find((entry) => entry.id === terminalId);
        if (!acceptsInput(tab) || text.length === 0) return;
        const assessment = assessPaste(text);
        if (!assessment.requiresConfirmation) {
          deliverInput(terminalId, preparePasteForPty(text));
          return;
        }
        set({ pendingPaste: { terminalId, text, assessment } });
      },

      confirmPaste: () => {
        const pending = get().pendingPaste;
        if (pending === null) return;
        set((state) => ({ pendingPaste: null, focusEpoch: state.focusEpoch + 1 }));
        deliverInput(pending.terminalId, preparePasteForPty(pending.text));
      },

      cancelPaste: () =>
        set((state) =>
          state.pendingPaste === null
            ? state
            : { pendingPaste: null, focusEpoch: state.focusEpoch + 1 },
        ),

      notifyResize: (terminalId, cols, rows) => {
        patchTab(terminalId, { cols, rows });
        sessions.get(terminalId)?.resize(cols, rows);
      },

      restartTerminal: (terminalId) => {
        const tab = get().tabs.find((entry) => entry.id === terminalId);
        if (tab === undefined) return;
        if (tab.status !== "exited" && tab.status !== "error" && tab.status !== "denied") return;
        appendOutput(terminalId, "\r\n[restarted]\r\n");
        attachPty(terminalId);
        set((state) => ({
          activeTerminalId: terminalId,
          focusEpoch: state.focusEpoch + 1,
        }));
      },

      setConnection: (connection) => {
        const previous = get().connection;
        if (connection === previous) return;
        if (connection !== "online") {
          // The wire is down: live handles are dead. Keep every tab and its
          // scrollback; drop the handles so nothing writes into a stale PTY.
          for (const tab of get().tabs) {
            if (tab.status === "running" || tab.status === "starting") {
              releasePty(tab.id);
            }
          }
          set({ connection });
          return;
        }
        set({ connection });
        // Back online: re-open shells for every tab that was live, marking
        // the boundary in scrollback so history is never silently stitched.
        for (const tab of get().tabs) {
          if (tab.status !== "running" && tab.status !== "starting") continue;
          appendOutput(tab.id, "\r\n[reconnected]\r\n");
          attachPty(tab.id);
        }
        set((state) => ({ focusEpoch: state.focusEpoch + 1 }));
      },
    };
  });

  // Restored tabs start as "starting" with no live PTY; open them now so a
  // window reload keeps the layout AND working shells.
  for (const tab of store.getState().tabs) {
    if (tab.status === "starting") store.getState().ensureOpen(tab.id);
  }

  store.subscribe((state) => {
    storage?.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        tabs: state.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
        groups: state.groups,
        activeTerminalId: state.activeTerminalId,
        drawerHeight: state.drawerHeight,
        counter,
      } satisfies PersistedDrawer),
    );
  });

  return store;
}

// One drawer store per session for the window lifetime; shells survive the
// drawer closing and re-opening.
const storesBySession = new Map<string, TerminalDrawerStoreApi>();

export type TerminalStoreFactory = (sessionId: string) => TerminalDrawerStoreApi;

let factory: TerminalStoreFactory | null = null;

export function installTerminalStoreFactory(next: TerminalStoreFactory): void {
  factory = next;
  storesBySession.clear();
}

export function getTerminalStore(sessionId: string): TerminalDrawerStoreApi | null {
  const existing = storesBySession.get(sessionId);
  if (existing !== undefined) return existing;
  if (factory === null) return null;
  const created = factory(sessionId);
  storesBySession.set(sessionId, created);
  return created;
}

export function useTerminalDrawer<T>(
  api: TerminalDrawerStoreApi,
  selector: (state: TerminalDrawerStore) => T,
): T {
  return useStore(api, selector);
}
