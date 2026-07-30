#!/usr/bin/env bun
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, readFile, unlink } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { KubernetesApiClient, KubernetesTokenReviewer } from "./kubernetes-client.ts";
import { KubernetesWriterLeaseAuthority } from "./session-writer-lease.ts";
import { WebSocketServer, WebSocket } from "ws";

const MAX_REQUEST_BYTES = 20 * 1024;
const HEARTBEAT_MAX_AGE_MS = 15_000;
const TOKEN_MAX_BYTES = 16_384;

const ACTIVITY_RESPONSE_MAX_BYTES = 64 * 1024;
const CMUX_MAX_FRAME_BYTES = 67_108_864;
const CMUX_MAX_BUFFERED_BYTES = 1_048_576;

type BrokerRequest =
	| { id: number; command: "register"; generation: string; hostId: string; sessionId: string }
	| { id: number; command: "heartbeat"; generation: string }
	| { id: number; command: "review"; token: string }
	| { id: number; command: "acquire" }
	| { id: number; command: "release" }
	| { id: number; command: "state" };

export interface SessionCredentialBrokerConfig {
	readonly socketPath: string;
	readonly kubernetesBaseUrl: string;
	readonly kubernetesTokenPath: string;
	readonly kubernetesCaPath: string;
	readonly kubernetesNamespacePath: string;
	readonly serverServiceAccountName: string;
	readonly writerLeaseName: string;
	readonly podUid: string;
	readonly generation: string;
	readonly runtimeUid: string;
	readonly activitySocketPath: string;
	readonly cmuxSocketPath: string;
	readonly activityPort: number;
	readonly generationAuthPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function absolute(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
export function decodeSessionCredentialBrokerRequest(value: unknown): BrokerRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("credential broker request is invalid");
	const request = value as Record<string, unknown>;
	if (!Number.isSafeInteger(request.id) || (request.id as number) < 1 || typeof request.command !== "string") throw new Error("credential broker request identity is invalid");
	switch (request.command) {
		case "register":
			if (!exactKeys(request, ["id", "command", "generation", "hostId", "sessionId"]) || typeof request.generation !== "string" || typeof request.hostId !== "string" || typeof request.sessionId !== "string") break;
			return request as unknown as BrokerRequest;
		case "heartbeat":
			if (!exactKeys(request, ["id", "command", "generation"]) || typeof request.generation !== "string") break;
			return request as unknown as BrokerRequest;
		case "review":
			if (!exactKeys(request, ["id", "command", "token"]) || typeof request.token !== "string" || Buffer.byteLength(request.token) > TOKEN_MAX_BYTES) break;
			return request as unknown as BrokerRequest;
		case "acquire": case "release": case "state":
			if (exactKeys(request, ["id", "command"])) return request as unknown as BrokerRequest;
	}
	throw new Error("credential broker command is not allowed");
}
export function credentialBrokerRegistrationIsFresh(heartbeatAt: number | undefined, now = Date.now()): boolean {
	return heartbeatAt !== undefined && now >= heartbeatAt && now - heartbeatAt <= HEARTBEAT_MAX_AGE_MS;
}

export function sessionCredentialBrokerConfigFromEnv(env: NodeJS.ProcessEnv): SessionCredentialBrokerConfig {
	const host = required(env, "KUBERNETES_SERVICE_HOST");
	const port = Number(env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? "443");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("KUBERNETES_SERVICE_PORT is invalid");
	return {
		socketPath: absolute(required(env, "T4_CREDENTIAL_BROKER_SOCKET"), "T4_CREDENTIAL_BROKER_SOCKET"),
		kubernetesBaseUrl: `https://${host}:${port}`,
		kubernetesTokenPath: absolute(required(env, "T4_KUBERNETES_TOKEN_PATH"), "T4_KUBERNETES_TOKEN_PATH"),
		kubernetesCaPath: absolute(required(env, "T4_KUBERNETES_CA_PATH"), "T4_KUBERNETES_CA_PATH"),
		kubernetesNamespacePath: absolute(required(env, "T4_KUBERNETES_NAMESPACE_PATH"), "T4_KUBERNETES_NAMESPACE_PATH"),
		serverServiceAccountName: required(env, "T4_CLUSTER_SERVER_SERVICE_ACCOUNT"),
		writerLeaseName: required(env, "T4_WRITER_LEASE_NAME"),
		podUid: required(env, "POD_UID"),
		generation: required(env, "T4_RUNTIME_GENERATION"),
		runtimeUid: required(env, "T4_RUNTIME_UID"),
		activitySocketPath: absolute(env.T4_RUNTIME_ACTIVITY_SOCKET ?? join(dirname(required(env, "T4_CREDENTIAL_BROKER_SOCKET")), "activity.sock"), "T4_RUNTIME_ACTIVITY_SOCKET"),
		cmuxSocketPath: absolute(required(env, "T4_CMUX_SOCKET_PATH"), "T4_CMUX_SOCKET_PATH"),
		activityPort: Number(env.T4_RUNTIME_ACTIVITY_PORT ?? "8788"),

		generationAuthPath: absolute(required(env, "T4_GENERATION_AUTH_PATH"), "T4_GENERATION_AUTH_PATH"),
	};
}

function proxyActivity(socketPath: string, route: string, body: string): Promise<{ status: number; body: Buffer }> {
	const result = Promise.withResolvers<{ status: number; body: Buffer }>();
	const request = httpRequest({
		socketPath,
		path: route,
		method: "POST",
		headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
	}, response => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		response.on("data", chunk => {
			bytes += chunk.length;
			if (bytes > ACTIVITY_RESPONSE_MAX_BYTES) response.destroy(new Error("activity response exceeds its bound"));
			else chunks.push(Buffer.from(chunk));
		});
		response.once("error", result.reject);
		response.once("end", () => result.resolve({ status: response.statusCode ?? 503, body: Buffer.concat(chunks) }));
	});
	request.once("error", result.reject);
	request.end(body);
	return result.promise;
}
export async function releaseSessionWriterAuthority(fence: () => void, authority: { release(): Promise<void> }): Promise<void> {
	fence();
	await authority.release();
}


