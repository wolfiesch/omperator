// Single source of truth for the public release: repo, tag, asset names,
// download URLs, and the platform-detection rule the hero button uses.

export const SITE_URL = "https://t4code.net";
export const DOCS_URL = `${SITE_URL}/docs`;
export const REPO_URL = "https://github.com/LycaonLLC/t4-code";
export const OMP_URL = "https://github.com/can1357/oh-my-pi";
export const OMP_RUNTIME_VERSION = "16.5.0";
export const OMP_RUNTIME_COMMIT = "d4a0b9344e1796c0e56041cfeea3431a8a728e61";
export const OMP_RUNTIME_TAG = "t4code-16.5.0-appserver-3";
export const OMP_RUNTIME_URL = `https://github.com/lyc-aon/oh-my-pi/tree/${OMP_RUNTIME_TAG}`;
export const OMP_UPSTREAM_TAG = "v16.5.0";
export const OMP_UPSTREAM_COMMIT = "3047c27c332c5629c8e063283d349384c10c9a56";
export const OMP_UPSTREAM_URL = `${OMP_URL}/tree/${OMP_UPSTREAM_TAG}`;
export const APP_WIRE_VERSION = "0.5.2";
export const RELEASE_TAG = "v0.1.9";
export const RELEASE_VERSION = "0.1.9";
export const RELEASES_URL = `${REPO_URL}/releases/tag/${RELEASE_TAG}`;

export type Platform = "android" | "linux" | "mac";
export type DesktopPlatform = Exclude<Platform, "android">;
export type AssetKind = "apk" | "deb" | "appimage" | "dmg" | "zip";

export interface ReleaseAsset {
  readonly platform: Platform;
  readonly kind: AssetKind;
  readonly arch: string;
  readonly filename: string;
  readonly label: string;
  readonly url: string;
}

function asset(
  platform: Platform,
  kind: AssetKind,
  arch: string,
  filename: string,
  label: string,
): ReleaseAsset {
  return {
    platform,
    kind,
    arch,
    filename,
    label,
    url: `${REPO_URL}/releases/download/${RELEASE_TAG}/${encodeURIComponent(filename)}`,
  };
}

export const RELEASE_ASSETS: readonly ReleaseAsset[] = [
  asset("android", "apk", "universal", "T4-Code-0.1.9-android.apk", "Android APK"),
  asset("linux", "deb", "x86_64", "T4-Code-0.1.9-linux-amd64.deb", "Linux .deb"),
  asset("linux", "appimage", "x86_64", "T4-Code-0.1.9-linux-x86_64.AppImage", "Linux AppImage"),
  asset("mac", "dmg", "arm64", "T4-Code-0.1.9-mac-arm64.dmg", "macOS .dmg"),
  asset("mac", "zip", "arm64", "T4-Code-0.1.9-mac-arm64.zip", "macOS .zip"),
];

export function assetsFor(platform: Platform): readonly ReleaseAsset[] {
  return RELEASE_ASSETS.filter((a) => a.platform === platform);
}

/** Preferred single download per platform: APK on Android, .deb on Linux, .dmg on macOS. */
export function primaryAsset(platform: Platform): ReleaseAsset {
  const kind: AssetKind = platform === "android" ? "apk" : platform === "linux" ? "deb" : "dmg";
  const found = RELEASE_ASSETS.find((a) => a.platform === platform && a.kind === kind);
  if (!found) throw new Error(`no ${kind} asset for ${platform}`);
  return found;
}

/**
 * Detect the visitor's desktop platform from a user-agent string. Anything
 * else falls back to Linux; the Android download is offered separately.
 */
export function detectPlatform(userAgent: string): DesktopPlatform {
  if (/mac os x|macintosh/i.test(userAgent)) return "mac";
  return "linux";
}
