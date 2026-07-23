import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostDaemonPaths,
  OFFICIAL_OMP_BUILD,
  OFFICIAL_OMP_VERSION,
  parseHostDaemonArgs,
  runHostDaemon,
  verifyOfficialRuntime,
} from "../src/cli.ts";

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
    expect(commandNames).not.toContain("session.fast.set");
    expect(commandNames).not.toContain("session.retry");
    expect(authorityCloses).toBe(1);
  });

  test("official runtime probe fails closed on version drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-official-version-"));
    const exact = join(root, "exact-omp");
    const drifted = join(root, "drifted-omp");
    await Promise.all([
      writeFile(exact, `#!/bin/sh\nprintf 'omp/${OFFICIAL_OMP_VERSION}\\n'\n`),
      writeFile(drifted, "#!/bin/sh\nprintf 'omp/17.0.7\\n'\n"),
    ]);
    await Promise.all([chmod(exact, 0o700), chmod(drifted, 0o700)]);
    expect(await verifyOfficialRuntime(exact)).toEqual({
      ompVersion: OFFICIAL_OMP_VERSION,
      ompBuild: OFFICIAL_OMP_BUILD,
    });
    await expect(verifyOfficialRuntime(drifted)).rejects.toThrow(`omp/${OFFICIAL_OMP_VERSION}`);
  });
});
