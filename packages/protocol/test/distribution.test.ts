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
const packageEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/app-wire"));
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
    "welcome",
  ].map((name) => `package/fixtures/v1/${name}.json`),
  ...[
    "additive",
    "agents",
    "audit",
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
    "user-terminals",
  ].map((name) => `package/src/${name}.ts`),
].sort();

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Sorted POSIX fixture path + NUL + raw bytes + NUL, hashed as one stream. */
function goldenCorpusSha256(root: string): string {
  const paths: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join("/"));
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

describe("vendored app-wire distribution", () => {
  it("pins the frozen source, protocol, corpus, and tarball checksums", () => {
    expect(manifest).toMatchObject({
      package: "@oh-my-pi/app-wire",
      version: "0.5.5",
      sourceRepository: "https://github.com/lyc-aon/oh-my-pi",
      sourceCommit: "6a87fa6407ebff20417b4d52885a6bb3091003ea",
      sourceTreeHash: "a2495fe8781c979184fe7fb9a6d37d8f33bad30f",
      tarball: "oh-my-pi-app-wire-0.5.5.tgz",
      appProtocol: "omp-app/1",
      goldenCorpusSha256: "e92d3d7a4848ab6ea6403cc1c1faa6912f8fdc75d2a6abf663ece0154a6eb7fa",
    });
    expect(manifest.createdAt).toMatch(/^2026-07-14T\d{2}:\d{2}:\d{2}Z$/u);
    expect(sha256(tarballPath)).toBe(manifest.tarballSha256);
    expect(goldenCorpusSha256(join(installedRoot, "fixtures", "v1"))).toBe(
      manifest.goldenCorpusSha256,
    );
    const installedPackage = JSON.parse(
      readFileSync(join(installedRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(installedPackage.name).toBe(manifest.package);
    expect(installedPackage.version).toBe(manifest.version);
    expect(installedPackage.dependencies ?? {}).toEqual({});
  });

  it("keeps the packed surface exact and dependency paths portable", () => {
    const entries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(entries).toEqual(expectedTarEntries);
    expect(entries).toHaveLength(68);

    const protocolPackage = readFileSync(
      join(repoRoot, "packages", "protocol", "package.json"),
      "utf8",
    );
    const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(`${protocolPackage}\n${lockfile}`).not.toContain("/home/");
    expect(protocolPackage).toMatch(
      /"@oh-my-pi\/app-wire": "file:\.\.\/\.\.\/vendor\/app-wire\/oh-my-pi-app-wire-0\.5\.5\.tgz"/u,
    );
    expect(lockfile).toMatch(/version: file:vendor\/app-wire\/oh-my-pi-app-wire-0\.5\.5\.tgz/u);
    expect(`${protocolPackage}\n${lockfile}`).not.toMatch(/file:\/\//u);
  });
});