export async function runSessionCredentialBroker(config: SessionCredentialBrokerConfig): Promise<void> {
	const [namespace, ca, generationAuth] = await Promise.all([
		readFile(config.kubernetesNamespacePath, "utf8").then(value => value.trim()),
		readFile(config.kubernetesCaPath, "utf8"),
		readFile(config.generationAuthPath),
	]);
	if (generationAuth.length !== 32) throw new Error("runtime generation authentication key is invalid");
	const generationAuthSha256 = createHash("sha256").update(generationAuth).digest("hex");
	const api = new KubernetesApiClient({ baseUrl: config.kubernetesBaseUrl, namespace, tokenFile: config.kubernetesTokenPath, ca });
	const reviewer = new KubernetesTokenReviewer({
		baseUrl: config.kubernetesBaseUrl,
		tokenPath: config.kubernetesTokenPath,
		caPath: config.kubernetesCaPath,
		namespacePath: config.kubernetesNamespacePath,
		serverServiceAccountName: config.serverServiceAccountName,
	});
	const lease = new KubernetesWriterLeaseAuthority(api, { namespace, leaseName: config.writerLeaseName, podUid: config.podUid, generation: config.generation });
	await unlink(config.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
	let registered: { hostId: string; sessionId: string; heartbeatAt: number } | undefined;
	let authority: Socket | undefined;
	const stopped = Promise.withResolvers<void>();
	const cmuxServer = new WebSocketServer({ noServer: true, maxPayload: CMUX_MAX_FRAME_BYTES, perMessageDeflate: false });
	let cmuxFenceEpoch = 0;
	const cmuxClients = new Set<WebSocket>();
	const cmuxUpstreams = new Set<Socket>();
	let cmuxAccepting = false;
	const fenceCmux = (): void => {
		cmuxFenceEpoch++;
		cmuxAccepting = false;
		for (const upstream of cmuxUpstreams) upstream.destroy();
		for (const client of cmuxClients) client.terminate();
		cmuxUpstreams.clear();
		cmuxClients.clear();
	};
	let writerReleasesInFlight = 0;
	const releaseWriter = async (): Promise<void> => {
		writerReleasesInFlight++;
		try { await releaseSessionWriterAuthority(fenceCmux, lease); }
		finally { writerReleasesInFlight--; }
	};
	const server = createNetServer(socket => {
		if (authority) { socket.destroy(); return; }
		authority = socket;
		server.close();
		void unlink(config.socketPath).catch(() => undefined);
		let buffered = "";
		let operations = Promise.resolve();
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffered += chunk;
			if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
				operations = operations.then(async () => {
					let id = 0;
					try {
						const request = decodeSessionCredentialBrokerRequest(JSON.parse(line)); id = request.id;
						let result: unknown;
						switch (request.command) {
							case "register":
								if (request.generation !== config.generation || registered) throw new Error("credential broker registration rejected");
								registered = { hostId: request.hostId, sessionId: request.sessionId, heartbeatAt: Date.now() }; result = { generationAuthSha256 }; break;
							case "heartbeat":
								if (!registered || request.generation !== config.generation) throw new Error("credential broker heartbeat rejected");
								registered.heartbeatAt = Date.now(); result = { accepted: true }; break;
							case "review": result = { authenticated: await reviewer.review(request.token) }; break;
							case "acquire":
								if (!registered) throw new Error("credential broker host is not registered");
								await lease.acquire();
								if (socket.destroyed) {
									await releaseWriter();
									throw new Error("credential broker authority closed");
								}
								cmuxAccepting = true;
								result = { acquired: true };
								break;
							case "release":
								await releaseWriter();
								result = { released: true };
								break;
							case "state": {
								const leaseHeld = await lease.verifyHeld();
								if (!leaseHeld) fenceCmux();
								result = { generation: config.generation, generationAuthSha256, registered: Boolean(registered), fresh: credentialBrokerRegistrationIsFresh(registered?.heartbeatAt), leaseHeld, hostId: registered?.hostId, sessionId: registered?.sessionId };
								break;
							}
						}
						socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
					} catch (error) { socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : "credential broker request failed" })}\n`); }
				});
			}
		});
		socket.once("close", () => {
			fenceCmux();
			operations = operations.then(releaseWriter).finally(stopped.resolve);
		});
		socket.once("error", () => socket.destroy());
	});
	if (!Number.isSafeInteger(config.activityPort) || config.activityPort < 0 || config.activityPort > 65_535)
		throw new Error("runtime activity port is invalid");
	const expectedBearer = Buffer.from(`Bearer ${generationAuth.toString("base64url")}`);
	cmuxServer.on("connection", client => {
		const upstream = createConnection(config.cmuxSocketPath);
		cmuxUpstreams.add(upstream);
		cmuxClients.add(client);
		const close = (): void => {
			cmuxClients.delete(client);
			cmuxUpstreams.delete(upstream);
			upstream.destroy();
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.terminate();
		};
		client.on("message", value => {
			const chunk = value instanceof ArrayBuffer ? Buffer.from(value) : Array.isArray(value) ? Buffer.concat(value) : Buffer.from(value);
			if (chunk.byteLength > CMUX_MAX_FRAME_BYTES || upstream.destroyed || !upstream.write(chunk)) close();
		});
		client.once("close", close);
		client.once("error", close);
		upstream.on("data", chunk => {
			if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > CMUX_MAX_BUFFERED_BYTES - chunk.byteLength) { close(); return; }
			client.send(chunk, { binary: true }, error => { if (error) close(); });
		});
		upstream.once("end", () => { if (client.readyState === WebSocket.OPEN) client.close(1000, "cmux transport ended"); });
		upstream.once("error", close);
	});
	const leaseFenceTimer = setInterval(() => {
		if (!cmuxAccepting) return;
		void lease.verifyHeld().then(held => { if (!held) fenceCmux(); }).catch(fenceCmux);
	}, 1_000);
	leaseFenceTimer.unref?.();
	const activityServer = createHttpServer((request, response) => {
		void (async () => {
			try {
				const requestUrl = request.url ?? "";
				if (request.method !== "POST" || !["/internal/runtime/activity", "/internal/runtime/drain", "/internal/runtime/quiesce", "/internal/runtime/reopen"].includes(requestUrl)) {
					response.writeHead(404).end();
					return;
				}
				const authorization = Buffer.from(request.headers.authorization ?? "");
				if (authorization.length !== expectedBearer.length || !timingSafeEqual(authorization, expectedBearer)) {
					response.writeHead(403).end();
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				for await (const chunk of request) {
					bytes += chunk.length;
					if (bytes > 1024) throw new Error("runtime activity request exceeds its bound");
					chunks.push(Buffer.from(chunk));
				}
				const body = Buffer.concat(chunks).toString("utf8");
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (
					Object.keys(parsed).sort().join(",") !== "expectedGeneration,expectedRuntimeUid" ||
					parsed.expectedRuntimeUid !== config.runtimeUid ||
					parsed.expectedGeneration !== config.generation
				) {
					response.writeHead(403).end();
					return;
				}
				const route = requestUrl.endsWith("/quiesce") ? "/quiesce" : requestUrl.endsWith("/reopen") ? "/reopen" : requestUrl.endsWith("/drain") ? "/drain" : "/activity";
				if (route === "/drain" || route === "/quiesce") fenceCmux();
				const proxied = await proxyActivity(config.activitySocketPath, route, body);
				if (route === "/reopen" && proxied.status >= 200 && proxied.status < 300) {
					const observedFenceEpoch = cmuxFenceEpoch;
					if (writerReleasesInFlight === 0 && await lease.verifyHeld() && observedFenceEpoch === cmuxFenceEpoch && writerReleasesInFlight === 0) cmuxAccepting = true;
					else fenceCmux();
				}
				response.writeHead(proxied.status, { "content-type": "application/json", "content-length": proxied.body.length });
				response.end(proxied.body);
			} catch {
				response.writeHead(503).end();
			}
		})();
	});
	activityServer.on("upgrade", (request, socket, head) => {
		void (async () => {
			const authorization = Buffer.from(request.headers.authorization ?? "");
			const runtimeUid = request.headers["x-runtime-uid"];
			const generation = request.headers["x-runtime-generation"];
			const authorized = authorization.length === expectedBearer.length && timingSafeEqual(authorization, expectedBearer);
			const leaseHeld = await lease.verifyHeld();
			if (!leaseHeld) fenceCmux();
			if (
				request.url !== "/internal/runtime/cmux" ||
				!authorized ||
				runtimeUid !== config.runtimeUid ||
				generation !== config.generation ||
				!cmuxAccepting ||
				!registered ||
				!credentialBrokerRegistrationIsFresh(registered.heartbeatAt) ||
				!leaseHeld
			) {
				socket.destroy();
				return;
			}
			cmuxServer.handleUpgrade(request, socket, head, client => cmuxServer.emit("connection", client, request));
		})().catch(() => socket.destroy());
	});
	const activityListening = Promise.withResolvers<void>();
	activityServer.once("listening", activityListening.resolve);
	activityServer.once("error", activityListening.reject);
	activityServer.listen(config.activityPort, "0.0.0.0");
	await activityListening.promise;

	const listening = Promise.withResolvers<void>();
	server.once("listening", listening.resolve); server.once("error", listening.reject);
	server.listen(config.socketPath); await listening.promise; await chmod(config.socketPath, 0o660);
	let activityClose: Promise<void> | undefined;
	const closeActivityServer = (): Promise<void> => {
		if (activityClose) return activityClose;
		const closed = Promise.withResolvers<void>();
		activityClose = closed.promise;
		activityServer.close(error => error ? closed.reject(error) : closed.resolve());
		activityServer.closeAllConnections();
		return activityClose;
	};
	let cmuxClose: Promise<void> | undefined;
	const closeCmuxServer = (): Promise<void> => {
		if (cmuxClose) return cmuxClose;
		const closed = Promise.withResolvers<void>();
		cmuxClose = closed.promise;
		cmuxServer.close(() => closed.resolve());
		return cmuxClose;
	};
	const stop = (): void => {
		fenceCmux();
		void closeActivityServer();
		void closeCmuxServer();
		authority?.destroy();
		if (!authority) {
			server.close();
			void releaseWriter().finally(stopped.resolve);
		}
	};
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	await stopped.promise;
	clearInterval(leaseFenceTimer);
	process.off("SIGINT", stop); process.off("SIGTERM", stop);
	fenceCmux();
	await Promise.all([closeActivityServer(), closeCmuxServer()]);
	await unlink(config.socketPath).catch(() => undefined);
}

if (import.meta.main) {
	try { await runSessionCredentialBroker(sessionCredentialBrokerConfigFromEnv(process.env)); }
	catch (error) { process.stderr.write(`${JSON.stringify({ component: "session-credential-broker", level: "error", message: error instanceof Error ? error.message : "credential broker failed" })}\n`); process.exitCode = 1; }
}
