import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessOfficialRuntime,
  hostDaemonPaths,
  OFFICIAL_OMP_BUILD,
  OFFICIAL_OMP_VERSION,
  officialOmpRootFromSessionsRoot,
  parseHostDaemonArgs,
  runHostDaemon,
  verifyOfficialRuntime,
} from "../src/cli.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("T4 host daemon CLI", () => {
  test("parses a local direct-replacement service without ambient executable lookup", () => {
    const config = parseHostDaemonArgs(
      ["serve", "--omp", "/opt/t4/runtime/omp", "--profile", "default"],
      "/home/test",
    );
    expect(config).toEqual({
      ompExecutable: "/opt/t4/runtime/omp",
      authorityMode: "bridge",
      profileId: "default",
      stateRoot: "/home/test/.t4-code/host",
    });
    expect(hostDaemonPaths(config)).toMatchObject({
      profileStateRoot: expect.stringContaining("/home/test/.t4-code/host/profiles/"),
      hostIdPath: expect.stringContaining("/host-id"),
      sessionOwnershipPath: expect.stringContaining("/owned-sessions.json"),
      transcriptSearchPath: expect.stringContaining("/transcript-search.sqlite"),
    });
  });

  test("keeps official settings inside the selected OMP profile root", () => {
    expect(
      officialOmpRootFromSessionsRoot("/profiles/test/.omp/agent/sessions"),
    ).toBe("/profiles/test/.omp");
    expect(
      officialOmpRootFromSessionsRoot("/isolated-profile/sessions"),
    ).toBe("/isolated-profile");
  });

  test("validates remote exposure and rejects ambiguous or relative authority", () => {
    expect(() => parseHostDaemonArgs(["serve", "--omp", "omp"], "/home/test")).toThrow("absolute");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-address", "100.64.0.1"],
        "/home/test",
      ),
    ).toThrow("require --remote-mode");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-mode", "serve", "--remote-address", "0.0.0.0"],
        "/home/test",
      ),
    ).toThrow("loopback");
    expect(
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "direct",
          "--remote-address",
          "100.64.0.1",
          "--remote-port",
          "8787",
          "--remote-tls-port",
          "8788",
        ],
        "/home/test",
      ).remote,
    ).toMatchObject({ port: 8787, tlsPort: 8788 });
    expect(() =>
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "direct",
          "--remote-address",
          "100.64.0.1",
          "--remote-port",
          "8788",
          "--remote-tls-port",
          "8788",
        ],
        "/home/test",
      ),
    ).toThrow("must differ");
    expect(() =>
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "serve",
          "--remote-address",
          "127.0.0.1",
          "--trusted-serve-proxy",
          "--remote-tls-port",
          "8788",
        ],
        "/home/test",
      ),
    ).toThrow("direct-mode only");
    expect(() =>
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "direct",
          "--remote-address",
          "100.64.0.1",
          "--remote-origin",
          "https://example.com/path",
        ],
        "/home/test",
      ),
    ).toThrow("HTTP origin");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--omp-authority", "official"],
        "/home/test",
      ),
    ).toThrow("--omp-sessions-root");
    expect(
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--omp-authority",
          "official",
          "--omp-sessions-root",
          "/home/test/.omp/t4/sessions",
          "--profile",
          "t4",
        ],
        "/home/test",
      ),
    ).toMatchObject({
      authorityMode: "official",
      ompSessionsRoot: "/home/test/.omp/t4/sessions",
      profileId: "t4",
    });
  });
  // Seeding writes disposable sessions into whatever profile the daemon serves
  // and deletes them later, so an accidental enable on a real profile or a
  // remote listener would be destructive rather than merely noisy.
  test("test control stays off by default and refuses unsafe enablement", () => {
    const previous = process.env.OMP_APP_TEST_MODE;
    try {
      delete process.env.OMP_APP_TEST_MODE;
      expect(
        parseHostDaemonArgs(["serve", "--omp", "/opt/omp", "--profile", "t4"], "/home/test").testControl,
      ).toBeUndefined();
      expect(() =>
        parseHostDaemonArgs(["serve", "--omp", "/opt/omp", "--profile", "t4", "--test-control"], "/home/test"),
      ).toThrow("OMP_APP_TEST_MODE");
      process.env.OMP_APP_TEST_MODE = "1";
      expect(() =>
        parseHostDaemonArgs(["serve", "--omp", "/opt/omp", "--profile", "default", "--test-control"], "/home/test"),
      ).toThrow("default profile");
      expect(() =>
        parseHostDaemonArgs(
          [
            "serve",
            "--omp",
            "/opt/omp",
            "--profile",
            "t4",
            "--test-control",
            "--remote-mode",
            "direct",
            "--remote-address",
            "100.64.0.1",
          ],
          "/home/test",
        ),
      ).toThrow("local-only");
      const config = parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--profile", "t4", "--test-control"],
        "/home/test",
      );
      expect(config.testControl).toBe(true);
      expect(hostDaemonPaths(config).testControlManifestPath).toContain("/test-control-manifest.json");
    } finally {
      if (previous === undefined) delete process.env.OMP_APP_TEST_MODE;
      else process.env.OMP_APP_TEST_MODE = previous;
    }
  });

  test("stops the OMP bridge when authority startup fails", async () => {
    let bridgeStops = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({ hostInfo: async () => { throw new Error("host info failed"); } }),
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        { createBridge: () => bridge as never },
      ),
    ).rejects.toThrow("host info failed");
    expect(bridgeStops).toBe(1);
  });

  test("closes the search index when appserver construction fails", async () => {
    let bridgeStops = 0;
    let searchCloses = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        {
          createBridge: () => bridge as never,
          createTranscriptSearch: () => ({ close: async () => { searchCloses += 1; } }) as never,
          createLocal: () => { throw new Error("appserver construction failed"); },
        },
      ),
    ).rejects.toThrow("appserver construction failed");
    expect(searchCloses).toBe(1);
    expect(bridgeStops).toBe(1);
  });

  test("serves working-tree diffs locally and reserves the bridge for turn snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-host-files-diff-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    for (const args of [
      ["init"],
      ["add", "."],
      ["-c", "user.name=T4 Test", "-c", "user.email=t4@example.invalid", "commit", "-m", "base"],
    ]) {
      const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
      if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    }
    let bridgeDiffCalls = 0;
    let captured: Record<string, unknown> | undefined;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {
          filesDiff: async () => {
            bridgeDiffCalls += 1;
            return { diff: "bridge turn snapshot" };
          },
        },
        projectRootForProject: async () => root,
        projectRootForSession: async () => root,
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => {},
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        {
          createBridge: () => bridge as never,
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: options => {
            captured = options as unknown as Record<string, unknown>;
            throw new Error("captured operations");
          },
        },
      ),
    ).rejects.toThrow("captured operations");
    const filesDiff = (
      captured?.operationsAuthority as {
        filesDiff?: (
          args: Record<string, unknown>,
          context: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    )?.filesDiff;
    if (!filesDiff) throw new Error("files.diff operation missing");
    const context = {
      hostId: "host-test",
      sessionId: "session-test",
      deviceId: "device-test",
      connectionId: "connection-test",
      capabilities: new Set(["files.diff"]),
      abortSignal: new AbortController().signal,
    };
    expect(await filesDiff({}, context)).toEqual({ diff: "" });
    expect(bridgeDiffCalls).toBe(0);
    expect(await filesDiff({ turnId: "turn-test" }, context)).toEqual({
      diff: "bridge turn snapshot",
    });
    expect(bridgeDiffCalls).toBe(1);
  });

  test("pins and reports the exact official OMP runtime before exposing official authority", async () => {
    let authorityCloses = 0;
    let captured: Record<string, unknown> | undefined;
    const authority = {
      initialize: async () => {},
      close: async () => { authorityCloses += 1; },
      projectRootForProject: async () => "/tmp",
      projectRootForSession: async () => "/tmp",
      lockCheck: async () => {},
      lockStatus: () => "missing",
      list: async () => [],
    };
    await expect(
      runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          authorityMode: "official",
          ompSessionsRoot: "/tmp/t4-official-sessions",
          profileId: "t4",
          stateRoot: "/tmp/t4-official-state",
        },
        {
          verifyOfficialRuntime: async () => ({
            ompVersion: OFFICIAL_OMP_VERSION,
            ompBuild: OFFICIAL_OMP_BUILD,
          }),
          createOfficialAuthority: () => authority as never,
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: options => {
            captured = options as unknown as Record<string, unknown>;
            throw new Error("captured official options");
          },
        },
      ),
    ).rejects.toThrow("captured official options");
    expect(captured).toMatchObject({
      ompVersion: OFFICIAL_OMP_VERSION,
      ompBuild: OFFICIAL_OMP_BUILD,
      rpcDialect: "official-17.0.9",
      claimLocklessSessions: true,
      observerIndependentTerminalOperations: true,
      sessionOwnershipPath: expect.stringContaining("/owned-sessions.json"),
    });
    const operations = captured?.operationsAuthority as {
      catalogGet?: () => Promise<Record<string, unknown>>;
    };
    expect(await operations.catalogGet?.()).toMatchObject({
      revision: `official-omp-${OFFICIAL_OMP_VERSION}`,
    });
    const catalog = await operations.catalogGet?.();
    if (!catalog) throw new Error("official catalog missing");
    const officialItems = catalog.items as Array<{ kind: string; name: string }>;
    const commandNames = officialItems.map(item => item.name);
    expect(officialItems.every(item => item.kind === "command")).toBe(true);
    expect(commandNames).toContain("session.model.set");
    expect(commandNames).toContain("session.release");
    expect(commandNames).toContain("session.reclaim");
    expect(commandNames).not.toContain("session.fast.set");
    expect(commandNames).not.toContain("session.retry");
    expect(authorityCloses).toBe(1);
  });

  test("official runtime probe accepts proven builds and rejects below the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-official-version-"));
    const exact = join(root, "exact-omp");
    const drifted = join(root, "drifted-omp");
    await Promise.all([
      writeFile(exact, `#!/bin/sh\nprintf 'omp/${OFFICIAL_OMP_VERSION}\\n'\n`),
      writeFile(drifted, "#!/bin/sh\nprintf 'omp/17.0.7\\n'\n"),
    ]);
    await Promise.all([chmod(exact, 0o700), chmod(drifted, 0o700)]);
    expect(await verifyOfficialRuntime(exact)).toMatchObject({
      ompVersion: OFFICIAL_OMP_VERSION,
      ompBuild: OFFICIAL_OMP_BUILD,
      dialect: "official-17.0.9",
    });
    await expect(verifyOfficialRuntime(drifted)).rejects.toThrow("outside the supported window");
  });

  test("official runtime probe accepts a newer stock version with an advisory", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-official-newer-"));
    const newer = join(root, "newer-omp");
    await writeFile(newer, "#!/bin/sh\nprintf 'omp/17.2.9\\n'\n");
    await chmod(newer, 0o700);
    const verified = await verifyOfficialRuntime(newer);
    expect(verified).toMatchObject({
      ompVersion: "17.2.9",
      ompBuild: OFFICIAL_OMP_BUILD,
      dialect: "official-17.0.9",
    });
    expect(verified.warning).toContain("17.2.9");
    expect(verified.warning).toContain("gate-proven");
  });

  test("official runtime probe resolves env-shebang runtimes (stock OMP ships as a bun script)", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-official-shebang-"));
    const script = join(root, "omp-script");
    await writeFile(script, "#!/usr/bin/env sh\nprintf 'omp/17.1.3\\n'\n");
    await chmod(script, 0o700);
    const verified = await verifyOfficialRuntime(script);
    expect(verified).toMatchObject({
      ompVersion: "17.1.3",
      dialect: "official-17.0.9",
    });
  });

  test("assessOfficialRuntime tiers stock OMP versions without spawning", () => {
    expect(assessOfficialRuntime(`omp/${OFFICIAL_OMP_VERSION}`)).toEqual({
      decision: "known-good",
      version: OFFICIAL_OMP_VERSION,
      build: OFFICIAL_OMP_BUILD,
      dialect: "official-17.0.9",
    });
    const compatible = assessOfficialRuntime("omp/17.2.9");
    expect(compatible).toMatchObject({
      decision: "compatible",
      version: "17.2.9",
      dialect: "official-17.0.9",
    });
    if (compatible.decision !== "compatible") throw new Error("expected compatible");
    expect(compatible.warning).toContain("official-omp-gate0");
    // Numeric compare: 17.10.0 is newer than 17.0.9 despite "10" < "2" lexically.
    expect(assessOfficialRuntime("omp/17.10.0").decision).toBe("compatible");
    expect(assessOfficialRuntime("omp/16.9.9").decision).toBe("too-old");
    expect(assessOfficialRuntime("omp/18.0.0").decision).toBe("too-old");
    expect(assessOfficialRuntime("omp/17.2.9", true).decision).toBe("unsupported");
    expect(assessOfficialRuntime(`omp/${OFFICIAL_OMP_VERSION}`, true).decision).toBe("known-good");
    expect(assessOfficialRuntime("not-a-version").decision).toBe("unparseable");
    expect(assessOfficialRuntime("").decision).toBe("unparseable");
  });
});
