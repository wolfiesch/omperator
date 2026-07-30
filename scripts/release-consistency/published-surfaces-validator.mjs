import { expectedReleaseAssetNames } from "../release-asset-names.mjs";
import {
  OMP_APP_WIRE_SOURCE_REPOSITORY,
  REPOSITORY_URL,
  requireText,
} from "./shared.mjs";

export function validatePublishedSurfaces(context) {
  const {
    errors,
    expectedTag,
    files,
    macosIdentity,
    ompRuntimeCommit,
    ompRuntimeCommitUrl,
    ompRuntimeSourceTag,
    ompRuntimeSourceUrl,
    ompRuntimeVersion,
    ompUpstreamCommit,
    ompUpstreamCommitUrl,
    ompUpstreamTag,
    ompUpstreamTagUrl,
    publishedAppWireSourceCommit,
    publishedAppWireSourceTree,
    publishedAppWireVersion,
    version,
  } = context;
  const site = files.get("apps/site/src/release.ts") ?? "";
  requireText(
    site,
    `export const RELEASE_TAG = "${expectedTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const RELEASE_VERSION = "${version}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const RELEASE_MANIFEST_URL = `${SITE_URL}/releases/latest.json`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_VERSION = "${ompRuntimeVersion}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_COMMIT = "${ompRuntimeCommit}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_TAG = "${ompRuntimeSourceTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_TAG = "${ompUpstreamTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_COMMIT = "${ompUpstreamCommit}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_UPSTREAM_URL = `${OMP_URL}/tree/${OMP_UPSTREAM_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_RUNTIME_URL = `https://github.com/wolfiesch/oh-my-pi/tree/${OMP_RUNTIME_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const APP_WIRE_VERSION = "${publishedAppWireVersion}";`,
    "apps/site/src/release.ts",
    errors,
  );
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(site, `"${filename}"`, "apps/site/src/release.ts", errors);
  }
  const siteAssetVersions = new Set(
    [...site.matchAll(/Omperator-(\d+\.\d+\.\d+)-(?:android|linux|mac)(?:\.|-)/gu)].map(
      (match) => match[1],
    ),
  );
  for (const assetVersion of siteAssetVersions) {
    if (assetVersion !== version) {
      errors.push(
        `apps/site/src/release.ts contains an asset for ${assetVersion}; expected ${version}`,
      );
    }
  }

  const readme = files.get("README.md") ?? "";
  requireText(
    readme,
    `[**Download ${expectedTag}**](${REPOSITORY_URL}/releases/tag/${expectedTag})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `Omperator ${expectedTag} was verified with OMP ${ompRuntimeVersion} built from [\`${String(ompRuntimeCommit).slice(0, 8)}\`](${ompRuntimeCommitUrl}), tagged [\`${ompRuntimeSourceTag}\`](${ompRuntimeSourceUrl}).`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `official upstream [\`${ompUpstreamTag}\`](${ompUpstreamTagUrl}) tag at [\`${String(ompUpstreamCommit).slice(0, 8)}\`](${ompUpstreamCommitUrl})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `The official upstream ${ompUpstreamTag} tag has no \`appserver\` command, so it cannot host Omperator.`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `Omperator vendors \`@oh-my-pi/app-wire\` ${publishedAppWireVersion} from integration commit [\`${publishedAppWireSourceCommit.slice(0, 8)}\`](${OMP_APP_WIRE_SOURCE_REPOSITORY}/commit/${publishedAppWireSourceCommit}), source tree \`${publishedAppWireSourceTree}\`.`,
    "README.md",
    errors,
  );
  requireText(readme, `## What changed in ${expectedTag}`, "README.md", errors);
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(
      readme,
      `${REPOSITORY_URL}/releases/download/${expectedTag}/${filename}`,
      "README.md",
      errors,
    );
  }
  const linkedReleaseTags = new Set(
    [
      ...readme.matchAll(
        /https:\/\/github\.com\/wolfiesch\/omperator\/releases\/(?:tag|download)\/(v\d+\.\d+\.\d+)/gu,
      ),
    ].map((match) => match[1]),
  );
  for (const linkedTag of linkedReleaseTags) {
    if (linkedTag !== expectedTag) {
      errors.push(`README.md contains a release URL for ${linkedTag}; expected ${expectedTag}`);
    }
  }

  const releaseNotes = files.get("docs/CURRENT_RELEASE_NOTES.md") ?? "";
  for (const expected of [
    `app-wire ${publishedAppWireVersion}`,
    `[${publishedAppWireSourceCommit.slice(0, 8)}](${OMP_APP_WIRE_SOURCE_REPOSITORY}/commit/${publishedAppWireSourceCommit})`,
    `OMP ${ompRuntimeVersion}`,
    `[${String(ompRuntimeCommit).slice(0, 8)}](${ompRuntimeCommitUrl})`,
    `[${ompRuntimeSourceTag}](${ompRuntimeSourceUrl})`,
    `[${ompUpstreamTag} tag](${ompUpstreamTagUrl})`,
    `[${String(ompUpstreamCommit).slice(0, 8)}](${ompUpstreamCommitUrl})`,
  ]) {
    requireText(releaseNotes, expected, "docs/CURRENT_RELEASE_NOTES.md", errors);
  }

  const securityPolicy = files.get("SECURITY.md") ?? "";
  requireText(
    securityPolicy,
    "Published macOS builds are signed with Apple Developer ID and notarized by Apple",
    "SECURITY.md",
    errors,
  );
  requireText(
    securityPolicy,
    `Starting with ${macosIdentity?.firstSignedReleaseTag ?? "the first signed release"}`,
    "SECURITY.md",
    errors,
  );
  requireText(
    files.get(".github/ISSUE_TEMPLATE/bug_report.yml") ?? "",
    `placeholder: "${version}"`,
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    errors,
  );

  const runtimeIdentifiers = [
    ["apps/desktop/src/target-manager.ts", [`version: "${version}"`, 'build: "desktop"']],
    ["apps/web/src/platform/browser-shell-port.ts", [`version: "${version}"`]],
    ["packages/client/src/omp-client-frames.ts", [`version: "${version}"`, 'build: "client"']],
  ];
  for (const [path, expectedValues] of runtimeIdentifiers) {
    for (const expected of expectedValues) {
      requireText(files.get(path) ?? "", expected, path, errors);
    }
  }

  const siteDocs = files.get("apps/site/src/docs/content.ts") ?? "";
  requireText(siteDocs, "OMP_RUNTIME_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_COMMIT", "apps/site/src/docs/content.ts", errors);
  requireText(
    siteDocs,
    "Official upstream OMP v${OMP_RUNTIME_VERSION} does not ship the \\`appserver\\` command, so it cannot host Omperator.",
    "apps/site/src/docs/content.ts",
    errors,
  );
  requireText(
    siteDocs,
    'id: "troubleshooting-large-session"',
    "apps/site/src/docs/content.ts",
    errors,
  );

}
