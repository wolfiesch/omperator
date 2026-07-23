import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { T4OmpLauncher } from "../src/t4-omp-launcher.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t4-omp-launcher-"));
  const home = join(root, "home");
  const runtimeRoot = join(root, "support", "runtime");
  const current = join(runtimeRoot, "t4code-17.0.5-appserver-12", "omp");
  const previous = join(runtimeRoot, "t4code-17.0.5-appserver-11", "omp");
  const launcherPath = join(home, ".local", "bin", "t4-omp");
  await mkdir(join(current, ".."), { recursive: true });
  await mkdir(join(previous, ".."), { recursive: true });
  await writeFile(current, "current");
  await writeFile(previous, "previous");
  await chmod(current, 0o755);
  await chmod(previous, 0o755);
  const launcher = new T4OmpLauncher({
    supported: true,
    homeDirectory: home,
    runtimeRoot,
    resolveRuntime: async () => current,
  });
  return { current, home, launcher, launcherPath, previous, root, runtimeRoot };
}

describe("t4-omp terminal launcher", () => {
  it("installs and removes a side-by-side link without touching omp", async () => {
    const { current, home, launcher, launcherPath } = await fixture();
    const existingOmp = join(home, ".local", "bin", "omp");
    await mkdir(join(existingOmp, ".."), { recursive: true });
    await writeFile(existingOmp, "upstream");

    expect((await launcher.inspect()).phase).toBe("not-installed");
    expect((await launcher.install()).phase).toBe("installed");
    expect(await readlink(launcherPath)).toBe(current);
    expect(await readFile(existingOmp, "utf8")).toBe("upstream");
    expect((await launcher.remove()).phase).toBe("not-installed");
    expect(await readFile(existingOmp, "utf8")).toBe("upstream");
  });

  it("updates only links that already point into T4's runtime tree", async () => {
    const { current, launcher, launcherPath, previous } = await fixture();
    await mkdir(join(launcherPath, ".."), { recursive: true });
    await symlink(previous, launcherPath);
    expect((await launcher.inspect()).phase).toBe("update-available");
    expect((await launcher.install()).phase).toBe("installed");
    expect(await readlink(launcherPath)).toBe(current);
  });

  it("refuses regular files and foreign symlinks", async () => {
    const regular = await fixture();
    await mkdir(join(regular.launcherPath, ".."), { recursive: true });
    await writeFile(regular.launcherPath, "mine");
    expect((await regular.launcher.inspect()).phase).toBe("conflict");
    await expect(regular.launcher.install()).rejects.toThrow("left it untouched");
    expect(await readFile(regular.launcherPath, "utf8")).toBe("mine");

    const foreign = await fixture();
    const other = join(foreign.root, "foreign-omp");
    await writeFile(other, "foreign");
    await mkdir(join(foreign.launcherPath, ".."), { recursive: true });
    await symlink(other, foreign.launcherPath);
    expect((await foreign.launcher.inspect()).phase).toBe("conflict");
    await expect(foreign.launcher.remove()).rejects.toThrow("left it untouched");
    expect(await readlink(foreign.launcherPath)).toBe(other);
  });

  it("fails closed outside the installed macOS product", async () => {
    const { home, current, runtimeRoot } = await fixture();
    const launcher = new T4OmpLauncher({
      supported: false,
      homeDirectory: home,
      runtimeRoot,
      resolveRuntime: async () => current,
    });
    expect((await launcher.inspect()).phase).toBe("unsupported");
    await expect(launcher.install()).rejects.toThrow("unavailable");
  });

  it("refuses a symlinked ~/.local installation tree", async () => {
    const { home, launcher, root } = await fixture();
    const outside = join(root, "outside");
    await mkdir(home, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(home, ".local"));
    await expect(launcher.install()).rejects.toThrow("not a safe installation directory");
  });
});
