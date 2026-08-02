#!/usr/bin/env bun
import { chmod, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { SessionCredentialClient } from "./session-credential-client.ts";

const MAX_HEALTH_BYTES = 4096;
const HEALTH_TIMEOUT_MS = 1000;

export interface SessionAuthorityHealthHandle { stop(): Promise<void>; }

export async function startSessionAuthorityHealth(socketPath: string, generation: string, credential: SessionCredentialClient): Promise<SessionAuthorityHealthHandle> {
	await unlink(socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
	const sockets = new Set<Socket>();
	const server: Server = createServer(socket => {
		sockets.add(socket); socket.once("close", () => sockets.delete(socket));
		let request = "";
		let answered = false;
		socket.on("data", chunk => {
			if (answered) { socket.destroy(); return; }
			request += String(chunk);
			if (Buffer.byteLength(request) > MAX_HEALTH_BYTES) { socket.destroy(); return; }
			if (!request.includes("\n")) return;
			if (request !== "health\n") { socket.destroy(); return; }
			answered = true;
			void credential.state().then(state => {
				const healthy = state.generation === generation && state.registered && state.fresh && state.leaseHeld;
				socket.end(`${JSON.stringify({ healthy, generation: state.generation })}\n`);
			}, () => socket.destroy());
		});
	});
	const listening = Promise.withResolvers<void>(); server.once("listening", listening.resolve); server.once("error", listening.reject);
	server.listen(socketPath); await listening.promise; await chmod(socketPath, 0o600);
	return { async stop(): Promise<void> {
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(error => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		await unlink(socketPath).catch(() => undefined);
	} };
}

export async function probeSessionAuthority(socketPath: string, generation: string): Promise<void> {
	const socket = createConnection(socketPath);
	let response = "";
	const completed = Promise.withResolvers<void>();
	const timeout = setTimeout(() => { socket.destroy(); completed.reject(new Error("session authority health timed out")); }, HEALTH_TIMEOUT_MS);
	socket.once("connect", () => socket.write("health\n"));
	socket.on("data", chunk => { response += String(chunk); if (Buffer.byteLength(response) > MAX_HEALTH_BYTES) socket.destroy(new Error("session authority health response exceeds its bound")); });
	socket.once("error", error => { clearTimeout(timeout); completed.reject(error); });
	socket.once("end", () => { clearTimeout(timeout); completed.resolve(); });
	await completed.promise;
	let body: Record<string, unknown>;
	try { body = JSON.parse(response) as Record<string, unknown>; } catch { throw new Error("session authority health response is invalid"); }
	if (Object.keys(body).sort().join("\0") !== ["generation", "healthy"].sort().join("\0") || body.generation !== generation || body.healthy !== true)
		throw new Error("session authority is not registered, fresh, and holding its writer Lease");
}

if (import.meta.main) {
	try {
		const socketPath = process.env.T4_AUTHORITY_HEALTH_SOCKET;
		const generation = process.env.T4_RUNTIME_GENERATION;
		if (!socketPath || !generation) throw new Error("authority health configuration is required");
		await probeSessionAuthority(socketPath, generation);
	} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "authority health failed"}\n`); process.exitCode = 1; }
}
