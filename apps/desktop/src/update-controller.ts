import { redactedMessage } from "@t4-code/client";
import { decodeDesktopUpdateState, type DesktopUpdateState } from "@t4-code/protocol/desktop-ipc";

export const UPDATE_MANIFEST_URL = "https://t4code.net/releases/latest.json";
const UPDATE_MANIFEST_MAX_BYTES = 256 * 1024;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const PASSIVE_UPDATE_DELAY_MS = 15_000;
const RELEASE_DOWNLOAD_ROOT = "https://github.com/wolfiesch/omperator/releases/download";

interface NativeUpdateInfo {
  readonly version: string;
}

interface NativeUpdateCheckResult {
  readonly isUpdateAvailable: boolean;
  readonly updateInfo: NativeUpdateInfo;
}

interface NativeProgressInfo {
  readonly percent: number;
}

type NativeUpdateEvent = "error" | "download-progress" | "update-downloaded";

export interface NativeUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<NativeUpdateCheckResult | null>;
  downloadUpdate(): Promise<readonly string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (progress: NativeProgressInfo) => void): unknown;
  on(event: "update-downloaded", listener: (info: NativeUpdateInfo) => void): unknown;
  removeListener(event: NativeUpdateEvent, listener: (...args: unknown[]) => void): unknown;
}

export interface UpdateFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { readonly get: (name: string) => string | null };
  readonly body: {
    getReader(): {
      read(): Promise<
        | { readonly done: false; readonly value: Uint8Array }
        | { readonly done: true; readonly value?: Uint8Array | undefined }
      >;
      cancel(reason?: unknown): Promise<void>;
      releaseLock?(): void;
    };
  } | null;
}

export interface DesktopUpdateControllerOptions {
  readonly currentVersion: string;
  readonly platform: "linux" | "darwin";
  readonly isPackaged: boolean;
  readonly nativeLinuxPackage?: "appimage" | "deb";
  readonly nativeUpdater: NativeUpdaterPort;
  readonly fetchManifest: (
    url: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<UpdateFetchResponse>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface ReleaseAsset {
  readonly platform: "android" | "linux" | "mac";
  readonly kind: "apk" | "deb" | "appimage" | "dmg" | "zip";
  readonly arch: "universal" | "x86_64" | "arm64";
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

interface ReleaseManifest {
  readonly version: string;
  readonly assets: readonly ReleaseAsset[];
}

type StateListener = (state: DesktopUpdateState) => void;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid ${name}`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${key}`);
  }
}

function version(value: unknown, name = "version"): string {
  try {
    return decodeDesktopUpdateState({
      version: 1,
      currentVersion: value,
      phase: "idle",
    }).currentVersion;
  } catch {
    throw new Error(`invalid ${name}`);
  }
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function releaseAsset(value: unknown, releaseVersion: string): ReleaseAsset {
  const item = record(value, "release asset");
  exact(item, ["platform", "kind", "arch", "name", "url", "size", "sha256"]);
  if (!["android", "linux", "mac"].includes(item.platform as string)) {
    throw new Error("invalid release asset platform");
  }
  if (!["apk", "deb", "appimage", "dmg", "zip"].includes(item.kind as string)) {
    throw new Error("invalid release asset kind");
  }
  if (!["universal", "x86_64", "arm64"].includes(item.arch as string)) {
    throw new Error("invalid release asset architecture");
  }
  const name = requiredString(item.name, "release asset name", 160);
  const expectedUrl = `${RELEASE_DOWNLOAD_ROOT}/v${releaseVersion}/${name}`;
  if (item.url !== expectedUrl) throw new Error("invalid release asset URL");
  if (
    typeof item.size !== "number" ||
    !Number.isSafeInteger(item.size) ||
    item.size <= 0 ||
    item.size > 2 * 1024 * 1024 * 1024
  ) {
    throw new Error("invalid release asset size");
  }
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
    throw new Error("invalid release asset digest");
  }
  return Object.freeze({
    platform: item.platform as ReleaseAsset["platform"],
    kind: item.kind as ReleaseAsset["kind"],
    arch: item.arch as ReleaseAsset["arch"],
    name,
    url: expectedUrl,
    size: item.size,
    sha256: item.sha256,
  });
}

