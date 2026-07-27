// tui.ts — the t4 terminal UI: session rail + live transcript + composer,
// styled after the native apps (Rosé Pine, status glyphs, unread dots).
import { T4Client, type SessionRef, type TranscriptEntry, type HostEvents } from "./client.ts";
import { Screen, wrap, clip, type Cell } from "./render.ts";
import { FG, palette as p, statusColor, RESET, BOLD, ITALIC } from "./theme.ts";

const RAIL_W = 30;

interface State {
	sessions: SessionRef[];
	selected: number;
	entries: TranscriptEntry[];
	unread: Set<string>;
	connected: boolean;
	connecting: boolean;
	statusLine: string;
	focus: "rail" | "composer";
	composer: string;
	history: string[];
	historyIdx: number;
	scroll: number; // transcript lines scrolled up from bottom
	sending: boolean;
	showHelp: boolean;
	sessionStatus: Map<string, string>;
}

export class Tui implements HostEvents {
	private state: State = {
		sessions: [], selected: 0, entries: [], unread: new Set(),
		connected: false, connecting: true, statusLine: "connecting…",
		focus: "rail", composer: "", history: [], historyIdx: -1, scroll: 0,
		sending: false, showHelp: false, sessionStatus: new Map(),
	};
	private screen = new Screen();
	private attachedId: string | undefined;

	private client!: T4Client;
	setClient(client: T4Client): void {
		this.client = client;
	}

