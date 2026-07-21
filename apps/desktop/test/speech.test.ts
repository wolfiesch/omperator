import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import type { ChildProcess, spawn } from "node:child_process";
import { createDesktopSpeechService } from "../src/speech.ts";
class FakeChild extends EventEmitter { pid = undefined; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false; kill(signal?: NodeJS.Signals): boolean { this.killed = true; this.signalCode = signal ?? "SIGTERM"; this.emit("exit", null, this.signalCode); return true; } }
const fakeSpawn = (child: FakeChild, args: (value: string, next: readonly string[], options?: unknown) => void = () => undefined) => ((_: string, next: readonly string[], options?: unknown) => { args(_, next, options); return child as unknown as ChildProcess; }) as typeof spawn;
describe("desktop read-aloud process bridge", () => {
  it("uses a private temp file and keeps text out of argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-speech-test-")); const child = new FakeChild(); let argv: readonly string[] = []; let spawnOptions: unknown; const spawned = Promise.withResolvers<void>();
    const service = createDesktopSpeechService({ discoverExecutable: async () => "/opt/omp", makeTempDirectory: async () => mkdtemp(join(root, "run-")), spawn: fakeSpawn(child, (_, next, options) => { argv = next; spawnOptions = options; spawned.resolve(); }) });
    const speaking = service.speakText({ text: "private sentence" }); await spawned.promise; const file = argv[2] as string;
    expect((spawnOptions as { shell?: boolean }).shell).toBe(false); expect(argv[0]).toBe("say"); expect(argv[1]).toBe("--file"); expect((argv[2] as string).endsWith("/speech.txt")).toBe(true); expect(argv.join(" ")).not.toContain("private sentence"); expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, "utf8")).toBe("private sentence");
    child.emit("exit", 0, null); expect(await speaking).toEqual({ accepted: true }); await expect(stat(file)).rejects.toThrow(); await service.dispose(); await rm(root, { recursive: true, force: true });
  });
  it("replaces and cancels active speech, settling both requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-speech-test-")); const children: FakeChild[] = []; const firstSpawned = Promise.withResolvers<void>(); const secondSpawned = Promise.withResolvers<void>();
    const service = createDesktopSpeechService({ discoverExecutable: async () => "/opt/omp", makeTempDirectory: async () => mkdtemp(join(root, "run-")), spawn: ((_: string, _args: readonly string[]) => { const child = new FakeChild(); children.push(child); (children.length === 1 ? firstSpawned : secondSpawned).resolve(); return child as unknown as ChildProcess; }) as typeof spawn });
    const first = service.speakText({ text: "first" }); await firstSpawned.promise; const second = service.speakText({ text: "second" }); await secondSpawned.promise; expect(children).toHaveLength(2); expect(children[0]?.killed).toBe(true); await service.stopSpeaking(); expect(children[1]?.killed).toBe(true); expect(await first).toMatchObject({ accepted: false }); expect(await second).toMatchObject({ accepted: false }); await service.dispose(); await rm(root, { recursive: true, force: true });
  });
  it("settles and cleans up on process exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-speech-test-")); const child = new FakeChild(); const spawned = Promise.withResolvers<void>(); const service = createDesktopSpeechService({ discoverExecutable: async () => "/opt/omp", makeTempDirectory: async () => mkdtemp(join(root, "run-")), spawn: fakeSpawn(child, () => spawned.resolve()) });
    const speaking = service.speakText({ text: "exit cleanup" }); await spawned.promise; child.emit("exit", 0, null); expect(await speaking).toEqual({ accepted: true }); await service.dispose(); await rm(root, { recursive: true, force: true });
  });
});