export function decodeReleaseManifest(value: unknown): ReleaseManifest {
  const root = record(value, "release manifest");
  exact(root, [
    "schemaVersion",
    "channel",
    "version",
    "tag",
    "publishedAt",
    "releaseUrl",
    "assets",
  ]);
  if (root.schemaVersion !== 1 || root.channel !== "stable") {
    throw new Error("unsupported release manifest");
  }
  const releaseVersion = version(root.version, "release version");
  if (root.tag !== `v${releaseVersion}`) throw new Error("invalid release tag");
  if (root.releaseUrl !== `https://github.com/wolfiesch/omperator/releases/tag/v${releaseVersion}`) {
    throw new Error("invalid release URL");
  }
  const publishedAt = requiredString(root.publishedAt, "publishedAt", 64);
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("invalid publishedAt");
  if (!Array.isArray(root.assets) || root.assets.length !== 5) {
    throw new Error("invalid release assets");
  }
  const assets = Object.freeze(root.assets.map((asset) => releaseAsset(asset, releaseVersion)));
  const names = new Set(assets.map((asset) => asset.name));
  if (names.size !== assets.length) throw new Error("duplicate release asset");
  const canonical = [
    ["android", "apk", "universal", `T4-Code-${releaseVersion}-android.apk`],
    ["linux", "deb", "x86_64", `T4-Code-${releaseVersion}-linux-amd64.deb`],
    ["linux", "appimage", "x86_64", `T4-Code-${releaseVersion}-linux-x86_64.AppImage`],
    ["mac", "dmg", "arm64", `T4-Code-${releaseVersion}-mac-arm64.dmg`],
    ["mac", "zip", "arm64", `T4-Code-${releaseVersion}-mac-arm64.zip`],
  ] as const;
  for (const [platform, kind, arch, name] of canonical) {
    if (
      assets.filter(
        (asset) =>
          asset.platform === platform &&
          asset.kind === kind &&
          asset.arch === arch &&
          asset.name === name,
      ).length !== 1
    ) {
      throw new Error("invalid canonical release assets");
    }
  }
  return Object.freeze({ version: releaseVersion, assets });
}

interface ParsedVersion {
  readonly core: readonly number[];
  readonly prerelease: readonly string[];
}

