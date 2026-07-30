#!/usr/bin/env bun
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import {
	OmpAuthorityBridgeClient,
	TranscriptSearchIndex,
	appserverSupportedCapabilities,
	appserverSupportedFeatures,
	createAppserver,
	type AppserverHandle,
} from "@t4-code/host-service";
import { hostId } from "@t4-code/host-wire";
import { ClusterInternalRemotePolicy, sessionHostConfigFromEnv, type SessionHostConfig } from "./session-host-policy.ts";
import { removeTerminalAttachIdentity, writeTerminalAttachIdentity } from "./terminal-attach-identity.ts";
import { startTerminalAttachBroker, type TerminalAttachBrokerHandle } from "./terminal-attach-broker.ts";
import { createBrowserPreviewOperations, mergeBrowserPreviewOperations, type BrowserPreviewAuthority } from "./browser-preview-authority.ts";
import { SessionCredentialClient } from "./session-credential-client.ts";
import { startSessionAuthorityHealth, type SessionAuthorityHealthHandle } from "./session-authority-health.ts";

const OMP_VERSION = "17.1.2";
const OMP_COMMIT = "b86f6116e6223ebb2d747748dc1dc14ddcb35428";

async function durableSyncTree(path: string): Promise<void> {
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) throw new Error("durable state contains a symbolic link");
	if (stat.isFile()) {
		const handle = await open(path, "r");
		try { await handle.sync(); }
		finally { await handle.close(); }
		return;
	}
	if (!stat.isDirectory()) throw new Error("durable state contains an unsupported file");
	for (const entry of await readdir(path)) await durableSyncTree(join(path, entry));
	const handle = await open(path, "r");
	try { await handle.sync(); }
	finally { await handle.close(); }
}

