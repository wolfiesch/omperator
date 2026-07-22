import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testRoot, "../../..");
const vendorRoot = join(repoRoot, "vendor", "app-wire");
const manifest = JSON.parse(readFileSync(join(vendorRoot, "manifest.json"), "utf8")) as {
  package: string;
  version: string;
  sourceRepository: string;
  sourceCommit: string;
  sourceTreeHash: string;
  tarball: string;
  tarballSha256: string;
  appProtocol: string;
  goldenCorpusSha256: string;
  createdAt: string;
};
const tarballPath = join(vendorRoot, manifest.tarball);
const packageEntry = fileURLToPath(import.meta.resolve("@t4-code/host-wire"));
const installedRoot = dirname(dirname(packageEntry));

const expectedTarEntries = [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/CHANGELOG.md",
  ...[
    "agent-progress",
    "agent",
    "audit-event",
    "audit-host",
    "audit",
    "bye",
    "catalog",
    "command",
    "confirmation-challenge",
    "confirmation",
    "entry-frame",
    "entry",
    "error",
    "event",
    "files-diff",
    "files",
    "gap",
    "hello-auth-bad.invalid",
    "hello-auth-partial.invalid",
    "hello-auth",
    "hello",
    "host-list",
    "host-watch",
    "pair-start",
    "pairing",
    "ping",
    "pong",
    "preview-capture",
    "prompt-lease",
    "response",
    "restart",
    "review",
    "session-delta",
    "session-secret.invalid",
    "sessions",
    "snapshot",
    "terminal-output",
    "terminal",
    "transcript-context-anchor.invalid",
    "transcript-context-request",
    "transcript-context-response",
    "transcript-search-limit.invalid",
    "transcript-search-request",
    "transcript-search-response",
    "welcome",
  ].map((name) => `package/fixtures/v1/${name}.json`),
  "package/fixtures/v1/scenarios/agent-view-lifecycle.json",
  ...[
    "additive",
    "agents",
    "audit",
    "broker",
    "capabilities",
    "command",
    "cursor",
    "entry",
    "envelope",
    "errors",
    "event",
    "files-review",
    "gap",
    "guards",
    "heartbeat",
    "hello",
    "ids",
    "index",
    "limits",
    "pairing-confirm",
    "result",
    "session-index",
    "session-state",
    "snapshot",
    "terminal",
    "transcript-search",
    "usage",
    "user-terminals",
  ].map((name) => `package/src/${name}.ts`),
].sort();

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Sorted POSIX fixture path + NUL + raw bytes + NUL, hashed as one stream. */
function goldenCorpusSha256(root: string, excluded: ReadonlySet<string> = new Set()): string {
  const paths: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const fixturePath = relative(root, absolute).split(sep).join("/");
        if (!excluded.has(fixturePath)) paths.push(fixturePath);
      }
    }
  }
  visit(root);
  paths.sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(readFileSync(join(root, ...path.split("/"))));
    digest.update(Buffer.from([0]));
  }
  return digest.digest("hex");
}

describe("T4 host-wire distribution", () => {
  it("keeps the T4-owned source compatible with the frozen OMP bridge snapshot", () => {
    expect(manifest).toMatchObject({
      package: "@oh-my-pi/app-wire",
      version: "0.7.0",
      sourceRepository: "https://github.com/lyc-aon/oh-my-pi",
      sourceCommit: "796bb7dca45027bd4b7b94017cdf41ef214a11f2",
      sourceTreeHash: "0c195a01ba0bb98fbf4d4863aee59bf23a6e81b7",
      tarball: "oh-my-pi-app-wire-0.7.0.tgz",
      appProtocol: "omp-app/1",
      goldenCorpusSha256: "d5e674095de3d9b3b56a5668bc91cbbf1904b409ea9ea6456c2eabdf272e7870",
    });
    expect(manifest.createdAt).toBe("2026-07-20T03:17:05Z");
    expect(sha256(tarballPath)).toBe(manifest.tarballSha256);
    const installedFixtures = join(installedRoot, "fixtures", "v1");
    expect(goldenCorpusSha256(installedFixtures)).toBe(
      "8987b23e778ae5d4aee9b58d430cff007194ba47c8313d78db678f7a418b88bc",
    );
    expect(
      goldenCorpusSha256(
        installedFixtures,
        new Set(["sessions-cluster.json", "workspace-state.json"]),
      ),
    ).toBe(manifest.goldenCorpusSha256);
    const installedPackage = JSON.parse(
      readFileSync(join(installedRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(installedPackage.name).toBe("@t4-code/host-wire");
    expect(installedPackage.version).toBe("0.1.31");
    expect(installedPackage.version).not.toBe(manifest.version);
    expect(installedPackage.dependencies ?? {}).toEqual({});
  });

  it("keeps the packed surface exact and dependency paths portable", () => {
    const entries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(entries).toEqual(expectedTarEntries);
    expect(entries).toHaveLength(78);

    const protocolPackage = readFileSync(
      join(repoRoot, "packages", "protocol", "package.json"),
      "utf8",
    );
    const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(`${protocolPackage}\n${lockfile}`).not.toContain("/home/");
    expect(protocolPackage).toMatch(/"@t4-code\/host-wire": "workspace:\*"/u);
    expect(lockfile).toContain("'@t4-code/host-wire':");
    expect(`${protocolPackage}\n${lockfile}`).not.toMatch(/file:\/\//u);
  });
});