function parsedVersion(value: string): ParsedVersion {
  const [base = "", suffix] = value.split("-", 2);
  return {
    core: base.split(".").map((part) => Number.parseInt(part, 10)),
    prerelease: suffix === undefined ? [] : suffix.split("."),
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parsedVersion(version(left));
  const b = parsedVersion(version(right));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Math.sign(Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10));
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function selectedManualAsset(
  manifest: ReleaseManifest,
  platform: DesktopUpdateControllerOptions["platform"],
): ReleaseAsset {
  const expected =
    platform === "darwin"
      ? {
          platform: "mac",
          kind: "dmg",
          arch: "arm64",
          name: `T4-Code-${manifest.version}-mac-arm64.dmg`,
        }
      : {
          platform: "linux",
          kind: "deb",
          arch: "x86_64",
          name: `T4-Code-${manifest.version}-linux-amd64.deb`,
        };
  const matches = manifest.assets.filter(
    (asset) =>
      asset.platform === expected.platform &&
      asset.kind === expected.kind &&
      asset.arch === expected.arch &&
      asset.name === expected.name,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("required release asset is missing");
  }
  return matches[0];
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Update check failed";
  return redactedMessage(message, 512) || "Update check failed";
}

export class DesktopUpdateController {
  private readonly options: DesktopUpdateControllerOptions;
  private readonly listeners = new Set<StateListener>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly nativeEligible: boolean;
  private state: DesktopUpdateState;
  private manualUrl: string | undefined;
  private checkPromise: Promise<DesktopUpdateState> | undefined;
  private downloadPromise: Promise<DesktopUpdateState> | undefined;
  private surfaceCheckErrors = false;
  private passiveTimer: unknown;
  private passiveAttempted = false;
  private disposed = false;

  private readonly onNativeError = (error: Error): void => {
    if (
      this.disposed ||
      (this.state.phase !== "downloading" && this.state.phase !== "ready")
    ) {
      return;
    }
    this.setState({
      version: 1,
      currentVersion: this.options.currentVersion,
      phase: "error",
      ...(this.state.checkedAt === undefined ? {} : { checkedAt: this.state.checkedAt }),
      ...(this.state.availableVersion === undefined
        ? {}
        : { availableVersion: this.state.availableVersion }),
      message: safeError(error),
    });
  };

  private readonly onNativeProgress = (progress: NativeProgressInfo): void => {
    if (this.disposed || this.state.phase !== "downloading") return;
    const percent = Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : 0;
    this.setState({ ...this.state, progressPercent: percent });
  };

  private readonly onNativeDownloaded = (info: NativeUpdateInfo): void => {
    if (this.disposed || this.state.phase !== "downloading") return;
    let availableVersion: string;
    try {
      availableVersion = version(info.version, "downloaded version");
    } catch (error) {
      this.onNativeError(error instanceof Error ? error : new Error("invalid downloaded version"));
      return;
    }
    if (
      this.state.availableVersion === undefined ||
      availableVersion !== this.state.availableVersion
    ) {
      this.onNativeError(new Error("Downloaded update version did not match the selected release"));
      return;
    }
    this.setState({
      version: 1,
      currentVersion: this.options.currentVersion,
      phase: "ready",
      ...(this.state.checkedAt === undefined ? {} : { checkedAt: this.state.checkedAt }),
      availableVersion,
      progressPercent: 100,
      message: "Restart T4 Code to finish updating.",
    });
  };

  constructor(options: DesktopUpdateControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.nativeEligible =
      options.isPackaged &&
      options.platform === "linux" &&
      options.nativeLinuxPackage !== undefined;
    this.state = decodeDesktopUpdateState({
      version: 1,
      currentVersion: options.currentVersion,
      phase: "idle",
    });

    options.nativeUpdater.autoDownload = false;
    options.nativeUpdater.autoInstallOnAppQuit = false;
    options.nativeUpdater.allowPrerelease = false;
    options.nativeUpdater.allowDowngrade = false;
    options.nativeUpdater.on("error", this.onNativeError);
    options.nativeUpdater.on("download-progress", this.onNativeProgress);
    options.nativeUpdater.on("update-downloaded", this.onNativeDownloaded);
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  schedulePassiveCheck(delayMs = PASSIVE_UPDATE_DELAY_MS): void {
    if (!this.options.isPackaged || this.disposed || this.passiveAttempted) return;
    this.passiveAttempted = true;
    this.passiveTimer = this.setTimer(() => {
      this.passiveTimer = undefined;
      void this.checkForUpdate(false);
    }, delayMs);
  }

  checkForUpdate(interactive = true): Promise<DesktopUpdateState> {
    if (this.disposed) return Promise.resolve(this.state);
    if (interactive && this.passiveTimer !== undefined) {
      this.clearTimer(this.passiveTimer);
      this.passiveTimer = undefined;
    }
    if (this.state.phase === "downloading" || this.state.phase === "ready") {
      return Promise.resolve(this.state);
    }
    if (interactive) this.surfaceCheckErrors = true;
    if (this.checkPromise !== undefined) return this.checkPromise;
    this.setState({
      version: 1,
      currentVersion: this.options.currentVersion,
      phase: "checking",
      ...(this.state.availableVersion === undefined
        ? {}
        : { availableVersion: this.state.availableVersion }),
    });
    const operation = this.nativeEligible ? this.checkNative() : this.checkManual();
    this.checkPromise = operation.catch((error: unknown) => {
      if (this.surfaceCheckErrors) {
        this.setState({
          version: 1,
          currentVersion: this.options.currentVersion,
          phase: "error",
          checkedAt: this.now(),
          message: safeError(error),
        });
      } else {
        this.setState({
          version: 1,
          currentVersion: this.options.currentVersion,
          phase: "idle",
        });
      }
      return this.state;
    });
    const clear = (): void => {
      this.checkPromise = undefined;
      this.surfaceCheckErrors = false;
    };
    void this.checkPromise.then(clear, clear);
    return this.checkPromise;
  }

  downloadUpdate(): Promise<DesktopUpdateState> {
    if (this.disposed) return Promise.resolve(this.state);
    if (this.downloadPromise !== undefined) return this.downloadPromise;
    if (this.state.phase === "manual" && this.manualUrl !== undefined) {
      const operation = this.options.openExternal(this.manualUrl).then(() => {
        this.setState({
          ...this.state,
          message: "The official release download opened in your browser.",
        });
        return this.state;
      });
      this.downloadPromise = this.withActionError(operation);
    } else if (this.state.phase === "available" && this.nativeEligible) {
      this.setState({
        ...this.state,
        phase: "downloading",
        progressPercent: 0,
        message: "Downloading update…",
      });
      const operation = this.options.nativeUpdater.downloadUpdate().then(() => {
        if (this.state.phase === "downloading") {
          this.setState({
            ...this.state,
            phase: "ready",
            progressPercent: 100,
            message: "Restart T4 Code to finish updating.",
          });
        }
        return this.state;
      });
      this.downloadPromise = this.withActionError(operation);
    } else {
      return Promise.resolve(this.state);
    }
    const clear = (): void => {
      this.downloadPromise = undefined;
    };
    void this.downloadPromise.then(clear, clear);
    return this.downloadPromise;
  }

  restartToUpdate(): DesktopUpdateState {
    if (!this.disposed && this.nativeEligible && this.state.phase === "ready") {
      try {
        this.options.nativeUpdater.quitAndInstall(false, true);
      } catch (error) {
        this.onNativeError(
          error instanceof Error ? error : new Error("The update installer could not start"),
        );
      }
    }
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.passiveTimer !== undefined) this.clearTimer(this.passiveTimer);
    this.passiveTimer = undefined;
    this.listeners.clear();
    this.options.nativeUpdater.removeListener(
      "error",
      this.onNativeError as (...args: unknown[]) => void,
    );
    this.options.nativeUpdater.removeListener(
      "download-progress",
      this.onNativeProgress as (...args: unknown[]) => void,
    );
    this.options.nativeUpdater.removeListener(
      "update-downloaded",
      this.onNativeDownloaded as (...args: unknown[]) => void,
    );
  }

  private async checkNative(): Promise<DesktopUpdateState> {
    this.manualUrl = undefined;
    const result = await this.options.nativeUpdater.checkForUpdates();
    const checkedAt = this.now();
    if (result === null || !result.isUpdateAvailable) {
      this.setState({
        version: 1,
        currentVersion: this.options.currentVersion,
        phase: "current",
        checkedAt,
        message: "T4 Code is up to date.",
      });
      return this.state;
    }
    const availableVersion = version(result.updateInfo.version, "available version");
    if (compareVersions(availableVersion, this.options.currentVersion) <= 0) {
      this.setState({
        version: 1,
        currentVersion: this.options.currentVersion,
        phase: "current",
        checkedAt,
        message: "T4 Code is up to date.",
      });
      return this.state;
    }
    this.setState({
      version: 1,
      currentVersion: this.options.currentVersion,
      phase: "available",
      checkedAt,
      availableVersion,
      message: `T4 Code ${availableVersion} is ready to download.`,
    });
    return this.state;
  }

  private async checkManual(): Promise<DesktopUpdateState> {
    const manifest = await this.fetchReleaseManifest();
    const checkedAt = this.now();
    if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
      this.manualUrl = undefined;
      this.setState({
        version: 1,
        currentVersion: this.options.currentVersion,
        phase: "current",
        checkedAt,
        message: "T4 Code is up to date.",
      });
      return this.state;
    }
    const asset = selectedManualAsset(manifest, this.options.platform);
    this.manualUrl = asset.url;
    this.setState({
      version: 1,
      currentVersion: this.options.currentVersion,
      phase: "manual",
      checkedAt,
      availableVersion: manifest.version,
      message: `T4 Code ${manifest.version} is available from the official release.`,
    });
    return this.state;
  }

  private async fetchReleaseManifest(): Promise<ReleaseManifest> {
    const abort = new AbortController();
    const timeout = this.setTimer(() => abort.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const response = await this.options.fetchManifest(UPDATE_MANIFEST_URL, {
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`Update service returned ${response.status}`);
      const declaredLength = response.headers?.get("content-length");
      if (declaredLength !== null && declaredLength !== undefined) {
        if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength)) {
          abort.abort();
          throw new Error("Update manifest Content-Length is invalid");
        }
        const parsedLength = Number(declaredLength);
        if (!Number.isSafeInteger(parsedLength)) {
          abort.abort();
          throw new Error("Update manifest Content-Length is invalid");
        }
        if (parsedLength > UPDATE_MANIFEST_MAX_BYTES) {
          abort.abort();
          throw new Error("Update manifest is too large");
        }
      }
      if (response.body === null) throw new Error("Update manifest body is missing");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) {
            throw new Error("Update manifest body is invalid");
          }
          if (result.value.byteLength > UPDATE_MANIFEST_MAX_BYTES - byteLength) {
            abort.abort();
            try {
              await reader.cancel("Update manifest is too large");
            } catch {
              // The aborted Electron response may already have cancelled its reader.
            }
            throw new Error("Update manifest is too large");
          }
          byteLength += result.value.byteLength;
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Update manifest is not valid UTF-8");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new Error("Update manifest is invalid");
      }
      return decodeReleaseManifest(decoded);
    } finally {
      this.clearTimer(timeout);
    }
  }

  private withActionError(operation: Promise<DesktopUpdateState>): Promise<DesktopUpdateState> {
    return operation.catch((error: unknown) => {
      this.setState({
        version: 1,
        currentVersion: this.options.currentVersion,
        phase: "error",
        ...(this.state.checkedAt === undefined ? {} : { checkedAt: this.state.checkedAt }),
        ...(this.state.availableVersion === undefined
          ? {}
          : { availableVersion: this.state.availableVersion }),
        message: safeError(error),
      });
      return this.state;
    });
  }

  private setState(value: DesktopUpdateState): void {
    this.state = decodeDesktopUpdateState(value);
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        // A renderer/window listener must not interrupt update state transitions.
      }
    }
  }
}