async function checkpointCmux(socketPath: string, sessionName: string): Promise<void> {
	const child = Bun.spawn(["/usr/local/bin/cmux-tui", "identify", "--socket", socketPath, "--json"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const output = await new Response(child.stdout).text();
	if (await child.exited !== 0 || Buffer.byteLength(output) > 16_384) throw new Error("cmux checkpoint barrier failed");
	let identity: Record<string, unknown>;
	try { identity = JSON.parse(output) as Record<string, unknown>; }
	catch { throw new Error("cmux checkpoint barrier returned invalid JSON"); }
	if (identity.protocol !== 10 || identity.session !== sessionName || !Number.isSafeInteger(identity.pid))
		throw new Error("cmux checkpoint barrier identity mismatch");
}

async function quiesceCmux(socketPath: string, generation: string): Promise<void> {
	const response = await new Promise<string>((resolve, reject) => {
		const socket = createConnection(socketPath);
		const chunks: Buffer[] = [];
		let bytes = 0;
		socket.setTimeout(5_000, () => socket.destroy(new Error("cmux quiesce timed out")));
		socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, command: "quiesce", generation })}\n`));
		socket.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1_024) socket.destroy(new Error("cmux quiesce response exceeds size bound"));
			else chunks.push(chunk);
		});
		socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		socket.once("error", reject);
	});
	let acknowledgement: Record<string, unknown>;
	try { acknowledgement = JSON.parse(response) as Record<string, unknown>; }
	catch { throw new Error("cmux quiesce response is invalid"); }
	if (Object.keys(acknowledgement).sort().join(",") !== "generation,ok,v" ||
		acknowledgement.v !== 1 || acknowledgement.ok !== true || acknowledgement.generation !== generation)
		throw new Error("cmux quiesce was not acknowledged");
}

export async function runSessionHost(
	config: SessionHostConfig,
	registerSignal: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void = (signal, listener) => process.on(signal, listener),
): Promise<void> {
	const home = join(config.stateRoot, "home");
	const runtime = config.runtimeRoot;
	await Promise.all([
		mkdir(home, { recursive: true, mode: 0o700 }),
		mkdir(runtime, { recursive: true, mode: 0o770 }),
		mkdir(config.privateRuntimeRoot, { recursive: true, mode: 0o700 }),
	]);
	await unlink(config.readyPath).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
	const credential = await SessionCredentialClient.connect(config.credentialBrokerSocket);
	const bridge = new OmpAuthorityBridgeClient({
		executable: config.ompExecutable,
		cwd: config.workspaceRoot,
		environment: {
			OMP_PROFILE: config.sessionName,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_RUNTIME_DIR: runtime,
		},
	});
	const ready = await bridge.start();
	if (ready.ompVersion !== OMP_VERSION || ready.ompBuild !== OMP_COMMIT) {
		await bridge.stop();
		throw new Error("session pod OMP authority identity does not match the pinned release");
	}
	let appserver: AppserverHandle | undefined;
	let attachBroker: TerminalAttachBrokerHandle | undefined;
	let browserAuthority: BrowserPreviewAuthority | undefined;
	let readyPublished = false;
	let attachIdentityPublished = false;
	let heartbeat: NodeJS.Timeout | undefined;
	let authorityHealth: SessionAuthorityHealthHandle | undefined;
	let activityServer: Bun.Server<undefined> | undefined;
	const activitySocketPath = join(dirname(config.credentialBrokerSocket), "activity.sock");

	const search = new TranscriptSearchIndex(join(config.stateRoot, "transcript-search.sqlite"));
	try {
		const authorities = bridge.createAuthorities();
		const existing = await authorities.sessionAuthority.list();
		if (existing.length > 1) throw new Error("session pod contains more than one authoritative OMP session");
		const authoritativeSession = existing[0] ?? await authorities.sessionAuthority.create(config.workspaceRoot, config.sessionName);
		const hostInfo = await authorities.hostInfo();
		const runtimeHostId = hostId(`pod:${config.sessionName}`);
		const credentialIdentity = await credential.register(config.generation, String(runtimeHostId), String(authoritativeSession.sessionId));
		await credential.acquire();
		heartbeat = setInterval(() => { void credential.heartbeat(config.generation).catch(() => undefined); }, 5_000);
		const browser = createBrowserPreviewOperations(
			config.browserEnabled ? { mode: "durable", stateDirectory: config.browserStateRoot } : { mode: "disabled" },
			{
				hostId: runtimeHostId,
				sessionId: authoritativeSession.sessionId,
				workspaceRoot: config.workspaceRoot,
				cdpEndpoint: "http://127.0.0.1:9222",
			},
		);
		browserAuthority = browser.authority;
		const base = {
			hostId: runtimeHostId,
			epoch: `generation:${config.generation}`,
			socketPath: join(config.privateRuntimeRoot, "appserver.sock"),
			attentionOutcomePath: join(config.stateRoot, "attention-outcomes.json"),
			ompVersion: ready.ompVersion,
			ompBuild: ready.ompBuild,
			appserverVersion: "0.2.1",
			appserverBuild: "cluster-session",
			sessionAuthority: authorities.sessionAuthority,
			discovery: authorities.discovery,
			operationsAuthority: mergeBrowserPreviewOperations(authorities.operationsAuthority, browser.operations),
			...(authorities.usageAuthority ? { usageAuthority: authorities.usageAuthority } : {}),
			transcriptSearchAuthority: search,
			projectRootForProject: authorities.projectRootForProject,
			lockCheck: authorities.lockCheck,
			lockStatus: authorities.lockStatus,
			transcriptImageRoot: hostInfo.transcriptImageRoot,
			rpcChildInvocation: { executable: config.ompExecutable, prefixArgv: [] },
		};
		const policy = new ClusterInternalRemotePolicy({
			reviewer: { review: token => credential.review(token) },
			supportedCapabilities: appserverSupportedCapabilities(base),
			supportedFeatures: appserverSupportedFeatures(base, true),
		});
		const runtimeActivity = () => ({
			keepalive: config.keepalive,
			policy: config.idlePolicy,
			...(attachBroker?.activity() ?? { terminalConnections: 0, terminalLeases: 0 }),
			...(browserAuthority?.activity() ?? { browserPreviews: 0, browserLeases: 0 }),
			gatewayUpstreams: 0,
		});

		const runtimeIngress = {
			beginDrain(_mode: "idle" | "explicit"): void {
				attachBroker?.beginDrain();
				browserAuthority?.beginDrain();
			},
			rollbackDrain(): void {
				attachBroker?.rollbackDrain();
				browserAuthority?.rollbackDrain();
			},
			async quiesce(): Promise<void> {
				await Promise.all([
					attachBroker?.quiesce(),
					browserAuthority?.quiesce(),
					bridge.quiesce(),
					quiesceCmux(join(runtime, "supervisor.sock"), config.generation),
				]);
			},
		};

		appserver = createAppserver({
			...base,
			remoteEndpoint: {
				address: "0.0.0.0",
				port: config.port,
				internalPeerNodeId: "cluster-server",
				originAllowlist: [],
				maxConnections: 8,
				maxFrameBytes: 1_048_576,
				idleTimeoutSeconds: 120,
				backpressureLimit: 1_048_576,
			},
			remotePolicy: policy,
			runtimeIdentity: { uid: config.runtimeUid, generation: config.generation },
			runtimeActivity,
			runtimeIngress,
			durableFlush: async () => {
				const brokerState = await credential.state();
				if (brokerState.generation !== config.generation || !brokerState.registered || !brokerState.fresh || !brokerState.leaseHeld)
					throw new Error("runtime credential authority is not durable");
				await bridge.flush();
				await search.reconcile([authoritativeSession], { pruneMissing: false });
				await search.checkpoint();
				await checkpointCmux(join(runtime, "c.sock"), config.sessionName);
				if (config.browserEnabled) await browserAuthority?.checkpoint();
				for (const path of [
					join(config.stateRoot, "authority"),
					join(config.stateRoot, "cmux"),
					...(config.browserEnabled ? [config.browserStateRoot] : []),
				]) await durableSyncTree(path);
				await durableSyncTree(config.stateRoot);
			},
		});
		const stopped = Promise.withResolvers<void>();
		let stopping = false;
		const stop = (): void => {
			if (stopping) return;
			stopping = true;
			void appserver!.stop().then(stopped.resolve, stopped.reject);
		};
		registerSignal("SIGINT", stop);
		registerSignal("SIGTERM", stop);
		await appserver.start();
		await unlink(activitySocketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		activityServer = Bun.serve({
			unix: activitySocketPath,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method !== "POST" || !["/activity", "/drain", "/quiesce", "/reopen"].includes(url.pathname))
					return new Response("Not Found", { status: 404 });
				const length = Number(request.headers.get("content-length") ?? "0");
				if (!Number.isSafeInteger(length) || length < 2 || length > 1024)
					return new Response("Invalid Request", { status: 400 });
				let body: Record<string, unknown>;
				try { body = await request.json() as Record<string, unknown>; }
				catch { return new Response("Invalid Request", { status: 400 }); }
				if (
					Object.keys(body).sort().join(",") !== "expectedGeneration,expectedRuntimeUid" ||
					typeof body.expectedRuntimeUid !== "string" ||
					typeof body.expectedGeneration !== "string"
				)
					return new Response("Invalid Request", { status: 400 });
				if (url.pathname === "/activity") {
					const snapshot = appserver!.runtimeActivity(body.expectedRuntimeUid, body.expectedGeneration);
					return snapshot ? Response.json(snapshot) : new Response("Forbidden", { status: 403 });
				}
				if (url.pathname === "/reopen")
					return Response.json(await appserver!.reopen(body.expectedRuntimeUid, body.expectedGeneration));
				return Response.json(url.pathname === "/quiesce"
					? await appserver!.quiesce(body.expectedRuntimeUid, body.expectedGeneration)
					: await appserver!.drainIfIdle(body.expectedRuntimeUid, body.expectedGeneration));
			},
		});
		await chmod(activitySocketPath, 0o660);

		authorityHealth = await startSessionAuthorityHealth(join(runtime, "authority-health.sock"), config.generation, credential);
		attachBroker = await startTerminalAttachBroker({
			listenPath: join(runtime, "attach.sock"),
			appserverPath: base.socketPath,
			generation: config.generation,
			hostId: String(runtimeHostId),
			sessionId: String(authoritativeSession.sessionId),
		});
		await writeTerminalAttachIdentity(runtime, {
			runtimeId: config.runtimeId,
			generation: config.generation,
			hostId: String(runtimeHostId),
			sessionId: String(authoritativeSession.sessionId),
		});
		attachIdentityPublished = true;
		const readyFile = await open(config.readyPath, "wx", 0o600);
		try {
			await readyFile.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, generation: config.generation, generationAuthSha256: credentialIdentity.generationAuthSha256 })}\n`);
			await readyFile.sync();
			readyPublished = true;
		} finally {
			await readyFile.close();
		}
		await stopped.promise;
	} finally {
		clearInterval(heartbeat);
		await authorityHealth?.stop().catch(() => undefined);
		await attachBroker?.stop().catch(() => undefined);
		activityServer?.stop(true);
		await unlink(activitySocketPath).catch(() => undefined);
		await appserver?.stop().catch(() => undefined);
		if (attachIdentityPublished) await removeTerminalAttachIdentity(runtime).catch(() => undefined);
		if (readyPublished) await unlink(config.readyPath).catch(() => undefined);
		await Promise.resolve(search.close()).catch(() => undefined);
		await browserAuthority?.close().catch(() => undefined);
		try { await bridge.stop(); }
		finally {
			await credential.release().catch(() => undefined);
			credential.close();
		}
	}
}

async function main(): Promise<void> {
	try { await runSessionHost(sessionHostConfigFromEnv(process.env)); }
	catch (error) {
		process.stderr.write(`${JSON.stringify({ component: "session-host", level: "error", message: error instanceof Error ? error.message : "session host failed" })}\n`);
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
