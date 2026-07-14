// Release contract guard: exact v0.1.9 asset names and URLs, and the
// platform-detection rule the hero download button relies on.
import { describe, expect, it } from "vite-plus/test";
import {
  APP_WIRE_VERSION,
  assetsFor,
  detectPlatform,
  OMP_RUNTIME_COMMIT,
  OMP_RUNTIME_TAG,
  OMP_RUNTIME_URL,
  OMP_UPSTREAM_COMMIT,
  OMP_UPSTREAM_TAG,
  OMP_UPSTREAM_URL,
  primaryAsset,
  RELEASE_ASSETS,
  RELEASE_TAG,
  RELEASE_VERSION,
  REPO_URL,
} from "../src/release.ts";

describe("release assets", () => {
  it("carries the five contracted v0.1.9 filenames", () => {
    expect(RELEASE_ASSETS.map((a) => a.filename)).toEqual([
      "T4-Code-0.1.9-android.apk",
      "T4-Code-0.1.9-linux-amd64.deb",
      "T4-Code-0.1.9-linux-x86_64.AppImage",
      "T4-Code-0.1.9-mac-arm64.dmg",
      "T4-Code-0.1.9-mac-arm64.zip",
    ]);
  });

  it("builds download URLs under the release tag", () => {
    for (const asset of RELEASE_ASSETS) {
      expect(asset.url).toBe(`${REPO_URL}/releases/download/${RELEASE_TAG}/${asset.filename}`);
    }
  });

  it("targets the public LycaonLLC repo", () => {
    expect(REPO_URL).toBe("https://github.com/LycaonLLC/t4-code");
    expect(RELEASE_TAG).toBe("v0.1.9");
    expect(RELEASE_VERSION).toBe("0.1.9");
  });

  it("splits assets by platform with correct architectures", () => {
    expect(assetsFor("linux").every((a) => a.arch === "x86_64")).toBe(true);
    expect(assetsFor("mac").every((a) => a.arch === "arm64")).toBe(true);
    expect(assetsFor("android").every((a) => a.arch === "universal")).toBe(true);
    expect(assetsFor("android")).toHaveLength(1);
    expect(assetsFor("linux")).toHaveLength(2);
    expect(assetsFor("mac")).toHaveLength(2);
  });

  it("picks the APK, .deb, and .dmg as primary downloads", () => {
    expect(primaryAsset("android").kind).toBe("apk");
    expect(primaryAsset("linux").kind).toBe("deb");
    expect(primaryAsset("mac").kind).toBe("dmg");
  });
});

describe("OMP integration contract", () => {
  it("pins the verified runtime tag, commit, and app-wire package", () => {
    expect(OMP_RUNTIME_TAG).toBe("t4code-16.5.0-appserver-3");
    expect(OMP_RUNTIME_COMMIT).toBe("d4a0b9344e1796c0e56041cfeea3431a8a728e61");
    expect(OMP_RUNTIME_URL).toBe(
      "https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.0-appserver-3",
    );
    expect(OMP_UPSTREAM_TAG).toBe("v16.5.0");
    expect(OMP_UPSTREAM_COMMIT).toBe("3047c27c332c5629c8e063283d349384c10c9a56");
    expect(OMP_UPSTREAM_URL).toBe("https://github.com/can1357/oh-my-pi/tree/v16.5.0");
    expect(APP_WIRE_VERSION).toBe("0.5.2");
  });
});

describe("detectPlatform", () => {
  it("detects macOS user agents", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"),
    ).toBe("mac");
  });

  it("detects Linux user agents", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("linux");
  });

  it("falls back to Linux for platforms without a build", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("linux");
    expect(detectPlatform("")).toBe("linux");
  });
});
