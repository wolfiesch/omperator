import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEndpointOnlyProfileDifference,
  createPortableClientProfile,
  importPortableState,
  portableDeploymentStatus,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("local and single-host deployment contracts", () => {
  test("rejects false HA advertising while preserving the one OMP authority", () => {
    expect(portableDeploymentStatus("local")).toEqual({
      mode: "local",
      highAvailability: { gateway: false, runtime: false },
      writableOmpAuthoritiesPerRuntime: 1,
    });
    expect(portableDeploymentStatus("single-host")).toEqual({
      mode: "single-host",
      highAvailability: { gateway: false, runtime: false },
      writableOmpAuthoritiesPerRuntime: 1,
    });
    expect(() => portableDeploymentStatus("single-host", { gateway: true })).toThrow(/cannot advertise high availability/);
  });

  test("allows only endpoint and identity differences between local and remote profiles", () => {
    const local = createPortableClientProfile({
      profileId: "local",
      identity: { kind: "local-peer", principalId: "local-user" },
      endpoints: {
        restBaseUrl: "http://127.0.0.1:8787/v1",
        providerWebSocketUrl: "ws://127.0.0.1:8787/v1/provider/control",
        cmuxWebSocketTemplate: "ws://127.0.0.1:8787/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "ws://127.0.0.1:8787/v1/ws",
      },
    });
    const remote = createPortableClientProfile({
      profileId: "remote",
      identity: { kind: "bearer", principalId: "remote-user" },
      endpoints: {
        restBaseUrl: "https://host.example.test/v1",
        providerWebSocketUrl: "wss://host.example.test/v1/provider/control",
        cmuxWebSocketTemplate: "wss://host.example.test/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "wss://host.example.test/v1/ws",
      },
    });
    expect(() => assertEndpointOnlyProfileDifference(local, remote)).not.toThrow();
    expect(local.protocols).toEqual(remote.protocols);
    expect(local.resources).toEqual(remote.resources);
  });
});

describe("copy-on-import", () => {
  test("copies OMP and cmux state without changing the originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-import-"));
    roots.push(root);
    const omp = join(root, "source-omp");
    const cmux = join(root, "source-cmux");
    const destination = join(root, "owned");
    await Promise.all([mkdir(omp), mkdir(cmux), mkdir(destination)]);
    await writeFile(join(omp, "session.jsonl"), "original omp\n", { mode: 0o600 });
    await writeFile(join(cmux, "state.json"), "{\"original\":true}\n", { mode: 0o600 });
    const before = await Promise.all([
      readFile(join(omp, "session.jsonl"), "utf8"),
      readFile(join(cmux, "state.json"), "utf8"),
      stat(join(omp, "session.jsonl")),
      stat(join(cmux, "state.json")),
    ]);

    const imported = await importPortableState({ importId: "existing-state", destinationRoot: destination, sources: { omp, cmux } });

    expect(await readFile(join(imported.destination, "omp/session.jsonl"), "utf8")).toBe("original omp\n");
    expect(await readFile(join(imported.destination, "cmux/state.json"), "utf8")).toBe("{\"original\":true}\n");
    expect(await readFile(join(omp, "session.jsonl"), "utf8")).toBe(before[0]);
    expect(await readFile(join(cmux, "state.json"), "utf8")).toBe(before[1]);
    expect((await stat(join(omp, "session.jsonl"))).ino).toBe(before[2].ino);
    expect((await stat(join(cmux, "state.json"))).ino).toBe(before[3].ino);
  });

  test("resumes a matching partial import without overwriting copied files", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-import-resume-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "owned");
    const partial = join(destination, "imports/resume.partial");
    await mkdir(source);
    await mkdir(join(partial, "omp"), { recursive: true });
    await writeFile(join(source, "state"), "stable\n");
    await writeFile(join(partial, "omp/state"), "stable\n");
    await writeFile(join(partial, "import.json"), `${JSON.stringify({ version: 1, importId: "resume", sources: { omp: source }, state: "copying", copiedFiles: 0, reusedFiles: 0 })}\n`);

    const imported = await importPortableState({ importId: "resume", destinationRoot: destination, sources: { omp: source } });

    expect(imported.reusedFiles).toBe(1);
    expect(await readFile(join(imported.destination, "omp/state"), "utf8")).toBe("stable\n");
  });
});
