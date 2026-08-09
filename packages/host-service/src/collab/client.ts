//  collab/client.ts
//  Guest-side collab WebSocket client: connects to the relay with ?role=guest,
//  seals hello on open, opens host frames, accumulates the snapshot, and
//  reconnects with exponential backoff. Decryption failure and fatal close
//  codes are terminal (bad key / room gone), everything else retries.

import { createCollabCipher, type CollabCipher, packEnvelope, unpackEnvelope } from "./crypto.ts";
import { parseCollabLink, type CollabLink } from "./link.ts";
import { COLLAB_PROTO, type CollabGuestFrame, type CollabHostFrame, type CollabWireEntry } from "./frames.ts";

export interface CollabGuestSnapshot {
	readonly header: CollabHostFrame & { t: "welcome" };
	readonly entries: CollabWireEntry[];
	readonly readOnly: boolean;
}

export interface CollabGuestHandlers {
	onOpen?(): void;
	/** A full snapshot has been replayed; the client is live. */
	onSnapshot(snapshot: CollabGuestSnapshot): void;
	/** One live host frame after the snapshot (entry/event/state/bus/agents/…). */
	onFrame(frame: CollabHostFrame): void;
	/** The room is gone / unrecoverable (fatal code, bad key, or bye). */
	onFatal(reason: string): void;
}

