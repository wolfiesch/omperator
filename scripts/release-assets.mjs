// Canonical release asset names, deliberately free of third-party imports.
//
// `deploy-site.yml` classifies and confirms a release from the trusted workflow
// checkout, before the immutable deployment source is checked out and its
// dependencies are installed. Anything those steps load therefore has to run on
// Node built-ins alone. Importing this list from the full consistency checker
// pulled in `js-yaml` and crashed the deploy whenever a release was published.
export function expectedReleaseAssetNames(version) {
  return [
    `T4-Code-${version}-android.apk`,
    `T4-Code-${version}-linux-amd64.deb`,
    `T4-Code-${version}-linux-x86_64.AppImage`,
    `T4-Code-${version}-mac-arm64.dmg`,
    `T4-Code-${version}-mac-arm64.zip`,
  ];
}
