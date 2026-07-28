import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const RELEASE_CONTRACT_PATHS = [
  ".woodpecker.yml",
  ".github/android-release-identity.json",
  ".github/macos-release-identity.json",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-site.yml",
  ".github/workflows/release.yml",
  "electron-builder.config.mjs",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "apps/desktop/src/bundled-runtime.ts",
  "apps/desktop/src/target-manager.ts",
  "apps/site/src/docs/content.ts",
  "apps/site/src/release.ts",
  "apps/web/src/platform/browser-shell-port.ts",
  "compat/official-omp-gate0.json",
  "compat/omp-app-matrix.json",
  "docs/CURRENT_RELEASE_NOTES.md",
  "docs/MACOS_SIGNING.md",
  "docs/RELEASE_GATE.md",
  "ops/t4-maintainer/README.md",
  "packages/client/src/omp-client-frames.ts",
  "provenance/omp-host-migration.json",
  "scripts/check-release-publication.mjs",
  "scripts/ci-baseline.mjs",
  "scripts/ci-paths.mjs",
  "scripts/deploy-site.mjs",
  "scripts/dispatch-site-deployment.mjs",
  "scripts/generate-release-manifest.mjs",
  "scripts/inspect-linux-update.mjs",
  "scripts/read-bounded-response.mjs",
  "scripts/reconcile-release-assets.mjs",
  "scripts/wait-for-exact-ci.mjs",
  "scripts/wait-for-release-assets.mjs",
  "vendor/app-wire/manifest.json",
];

export function discoverReleasePackagePaths(repoRoot) {
  const paths = ["package.json"];
  for (const parent of ["apps", "packages"]) {
    const entries = readdirSync(resolve(repoRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = `${parent}/${entry.name}/package.json`;
        if (existsSync(resolve(repoRoot, manifestPath))) paths.push(manifestPath);
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

export function loadReleaseContractFiles(repoRoot) {
  const paths = [...new Set([...discoverReleasePackagePaths(repoRoot), ...RELEASE_CONTRACT_PATHS])];
  return new Map(
    paths.map((relativePath) => [
      relativePath,
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ]),
  );
}

function rejectDuplicateJsonKeys(source) {
  let offset = 0;

  function skipWhitespace() {
    while (offset < source.length && /\s/u.test(source[offset])) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (source[offset] !== '"') {
      if (source[offset] === "\\") offset += 1;
      offset += 1;
    }
    offset += 1;
    return JSON.parse(source.slice(start, offset));
  }

  function readValue() {
    skipWhitespace();
    if (source[offset] === "{") {
      readObject();
    } else if (source[offset] === "[") {
      readArray();
    } else if (source[offset] === '"') {
      readString();
    } else {
      while (offset < source.length && !/[,}\]]/u.test(source[offset])) offset += 1;
    }
  }

  function readObject() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }

    const keys = new Set();
    while (offset < source.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) throw new SyntaxError(`duplicated mapping key ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace();
      offset += 1;
      readValue();
      skipWhitespace();
      if (source[offset] === ",") {
        offset += 1;
        continue;
      }
      offset += 1;
      return;
    }
  }

  function readArray() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }

    while (offset < source.length) {
      readValue();
      skipWhitespace();
      if (source[offset] === ",") {
        offset += 1;
        continue;
      }
      offset += 1;
      return;
    }
  }

  readValue();
}

export function parseJson(files, path, errors) {
  try {
    const source = files.get(path) ?? "";
    const parsed = JSON.parse(source);
    rejectDuplicateJsonKeys(source);
    return parsed;
  } catch (error) {
    errors.push(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
