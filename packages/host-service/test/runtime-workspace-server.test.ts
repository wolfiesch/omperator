import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, type ServerFrame, sessionId } from "@t4-code/host-wire";
import { type RuntimeAdapter, type RuntimeAdapterCallbacks, RuntimeAdapterRegistry } from "../src/runtime-adapter.ts";
import { appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import { WorkspaceAuthority } from "../src/workspace-authority.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("runtime-workspace-test-host");

setDefaultTimeout(30_000);

async function git(cwd: string, ...arguments_: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-C", cwd, ...arguments_], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
}

async function gitOutput(cwd: string, ...arguments_: string[]): Promise<string> {
	const child = Bun.spawn(["git", "-C", cwd, ...arguments_], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
	return stdout.trim();
}

async function runProcess(command: string, arguments_: readonly string[]) {
	const child = Bun.spawn([command, ...arguments_], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function hello(): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "authority-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["runtime.adapters", "workspace.lifecycle"],
		capabilities: { client: ["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control"] },
		savedCursors: [],
	};
}

function command(requestId: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId: requestId,
		hostId: host,
		command: name,
		args,
	};
}

async function response(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) return frame;
	}
}
async function sessionEvent(client: RawUdsWebSocket, type: string): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "event" && frame.event.type === type) return frame.event;
	}
}

async function approveChallenge(
	client: RawUdsWebSocket,
	requestId: string,
	sessionId?: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type !== "confirmation" || frame.commandId !== requestId) continue;
		client.sendJson({
			v: "omp-app/1",
			type: "confirm",
			requestId: `${requestId}-confirm`,
			confirmationId: frame.confirmationId,
			commandId: requestId,
			hostId: host,
			...(sessionId ? { sessionId } : {}),
			decision: "approve",
		});
		return response(client, requestId);
	}
}

async function approveChallengeAndContinue(client: RawUdsWebSocket, requestId: string): Promise<void> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type !== "confirmation" || frame.commandId !== requestId) continue;
		client.sendJson({
			v: "omp-app/1",
			type: "confirm",
			requestId: `${requestId}-confirm`,
			confirmationId: frame.confirmationId,
			commandId: requestId,
			hostId: host,
			decision: "approve",
		});
		return;
	}
}

