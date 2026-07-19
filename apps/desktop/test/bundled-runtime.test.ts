import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { installBundledOmpRuntime } from "../src/bundled-runtime.ts";

describe("bundled OMP runtime", () => {
  it("installs the pinned executable atomically and reuses a verified install", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-bundled-runtime-"));
    const resourcesPath = join(root, "resources");
    const supportPath = join(root, "support");
    const runtimeRoot = join(resourcesPath, "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    const bytes = Buffer.from("synthetic omp runtime");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(runtimeRoot, "omp"), bytes);
    await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({
      version: 1, tag: "t4code-17.0.5-appserver-5", platform: "darwin", arch: "arm64",
      executable: "omp", size: bytes.length, sha256,
    }));

    const first = await installBundledOmpRuntime({ resourcesPath, applicationSupportPath: supportPath });
    const second = await installBundledOmpRuntime({ resourcesPath, applicationSupportPath: supportPath });

    expect(second).toBe(first);
    expect(await readFile(first)).toEqual(bytes);
    expect((await stat(first)).mode & 0o777).toBe(0o755);
  });

  it("rejects a bundled executable that does not match its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-bundled-runtime-bad-"));
    const resourcesPath = join(root, "resources");
    const runtimeRoot = join(resourcesPath, "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "omp"), "wrong");
    await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({
      version: 1, tag: "t4code-17.0.5-appserver-5", platform: "darwin", arch: "arm64",
      executable: "omp", size: 5, sha256: "0".repeat(64),
    }));

    await expect(installBundledOmpRuntime({ resourcesPath, applicationSupportPath: join(root, "support") }))
      .rejects.toThrow("integrity check");
  });
});
