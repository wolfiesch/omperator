/**
 * Release asset naming, kept free of third-party imports.
 *
 * The deploy-site workflow classifies and waits for a release before it checks
 * out the immutable source and installs dependencies, so every module reachable
 * from those steps must load with node_modules absent. Keeping this helper in
 * its own module lets the release-consistency checker keep its `js-yaml`
 * dependency without dragging it into that pre-install path.
 * `scripts/pre-install-scripts.test.mjs` enforces the boundary.
 */
export function expectedReleaseAssetNames(version) {
  return [
    `Omperator-${version}-android.apk`,
    `Omperator-${version}-linux-amd64.deb`,
    `Omperator-${version}-linux-x86_64.AppImage`,
    `Omperator-${version}-mac-arm64.dmg`,
    `Omperator-${version}-mac-arm64.zip`,
  ];
}
