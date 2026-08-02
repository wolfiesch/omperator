#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OmpAuthorityBridgeClient } from "../src/omp-authority-bridge-client.ts";
import {
  OMP_AUTHORITY_BRIDGE_METHODS,
  OMP_AUTHORITY_BRIDGE_PROTOCOL,
} from "../src/omp-authority-bridge-contract.ts";

interface PortableRuntime {
  readonly sourceCommit: string;
  readonly sourceRepository: string;
  readonly version: string;
  readonly contractCommit: string;
  readonly bridge: {
    readonly protocol: string;
    readonly methods: readonly string[];
    readonly compatibilityStatus: string;
  };
}

function runtime(value: unknown): PortableRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("compatibility matrix portableRuntime is invalid");
  const record = value as Record<string, unknown>;
  for (const key of ["sourceCommit", "sourceRepository", "version", "contractCommit"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0)
      throw new Error(`compatibility matrix portableRuntime.${key} is invalid`);
  }
  if (!record.bridge || typeof record.bridge !== "object" || Array.isArray(record.bridge))
    throw new Error("compatibility matrix portableRuntime.bridge is invalid");
  return record as unknown as PortableRuntime;
}

async function gitHead(sourceRoot: string): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`cannot resolve current OMP source: ${stderr.trim().slice(-1_024)}`);
  return stdout.trim();
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const sourceRoot = process.env.T4_CURRENT_OMP_SOURCE_DIR;
  if (!sourceRoot) throw new Error("set T4_CURRENT_OMP_SOURCE_DIR to the current OMP source checkout");
  const exactSourceRoot = resolve(repoRoot, sourceRoot);
  const matrix = JSON.parse(await readFile(join(repoRoot, "compat", "omp-app-matrix.json"), "utf8")) as {
    portableRuntime?: unknown;
  };
  const expected = runtime(matrix.portableRuntime);
  if (expected.sourceRepository !== "https://github.com/wolfiesch/oh-my-pi")
    throw new Error("portable runtime repository is not the owned OMP fork");
  if (expected.contractCommit !== "d16c6168c86f40fc44f25118c2fd06fe160fcb93")
    throw new Error("portable runtime does not record the reviewed OMP contract ancestry");
  if ((await gitHead(exactSourceRoot)) !== expected.sourceCommit)
    throw new Error("checked-out current OMP source does not match portableRuntime.sourceCommit");
  const cli = join(exactSourceRoot, "packages", "coding-agent", "src", "cli.ts");
  if (!(await stat(cli)).isFile()) throw new Error("current OMP CLI source is missing");

  const root = await mkdtemp(join(tmpdir(), "t4-current-omp-bridge-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const forkWorkspace = join(root, "fork-workspace");
  const profile = `current-proof-${Bun.randomUUIDv7().slice(-12)}`;
  const client = new OmpAuthorityBridgeClient({
    executable: process.execPath,
    argv: [cli, "bridge", "--stdio"],
    cwd: exactSourceRoot,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_NOTIFICATIONS: "off",
      OMP_PROFILE: profile,
    },
  });
  try {
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(workspace),
      mkdir(forkWorkspace),
    ]);
    const ready = await client.start();
    if (ready.ompVersion !== expected.version || ready.ompBuild !== "source")
      throw new Error("current OMP bridge identity does not match the portable runtime");
    const advertisedMethods = [...ready.methods].sort();
    const requiredMethods = [...OMP_AUTHORITY_BRIDGE_METHODS].sort();
    if (
      expected.bridge.protocol !== OMP_AUTHORITY_BRIDGE_PROTOCOL ||
      expected.bridge.compatibilityStatus !== "admitted" ||
      JSON.stringify([...expected.bridge.methods].sort()) !== JSON.stringify(requiredMethods) ||
      JSON.stringify(advertisedMethods) !== JSON.stringify(requiredMethods)
    ) {
      throw new Error("current OMP bridge method set does not match the admitted portable contract");
    }

    const authorities = client.createAuthorities();
    const host = await authorities.hostInfo();
    if (!host.transcriptImageRoot.startsWith(home))
      throw new Error("current OMP bridge escaped the disposable profile");
    const initial = await authorities.sessionAuthority.list();
    if (initial.length !== 0 || !authorities.discovery.inventoryComplete?.())
      throw new Error("current OMP bridge did not return one complete disposable inventory");

    await client.flush();
    const created = await authorities.sessionAuthority.create(workspace, "portable-authority-proof");
    const afterCreate = await authorities.sessionAuthority.list();
    const createdRecord = afterCreate.find((session) => session.sessionId === created.sessionId);
    if (!createdRecord)
      throw new Error("created session is absent from the authoritative inventory");
    const fork = authorities.sessionAuthority.fork;
    if (!fork) throw new Error("current OMP bridge did not expose session.fork");
    const forked = await fork(createdRecord, forkWorkspace);
    const afterFork = await authorities.sessionAuthority.list();
    const forkedRecord = afterFork.find((session) => session.sessionId === forked.sessionId);
    if (!forkedRecord)
      throw new Error("forked session is absent from the authoritative inventory");
    await authorities.sessionAuthority.archive(createdRecord, new Date().toISOString());
    await authorities.sessionAuthority.restore(createdRecord);
    await authorities.sessionAuthority.delete(forkedRecord);
    await authorities.sessionAuthority.delete(createdRecord);
    await client.flush();
    const remaining = await authorities.sessionAuthority.list();
    if (remaining.length !== 0)
      throw new Error("real session lifecycle did not return the disposable inventory to empty");
    await client.quiesce();

    const evidence = {
      schemaVersion: 1,
      runtime: {
        repository: expected.sourceRepository,
        commit: expected.sourceCommit,
        contractCommit: expected.contractCommit,
        version: ready.ompVersion,
        build: ready.ompBuild,
      },
      bridge: {
        protocol: OMP_AUTHORITY_BRIDGE_PROTOCOL,
        methods: advertisedMethods,
        completeInventory: true,
      },
      lifecycle: {
        create: true,
        fork: true,
        archive: true,
        restore: true,
        delete: true,
        flush: true,
        quiesce: true,
        finalSessionCount: remaining.length,
      },
      passed: true,
    };
    const evidenceRoot = join(repoRoot, "artifacts", "current-omp-bridge");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `${process.platform}-${process.arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await client.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
