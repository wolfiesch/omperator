// client.ts — omp-app/1 client for the TUI. Speaks plain JSON frames (the
// same vocabulary the iOS HostWire package encodes), over UDS by default or
// remote ws/wss with device credentials. Tracks stream cursors so a reconnect
// can resume instead of re-snapshotting.
import WebSocket from "ws";

export interface SessionRef {
	sessionId: string;
	title: string;
	status: string;
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

export type Frame = Record<string, any>;

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

	constructor(
		private readonly endpoint: string,
		private readonly auth: { deviceId: string; deviceToken: string } | undefined,
		events: HostEvents,
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
		ws.on("message", raw => {
			let f: Frame;
			try { f = JSON.parse(raw.toString()); } catch { return; }
			if (f.type === "welcome") {
				this.hostId = f.hostId;
				this.events.open();
				resolve(f);
				return;
			}
			if (f.requestId && this.pending.has(f.requestId)) {
				const p = this.pending.get(f.requestId)!;
				this.pending.delete(f.requestId);
				clearTimeout(p.timer);
				f.ok === false ? p.reject(new Error(f.error?.message ?? f.error?.code ?? "command failed")) : p.resolve(f);
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

	private route(f: Frame): void {
		switch (f.type) {
			case "sessions": return this.events.sessions(f.sessions ?? []);
			case "snapshot": return this.events.snapshot(f.sessionId, f.entries ?? []);
			case "entry": return this.events.entry(f.sessionId, f.entry);
			case "session.delta":
				if (f.ref) this.events.status(f.sessionId ?? f.ref.sessionId, f.ref.status ?? "idle");
				return;
			case "confirmation": return this.events.confirm(f);
			case "terminal.output":
				return this.events.termOutput(f.sessionId, f.terminalId, f.stream ?? "stdout", f.data ?? "", f.encoding);
			case "terminal.exit": return this.events.termExit(f.sessionId, f.terminalId);
			case "error": return this.events.error(f.message ?? f.code ?? "host error");
		}
	}

	command<T = Frame>(command: string, args: Frame = {}, sessionId?: string): Promise<T> {
		const requestId = `t4-${++this.seq}-${Date.now()}`;
		const frame: Frame = {
			v: "omp-app/1", type: "command", requestId,
			commandId: `c-${this.seq}-${Date.now()}`,
			timestamp: new Date().toISOString(),
			hostId: this.hostId, command, args,
			...(sessionId ? { sessionId } : {}),
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

	sessionList() { return this.command<{ sessions: SessionRef[] }>("session.list"); }
	sessionCreate(cwd?: string) { return this.command<{ session: SessionRef }>("session.create", cwd ? { cwd } : {}); }
	attach(sessionId: string) { return this.command("session.attach", {}, sessionId); }
	prompt(sessionId: string, text: string) {
		return this.command("session.prompt", { input: [{ type: "text", text }] }, sessionId);
	}
	fork(sessionId: string) { return this.command<{ session: SessionRef }>("session.fork", {}, sessionId); }
	cancel(sessionId: string) { return this.command("session.cancel", {}, sessionId); }
	rename(sessionId: string, title: string, expectedRevision?: string) {
		return this.command("session.rename", { title, ...(expectedRevision ? { expectedRevision } : {}) }, sessionId);
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
