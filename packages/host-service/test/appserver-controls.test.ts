import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@t4-code/host-wire";
import { stableProjectId } from "../src/discovery.ts";
import { createAppserver } from "../src/server.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, DeferredPromptFactory, StatePhaseFactory, SilentSupervisorFactory } from "./appserver-fixtures.ts";

describe("appserver controls and prompt lifecycle", () => {
	test("session.mode.set shapes forwarded prompts, persists, and echoes on the ref", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-session-mode-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			let createCount = 0;
			const sessionAuthority = {
				create: async () => {
					const id = `mode-session-${++createCount}`;
					return {
						...record(id),
						path: join(root, `${id}.jsonl`),
						cwd: root,
						projectId: stableProjectId(root),
					};
				},
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const factory = new DeferredPromptFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "session-mode-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
				projectRootForProject: () => root,
				childFactory: factory,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			const nextResponse = async (requestId: string) => {
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === requestId) return frame;
				}
			};
			const PLAN_PREFIX =
				"[PLAN MODE — you may inspect but MUST NOT modify anything: no file writes, edits, patches, or state-changing commands. Analyze the request, then propose a concrete step-by-step plan and stop.]\n\n";
			const READONLY_PREFIX =
				"[READ-ONLY MODE — answer by inspection only: no writes, edits, patches, builds, or commands of any kind.]\n\n";
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "mode-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
	
				const runPrompt = async (mode: "build" | "plan" | "readOnly"): Promise<string> => {
					const projectRoot = stableProjectId(root);
					const reqCreate = `create-${mode}-${createCount + 1}`;
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: reqCreate,
						commandId: `${reqCreate}-command`,
						hostId: host,
						command: "session.create",
						args: { projectId: projectRoot },
					});
					const createResp = await nextResponse(reqCreate);
					expect(createResp).toMatchObject({ ok: true });
					const sid = sessionId((createResp.result as { session: { sessionId: string } }).session.sessionId);
	
					const reqMode = `mode-${mode}-${createCount}`;
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: reqMode,
						commandId: `${reqMode}-command`,
						hostId: host,
						sessionId: sid,
						command: "session.mode.set",
						args: { mode },
					});
					const modeResp = await nextResponse(reqMode);
					expect(modeResp).toMatchObject({ ok: true, result: { mode } });
					expect(appserver.snapshot(sid)?.ref.mode).toBe(mode === "build" ? undefined : mode);
	
					const reqPrompt = `prompt-${mode}-${createCount}`;
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: reqPrompt,
						commandId: `${reqPrompt}-command`,
						hostId: host,
						sessionId: sid,
						command: "session.prompt",
						args: { message: "hello" },
					});
					const child = factory.children.at(-1);
					if (!child) throw new Error("created session did not start its writer");
					const promptFrame = await child.promptReceived;
					child.replyToPrompt();
					await nextResponse(reqPrompt);
					return promptFrame.message as string;
				};
	
				expect(await runPrompt("plan")).toBe(PLAN_PREFIX + "hello");
				expect(await runPrompt("readOnly")).toBe(READONLY_PREFIX + "hello");
				expect(await runPrompt("build")).toBe("hello");
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("session.state.get surfaces todoPhases reported by the child", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-session-state-phases-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			let createCount = 0;
			const sessionAuthority = {
				create: async () => {
					const id = `state-phase-session-${++createCount}`;
					return {
						...record(id),
						path: join(root, `${id}.jsonl`),
						cwd: root,
						projectId: stableProjectId(root),
					};
				},
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const factory = new StatePhaseFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "session-state-phases-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
				projectRootForProject: () => root,
				childFactory: factory,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			const nextResponse = async (requestId: string) => {
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === requestId) return frame;
				}
			};
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "state-phases-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
	
				const reqCreate = "create-state-phases";
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: reqCreate,
					commandId: `${reqCreate}-command`,
					hostId: host,
					command: "session.create",
					args: { projectId: stableProjectId(root) },
				});
				const createResp = await nextResponse(reqCreate);
				expect(createResp).toMatchObject({ ok: true });
				const createResult = createResp.result;
				if (!createResult || typeof createResult !== "object" || !("session" in createResult))
					throw new Error("session.create result missing session");
				const sessionShape = createResult.session;
				if (!sessionShape || typeof sessionShape !== "object" || !("sessionId" in sessionShape))
					throw new Error("session.create result missing sessionId");
				const sid = sessionId(sessionShape.sessionId);
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "state-phases",
					commandId: "state-phases-command",
					hostId: host,
					sessionId: sid,
					command: "session.state.get",
					args: {},
				});
				const stateResp = await nextResponse("state-phases");
				expect(stateResp).toMatchObject({ type: "response", ok: true });
				const stateResult = stateResp.result;
				if (!stateResult || typeof stateResult !== "object" || !("todoPhases" in stateResult))
					throw new Error("session.state.get result missing todoPhases");
				expect(stateResult.todoPhases).toEqual([
					{
						name: "Research",
						tasks: [
							{ content: "Map the call sites", status: "completed" },
							{ content: "Note the shared helper", status: "in_progress" },
							{ content: "Sketch the contract", status: "pending" },
						],
					},
					{
						name: "Implement",
						tasks: [{ content: "Wire the decoder", status: "custom_status" }],
					},
				]);
	
				// A child that omits todoPhases yields a result without the field.
				const phaseless = factory.children.at(-1);
				if (!phaseless) throw new Error("created session did not start its writer");
				phaseless.todoPhases = undefined;
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "state-no-phases",
					commandId: "state-no-phases-command",
					hostId: host,
					sessionId: sid,
					command: "session.state.get",
					args: {},
				});
				const noPhasesResp = await nextResponse("state-no-phases");
				expect(noPhasesResp).toMatchObject({ type: "response", ok: true });
				const noPhasesResult = noPhasesResp.result;
				expect(
					noPhasesResult && typeof noPhasesResult === "object" && "todoPhases" in noPhasesResult,
				).toBe(false);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("idle-supervisor watchdog SIGKILLs a silent child and releases the wedged prompt lifecycle", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-idle-supervisor-watchdog-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const created = {
				...record("silent-supervisor"),
				path: join(root, "silent-supervisor.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const sessionAuthority = {
				create: async () => created,
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const factory = new SilentSupervisorFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "idle-supervisor-watchdog-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
				projectRootForProject: () => root,
				childFactory: factory,
				idleSupervisorGraceMs: 60,
				idleSupervisorTickMs: 10,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			const nextResponse = async (requestId: string) => {
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === requestId) return frame;
				}
			};
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "watchdog-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-watchdog",
					commandId: "create-watchdog-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				expect(await nextResponse("create-watchdog")).toMatchObject({ ok: true });
				const firstChild = factory.children[0];
				if (!firstChild) throw new Error("created session did not start its writer");
	
				// First prompt: the child accepts (agentInvoked=true) then goes mute,
				// never emitting turn.end. The lifecycle stays pending.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-watchdog-1",
					commandId: "prompt-watchdog-1-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "wedge me" },
				});
				await firstChild.promptReceived;
				expect(await nextResponse("prompt-watchdog-1")).toMatchObject({ ok: true, result: { accepted: true } });
	
				// A second prompt while the first lifecycle is wedged must be busy.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-watchdog-busy",
					commandId: "prompt-watchdog-busy-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "still busy" },
				});
				expect(await nextResponse("prompt-watchdog-busy")).toMatchObject({
					ok: false,
					error: { code: "session_busy" },
				});
	
				// Wait for the watchdog to dispose the silent supervisor: the runtime
				// is marked crashed then restartable (status settles to idle) and the
				// child is SIGKILLed.
				await Promise.race([
					(async () => {
						while (appserver.snapshot(created.sessionId)?.ref.status === "active") await Bun.sleep(5);
					})(),
					Bun.sleep(2_000).then(() => {
						throw new Error("watchdog did not release the wedged session");
					}),
				]);
				expect(firstChild.killed).toBe(true);
	
				// After grace the session accepts a new prompt instead of session_busy.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-watchdog-2",
					commandId: "prompt-watchdog-2-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "after grace" },
				});
				// The host processes the command asynchronously; wait for it to
				// restart the supervisor (spawn a fresh child) and accept the prompt.
				const secondChild = await Promise.race([
					(async () => {
						while (factory.children.at(-1) === undefined || factory.children.at(-1) === firstChild)
							await Bun.sleep(5);
						return factory.children.at(-1)!;
					})(),
					Bun.sleep(2_000).then(() => {
						throw new Error("watchdog did not restart the supervisor");
					}),
				]);
				await secondChild.promptReceived;
				expect(await nextResponse("prompt-watchdog-2")).toMatchObject({ ok: true, result: { accepted: true } });
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("state-refresh reconciliation releases a wedged prompt lifecycle without killing the child", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-state-refresh-reconcile-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const created = {
				...record("reconcile-supervisor"),
				path: join(root, "reconcile-supervisor.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const sessionAuthority = {
				create: async () => created,
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const factory = new SilentSupervisorFactory();
			// A grace window large enough that the watchdog never fires during the
			// test: only the explicit state refresh reconciles the stale lifecycle.
			const appserver = createAppserver({
				hostId: host,
				epoch: "state-refresh-reconcile-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
				projectRootForProject: () => root,
				childFactory: factory,
				idleSupervisorGraceMs: 60,
				idleSupervisorTickMs: 10_000,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			const nextResponse = async (requestId: string) => {
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === requestId) return frame;
				}
			};
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "reconcile-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-reconcile",
					commandId: "create-reconcile-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				expect(await nextResponse("create-reconcile")).toMatchObject({ ok: true });
				const child = factory.children[0];
				if (!child) throw new Error("created session did not start its writer");
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-reconcile-1",
					commandId: "prompt-reconcile-1-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "wedge me" },
				});
				await child.promptReceived;
				expect(await nextResponse("prompt-reconcile-1")).toMatchObject({ ok: true, result: { accepted: true } });
	
				// Before grace, a state refresh sees isStreaming=false but the
				// lifecycle is not yet stale, so it must stay pending (busy).
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "state-before-grace",
					commandId: "state-before-grace-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.state.get",
					args: {},
				});
				expect(await nextResponse("state-before-grace")).toMatchObject({ ok: true });
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-reconcile-busy",
					commandId: "prompt-reconcile-busy-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "still busy" },
				});
				expect(await nextResponse("prompt-reconcile-busy")).toMatchObject({
					ok: false,
					error: { code: "session_busy" },
				});
	
				// After grace, a state refresh reconciles the stale lifecycle: OMP
				// finished (isStreaming=false) so the transient is released honestly
				// and the session settles to idle — without killing the child.
				// Cross the grace window on the real platform clock: the watchdog and
				// lifecycle timestamps use Date.now/setInterval, so deterministic fake
				// timers cannot drive them without rewiring the host clock injection.
				await Bun.sleep(80);
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "state-after-grace",
					commandId: "state-after-grace-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.state.get",
					args: {},
				});
				expect(await nextResponse("state-after-grace")).toMatchObject({ ok: true });
				expect(child.killed).toBe(false);
				await Promise.race([
					(async () => {
						while (appserver.snapshot(created.sessionId)?.ref.status === "active") await Bun.sleep(5);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("reconciliation did not settle the wedged session");
					}),
				]);
	
				// The same child (still alive) now accepts a new prompt.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-reconcile-2",
					commandId: "prompt-reconcile-2-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "after reconcile" },
				});
				await child.promptReceived;
				expect(await nextResponse("prompt-reconcile-2")).toMatchObject({ ok: true, result: { accepted: true } });
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
});
