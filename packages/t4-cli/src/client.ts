// client.ts — omp-app/1 client for the TUI. Speaks plain JSON frames (the
// same vocabulary the iOS HostWire package encodes), over UDS by default or
// remote ws/wss with device credentials. Tracks stream cursors so a reconnect
// can resume instead of re-snapshotting.
import WebSocket from "ws";

export interface SessionRef {
	sessionId: string;
	title: string;
	status: string;
	revision?: string;
	cwd?: string;
	project?: { name?: string; path?: string };
	updatedAt?: string;
	model?: string;
}
export interface TranscriptEntry {
	id: string;
	parentId?: string;
	turnId?: string;
	kind: string;
	timestamp?: string;
	headline?: string;
	body?: string;
	data?: Record<string, unknown>;
}
export interface HostEvents {
	sessions(sessions: SessionRef[]): void;
	snapshot(sessionId: string, entries: TranscriptEntry[]): void;
	entry(sessionId: string, entry: TranscriptEntry): void;
	status(sessionId: string, status: string): void;
	confirm(frame: Frame): void;
	termOutput(sessionId: string, terminalId: string, stream: string, data: string, encoding?: string): void;
	termExit(sessionId: string, terminalId: string): void;
	error(message: string): void;
	open(): void;
	close(reason: string): void;
}

export type Frame = Record<string, unknown>;

/** The server→client frames the TUI consumes, validated at the socket. */
interface WireFrame {
	v?: string;
	type?: string;
	hostId?: string;
	sessionId?: string;
	requestId?: string;
	commandId?: string;
	command?: string;
	ok?: boolean;
	error?: { message?: string; code?: string };
	result?: unknown;
	cursor?: unknown;
	sessions?: SessionRef[];
	entries?: TranscriptEntry[];
	entry?: TranscriptEntry;
	ref?: { sessionId?: string; status?: string; revision?: string };
	confirmationId?: string;
	summary?: string;
	terminalId?: string;
	stream?: string;
	data?: string;
	encoding?: string;
	message?: string;
	code?: string;
	reason?: string;
	[key: string]: unknown;
}

const CLIENT_FEATURES = [
	"resume", "prompt.lease", "controller.lease", "prompt.images", "transcript.page",
	"session.delta", "files.list", "files.diff", "terminal.io", "preview.control",
	"files.search", "transcript.search", "session.watch", "host.watch", "project.reveal",
];
const CLIENT_CAPS = [
	"sessions.read", "sessions.prompt", "sessions.control", "sessions.manage",
	"catalog.read", "files.list", "files.read", "files.diff",
	"term.open", "term.input", "term.resize",
	"preview.control", "preview.read", "usage.read", "agents.control",
	"audit.read", "config.read", "config.write",
];

export class T4Client {
	private events: HostEvents;
	private ws?: WebSocket;
	private hostId = "";
	private seq = 0;
	private pending = new Map<string, { resolve(f: Frame): void; reject(e: Error): void; timer: Timer }>();
	private savedCursors: Frame[] = [];
	/** Latest cursor per session — offered as savedCursors on reconnect. */
	private cursors = new Map<string, Frame>();
	/** Session revisions from the inventory — required for lease acquires. */
	private revisions = new Map<string, string>();

	constructor(
		private readonly endpoint: string,
		private readonly auth: { deviceId: string; deviceToken: string } | undefined,
		events: HostEvents,
		/** Unix-socket connections are local and trusted: no lease dance. */
		private readonly local = false,
	) {
		this.events = events;
	}

	setEvents(events: HostEvents): void {
		this.events = events;
	}

