import { createConnection, type Socket } from "node:net";

const MAX_RESPONSE_BYTES = 20 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

interface BrokerResponse { readonly id: number; readonly ok: boolean; readonly result?: unknown; readonly error?: string; }
export interface CredentialBrokerState {
	readonly generation: string;
	readonly generationAuthSha256: string;
	readonly registered: boolean;
	readonly fresh: boolean;
	readonly leaseHeld: boolean;
	readonly hostId?: string;
	readonly sessionId?: string;
}

export class SessionCredentialClient {
	readonly #socket: Socket;
	#nextId = 1;
	#buffered = "";
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#receive(String(chunk)));
		socket.once("close", () => this.#failAll(new Error("credential broker connection closed")));
		socket.once("error", error => this.#failAll(error));
	}
	static async connect(socketPath: string): Promise<SessionCredentialClient> {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		for (;;) {
			try {
				const socket = createConnection(socketPath);
				const connected = Promise.withResolvers<void>();
				socket.once("connect", connected.resolve); socket.once("error", connected.reject);
				await connected.promise;
				return new SessionCredentialClient(socket);
			} catch (error) {
				if (Date.now() >= deadline) throw error;
				const retry = Promise.withResolvers<void>();
				setTimeout(retry.resolve, 100);
				await retry.promise;
			}
		}
	}
	async register(generation: string, hostId: string, sessionId: string): Promise<{ generationAuthSha256: string }> {
		return await this.#request({ command: "register", generation, hostId, sessionId }) as { generationAuthSha256: string };
	}
	async heartbeat(generation: string): Promise<void> { await this.#request({ command: "heartbeat", generation }); }
	async review(token: string): Promise<boolean> {
		const result = await this.#request({ command: "review", token }) as { authenticated?: unknown };
		return result.authenticated === true;
	}
	async acquire(): Promise<void> { await this.#request({ command: "acquire" }); }
	async release(): Promise<void> { await this.#request({ command: "release" }); }
	async state(): Promise<CredentialBrokerState> { return await this.#request({ command: "state" }) as CredentialBrokerState; }
	close(): void { this.#socket.destroy(); }
	async #request(request: Record<string, unknown>): Promise<unknown> {
		const id = this.#nextId++;
		const response = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
		this.#socket.write(`${JSON.stringify({ id, ...request })}\n`);
		return await response;
	}
	#receive(chunk: string): void {
		this.#buffered += chunk;
		if (Buffer.byteLength(this.#buffered) > MAX_RESPONSE_BYTES) { this.#socket.destroy(new Error("credential broker response exceeds its bound")); return; }
		for (;;) {
			const newline = this.#buffered.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffered.slice(0, newline); this.#buffered = this.#buffered.slice(newline + 1);
			let response: BrokerResponse;
			try { response = JSON.parse(line) as BrokerResponse; } catch { this.#socket.destroy(new Error("credential broker response is invalid")); return; }
			const pending = this.#pending.get(response.id);
			if (!pending) { this.#socket.destroy(new Error("credential broker response identity is invalid")); return; }
			this.#pending.delete(response.id);
			if (response.ok) pending.resolve(response.result);
			else pending.reject(new Error(typeof response.error === "string" ? response.error : "credential broker request failed"));
		}
	}
	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}
