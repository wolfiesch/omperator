const runtimeExternalDependencies = [
  "node_modules/electron-store/**/*",
  "node_modules/electron-updater/**/*",
  "node_modules/ws/**/*",
];
const signedMacBuild = process.env.T4_MACOS_SIGNED_BUILD === "1";

export const linuxUpdatePublish = {
  provider: "github",
  owner: "LycaonLLC",
  repo: "t4-code",
  channel: "latest",
};

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.lycaonsolutions.t4code",
  productName: "T4 Code",
  electronVersion: "41.5.0",
  artifactName: "T4-Code-${version}-${os}-${arch}.${ext}",
  directories: {
    app: "apps/desktop",
    output: "release",
  },
  asar: true,
  files: [
    "dist-electron/**/*",
    "package.json",
    ...runtimeExternalDependencies,
    "!**/*.map",
  ],
  extraResources: [
    { from: "apps/web/dist", to: "web" },
    { from: "packages/host-daemon/dist/t4-host", to: "runtime/t4-host" },
    { from: "LICENSE", to: "LICENSE" },
  ],
  protocols: [{ name: "T4 Code", schemes: ["t4-code"] }],
  linux: {
    executableName: "t4-code",
    category: "Development",
    icon: "apps/desktop/build/icons",
    publish: [linuxUpdatePublish],
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: "apps/desktop/build/icon.png",
    identity: signedMacBuild ? undefined : null,
    hardenedRuntime: signedMacBuild,
    gatekeeperAssess: false,
    entitlements: signedMacBuild ? "apps/desktop/build/entitlements.mac.plist" : undefined,
    entitlementsInherit: signedMacBuild
      ? "apps/desktop/build/entitlements.mac.plist"
      : undefined,
    sign: signedMacBuild ? "scripts/sign-macos.mjs" : undefined,
    notarize: signedMacBuild,
    // The first signed release remains an explicit GitHub download. Keep the
    // updater feed disabled until signed-to-signed update migration has its
    // own release proof.
    publish: [],
    extraResources: [
      { from: ".artifacts/omp-runtime", to: "runtime" },
      { from: "scripts/tailnet-gateway.mjs", to: "gateway/tailnet-gateway.mjs" },
      { from: "scripts/tailnet-service.mjs", to: "gateway/tailnet-service.mjs" },
      { from: "apps/desktop/node_modules/ws", to: "node_modules/ws" },
    ],
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
  },
};

export { runtimeExternalDependencies };
export default config;