	connect(): Promise<Frame> {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const ws = new WebSocket(this.endpoint, { rejectUnauthorized: false });
		this.ws = ws;
		ws.on("open", () => {
			ws.send(JSON.stringify({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				capabilities: { client: CLIENT_CAPS },
				client: { name: "t4-tui", version: "0.2", build: "dev", platform: process.platform },
				requestedFeatures: CLIENT_FEATURES,
				savedCursors: [...this.cursors.values()],
				...(this.auth ? { authentication: { deviceId: this.auth.deviceId, deviceToken: this.auth.deviceToken } } : {}),
			}));
		});
		ws.on("message", (raw: WebSocket.RawData) => {
			// Socket boundary: frames are server JSON; the WireFrame surface is the
			// complete set of fields this client consumes, so assert once here.
			let f: WireFrame;
			try { f = JSON.parse(raw.toString()) as WireFrame; } catch { return; }
			if (f.type === "welcome") {
				this.hostId = f.hostId ?? "";
				this.events.open();
				resolve(f as Frame);
				return;
			}
			if (f.requestId && this.pending.has(f.requestId)) {
				const p = this.pending.get(f.requestId)!;
				this.pending.delete(f.requestId);
				clearTimeout(p.timer);
				// Command responses that carry the inventory also refresh revisions.
				// (session.list's result shape is asserted by the caller.)
				const result = f.result as { sessions?: SessionRef[] } | undefined;
				if (f.command === "session.list" && f.ok !== false && Array.isArray(result?.sessions)) {
					for (const s of result.sessions!) {
						if (s.revision) this.revisions.set(s.sessionId, s.revision);
					}
				}
				if (f.ok === false) p.reject(new Error(String(f.error?.message ?? f.error?.code ?? "command failed")));
				else p.resolve(f);
				return;
			}
			if (f.cursor && f.sessionId) this.cursors.set(f.sessionId, { sessionId: f.sessionId, cursor: f.cursor });
			this.route(f);
		});
		ws.on("error", e => { this.events.error(e.message); reject(e); });
		ws.on("close", (code, reason) => {
			for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("closed")); }
			this.pending.clear();
			this.events.close(`${code} ${reason}`);
		});
		return promise;
	}

	private route(f: WireFrame): void {
		switch (f.type) {
			case "sessions": {
				for (const s of (f.sessions ?? []) as SessionRef[]) {
					if (s.revision) this.revisions.set(s.sessionId, s.revision);
				}
				return this.events.sessions(f.sessions ?? []);
			}
			case "snapshot": return this.events.snapshot(f.sessionId ?? "", f.entries ?? []);
			case "entry": return this.events.entry(f.sessionId ?? "", f.entry ?? { id: "", kind: "entry" });
			case "session.delta":
				if (f.ref) this.events.status(f.sessionId ?? f.ref.sessionId ?? "", f.ref.status ?? "idle");
				return;
			case "confirmation": return this.events.confirm(f as Frame);
			case "terminal.output":
				return this.events.termOutput(f.sessionId ?? "", f.terminalId ?? "", f.stream ?? "stdout", f.data ?? "", f.encoding);
			case "terminal.exit": return this.events.termExit(f.sessionId ?? "", f.terminalId ?? "");
			case "error": return this.events.error(f.message ?? f.code ?? "host error");
		}
	}

	command<T = Frame>(command: string, args: Frame = {}, sessionId?: string, expectedRevision?: string): Promise<T> {
		const requestId = `t4-${++this.seq}-${Date.now()}`;
		const frame: Frame = {
			v: "omp-app/1", type: "command", requestId,
			commandId: `c-${this.seq}-${Date.now()}`,
			timestamp: new Date().toISOString(),
			hostId: this.hostId, command, args,
			...(sessionId ? { sessionId } : {}),
			...(expectedRevision ? { expectedRevision } : {}),
		};
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			this.pending.delete(requestId);
			reject(new Error(`${command}: timeout`));
		}, 30_000);
		this.pending.set(requestId, { resolve: f => resolve(f.result as T), reject, timer });
		this.ws!.send(JSON.stringify(frame));
		return promise;
	}

	/** Answer a confirmation challenge (confirm frame is not a command). */
	confirmAnswer(challenge: Frame, decision: "accept" | "reject"): void {
		this.sendRaw({
			v: "omp-app/1", type: "confirm",
			requestId: `t4-${++this.seq}-${Date.now()}`,
			confirmationId: challenge.confirmationId,
			commandId: challenge.commandId,
			hostId: this.hostId,
			...(challenge.sessionId ? { sessionId: challenge.sessionId } : {}),
			decision,
		});
	}

	/** Raw additive client → host frame (terminal.input/resize/close). */
	sendRaw(frame: Frame): void {
		this.ws?.send(JSON.stringify({ v: "omp-app/1", hostId: this.hostId, ...frame }));
	}

	sessionList() {
		return this.command<{ sessions: SessionRef[] }>("session.list");
	}

	/** Refresh the inventory and return one session's current revision. */
	private async freshRevision(sessionId: string): Promise<string | undefined> {
		await this.sessionList().catch(() => undefined);
		return this.revisions.get(sessionId);
	}

	/**
	 * Run a mutation under a freshly acquired lease. Every mutation
	 * (prompt/rename/cancel/preview.launch/…) is policy-denied — closing the
	 * connection — without a live lease, so this dance is mandatory.
	 */
	private async withLease(
		sessionId: string,
		kind: "prompt.lease" | "controller.lease",
		fn: (leaseId: string, revision: string) => Promise<void>,
	): Promise<void> {
		// Local connections are trusted — mutations go bare, and the lease
		// features aren't even supported on the unix-socket path.
		if (this.local) {
			await fn("", this.revisions.get(sessionId) ?? "");
			return;
		}
		let revision = this.revisions.get(sessionId) ?? (await this.freshRevision(sessionId));
		if (!revision) throw new Error("session revision unknown");
		let leaseId: string | undefined;
		for (let attempt = 0; attempt < 2 && !leaseId; attempt += 1) {
			try {
				const result = await this.command<{ leaseId: string }>(
					`${kind}.acquire`, { ownerId: "t4-tui" }, sessionId, revision);
				leaseId = result.leaseId;
			} catch (error) {
				if (attempt === 0) revision = await this.freshRevision(sessionId);
				else throw error;
			}
		}
		if (!leaseId || !revision) throw new Error(`${kind}.acquire failed`);
		// The acquire bumps the revision; the mutation must carry the fresh one.
		const mutationRevision = (await this.freshRevision(sessionId)) ?? revision;
		try {
			await fn(leaseId, mutationRevision);
		} finally {
			await this.command(`${kind}.release`, { leaseId }, sessionId, mutationRevision).catch(() => undefined);
		}
	}

	sessionCreate(cwd?: string) { return this.command<{ session: SessionRef }>("session.create", cwd ? { cwd } : {}); }
	attach(sessionId: string) { return this.command("session.attach", {}, sessionId); }
	async prompt(sessionId: string, text: string) {
		await this.withLease(sessionId, "prompt.lease", async (leaseId, revision) => {
			await this.command("session.prompt",
				{ message: text, ...(leaseId ? { leaseId } : {}) }, sessionId, revision || undefined);
		});
	}
	fork(sessionId: string) { return this.command<{ session: SessionRef }>("session.fork", {}, sessionId); }
	async cancel(sessionId: string) {
		await this.withLease(sessionId, "controller.lease", async (leaseId, revision) => {
			await this.command("session.cancel", { ...(leaseId ? { leaseId } : {}) }, sessionId, revision || undefined);
		});
	}
	async rename(sessionId: string, title: string) {
		await this.withLease(sessionId, "controller.lease", async (leaseId, revision) => {
			await this.command("session.rename", { name: title, ...(leaseId ? { leaseId } : {}) }, sessionId, revision || undefined);
		});
	}
	stateGet(sessionId: string) { return this.command<Frame>("session.state.get", {}, sessionId); }

	filesList(sessionId: string, path = "") { return this.command<Frame>("files.list", path ? { path } : {}, sessionId); }
	filesRead(sessionId: string, path: string) { return this.command<Frame>("files.read", { path }, sessionId); }
	filesSearch(sessionId: string, query: string) { return this.command<Frame>("files.search", { query }, sessionId); }
	filesDiff(sessionId: string) { return this.command<Frame>("files.diff", {}, sessionId); }

	termOpen(sessionId: string, cols: number, rows: number) {
		return this.command<{ terminalId: string }>("term.open", { cols, rows }, sessionId);
	}
	termInput(sessionId: string, terminalId: string, data: string) {
		this.sendRaw({ type: "terminal.input", sessionId, terminalId, data });
	}
	termResize(sessionId: string, terminalId: string, cols: number, rows: number) {
		this.sendRaw({ type: "terminal.resize", sessionId, terminalId, cols, rows });
	}
	termClose(sessionId: string, terminalId: string) {
		this.sendRaw({ type: "terminal.close", sessionId, terminalId });
	}

	close() { this.ws?.close(); }
}