test("negotiates and serves runtime and workspace authority commands", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-authority-wire-")));
	const workspaceAuthority = await WorkspaceAuthority.open({ databasePath: join(root, "workspaces.sqlite") });
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, "init", "-q");
	await git(repository, "config", "user.email", "test@example.invalid");
	await git(repository, "config", "user.name", "Runtime Workspace Test");
	await writeFile(join(repository, "README.md"), "fixture\n");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "-qm", "fixture");
	const rootWorkspace = await workspaceAuthority.import({
		repositoryId: "project-wire",
		repositoryPath: repository,
		workspacePath: repository,
		ownership: "repository-root",
	});
	const importedPath = join(root, "imported-workspace");
	await git(repository, "worktree", "add", "-b", "external/imported", importedPath, "HEAD");
	const importedWorkspace = await workspaceAuthority.import({
		repositoryId: "project-wire",
		repositoryPath: repository,
		workspacePath: importedPath,
		ownership: "imported-user",
	});
	const runtimes = new RuntimeAdapterRegistry({
		executableAvailable: executable => {
			if (executable === "broken-runtime") throw new Error("probe failed");
			return true;
		},
	});
	const adapter: RuntimeAdapter = {
		manifest: {
			id: "test-runtime",
			displayName: "Test Runtime",
			command: { executable: "test-runtime", arguments: [] },
			capabilities: { prompt: "native" },
		},
		openSession: async () => {
			throw new Error("not used by discovery commands");
		},
	};
	runtimes.register(adapter);
	runtimes.register({
		...adapter,
		manifest: { ...adapter.manifest, id: "broken-runtime", command: { executable: "broken-runtime", arguments: [] } },
	});
	expect(appserverSupportedFeatures({ workspaceAuthority })).not.toContain("workspace.lifecycle");
	const appserver = createAppserver({
		hostId: host,
		epoch: "authority-wire-test",
		socketPath: join(root, "run", "app.sock"),
		runtimeAdapters: runtimes,
		workspaceAuthority,
		projectRootForProject: () => repository,
		workspaceTargetPathForProject: (_projectId, name) => join(root, name),
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson(hello());
		const welcome = await client.nextServer();
		expect(welcome).toMatchObject({
			type: "welcome",
			grantedFeatures: expect.arrayContaining(["runtime.adapters", "workspace.lifecycle"]),
		});
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson(command("runtime-list", "runtime.list"));
		expect(await response(client, "runtime-list")).toMatchObject({
			ok: true,
			result: {
				runtimes: [
					{
						id: "test-runtime",
						availability: { state: "available" },
					},
					{
						id: "broken-runtime",
						availability: { state: "unknown" },
					},
				],
			},
		});

		client.sendJson(command("workspace-list", "workspace.list"));
		const workspaceList = await response(client, "workspace-list");
		const workspaceResult = workspaceList.result;
		if (
			!workspaceResult ||
			typeof workspaceResult !== "object" ||
			!("workspaces" in workspaceResult) ||
			!Array.isArray(workspaceResult.workspaces)
		)
			throw new Error("workspace list result is invalid");
		const workspaces = workspaceResult.workspaces;
		expect(workspaces).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ repositoryId: "project-wire", ownership: "repository-root" }),
				expect.objectContaining({ repositoryId: "project-wire", ownership: "imported-user" }),
			]),
		);
		const projectedWorkspace = workspaces[0]!;
		expect(projectedWorkspace).not.toHaveProperty("repositoryRoot");
		expect(projectedWorkspace).not.toHaveProperty("canonicalPath");
		expect(projectedWorkspace).not.toHaveProperty("recoveryDiagnostic");
		await writeFile(join(repository, "advanced.txt"), "would seal if unprotected\n");
		await git(repository, "add", "advanced.txt");
		await git(repository, "commit", "-qm", "advance protected workspace");
		client.sendJson(command("archive-protected", "workspace.archive", { instanceId: rootWorkspace.instanceId }));
		expect(await approveChallenge(client, "archive-protected")).toMatchObject({
			ok: false,
			error: { code: "repository-root-protected" },
		});
		expect(workspaceAuthority.get(rootWorkspace.instanceId)?.expectedHead).toBe(rootWorkspace.expectedHead);
		await writeFile(join(importedPath, "advanced.txt"), "would seal if imported\n");
		await git(importedPath, "add", "advanced.txt");
		await git(importedPath, "commit", "-qm", "advance imported workspace");
		client.sendJson(command("archive-imported", "workspace.archive", { instanceId: importedWorkspace.instanceId }));
		expect(await approveChallenge(client, "archive-imported")).toMatchObject({
			ok: false,
			error: { code: "ownership-protected" },
		});
		expect(workspaceAuthority.get(importedWorkspace.instanceId)?.expectedHead).toBe(importedWorkspace.expectedHead);

		client.sendJson(command("workspace-recover", "workspace.recover"));
		expect(await response(client, "workspace-recover")).toMatchObject({ ok: true, result: { workspaces: [] } });
	} finally {
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		workspaceAuthority.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("runs owner initialization only after exclusive appserver ownership", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-owner-initialization-")));
	const socketPath = join(root, "run", "app.sock");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let competingHookRan = false;
	const owner = createAppserver({
		hostId: host,
		epoch: "owner-initialization-test",
		socketPath,
		onOwnerAcquired: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const competing = createAppserver({
		hostId: host,
		epoch: "competing-owner-test",
		socketPath,
		onOwnerAcquired: () => {
			competingHookRan = true;
		},
	});
	try {
		const ownerStart = owner.start();
		await entered.promise;
		await expect(competing.start()).rejects.toThrow("another owner");
		expect(competingHookRan).toBeFalse();
		release.resolve();
		await ownerStart;
	} finally {
		release.resolve();
		await competing.stop();
		await owner.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("routes an external runtime session through appserver-owned workspace identity", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-external-runtime-wire-")));
	const archiveEntered = Promise.withResolvers<void>();
	const archiveRelease = Promise.withResolvers<void>();
	let holdArchive = false;
	const workspaceAuthority = await WorkspaceAuthority.open({
		databasePath: join(root, "workspaces.sqlite"),
		process: {
			async run(command, arguments_) {
				if (holdArchive && command === "git" && arguments_.includes("status")) {
					archiveEntered.resolve();
					await archiveRelease.promise;
				}
				return runProcess(command, arguments_);
			},
		},
	});
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, "init", "-q");
	await git(repository, "config", "user.email", "test@example.invalid");
	await git(repository, "config", "user.name", "Runtime Ownership Test");
	await writeFile(join(repository, "README.md"), "fixture\n");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "-qm", "fixture");
	const workspace = await workspaceAuthority.create({
		repositoryId: "project-external",
		repositoryPath: repository,
		targetPath: join(root, "external-workspace"),
		branch: "agent/external-runtime",
		sourceCommit: await gitOutput(repository, "rev-parse", "HEAD"),
	});
	const promptEntered = Promise.withResolvers<void>();
	const promptRelease = Promise.withResolvers<void>();
	const openingEntered = Promise.withResolvers<void>();
	const openingRelease = Promise.withResolvers<void>();
	const permissionEntered = Promise.withResolvers<void>();
	let permissionSelection: unknown;
	let promptCount = 0;
	let callbacks: RuntimeAdapterCallbacks | undefined;
	let openings = 0;
	let openedCwd: string | undefined;
	let prompted: string | undefined;
	let cancelled = 0;
	let disposed = 0;
	const runtimes = new RuntimeAdapterRegistry({ executableAvailable: () => true });
	runtimes.register({
		manifest: {
			id: "test-runtime",
			displayName: "Test Runtime",
			command: { executable: "test-runtime", arguments: [] },
			capabilities: { prompt: "native", cancel: "native" },
		},
		async openSession(request) {
			openings++;
			callbacks = request.callbacks;
			openedCwd = request.workspace.cwd;
			openingEntered.resolve();
			await openingRelease.promise;
			return {
				adapterId: "test-runtime",
				sessionId: "provider-private-session",
				workspace: request.workspace,
				async prompt(text) {
					promptCount += 1;
					prompted = text;
					if (promptCount === 1) {
						promptEntered.resolve();
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: "external response" },
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: " complete" },
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "tool_call",
								toolCallId: "provider-tool-id",
								title: "Run command",
								kind: "execute",
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: "provider-tool-id",
								status: "completed",
							},
						});
						await promptRelease.promise;
					} else {
						permissionEntered.resolve();
						permissionSelection = await callbacks?.onPermissionRequest?.({
							sessionId: "provider-private-session",
							toolCall: { toolCallId: "provider-tool-id", title: "Run command" },
							options: [
								{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
								{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
							],
						});
					}
					return { stopReason: "end_turn" };
				},
				async cancel() {
					cancelled += 1;
				},
				async dispose() {
					disposed += 1;
				},
			};
		},
	});
	const appserver = createAppserver({
		hostId: host,
		epoch: "external-runtime-test",
		socketPath: join(root, "run", "app.sock"),
		runtimeAdapters: runtimes,
		workspaceAuthority,
		projectRootForProject: () => repository,
		workspaceTargetPathForProject: (_projectId, name) => join(root, name),
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson(hello());
		expect((await client.nextServer()).type).toBe("welcome");
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson(
			command("create-external", "session.create", {
				projectId: "project-external",
				runtimeId: "test-runtime",
				workspaceInstanceId: workspace.instanceId,
				title: "External session",
			}),
		);
		await openingEntered.promise;
		client.sendJson(command("archive-during-open", "workspace.archive", { instanceId: workspace.instanceId }));
		expect(await approveChallenge(client, "archive-during-open")).toMatchObject({
			ok: false,
			error: { code: "mutation-in-progress" },
		});
		openingRelease.resolve();
		const created = await response(client, "create-external");
		expect(created).toMatchObject({
			ok: true,
			result: {
				session: {
					project: { projectId: "project-external" },
					runtime: { id: "test-runtime", workspaceInstanceId: workspace.instanceId },
				},
			},
		});
		expect(JSON.stringify(created)).not.toContain(repository);
		expect(openedCwd).toBe(workspace.canonicalPath);
		const publicSessionId = (created.result as { session: { sessionId: string } }).session.sessionId;
		client.sendJson(command("archive-live-runtime", "workspace.archive", { instanceId: workspace.instanceId }));
		expect(await approveChallenge(client, "archive-live-runtime")).toMatchObject({
			ok: false,
			error: { code: "mutation-in-progress" },
		});
		const sessionCommand = (requestId: string, name: string, args: Record<string, unknown> = {}) => ({
			...command(requestId, name, args),
			sessionId: publicSessionId,
		});

		client.sendJson(sessionCommand("state-external", "session.state.get"));
		expect(await response(client, "state-external")).toMatchObject({ ok: false, error: { code: "unsupported" } });
		client.sendJson(sessionCommand("attach-external", "session.attach"));
		expect(await response(client, "attach-external")).toMatchObject({ ok: true, result: { attached: true } });

		client.sendJson(sessionCommand("prompt-external", "session.prompt", { message: "run externally" }));
		await promptEntered.promise;
		expect(prompted).toBe("run externally");
		expect(await sessionEvent(client, "tool.result")).toMatchObject({ ok: true, result: { status: "completed" } });
		client.sendJson(sessionCommand("cancel-external", "session.cancel"));
		expect(await approveChallenge(client, "cancel-external", publicSessionId)).toMatchObject({
			ok: true,
			result: { cancelled: true },
		});
		expect(cancelled).toBe(1);
		client.sendJson(sessionCommand("prompt-before-cancel-settles", "session.prompt", { message: "too soon" }));
		expect(await response(client, "prompt-before-cancel-settles")).toMatchObject({
			ok: false,
			error: { code: "session_busy" },
		});
		promptRelease.resolve();
		expect(await response(client, "prompt-external")).toMatchObject({ ok: true, result: { accepted: true } });

		client.sendJson(sessionCommand("prompt-permission", "session.prompt", { message: "ask permission" }));
		await permissionEntered.promise;
		const pendingSnapshot = appserver.snapshot(sessionId(publicSessionId));
		const permissionId = pendingSnapshot?.ref.attention?.pending[0]?.id;
		expect(permissionId?.startsWith("acp-permission-")).toBeTrue();
		expect(JSON.stringify(pendingSnapshot?.ref.attention)).not.toContain("provider-tool-id");
		client.sendJson(
			sessionCommand("approve-permission", "session.ui.respond", { requestId: permissionId, confirmed: true }),
		);
		expect(await response(client, "approve-permission")).toMatchObject({ ok: true, result: { accepted: true } });
		expect(await response(client, "prompt-permission")).toMatchObject({ ok: true, result: { accepted: true } });
		expect(permissionSelection).toEqual({ outcome: "selected", optionId: "allow-once" });

		const snapshot = appserver.snapshot(sessionId(publicSessionId));
		expect(JSON.stringify(snapshot)).not.toContain("provider-private-session");
		expect(JSON.stringify(snapshot)).not.toContain("provider-tool-id");
		expect(snapshot?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "message", data: { role: "user", text: "run externally" } }),
				expect.objectContaining({
					kind: "message",
					data: { role: "assistant", text: "external response complete" },
				}),
			]),
		);
		const toolEntries = snapshot?.entries.filter(entry => entry.kind === "tool-use") ?? [];
		expect(toolEntries).toHaveLength(1);
		expect(toolEntries[0]?.data).toMatchObject({ tool: "execute", title: "Run command", status: "completed" });
		expect(toolEntries[0]?.data.toolCallId).not.toBe("provider-tool-id");

		client.sendJson({
			...sessionCommand("close-external", "session.close"),
			expectedRevision: snapshot!.revision,
		});
		expect(await approveChallenge(client, "close-external", publicSessionId)).toMatchObject({
			ok: true,
			result: { closed: true },
		});
		expect(disposed).toBe(1);
		await writeFile(join(workspace.canonicalPath, "fast-forward.txt"), "sealed before archive\n");
		await git(workspace.canonicalPath, "add", "fast-forward.txt");
		await git(workspace.canonicalPath, "commit", "-qm", "fast forward");
		holdArchive = true;
		client.sendJson(command("archive-quiescent-runtime", "workspace.archive", { instanceId: workspace.instanceId }));
		await approveChallengeAndContinue(client, "archive-quiescent-runtime");
		await archiveEntered.promise;
		client.sendJson(
			command("create-during-archive", "session.create", {
				projectId: "project-external",
				runtimeId: "test-runtime",
				workspaceInstanceId: workspace.instanceId,
				title: "Rejected while archiving",
			}),
		);
		expect(await response(client, "create-during-archive")).toMatchObject({ ok: false });
		expect(openings).toBe(1);
		archiveRelease.resolve();
		expect(await response(client, "archive-quiescent-runtime")).toMatchObject({
			ok: true,
			result: { workspace: { instanceId: workspace.instanceId, lifecycle: "archived" } },
		});
	} finally {
		promptRelease.resolve();
		openingRelease.resolve();
		archiveRelease.resolve();
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		workspaceAuthority.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("local clients execute challenge commands without a confirmation round trip", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "t4-challenge-local-")));
	const openedTerminal = crypto.randomUUID();
	const appserver = createAppserver({
		hostId: host,
		epoch: "challenge-local-test",
		socketPath: join(root, "run", "app.sock"),
		discovery: {
			async list() {
				return [
					{
						sessionId: sessionId("session-local"),
						path: "/tmp/session-local.jsonl",
						cwd: "/tmp",
						projectId: "project-local" as never,
						title: "session-local",
						updatedAt: "2026-01-01T00:00:00.000Z",
						status: "idle",
						entries: [],
					},
				];
			},
		},
		operationsAuthority: {
			termOpen: async () => ({ terminalId: openedTerminal }),
			terminalInput: async () => undefined,
			terminalResize: async () => undefined,
			terminalClose: async () => undefined,
		},
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson({ ...hello(), capabilities: { client: ["term.open"] } });
		await client.nextServer(); // welcome
		client.sendJson({
			...command("term-open-1", "term.open", { cols: 80, rows: 24 }),
			sessionId: "session-local",
		});
		// Same-machine Unix-socket clients bypass the remote confirmation
		// challenge, so routine local terminal opens execute immediately.
		expect(await response(client, "term-open-1")).toMatchObject({
			ok: true,
			result: { terminalId: openedTerminal },
		});
	} finally {
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		await rm(root, { recursive: true, force: true });
	}
});
