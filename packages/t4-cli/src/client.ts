// client.ts — minimal omp-app/1 client for the TUI. Speaks plain JSON frames
// (the same vocabulary the iOS HostWire package encodes), over UDS by default
// or remote ws/wss with device credentials.
import WebSocket from "ws";

export interface SessionRef {
	sessionId: string;
	title: string;
	status: string;
	cwd?: string;
	project?: { name?: string; path?: string };
	updatedAt?: string;
}
export interface TranscriptEntry {
	id: string;
	kind: string;
	timestamp?: string;
	data?: Record<string, unknown>;
}
export interface HostEvents {
	sessions(sessions: SessionRef[]): void;
	snapshot(sessionId: string, entries: TranscriptEntry[]): void;
	entry(sessionId: string, entry: TranscriptEntry): void;
	status(sessionId: string, status: string): void;
	error(message: string): void;
	open(): void;
	close(reason: string): void;
}

type Frame = Record<string, any>;

export class T4Client {
	private events: HostEvents;
	private ws?: WebSocket;
	private hostId = "";
	private seq = 0;
	private pending = new Map<string, { resolve(f: Frame): void; reject(e: Error): void; timer: Timer }>();
	private savedCursors: Frame[] = [];

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
					capabilities: {
						client: [
							"sessions.read", "sessions.prompt", "sessions.control", "sessions.manage",
							"catalog.read", "files.list", "files.read", "files.diff",
							"term.open", "term.input", "term.resize",
							"preview.control", "preview.read", "usage.read", "agents.control",
							"audit.read", "config.read",
						],
					},
					client: { name: "t4-tui", version: "0.1", build: "dev", platform: process.platform },
					requestedFeatures: [
						"resume", "prompt.lease", "controller.lease", "prompt.images", "transcript.page",
						"session.delta", "files.list", "terminal.io", "preview.control",
						"files.search", "transcript.search", "session.watch", "host.watch", "project.reveal",
					],
					savedCursors: this.savedCursors,
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
				if (f.ref?.status) this.events.status(f.sessionId ?? f.ref.sessionId, f.ref.status);
				if (f.ref) this.events.status(f.sessionId ?? f.ref.sessionId, f.ref.status ?? "idle");
				return;
			case "error": return this.events.error(f.message ?? f.code ?? "host error");
			case "confirmation":
				// TUI auto-approves nothing: surface as an error so the user sees it.
				return this.events.error(`confirmation required for ${f.commandId ?? "command"}`);
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

	sessionList() { return this.command<{ sessions: SessionRef[] }>("session.list"); }
	attach(sessionId: string) { return this.command("session.attach", {}, sessionId); }
	prompt(sessionId: string, text: string) {
		return this.command("session.prompt", { input: [{ type: "text", text }] }, sessionId);
	}
	fork(sessionId: string) { return this.command<{ session: SessionRef }>("session.fork", {}, sessionId); }
	close() { this.ws?.close(); }
}