const FATAL_CLOSE_CODES = new Set([4001, 4004, 4009, 4029]);
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const WELCOME_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export class CollabGuestClient {
	readonly link: CollabLink;
	readonly #cipher: CollabCipher;
	readonly #handlers: CollabGuestHandlers;
	readonly #guestName: string;
	#ws: WebSocket | undefined;
	#closed = false;
	#attempt = 0;
	#welcomeTimer: ReturnType<typeof setTimeout> | undefined;
	#snapshot: { header: (CollabHostFrame & { t: "welcome" }) | undefined; entries: CollabWireEntry[] } = {
		header: undefined,
		entries: [],
	};
	#sealChain: Promise<unknown> = Promise.resolve();
	#openChain: Promise<unknown> = Promise.resolve();

	constructor(
		link: CollabLink,
		handlers: CollabGuestHandlers,
		guestName = "omperator",
	) {
		this.link = link;
		this.#cipher = createCollabCipher(link.key);
		this.#handlers = handlers;
		this.#guestName = guestName;
	}

	get connected(): boolean {
		return this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN;
	}

	start(): void {
		this.#connect();
	}

	async #connect(): Promise<void> {
		if (this.#closed) return;
		const url = `${this.link.wsUrl}?role=guest`;
		const ws = new WebSocket(url);
		this.#ws = ws;
		this.#armWelcomeTimer();
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => {
			this.#attempt = 0;
			this.#resetSnapshot();
			// Send hello serially so reconnect never overlaps an in-flight seal.
			this.#enqueueSeal({ t: "hello", proto: COLLAB_PROTO, name: this.#guestName, ...(this.link.writeToken ? { writeToken: toBase64Url(this.link.writeToken) } : {}), ...(this.link.token ? { enclaveToken: this.link.token } : {}) });
			this.#handlers.onOpen?.();
		});
		ws.addEventListener("message", (event: MessageEvent) => {
			if (typeof event.data === "string") {
				// TEXT = relay control (room-closed). Parse leniently.
				try {
					const control = JSON.parse(event.data) as { t?: string };
					if (control.t === "room-closed") {
						this.#fatal("room closed by host");
						ws.close();
					}
				} catch {
					// Ignore malformed control frames.
				}
				return;
			}
			const bytes = toUint8Array(event.data);
			let sealed: Uint8Array;
			try {
				sealed = unpackEnvelope(bytes).sealed;
			} catch {
				this.#fatal("malformed envelope");
				ws.close();
				return;
			}
			// Serialize the open chain to preserve frame order (crypto.subtle
			// must not reorder concurrent decrypts).
			this.#openChain = this.#openChain
				.then(async () => {
					let plain: Uint8Array;
					try {
						plain = await this.#cipher.open(sealed);
					} catch {
						this.#fatal("bad key or corrupted frame");
						ws.close();
						return;
					}
					let frame: unknown;
					try {
						frame = JSON.parse(new TextDecoder().decode(plain));
					} catch {
						this.#fatal("bad key or corrupted frame");
						ws.close();
						return;
					}
					const record = frame as Record<string, unknown>;
					if (record?.t === "welcome" && typeof record.header === "object") {
						const header = record as CollabHostFrame & { t: "welcome" };
						this.#snapshot.header = header;
						this.#handlers.onFrame?.(header);
						return;
					}
					if (record?.t === "snapshot-chunk") {
						this.#snapshot.entries.push(...((record.entries as CollabWireEntry[] | undefined) ?? []));
						this.#handlers.onFrame?.(frame as CollabHostFrame);
						if (record.final === true) this.#completeSnapshot();
						return;
					}
					this.#handlers.onFrame?.(frame as CollabHostFrame);
				})
				.catch(() => undefined);
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.#clearWelcomeTimer();
			if (this.#closed) return;
			if (FATAL_CLOSE_CODES.has(event.code)) {
				this.#fatal(`room unavailable (${event.code})`);
				return;
			}
			this.#scheduleReconnect();
		});
		ws.addEventListener("error", () => {
			// close follows; the reconnect/fatal logic handles it.
		});
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			if (!this.connected) {
				this.#fatal("welcome timed out");
				this.#ws?.close();
			}
		}, WELCOME_TIMEOUT_MS);
	}
	#clearWelcomeTimer(): void {
		clearTimeout(this.#welcomeTimer);
		this.#welcomeTimer = undefined;
	}

	#resetSnapshot(): void {
		this.#snapshot = { header: undefined, entries: [] };
	}
	#completeSnapshot(): void {
		if (!this.#snapshot.header) {
			this.#fatal("snapshot finished without a welcome");
			return;
		}
		this.#handlers.onSnapshot?.({
			header: this.#snapshot.header,
			entries: this.#snapshot.entries,
			readOnly: this.#snapshot.header.readOnly === true,
		});
	}

	#scheduleReconnect(): void {
		const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt += 1;
		const jitter = delayMs * (0.75 + Math.random() * 0.5);
		void delay(jitter).then(() => this.#connect());
	}

	#fatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearWelcomeTimer();
		this.#handlers.onFatal?.(reason);
	}

	#enqueueSeal(frame: CollabGuestFrame): void {
		this.#sealChain = this.#sealChain
			.then(async () => {
				if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
				const plain = new TextEncoder().encode(JSON.stringify(frame));
				const sealed = await this.#cipher.seal(plain);
				this.#ws.send(packEnvelope(0, sealed) as unknown as BufferSource);
			})
			.catch(() => undefined);
	}

	prompt(text: string): void {
		this.#enqueueSeal({ t: "prompt", text });
	}
	abort(): void {
		this.#enqueueSeal({ t: "abort" });
	}
	/** /enclave extension: route a control command to the host plugin. */
	control(method: string, params: unknown, reqId: number): void {
		this.#enqueueSeal({ t: "enclave-cmd", method, params, reqId });
	}
	uiResponse(reqId: number, value?: string): void {
		this.#enqueueSeal({ t: "ui-response", reqId, ...(value === undefined ? {} : { value }) });
	}
	agentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#enqueueSeal({ t: "agent-cmd", cmd, agentId, ...(text === undefined ? {} : { text }) });
	}

	close(): void {
		this.#closed = true;
		this.#clearWelcomeTimer();
		const ws = this.#ws;
		this.#ws = undefined;
		try {
			ws?.close(1000, "omperator bridge closing");
		} catch {
			// already closed
		}
	}
}

function toUint8Array(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new Error("collab binary message is not bytes");
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function toBase64Url(bytes: Uint8Array): string {
	let out = "";
	for (let index = 0; index < bytes.byteLength; index += 3) {
		const a = bytes[index]!;
		const b = bytes[index + 1];
		const c = bytes[index + 2];
		out += B64URL[a >> 2];
		out += B64URL[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
		if (b !== undefined) out += B64URL[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
		if (c !== undefined) out += B64URL[c & 63];
	}
	return out;
}

export { parseCollabLink };