	async run(): Promise<void> {
		if (!process.stdin.isTTY) {
			console.error("t4: needs a TTY (run it in a terminal)");
			process.exit(2);
		}
		this.screen.enter();
		process.stdout.on("resize", () => { this.screen.resize(); this.draw(); });
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (d: string) => this.input(d));
		try {
			await this.client.connect();
			this.state.connected = true;
			this.state.connecting = false;
			this.state.statusLine = "connected";
			await this.refresh();
		} catch (error) {
			this.state.connecting = false;
			this.state.statusLine = `connect failed: ${error instanceof Error ? error.message : error}`;
		}
		this.draw();
		// Keep the process alive until quit.
		const { promise, resolve } = Promise.withResolvers<void>();
		this.quit = () => resolve();
		await promise;
	}
	private quit: () => void = () => {};

	// HostEvents -------------------------------------------------------------
	sessions(sessions: SessionRef[]): void {
		this.state.sessions = sessions;
		if (this.state.selected >= sessions.length) this.state.selected = Math.max(0, sessions.length - 1);
		this.draw();
	}
	snapshot(sessionId: string, entries: TranscriptEntry[]): void {
		if (sessionId !== this.currentId()) return;
		this.state.entries = entries;
		this.state.scroll = 0;
		this.draw();
	}
	entry(sessionId: string, entry: TranscriptEntry): void {
		if (sessionId === this.currentId()) {
			this.state.entries.push(entry);
			this.state.scroll = 0;
		} else {
			this.state.unread.add(sessionId);
		}
		this.draw();
	}
	status(sessionId: string, status: string): void {
		this.state.sessionStatus.set(sessionId, status);
		this.draw();
	}
	error(message: string): void {
		this.state.statusLine = message.slice(0, 120);
		this.draw();
	}
	open(): void {}
	close(reason: string): void {
		this.state.connected = false;
		this.state.statusLine = `disconnected (${reason})`;
		this.draw();
	}

	// Actions ----------------------------------------------------------------
	private currentId(): string | undefined {
		return this.state.sessions[this.state.selected]?.sessionId;
	}
	private async refresh(): Promise<void> {
		const { sessions } = await this.client.sessionList();
		this.sessions(sessions);
		await this.attachCurrent();
	}
	private async attachCurrent(): Promise<void> {
		const id = this.currentId();
		if (!id || id === this.attachedId) return;
		this.attachedId = id;
		this.state.entries = [];
		this.state.unread.delete(id);
		this.draw();
		try {
			await this.client.attach(id);
		} catch (error) {
			this.error(`attach: ${error instanceof Error ? error.message : error}`);
		}
	}
	private async send(): Promise<void> {
		const text = this.state.composer.trim();
		const id = this.currentId();
		if (!text || !id || this.state.sending) return;
		this.state.sending = true;
		this.state.history.unshift(text);
		this.state.historyIdx = -1;
		this.state.composer = "";
		this.draw();
		try {
			await this.client.prompt(id, text);
		} catch (error) {
			this.error(`prompt: ${error instanceof Error ? error.message : error}`);
		} finally {
			this.state.sending = false;
			this.draw();
		}
	}
	private async fork(): Promise<void> {
		const id = this.currentId();
		if (!id) return;
		this.state.statusLine = "forking…";
		this.draw();
		try {
			const { session } = await this.client.fork(id);
			this.state.statusLine = `forked → ${session.title ?? session.sessionId.slice(0, 8)}`;
			await this.refresh();
			const idx = this.state.sessions.findIndex(s => s.sessionId === session.sessionId);
			if (idx >= 0) {
				this.state.selected = idx;
				this.attachedId = undefined;
				await this.attachCurrent();
			}
		} catch (error) {
			this.error(`fork: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}

	// Input -------------------------------------------------------------------
	private input(data: string): void {
		for (let i = 0; i < data.length; i += 1) {
			const ch = data[i]!;
			if (ch === "\x1b") {
				const seq = data.slice(i, i + 3);
				if (seq === "\x1b[A") this.key("up");
				else if (seq === "\x1b[B") this.key("down");
				else if (seq === "\x1b[C") this.key("right");
				else if (seq === "\x1b[D") this.key("left");
				i += 2;
				continue;
			}
			if (ch === "\r") this.key("enter");
			else if (ch === "\t") this.key("tab");
			else if (ch === "\x7f") this.key("backspace");
			else if (ch === "\x03") this.key("quit"); // ctrl-c
			else if (ch >= " ") this.text(ch);
		}
	}
	private key(name: string): void {
		const s = this.state;
		if (name === "quit") return this.destroy();
		if (s.showHelp) {
			if (name === "enter" || name === "tab") { s.showHelp = false; this.draw(); }
			return;
		}
		switch (name) {
			case "up":
				if (s.focus === "rail") {
					s.selected = Math.max(0, s.selected - 1);
					this.attachedId = undefined;
					void this.attachCurrent();
				} else if (s.history.length && s.historyIdx < s.history.length - 1) {
					s.historyIdx += 1;
					s.composer = s.history[s.historyIdx]!;
				} else s.scroll += 4;
				break;
			case "down":
				if (s.focus === "rail") {
					s.selected = Math.min(s.sessions.length - 1, s.selected + 1);
					this.attachedId = undefined;
					void this.attachCurrent();
				} else if (s.historyIdx > 0) {
					s.historyIdx -= 1;
					s.composer = s.history[s.historyIdx]!;
				} else if (s.historyIdx === 0) {
					s.historyIdx = -1;
					s.composer = "";
				} else s.scroll = Math.max(0, s.scroll - 4);
				break;
			case "tab":
				s.focus = s.focus === "rail" ? "composer" : "rail";
				break;
			case "enter":
				if (s.focus === "composer") void this.send();
				break;
			case "backspace":
				s.composer = s.composer.slice(0, -1);
				break;
		}
		this.draw();
	}
	private text(ch: string): void {
		const s = this.state;
		if (s.focus === "composer") {
			s.composer += ch;
			this.draw();
			return;
		}
		// Rail hotkeys.
		switch (ch) {
			case "j": return this.key("down");
			case "k": return this.key("up");
			case "f": void this.fork(); return;
			case "r": void this.refresh(); return;
			case "n":
				s.focus = "composer";
				this.draw();
				return;
			case "q": return this.destroy();
			case "?":
				s.showHelp = true;
				this.draw();
				return;
			case "g": s.selected = 0; this.attachedId = undefined; void this.attachCurrent(); this.draw(); return;
			case "G":
				s.selected = Math.max(0, s.sessions.length - 1);
				this.attachedId = undefined;
				void this.attachCurrent();
				this.draw();
				return;
		}
	}
	private destroy(): void {
		this.client.close();
		this.screen.exit();
		this.quit();
		process.exit(0);
	}

	// Drawing -----------------------------------------------------------------
	private draw(): void {
		const s = this.state;
		const w = this.screen.cols;
		this.drawHeader(w);
		if (s.showHelp) return this.drawHelp(w);
		const bodyRows = this.screen.rows - 4; // header(2) + composer(2)
		this.drawBody(bodyRows, w);
		this.screen.rule(p.line);
		this.drawComposer(w);
		this.screen.finish();
	}

	private drawHeader(w: number): void {
		const s = this.state;
		const dot = s.connected ? `${FG(p.ok)}●${RESET}` : s.connecting ? `${FG(p.gold)}●${RESET}` : `${FG(p.love)}●${RESET}`;
		this.screen.line([
			{ text: " t4", fg: p.ink, bold: true },
			{ text: " " },
			{ text: dot },
			{ text: "  " },
			{ text: clip(s.statusLine, w - 22), fg: p.muted },
			{ text: " ".repeat(Math.max(1, w - 22 - Math.min(s.statusLine.length, w - 22) - 12)), },
			{ text: "? help", fg: p.label },
		]);
		this.screen.rule(p.line);
	}

	private drawBody(bodyRows: number, w: number): void {
		const s = this.state;
		const mainW = w - RAIL_W - 1;
		// Transcript lines (bottom-aligned with scroll).
		const allLines: Cell[][] = [];
		for (const e of s.entries) allLines.push(...this.entryLines(e, mainW - 2));
		const visible: (Cell[] | null)[] = [];
		const end = Math.max(0, allLines.length - s.scroll);
		for (let i = Math.max(0, end - bodyRows); i < end; i += 1) visible.push(allLines[i]!);
		while (visible.length < bodyRows) visible.unshift(null);

		for (let row = 0; row < bodyRows; row += 1) {
			const rail = this.railLine(row);
			const main = visible[row];
			const sep = `${FG(p.line)}│${RESET}`;
			if (main) this.screen.line([...rail, { text: sep }, ...main]);
			else this.screen.line([...rail, { text: sep }]);
		}
	}

	private railLine(row: number): Cell[] {
		const s = this.state;
		const width = RAIL_W - 2;
		if (row === 0) return [{ text: " sessions", fg: p.label, bold: true }, { text: " ".repeat(width - 9) }, { text: " " }];
		const idx = row - 1;
		const sess = s.sessions[idx];
		if (!sess) return [{ text: " ".repeat(RAIL_W - 1) }];
		const isSel = idx === s.selected;
		const status = s.sessionStatus.get(sess.sessionId) ?? sess.status ?? "idle";
		const glyphColor = statusColor(status);
		const unread = s.unread.has(sess.sessionId);
		const title = clip(sess.title || "untitled", width - 4);
		const cells: Cell[] = [
			{ text: isSel ? "▌" : " ", fg: p.accent },
			{ text: `${FG(glyphColor)}●${RESET}` },
			{ text: " " },
			{ text: title, fg: isSel ? p.ink : p.body, bold: isSel },
			{ text: unread ? `${FG(p.gold)}•${RESET}` : "" },
		];
		const used = 2 + 2 + title.length + (unread ? 1 : 0);
		cells.push({ text: " ".repeat(Math.max(0, RAIL_W - 1 - used)) });
		return cells;
	}

	private entryLines(e: TranscriptEntry, width: number): Cell[][] {
		const data = e.data ?? {};
		const kind = e.kind ?? "entry";
		const role = (data.role as string) ?? "";
		const text = String(data.text ?? data.content ?? data.message ?? data.summary ?? "");
		const lines: Cell[][] = [];
		const head = (label: string, color: number): void => {
			lines.push([{ text: ` ${label}`, fg: color, bold: true }]);
		};
		if (role === "user" || kind === "user" || kind === "prompt") head("you", p.gold);
		else if (role === "assistant" || kind === "assistant" || kind === "message") head("agent", p.foam);
		else if (kind === "tool" || kind === "tool_call") head("tool", p.pine);
		else if (kind === "error") head("error", p.love);
		else head(kind, p.muted);
		for (const line of wrap(text, width)) lines.push([{ text: `  ${line}`, fg: p.body }]);
		return lines;
	}

	private drawComposer(w: number): void {
		const s = this.state;
		const focused = s.focus === "composer";
		const cursor = focused ? `${FG(p.accent)}▌${RESET}` : " ";
		this.screen.line([
			{ text: focused ? "› " : "  ", fg: focused ? p.accent : p.label, bold: focused },
			{ text: clip(s.composer, w - 6), fg: s.composer ? p.ink : p.ghost },
			{ text: s.composer ? "" : clip("message the agent…  (tab to focus)", w - 6), fg: p.ghost, dim: true },
			{ text: cursor },
		]);
		this.screen.line([
			{ text: " j/k move · enter open · tab composer · f fork · r refresh · q quit", fg: p.label },
		]);
	}

	private drawHelp(w: number): void {
		const lines: [string, string][] = [
			["j / k · ↑ / ↓", "move in rail / history in composer"],
			["enter", "open session · send message"],
			["tab", "switch rail ↔ composer"],
			["f", "fork current session"],
			["r", "refresh sessions"],
			["g / G", "first / last session"],
			["pg via scroll", "↑/↓ in composer scrolls transcript"],
			["q · ctrl-c", "quit"],
		];
		this.screen.blank();
		this.screen.line([{ text: "  keys", fg: p.accent, bold: true }]);
		this.screen.blank();
		for (const [k, v] of lines) {
			this.screen.line([{ text: `  ${k.padEnd(18)}`, fg: p.gold }, { text: v, fg: p.muted }]);
		}
		this.screen.blank();
		this.screen.line([{ text: "  enter to close", fg: p.label }]);
		for (let i = lines.length + 5; i < this.screen.rows - 2; i += 1) this.screen.blank();
		this.screen.rule(p.line);
		this.screen.finish();
	}
}
