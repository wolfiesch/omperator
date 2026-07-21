import { join } from "node:path";
import { BrowserWindow, app, screen } from "electron";
import { strings } from "./strings.ts";
import {
  installNavigationGuards,
  installSessionSecurity,
  rendererUrl,
  type TrustedRenderer,
} from "./security.ts";
import { DESKTOP_CLUSTER_OPERATOR_SWITCH } from "./cluster-operator-flag.ts";

export const WINDOW_MIN_WIDTH = 840;
export const WINDOW_MIN_HEIGHT = 620;
export const WINDOW_DEFAULT_WIDTH = 1100;
export const WINDOW_DEFAULT_HEIGHT = 780;

export interface DesktopWindowOptions {
  readonly devServerUrl?: string;
  readonly webRoot?: string;
  readonly isPackaged?: boolean;
  readonly clusterOperatorEnabled?: boolean;
}

export interface DesktopWindowHandle {
  readonly window: BrowserWindow;
  readonly trustedRenderer: TrustedRenderer;
}

function webRootFrom(options: DesktopWindowOptions): string {
  if (options.webRoot !== undefined) return options.webRoot;
  return app.isPackaged ? join(process.resourcesPath, "web") : join(app.getAppPath(), "apps", "web", "dist");
}

export function createDesktopWindow(options: DesktopWindowOptions = {}): DesktopWindowHandle {
  const trusted = rendererUrl({
    isPackaged: options.isPackaged ?? app.isPackaged,
    devUrl: options.devServerUrl ?? process.env.OMP_DESKTOP_RENDERER_URL,
    webRoot: webRootFrom(options),
  });
  const window = new BrowserWindow({
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    show: false,
    backgroundColor: "#111318",
    title: strings.window.title,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarStyle: "default" as const }),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      ...(options.clusterOperatorEnabled
        ? { additionalArguments: [DESKTOP_CLUSTER_OPERATOR_SWITCH] }
        : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  installSessionSecurity(window.webContents.session, trusted, !app.isPackaged);
  installNavigationGuards(window, trusted);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(trusted.url);
  return { window, trustedRenderer: trusted };
}

export function recoverWindowBounds(window: BrowserWindow): void {
  const bounds = window.getBounds();
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  });
  if (!visible) window.setBounds({ x: 80, y: 80, width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT });
}

