(() => {
  "use strict";

  const BRIDGE_VERSION = 1;
  const THEME_KEYS = new Set([
    "name", "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
    "brightMagenta", "brightCyan", "brightWhite",
  ]);

  function decodeBootstrap() {
    const encoded = new URLSearchParams(window.location.search).get("config");
    if (!encoded) throw new Error("missing terminal bootstrap");
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4);
    const json = atob(padded);
    const value = JSON.parse(json);
    if (!value || value.v !== BRIDGE_VERSION || typeof value.instanceId !== "string") {
      throw new Error("invalid terminal bootstrap");
    }
    if (!Number.isInteger(value.scrollback) || value.scrollback < 0 || value.scrollback > 100000) {
      throw new Error("invalid terminal scrollback");
    }
    if (!value.theme || !value.keyMap || typeof value.interactive !== "boolean") {
      throw new Error("incomplete terminal bootstrap");
    }
    return value;
  }

  function xtermTheme(value) {
    const theme = {};
    for (const key of THEME_KEYS) {
      if (key !== "name" && typeof value[key] === "string") theme[key] = value[key];
    }
    return theme;
  }

  const config = decodeBootstrap();
  const mount = document.getElementById("terminal");
  if (!mount || typeof globalThis.Terminal !== "function" || !globalThis.FitAddon?.FitAddon) {
    throw new Error("bundled xterm assets did not load");
  }

  const terminal = new globalThis.Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    disableStdin: !config.interactive,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    lineHeight: 1.12,
    rightClickSelectsWord: true,
    scrollback: config.scrollback,
    theme: xtermTheme(config.theme),
  });
  const fitAddon = new globalThis.FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(mount);

  let disposed = false;
  let interactive = config.interactive;
  let resizeFrame = 0;
  const disposables = [];

  function post(type, fields = {}) {
    if (disposed || !globalThis.chrome?.webview) return;
    globalThis.chrome.webview.postMessage({
      v: BRIDGE_VERSION,
      instanceId: config.instanceId,
      type,
      ...fields,
    });
  }

  function fit() {
    resizeFrame = 0;
    if (disposed) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    try { fitAddon.fit(); } catch { return; }
    if (wasAtBottom) terminal.scrollToBottom();
  }

  function encodedSpecialKey(event) {
    if (event.type !== "keydown" || event.altKey || event.metaKey) return null;
    if (event.ctrlKey && !event.shiftKey) {
      const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
      return config.keyMap.control[key] ?? null;
    }
    if (event.ctrlKey || event.shiftKey) return null;
    const applicationCursor = terminal.modes?.applicationCursorKeysMode === true;
    if (applicationCursor && config.keyMap.applicationCursor[event.key] !== undefined) {
      return config.keyMap.applicationCursor[event.key];
    }
    return config.keyMap.normal[event.key] ?? null;
  }

  terminal.attachCustomKeyEventHandler((event) => {
    const data = encodedSpecialKey(event);
    if (data === null) return true;
    event.preventDefault();
    if (interactive) post("input", { data });
    return false;
  });

  disposables.push(terminal.onData((data) => {
    if (interactive && data.length > 0) post("input", { data });
  }));
  disposables.push(terminal.onResize(({ cols, rows }) => {
    if (Number.isInteger(cols) && Number.isInteger(rows)) post("resize", { cols, rows });
  }));

  const onPaste = (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    event.stopImmediatePropagation();
    if (interactive && text.length > 0) post("paste", { data: text });
  };
  document.addEventListener("paste", onPaste, true);

  const onFocusIn = () => post("focus", { focused: true });
  const onFocusOut = () => post("focus", { focused: false });
  mount.addEventListener("focusin", onFocusIn);
  mount.addEventListener("focusout", onFocusOut);

  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fit);
  });
  resizeObserver.observe(mount);

  function validHostMessage(message, required, optional = []) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    if (message.v !== BRIDGE_VERSION || message.instanceId !== config.instanceId) return false;
    const allowed = new Set(["v", "instanceId", "type", ...required, ...optional]);
    if (Object.keys(message).some((key) => !allowed.has(key))) return false;
    return required.every((key) => Object.hasOwn(message, key));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
    resizeObserver.disconnect();
    document.removeEventListener("paste", onPaste, true);
    mount.removeEventListener("focusin", onFocusIn);
    mount.removeEventListener("focusout", onFocusOut);
    for (const disposable of disposables) disposable.dispose();
    terminal.dispose();
  }

  globalThis.chrome.webview.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "write":
        if (validHostMessage(message, ["data"]) && typeof message.data === "string") {
          terminal.write(message.data);
        }
        break;
      case "reset":
        if (validHostMessage(message, ["data", "trimmed"]) && typeof message.data === "string" && typeof message.trimmed === "boolean") {
          terminal.reset();
          if (message.trimmed) terminal.write("\u001b[2m[earlier output trimmed]\u001b[0m\r\n");
          terminal.write(message.data);
        }
        break;
      case "theme":
        if (validHostMessage(message, ["theme"]) && message.theme && typeof message.theme === "object") {
          terminal.options.theme = xtermTheme(message.theme);
          terminal.refresh(0, terminal.rows - 1);
        }
        break;
      case "interactive":
        if (validHostMessage(message, ["interactive"]) && typeof message.interactive === "boolean") {
          interactive = message.interactive;
          terminal.options.disableStdin = !interactive;
        }
        break;
      case "focus":
        if (validHostMessage(message, [])) terminal.focus();
        break;
      case "dispose":
        if (validHostMessage(message, [])) dispose();
        break;
      default:
        break;
    }
  });

  requestAnimationFrame(() => requestAnimationFrame(fit));
  post("ready");
})();
