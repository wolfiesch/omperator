import { app } from "electron";
import { join } from "node:path";
import { DesktopLifecycle, developmentSandboxServiceConfig } from "./lifecycle.ts";
import { desktopClusterOperatorEnabled } from "./cluster-operator-flag.ts";

const MAX_RUNTIME_REJECTION_REPORTS = 10;
const MAX_FAILURE_MESSAGE_LENGTH = 1_024;

type DesktopApp = {
  on(event: "window-all-closed", listener: () => void): unknown;
  removeListener(event: "window-all-closed", listener: () => void): unknown;
  quit(): void;
};

type MainProcess = {
  platform: string;
  on(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
  removeListener(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
};

type Lifecycle = {
  start(): Promise<void>;
};

export interface MainRuntimeOptions {
  readonly app: DesktopApp;
  readonly lifecycle: Lifecycle;
  readonly process: MainProcess;
  readonly report?: (message: string) => void;
  readonly isRecoverableException?: (error: unknown) => boolean;
}

interface InstalledProcessPolicy {
  readonly uncaughtException: (reason: unknown) => void;
  readonly unhandledRejection: (reason: unknown) => void;
}

const installedProcessPolicies = new WeakMap<MainProcess, InstalledProcessPolicy>();
const windowCloseHandlers = new WeakMap<DesktopApp, () => void>();
const applicationShutdowns = new WeakMap<DesktopApp, { quitting: boolean }>();

function failureMessage(reason: unknown): string {
  try {
    let value: string;
    if (reason instanceof Error) value = `${reason.name}: ${reason.message}`;
    else if (typeof reason === "string") value = reason;
    else value = JSON.stringify(reason) ?? String(reason);
    return value.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  } catch {
    return "unprintable failure";
  }
}

function quitOnce(electronApp: DesktopApp): void {
  let shutdown = applicationShutdowns.get(electronApp);
  if (shutdown === undefined) {
    shutdown = { quitting: false };
    applicationShutdowns.set(electronApp, shutdown);
  }
  if (shutdown.quitting) return;
  shutdown.quitting = true;
  electronApp.quit();
}

function isRecoverable(
  error: unknown,
  classifier: ((error: unknown) => boolean) | undefined,
): boolean {
  try {
    return classifier?.(error) === true;
  } catch {
    return false;
  }
}

function installWindowCloseHandler(electronApp: DesktopApp, platform: string): void {
  const previous = windowCloseHandlers.get(electronApp);
  if (previous !== undefined) electronApp.removeListener("window-all-closed", previous);
  const handler = (): void => {
    if (platform !== "darwin") quitOnce(electronApp);
  };
  electronApp.on("window-all-closed", handler);
  windowCloseHandlers.set(electronApp, handler);
}

type SandboxApp = {
  setPath(name: string, path: string): void;
  commandLine: { appendSwitch(name: string): void };
};

type InstalledIdentityApp = SandboxApp & {
  getPath(name: string): string;
  setName(name: string): void;
};

export const LEGACY_APPLICATION_DATA_NAME = "T4 Code";

/**
 * The v0.2 product name is Omperator, but changing Electron's internal name
 * would silently select a new safeStorage key and userData directory. Keep
 * those technical identities stable so the signed in-place update preserves
 * encrypted host credentials, projection state, private runtimes, and local
 * services.
 */
export function applyInstalledIdentityContinuity(
  target: InstalledIdentityApp,
  sandbox: { readonly electronUserData: string } | undefined,
): void {
  target.setName(LEGACY_APPLICATION_DATA_NAME);
  if (sandbox === undefined) {
    target.setPath("userData", join(target.getPath("appData"), LEGACY_APPLICATION_DATA_NAME));
  }
}

/**
 * macOS resolves the default keychain from `$HOME`, and the development
 * sandbox redirects `HOME` to a disposable directory that has none. Without
 * the mock keychain, `safeStorage` fails to store its `<product> Key` item and
 * securityd raises a modal on every launch, after which the app silently runs
 * with no credential store and no projection cache.
 *
 * The switch follows the sandbox, not the packaging mode: `pnpm dogfood:mac`
 * launches the packaged app inside a sandbox and has no keychain either. Any
 * launch outside a sandbox keeps its real `HOME` and its real keychain.
 */
export function applyDevelopmentSandbox(
  target: SandboxApp,
  sandbox: { readonly electronUserData: string } | undefined,
  platform: string = process.platform,
): void {
  if (sandbox === undefined) return;
  target.setPath("userData", sandbox.electronUserData);
  if (platform === "darwin") target.commandLine.appendSwitch("use-mock-keychain");
}

export function bootstrapDesktopMain(options: MainRuntimeOptions): Promise<void> {
  const report = options.report ?? console.error;
  installWindowCloseHandler(options.app, options.process.platform);

  const previous = installedProcessPolicies.get(options.process);
  if (previous !== undefined) {
    options.process.removeListener("uncaughtException", previous.uncaughtException);
    options.process.removeListener("unhandledRejection", previous.unhandledRejection);
  }

  let rejectionReports = 0;
  const uncaughtException = (error: unknown): void => {
    if (isRecoverable(error, options.isRecoverableException)) {
      report(`[desktop] recoverable main exception: ${failureMessage(error)}`);
      return;
    }
    report(`[desktop] fatal main exception: ${failureMessage(error)}`);
    quitOnce(options.app);
  };
  const unhandledRejection = (reason: unknown): void => {
    if (rejectionReports >= MAX_RUNTIME_REJECTION_REPORTS) return;
    rejectionReports += 1;
    const suffix = rejectionReports === MAX_RUNTIME_REJECTION_REPORTS
      ? " (further runtime rejections suppressed)"
      : "";
    report(`[desktop] runtime rejection: ${failureMessage(reason)}${suffix}`);
  };
  options.process.on("uncaughtException", uncaughtException);
  options.process.on("unhandledRejection", unhandledRejection);
  installedProcessPolicies.set(options.process, { uncaughtException, unhandledRejection });

  try {
    return Promise.resolve(options.lifecycle.start()).catch((error: unknown) => {
      report(`[desktop] fatal startup failure: ${failureMessage(error)}`);
      quitOnce(options.app);
    });
  } catch (error) {
    report(`[desktop] fatal startup failure: ${failureMessage(error)}`);
    quitOnce(options.app);
    return Promise.resolve();
  }
}

const developmentSandbox = developmentSandboxServiceConfig();
applyInstalledIdentityContinuity(app as unknown as InstalledIdentityApp, developmentSandbox);
applyDevelopmentSandbox(app as unknown as SandboxApp, developmentSandbox);

const lifecycle = new DesktopLifecycle({
  clusterOperatorEnabled: desktopClusterOperatorEnabled(),
});
void bootstrapDesktopMain({
  app: app as unknown as DesktopApp,
  lifecycle,
  process: process as unknown as MainProcess,
});
