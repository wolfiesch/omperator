// One xterm surface bound to one drawer tab. Mount/fit/theme/buffer-replay
// flow adapted from T3 Code apps/web/src/components/ThreadTerminalDrawer.tsx
// `TerminalViewport` (MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb). OMP changes: token-driven theme
// via xtermThemeFromElement, store-owned buffers with trim-aware replay,
// backpressure-queued input through the drawer store, guarded paste routed
// through the store instead of xterm's clipboard path, read-only stdin while
// the connection is down, split-pane keyboard navigation, no link providers.
import "@xterm/xterm/css/xterm.css";

import { xtermThemeFromElement } from "@t4-code/ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import {
  useTerminalDrawer,
  type TerminalDrawerStoreApi,
} from "./terminal-store.ts";

function fitSafely(fitAddon: FitAddon): void {
  try {
    fitAddon.fit();
  } catch {
    // A zero-size mount during layout is fine; the next resize refits.
  }
}

export interface TerminalViewportProps {
  readonly api: TerminalDrawerStoreApi;
  readonly terminalId: string;
  readonly active: boolean;
  /** Bumps when layout changed (drawer resize, split change): refit. */
  readonly resizeEpoch: number;
  readonly onSelectionChange?: ((selection: TerminalSelectionChange) => void) | undefined;
}

export interface TerminalSelectionChange {
  readonly terminalId: string;
  readonly title: string;
  /** Empty when this exact terminal cleared its selection. */
  readonly text: string;
}

export function TerminalViewport({
  api,
  terminalId,
  active,
  resizeEpoch,
  onSelectionChange,
}: TerminalViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastWrittenRef = useRef("");
  const buffer = useTerminalDrawer(api, (state) =>
    state.tabs.find((tab) => tab.id === terminalId)?.buffer ?? "",
  );
  const trimmed = useTerminalDrawer(api, (state) =>
    state.tabs.find((tab) => tab.id === terminalId)?.trimmed ?? false,
  );
  const title = useTerminalDrawer(api, (state) =>
    state.tabs.find((tab) => tab.id === terminalId)?.title ?? "Shell",
  );
  const focusEpoch = useTerminalDrawer(api, (state) => state.focusEpoch);
  // Stdin is live only while the wire is up and the shell can take input.
  const inputLive = useTerminalDrawer(api, (state) => {
    const tab = state.tabs.find((entry) => entry.id === terminalId);
    return (
      state.connection === "online" &&
      tab !== undefined &&
      (tab.status === "running" || tab.status === "starting")
    );
  });

  // Mount once per terminal id.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1,
      scrollback: 5_000,
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
      theme: xtermThemeFromElement(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitSafely(fitAddon);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    lastWrittenRef.current = "";

    api.getState().ensureOpen(terminalId);

    const inputDisposable = terminal.onData((data) => {
      api.getState().sendInput(terminalId, data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      api.getState().notifyResize(terminalId, cols, rows);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      const text = terminal.getSelection();
      const currentTitle =
        api.getState().tabs.find((tab) => tab.id === terminalId)?.title ?? "Shell";
      onSelectionChange?.({ terminalId, title: currentTitle, text });
    });

    // Split-pane keyboard navigation: Ctrl+Shift+Arrow moves activation
    // between panes; xterm never sees the chord.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          api.getState().focusPane(-1);
          return false;
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          api.getState().focusPane(1);
          return false;
        }
      }
      return true;
    });

    // Paste guard: every clipboard path lands here before the PTY. Risky
    // text (multiline/large/destructive-looking) waits for confirmation
    // naming this exact terminal; the text itself is never logged.
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();
      if (text.length === 0) return;
      api.getState().requestPaste(terminalId, text);
    };
    mount.addEventListener("paste", onPaste, true);

    // Theme follows the .dark class without a second palette.
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = xtermThemeFromElement(mountRef.current);
      terminal.refresh(0, terminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    let resizeFrame = 0;
    const fitTerminal = () => {
      resizeFrame = 0;
      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      fitSafely(fitAddon);
      if (wasAtBottom) terminal.scrollToBottom();
    };
    const mountObserver = new ResizeObserver(() => {
      if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitTerminal);
    });
    mountObserver.observe(mount);

    return () => {
      if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      mount.removeEventListener("paste", onPaste, true);
      themeObserver.disconnect();
      mountObserver.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [api, onSelectionChange, terminalId]);

  // Replay store buffers: append the delta while the buffer only grew in
  // place; a front-trim or rewrite invalidates the prefix and forces a
  // clean repaint (T3's startsWith replay contract). Streaming stays an
  // append — the drawer never rerenders wholesale for output.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const previous = lastWrittenRef.current;
    if (buffer.startsWith(previous)) {
      terminal.write(buffer.slice(previous.length));
    } else {
      terminal.write("\u001bc");
      if (trimmed) terminal.write("[earlier output trimmed]\r\n");
      terminal.write(buffer);
    }
    lastWrittenRef.current = buffer;
  }, [buffer, trimmed]);

  // Read-only while disconnected or after the shell stops: keystrokes are
  // refused at the source, matching the store's input denial.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    terminal.options.disableStdin = !inputLive;
  }, [inputLive]);

  // Focus restoration: whenever this viewport is the active one and the
  // drawer asks for focus (open, tab switch, restart), take it.
  useEffect(() => {
    if (!active) return;
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const frame = window.requestAnimationFrame(() => terminal.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, focusEpoch]);

  // Layout epochs (drawer resize commit, split change) refit the grid.
  useEffect(() => {
    const fitAddon = fitRef.current;
    const terminal = terminalRef.current;
    if (fitAddon === null || terminal === null) return;
    const frame = window.requestAnimationFrame(() => {
      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      fitSafely(fitAddon);
      if (wasAtBottom) terminal.scrollToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resizeEpoch]);

  return (
    <div
      aria-label={`${title} terminal`}
      className="h-full w-full overflow-hidden"
      ref={mountRef}
      role="group"
    />
  );
}
