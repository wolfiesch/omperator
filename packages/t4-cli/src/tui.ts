// tui.ts — the t4 terminal UI, feature-parity with the desktop app: session
// rail (project-grouped, filtered), live rich transcript, composer with full
// editing and history, files/search/diff panes, and a live host terminal —
// all mouse-clickable (SGR 1002/1006, works over ssh) and styled after the
// native apps (Rosé Pine lineage).
import { T4Client, type SessionRef, type TranscriptEntry, type HostEvents, type Frame } from "./client.ts";
import { Screen, wrap, clip, type Cell } from "./render.ts";
import { FG, palette as p, statusColor, RESET } from "./theme.ts";

const RAIL_W = 28;
const PANES = ["chat", "files", "search", "diff", "term"] as const;
type Pane = (typeof PANES)[number];

type RailRow = { type: "group"; label: string } | { type: "session"; index: number };

interface FileEntry { path: string; kind: string; size?: number }

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
	cursorIdx: number;
	history: string[];
	historyIdx: number;
	scroll: number;
	sending: boolean;
	showHelp: boolean;
	sessionStatus: Map<string, string>;
	pane: Pane;
	filter: string;
	filtering: boolean;
	renameActive: boolean;
	pendingConfirm: Frame | undefined;
	// files pane
	filePath: string;
	fileEntries: FileEntry[];
	fileSelected: number;
	fileScroll: number;
	fileView: { path: string; lines: string[]; scroll: number; truncated: boolean } | undefined;
	// search pane
	searchQuery: string;
	searchResults: string[];
	searchSelected: number;
	searchScroll: number;
	searching: boolean;
	// diff pane
	diffLines: string[];
	diffScroll: number;
	diffLoadedFor: string | undefined;
	// term pane
	terminalId: string | undefined;
	termOpenedFor: string | undefined;
	termBuf: string[];
	termScroll: number;
}

export class Tui implements HostEvents {
	private state: State = {
		sessions: [], selected: 0, entries: [], unread: new Set(),
		connected: false, connecting: true, statusLine: "connecting…",
		focus: "rail", composer: "", cursorIdx: 0, history: [], historyIdx: -1, scroll: 0,
		sending: false, showHelp: false, sessionStatus: new Map(),
		pane: "chat", filter: "", filtering: false, renameActive: false, pendingConfirm: undefined,
		filePath: "", fileEntries: [], fileSelected: 0, fileScroll: 0, fileView: undefined,
		searchQuery: "", searchResults: [], searchSelected: 0, searchScroll: 0, searching: false,
		diffLines: [], diffScroll: 0, diffLoadedFor: undefined,
		terminalId: undefined, termOpenedFor: undefined, termBuf: [], termScroll: 0,
	};
	private screen = new Screen();
	private attachedId: string | undefined;
	private client!: T4Client;
	private reconnectDelay = 1;
	private searchTimer: Timer | undefined;

	setClient(client: T4Client): void {
		this.client = client;
	}

	async run(): Promise<void> {
		process.stdout.on("resize", () => {
			this.screen.resize();
			if (this.state.pane === "term" && this.state.terminalId && this.currentId())
				this.client.termResize(this.currentId()!, this.state.terminalId, this.termCols(), this.termRows());
			this.draw();
		});
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", d => this.input(d.toString("utf8")));
		this.screen.enter();
		// SGR mouse: button events + any-motion + SGR extended coords.
		process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
		void this.connectLoop();
		await new Promise<void>(resolve => {
			this.quit = resolve;
		});
	}

	private quit: () => void = () => {};

	private async connectLoop(): Promise<void> {
		for (;;) {
			try {
				this.state.connecting = true;
				this.draw();
				await this.client.connect();
				this.reconnectDelay = 1;
				await this.refresh();
				return; // connected; close() event re-enters the loop
			} catch (error) {
				this.state.connecting = false;
				this.state.statusLine = `connect failed (${error instanceof Error ? error.message : error}) — retry in ${this.reconnectDelay}s`;
				this.draw();
				await new Promise(r => setTimeout(r, this.reconnectDelay * 1000));
				this.reconnectDelay = Math.min(15, this.reconnectDelay * 2);
			}
		}
	}

	// HostEvents ---------------------------------------------------------------

	open(): void {
		this.state.connected = true;
		this.state.connecting = false;
		this.state.statusLine = "connected";
		this.draw();
	}
	close(reason: string): void {
		this.state.connected = false;
		this.state.terminalId = undefined;
		this.state.termOpenedFor = undefined;
		this.state.statusLine = `disconnected (${reason}) — reconnecting…`;
		this.draw();
		setTimeout(() => void this.connectLoop().then(() => this.refresh()).catch(() => undefined), 1000);
	}
	error(message: string): void {
		this.state.statusLine = `error: ${message}`;
		this.draw();
	}
	sessions(sessions: SessionRef[]): void {
		this.state.sessions = sessions;
		this.draw();
	}
	snapshot(sessionId: string, entries: TranscriptEntry[]): void {
		if (sessionId !== this.currentId()) return;
		this.state.entries = entries;
		this.draw();
	}
	entry(sessionId: string, entry: TranscriptEntry): void {
		if (sessionId === this.currentId()) {
			this.state.entries.push(entry);
		} else {
			this.state.unread.add(sessionId);
		}
		this.draw();
	}
	status(sessionId: string, status: string): void {
		this.state.sessionStatus.set(sessionId, status);
		this.draw();
	}
	confirm(frame: Frame): void {
		this.state.pendingConfirm = frame;
		this.state.statusLine = `confirm: ${frame.summary ?? frame.commandId ?? "command"} — y accept / n reject`;
		this.draw();
	}
	termOutput(_sessionId: string, terminalId: string, _stream: string, data: string, encoding?: string): void {
		if (terminalId !== this.state.terminalId) return;
		const text = encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
		// Strip ANSI control sequences for the tail view; keep it readable.
		const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
		for (const line of clean.split("\n")) {
			this.state.termBuf.push(line);
			if (this.state.termBuf.length > 2000) this.state.termBuf.shift();
		}
		if (this.state.pane === "term") this.draw();
	}
	termExit(_sessionId: string, terminalId: string): void {
		if (terminalId === this.state.terminalId) {
			this.state.terminalId = undefined;
			this.state.termOpenedFor = undefined;
			this.state.termBuf.push("— terminal exited —");
			this.draw();
		}
	}

	// Selection helpers ---------------------------------------------------------

	private currentId(): string | undefined {
		return this.state.sessions[this.state.selected]?.sessionId;
	}

	/** Visible rail rows: project group headers + filtered session rows. */
	private railRows(): RailRow[] {
		const s = this.state;
		const rows: RailRow[] = [];
		const q = s.filter.trim().toLowerCase();
		let lastGroup = "";
		s.sessions.forEach((sess, index) => {
			if (q && !sess.title.toLowerCase().includes(q) && !(sess.project?.name ?? "").toLowerCase().includes(q)) return;
			const group = sess.project?.name ?? "sessions";
			if (group !== lastGroup) {
				rows.push({ type: "group", label: group });
				lastGroup = group;
			}
			rows.push({ type: "session", index });
		});
		return rows;
	}

	private async refresh(): Promise<void> {
		const { sessions } = await this.client.sessionList();
		this.state.sessions = sessions;
		this.draw();
		await this.attachCurrent();
	}
	private async attachCurrent(): Promise<void> {
		const id = this.currentId();
		if (!id || id === this.attachedId) return;
		this.attachedId = id;
		this.state.entries = [];
		this.state.scroll = 0;
		this.state.unread.delete(id);
		this.state.diffLoadedFor = undefined;
		this.state.fileView = undefined;
		this.state.terminalId = undefined;
		this.state.termOpenedFor = undefined;
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
		this.state.cursorIdx = 0;
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
	private async cancelTurn(): Promise<void> {
		const id = this.currentId();
		if (!id) return;
		this.state.statusLine = "cancelling…";
		this.draw();
		try {
			await this.client.cancel(id);
			this.state.statusLine = "turn cancelled";
		} catch (error) {
			this.error(`cancel: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}
	private async newSession(): Promise<void> {
		this.state.statusLine = "creating session…";
		this.draw();
		try {
			const cwd = this.state.sessions[this.state.selected]?.cwd;
			const { session } = await this.client.sessionCreate(cwd);
			await this.refresh();
			const idx = this.state.sessions.findIndex(s => s.sessionId === session.sessionId);
			if (idx >= 0) {
				this.state.selected = idx;
				this.attachedId = undefined;
				await this.attachCurrent();
			}
			this.state.focus = "composer";
			this.state.statusLine = `new session → ${session.title ?? "untitled"}`;
		} catch (error) {
			this.error(`new: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}
	private async submitRename(): Promise<void> {
		const id = this.currentId();
		const title = this.state.composer.trim();
		this.state.renameActive = false;
		this.state.composer = "";
		this.state.cursorIdx = 0;
		if (!id || !title) { this.draw(); return; }
		try {
			await this.client.rename(id, title);
			await this.refresh();
			this.state.statusLine = `renamed → ${title}`;
		} catch (error) {
			this.error(`rename: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}

	// Pane loaders ---------------------------------------------------------------

	private async loadFiles(path: string): Promise<void> {
		const id = this.currentId();
		if (!id) return;
		try {
			const result = await this.client.filesList(id, path);
			this.state.filePath = path;
			this.state.fileEntries = (result.entries ?? []) as FileEntry[];
			this.state.fileSelected = 0;
			this.state.fileScroll = 0;
			this.state.fileView = undefined;
		} catch (error) {
			this.error(`files: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}
	private async openFile(path: string): Promise<void> {
		const id = this.currentId();
		if (!id) return;
		try {
			const result = await this.client.filesRead(id, path);
			const content = typeof result.content === "string" ? result.content : "(binary file)";
			this.state.fileView = { path, lines: content.split("\n"), scroll: 0, truncated: result.truncated === true };
		} catch (error) {
			this.error(`read: ${error instanceof Error ? error.message : error}`);
		}
		this.draw();
	}
	private async runSearch(): Promise<void> {
		const id = this.currentId();
		const q = this.state.searchQuery.trim();
		if (!id || !q) { this.state.searchResults = []; this.draw(); return; }
		this.state.searching = true;
		this.draw();
		try {
			const result = await this.client.filesSearch(id, q);
			this.state.searchResults = (result.matches ?? []).map((m: Frame) => m.path as string);
			this.state.searchSelected = 0;
			this.state.searchScroll = 0;
		} catch (error) {
			this.error(`search: ${error instanceof Error ? error.message : error}`);
		} finally {
			this.state.searching = false;
			this.draw();
		}
	}
	private async loadDiff(): Promise<void> {
		const id = this.currentId();
		if (!id || this.state.diffLoadedFor === id) return;
		this.state.diffLines = ["loading diff…"];
		this.draw();
		try {
			const result = await this.client.filesDiff(id);
			const text = typeof result.diff === "string" && result.diff.length > 0 ? result.diff : "no working-tree changes";
			this.state.diffLines = text.split("\n");
			this.state.diffScroll = 0;
			this.state.diffLoadedFor = id;
		} catch (error) {
			this.state.diffLines = [`files.diff failed: ${error instanceof Error ? error.message : error}`];
		}
		this.draw();
	}
	private termCols(): number { return this.screen.cols; }
	private termRows(): number { return Math.max(4, this.screen.rows - 5); }
	private async ensureTerminal(): Promise<void> {
		const id = this.currentId();
		if (!id || this.state.termOpenedFor === id) return;
		this.state.termBuf = [`opening terminal for ${id.slice(0, 8)}…`];
		this.draw();
		try {
			const { terminalId } = await this.client.termOpen(id, this.termCols(), this.termRows());
			this.state.terminalId = terminalId;
			this.state.termOpenedFor = id;
			this.state.termBuf = [];
		} catch (error) {
			this.state.termBuf = [`term.open failed: ${error instanceof Error ? error.message : error}`];
		}
		this.draw();
	}

	private setPane(pane: Pane): void {
		this.state.pane = pane;
		if (pane === "files") void this.loadFiles(this.state.filePath);
		if (pane === "diff") void this.loadDiff();
		if (pane === "term") void this.ensureTerminal();
		this.draw();
	}

	// Input ----------------------------------------------------------------------

	private input(data: string): void {
		for (let i = 0; i < data.length; i += 1) {
			const ch = data[i]!;
			if (ch === "\x1b") {
				// SGR mouse: \x1b[<b;x;yM (down) / \x1b[<b;x;ym (up)
				if (data[i + 1] === "[<") {
					const upIdx = data.indexOf("m", i + 3);
					const downIdx = data.indexOf("M", i + 3);
					const end = downIdx !== -1 && (upIdx === -1 || downIdx < upIdx) ? downIdx : upIdx;
					if (end !== -1) {
						const m = data.slice(i + 3, end).split(";").map(Number);
						this.mouse(m[0]!, m[1]!, m[2]!, end === downIdx);
						i = end;
						continue;
					}
				}
				const seq = data.slice(i, i + 3);
				if (seq === "\x1b[A") this.key("up");
				else if (seq === "\x1b[B") this.key("down");
				else if (seq === "\x1b[C") this.key("right");
				else if (seq === "\x1b[D") this.key("left");
				else if (data.slice(i, i + 4) === "\x1b[5~") { this.key("pageup"); i += 1; }
				else if (data.slice(i, i + 4) === "\x1b[6~") { this.key("pagedown"); i += 1; }
				else if (seq === "\x1b[H") this.key("home");
				else if (seq === "\x1b[F") this.key("end");
				else if (data.length === i + 1) { this.key("escape"); }
				i += 2;
				continue;
			}
			if (ch === "\r") this.key("enter");
			else if (ch === "\t") this.key("tab");
			else if (ch === "\x7f") this.key("backspace");
			else if (ch === "\x03") this.key("quit");
			else if (ch === "\x1b") this.key("escape");
			else if (ch === "\x01") this.key("home");
			else if (ch === "\x05") this.key("end");
			else if (ch === "\x15") {
				const s = this.state;
				if (s.pane === "search") { s.searchQuery = ""; this.scheduleSearch(); }
				else { s.composer = ""; s.cursorIdx = 0; }
				this.draw();
			}
			else if (ch >= " ") this.text(ch);
		}
	}

	private mouse(btn: number, x: number, y: number, down: boolean): void {
		const s = this.state;
		if (btn === 64 || btn === 65) {
			const delta = btn === 64 ? 3 : -3;
			if (s.pane === "chat") s.scroll = Math.max(0, Math.min(this.maxScroll(), s.scroll + delta));
			else if (s.pane === "files") {
				if (s.fileView) s.fileView.scroll = Math.max(0, Math.min(Math.max(0, s.fileView.lines.length - 1), s.fileView.scroll + delta));
				else s.fileScroll = Math.max(0, Math.min(Math.max(0, s.fileEntries.length - 1), s.fileScroll + delta));
			} else if (s.pane === "search") s.searchScroll = Math.max(0, Math.min(Math.max(0, s.searchResults.length - 1), s.searchScroll + delta));
			else if (s.pane === "diff") s.diffScroll = Math.max(0, Math.min(Math.max(0, s.diffLines.length - 1), s.diffScroll + delta));
			else if (s.pane === "term") s.termScroll = Math.max(0, Math.min(Math.max(0, s.termBuf.length - 1), s.termScroll + delta));
			this.draw();
			return;
		}
		if (!down || btn !== 0) return;
		// Tab bar row.
		if (y === 2) {
			let col = 2;
			for (const name of PANES) {
				const w = name.length + 2;
				if (x >= col && x < col + w) { this.setPane(name); return; }
				col += w + 1;
			}
			return;
		}
		if (s.pane !== "chat") return;
		if (x <= RAIL_W + 1) {
			const rows = this.railRows();
			const row = rows[y - 4];
			if (row?.type === "session") {
				s.selected = row.index;
				this.attachedId = undefined;
				void this.attachCurrent();
			}
			return;
		}
		if (y >= this.screen.rows - 2) {
			s.focus = "composer";
			this.draw();
		}
	}

	private key(name: string): void {
		const s = this.state;
		if (name === "quit") return this.destroy();
		if (s.pendingConfirm) {
			if (name === "escape") {
				this.client.confirmAnswer(s.pendingConfirm, "reject");
				s.pendingConfirm = undefined;
				s.statusLine = "rejected";
				this.draw();
			}
			return;
		}
		if (s.showHelp) {
			if (name === "enter" || name === "escape") { s.showHelp = false; this.draw(); }
			return;
		}
		if (s.filtering) {
			if (name === "enter" || name === "escape") { s.filtering = false; if (name === "escape") s.filter = ""; this.draw(); }
			else if (name === "backspace") { s.filter = s.filter.slice(0, -1); this.draw(); }
			return;
		}
		if (s.pane === "files") return this.filesKey(name);
		if (s.pane === "search") return this.searchKey(name);
		if (s.pane === "diff") return this.diffKey(name);
		if (s.pane === "term") return this.termKey(name);

		switch (name) {
			case "up":
				if (s.focus === "rail") this.moveSelection(-1);
				else if (s.historyIdx < s.history.length - 1) {
					s.historyIdx += 1;
					s.composer = s.history[s.historyIdx]!;
					s.cursorIdx = s.composer.length;
				} else s.scroll = Math.min(this.maxScroll(), s.scroll + 1);
				break;
			case "down":
				if (s.focus === "rail") this.moveSelection(1);
				else if (s.historyIdx > 0) {
					s.historyIdx -= 1;
					s.composer = s.history[s.historyIdx]!;
					s.cursorIdx = s.composer.length;
				} else if (s.historyIdx === 0) {
					s.historyIdx = -1;
					s.composer = "";
					s.cursorIdx = 0;
				} else s.scroll = Math.max(0, s.scroll - 1);
				break;
			case "pageup": s.scroll = Math.min(this.maxScroll(), s.scroll + this.bodyRows() - 4); break;
			case "pagedown": s.scroll = Math.max(0, s.scroll - (this.bodyRows() - 4)); break;
			case "left": if (s.focus === "composer") s.cursorIdx = Math.max(0, s.cursorIdx - 1); break;
			case "right": if (s.focus === "composer") s.cursorIdx = Math.min(s.composer.length, s.cursorIdx + 1); break;
			case "home": if (s.focus === "composer") s.cursorIdx = 0; break;
			case "end": if (s.focus === "composer") s.cursorIdx = s.composer.length; break;
			case "tab":
				s.focus = s.focus === "rail" ? "composer" : "rail";
				break;
			case "escape":
				if (s.focus === "composer" && s.composer) { s.composer = ""; s.cursorIdx = 0; }
				else s.focus = "rail";
				break;
			case "enter":
				if (s.focus === "composer") {
					if (s.renameActive) void this.submitRename();
					else void this.send();
				}
				break;
			case "backspace":
				if (s.focus === "composer" && s.cursorIdx > 0) {
					s.composer = s.composer.slice(0, s.cursorIdx - 1) + s.composer.slice(s.cursorIdx);
					s.cursorIdx -= 1;
				}
				break;
		}
		this.draw();
	}

	private moveSelection(delta: number): void {
		const s = this.state;
		s.selected = Math.max(0, Math.min(s.sessions.length - 1, s.selected + delta));
		this.attachedId = undefined;
		void this.attachCurrent();
	}

	private filesKey(name: string): void {
		const s = this.state;
		if (s.fileView) {
			switch (name) {
				case "up": s.fileView.scroll = Math.max(0, s.fileView.scroll - 1); break;
				case "down": s.fileView.scroll = Math.min(Math.max(0, s.fileView.lines.length - 1), s.fileView.scroll + 1); break;
				case "pageup": s.fileView.scroll = Math.max(0, s.fileView.scroll - (this.bodyRows() - 2)); break;
				case "pagedown": s.fileView.scroll = Math.min(Math.max(0, s.fileView.lines.length - 1), s.fileView.scroll + this.bodyRows() - 2); break;
				case "escape": case "backspace": s.fileView = undefined; break;
			}
			this.draw();
			return;
		}
		switch (name) {
			case "up": s.fileSelected = Math.max(0, s.fileSelected - 1); break;
			case "down": s.fileSelected = Math.min(s.fileEntries.length - 1, s.fileSelected + 1); break;
			case "pageup": s.fileSelected = Math.max(0, s.fileSelected - (this.bodyRows() - 2)); break;
			case "pagedown": s.fileSelected = Math.min(s.fileEntries.length - 1, s.fileSelected + this.bodyRows() - 2); break;
			case "backspace": {
				if (!s.filePath) break;
				void this.loadFiles(s.filePath.split("/").slice(0, -1).join("/"));
				break;
			}
			case "escape": this.setPane("chat"); return;
			case "enter": {
				const entry = s.fileEntries[s.fileSelected];
				if (!entry) break;
				const full = s.filePath ? `${s.filePath}/${entry.path}` : entry.path;
				if (entry.kind === "directory") void this.loadFiles(full);
				else void this.openFile(full);
				break;
			}
		}
		this.draw();
	}

	private searchKey(name: string): void {
		const s = this.state;
		switch (name) {
			case "up": s.searchSelected = Math.max(0, s.searchSelected - 1); break;
			case "down": s.searchSelected = Math.min(s.searchResults.length - 1, s.searchSelected + 1); break;
			case "backspace":
				s.searchQuery = s.searchQuery.slice(0, -1);
				this.scheduleSearch();
				break;
			case "escape": this.setPane("chat"); return;
			case "enter": {
				const path = s.searchResults[s.searchSelected];
				if (path) { this.setPane("files"); void this.openFile(path); }
				break;
			}
		}
		this.draw();
	}

	private scheduleSearch(): void {
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = setTimeout(() => void this.runSearch(), 300);
	}

	private diffKey(name: string): void {
		const s = this.state;
		switch (name) {
			case "up": s.diffScroll = Math.max(0, s.diffScroll - 1); break;
			case "down": s.diffScroll = Math.min(Math.max(0, s.diffLines.length - 1), s.diffScroll + 1); break;
			case "pageup": s.diffScroll = Math.max(0, s.diffScroll - (this.bodyRows() - 2)); break;
			case "pagedown": s.diffScroll = Math.min(Math.max(0, s.diffLines.length - 1), s.diffScroll + this.bodyRows() - 2); break;
			case "escape": this.setPane("chat"); return;
		}
		this.draw();
	}

	private termKey(name: string): void {
		const s = this.state;
		const id = this.currentId();
		if (!id || !s.terminalId) {
			if (name === "escape") { this.setPane("chat"); return; }
			return;
		}
		const tid = s.terminalId;
		switch (name) {
			case "escape": this.setPane("chat"); return;
			case "up": s.termScroll = Math.min(Math.max(0, s.termBuf.length - 1), s.termScroll + 1); break;
			case "down": s.termScroll = Math.max(0, s.termScroll - 1); break;
			case "pageup": s.termScroll = Math.min(Math.max(0, s.termBuf.length - 1), s.termScroll + this.bodyRows() - 2); break;
			case "pagedown": s.termScroll = Math.max(0, s.termScroll - (this.bodyRows() - 2)); break;
			case "enter": this.client.termInput(id, tid, "\r"); break;
			case "backspace": this.client.termInput(id, tid, "\x7f"); break;
			case "left": this.client.termInput(id, tid, "\x1b[D"); break;
			case "right": this.client.termInput(id, tid, "\x1b[C"); break;
			case "tab": this.client.termInput(id, tid, "\t"); break;
			default: return;
		}
		this.draw();
	}

	private text(ch: string): void {
		const s = this.state;
		if (s.pendingConfirm) {
			if (ch === "y" || ch === "n") {
				this.client.confirmAnswer(s.pendingConfirm, ch === "y" ? "accept" : "reject");
				s.statusLine = ch === "y" ? "accepted" : "rejected";
				s.pendingConfirm = undefined;
				this.draw();
			}
			return;
		}
		if (s.showHelp) return;
		if (s.filtering) { s.filter += ch; this.draw(); return; }
		// Pane switching: digits work where they aren't text input (chat rail,
		// files, diff) — search and term treat them as keystrokes.
		const digitPane = ch >= "1" && ch <= "5" &&
			((s.pane === "chat" && s.focus === "rail") || s.pane === "files" || s.pane === "diff");
		if (digitPane) {
			const pane = PANES[Number(ch) - 1]!;
			if (pane !== s.pane) this.setPane(pane);
			return;
		}
		if (s.pane === "search") {
			s.searchQuery += ch;
			this.scheduleSearch();
			this.draw();
			return;
		}
		if (s.pane === "term") {
			const id = this.currentId();
			if (id && s.terminalId) this.client.termInput(id, s.terminalId, ch);
			return;
		}
		if (s.pane !== "chat") return;
		if (s.focus === "composer") {
			s.composer = s.composer.slice(0, s.cursorIdx) + ch + s.composer.slice(s.cursorIdx);
			s.cursorIdx += ch.length;
			this.draw();
			return;
		}
		switch (ch) {
			case "j": return this.key("down");
			case "k": return this.key("up");
			case "f": void this.fork(); return;
			case "x": void this.cancelTurn(); return;
			case "r": void this.refresh(); return;
			case "n": void this.newSession(); return;
			case "e":
				s.renameActive = true;
				s.composer = s.sessions[s.selected]?.title ?? "";
				s.cursorIdx = s.composer.length;
				s.focus = "composer";
				this.draw();
				return;
			case "/":
				s.filtering = true;
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
		process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
		this.screen.exit();
		this.client.close();
		this.quit();
	}

	// Drawing ----------------------------------------------------------------------

	private maxScroll(): number {
		return Math.max(0, this.transcriptLines().length - (this.bodyRows() - 2));
	}
	private bodyRows(): number {
		return this.screen.rows - (this.state.pane === "chat" ? 6 : 4);
	}

	private transcriptLines(): Cell[][] {
		const s = this.state;
		const w = this.screen.cols - RAIL_W - 4;
		const lines: Cell[][] = [];
		for (const e of s.entries) lines.push(...this.entryLines(e, w));
		return lines;
	}

	private draw(): void {
		const s = this.state;
		if (s.showHelp) return this.drawHelp();
		this.drawHeader();
		this.drawTabs();
		this.screen.rule(p.line);
		switch (s.pane) {
			case "chat": this.drawChat(); break;
			case "files": this.drawFiles(); break;
			case "search": this.drawSearch(); break;
			case "diff": this.drawDiff(); break;
			case "term": this.drawTerm(); break;
		}
		this.screen.rule(p.line);
		this.drawFooter();
		this.screen.finish();
	}

	private drawHeader(): void {
		const s = this.state;
		const sess = s.sessions[s.selected];
		const dot = s.connected ? "●" : "○";
		const status = sess ? (s.sessionStatus.get(sess.sessionId) ?? sess.status ?? "") : "";
		this.screen.line([
			{ text: ` t4 `, fg: p.accent, bold: true },
			{ text: dot, fg: s.connected ? p.ok : p.love },
			{ text: ` ${clip(s.statusLine, 32)}`, fg: p.muted },
			{ text: sess ? `  ${clip(sess.title, 40)}` : "", fg: p.ink, bold: true },
			{ text: status ? `  ${status}` : "", fg: statusColor(status), dim: true },
		]);
	}

	private drawTabs(): void {
		const s = this.state;
		const cells: Cell[] = [{ text: " " }];
		for (const name of PANES) {
			if (s.pane === name) cells.push({ text: `${FG(p.accent)}\x1b[7m ${name} ${RESET}` });
			else cells.push({ text: ` ${name} `, fg: p.label });
			cells.push({ text: " " });
		}
		this.screen.line(cells);
	}

	private drawChat(): void {
		const rows = this.railRows();
		const transcript = this.transcriptLines();
		const bodyRows = this.bodyRows();
		const s = this.state;
		const tStart = Math.max(0, transcript.length - bodyRows - s.scroll);
		const tEnd = Math.max(0, transcript.length - s.scroll);
		const tSlice = transcript.slice(tStart, tEnd);

		for (let i = 0; i < bodyRows; i += 1) {
			const railRow = rows[i];
			const railCells = railRow ? this.railCells(railRow) : [{ text: "".padEnd(RAIL_W) }];
			const tCells = tSlice[i] ?? [];
			this.screen.line([...railCells, { text: " │ ", fg: p.line }, ...tCells]);
		}
	}

	private railCells(row: RailRow): Cell[] {
		const s = this.state;
		if (row.type === "group") {
			return [{ text: clip(` ${row.label}`, RAIL_W), fg: p.label, dim: true }];
		}
		const sess = s.sessions[row.index]!;
		const isSel = row.index === s.selected;
		const unread = s.unread.has(sess.sessionId);
		const status = s.sessionStatus.get(sess.sessionId) ?? sess.status ?? "";
		return [
			{ text: isSel ? "▌" : " ", fg: p.accent },
			{ text: unread ? "●" : status ? "•" : " ", fg: unread ? p.gold : statusColor(status) },
			{ text: clip(` ${sess.title}`, RAIL_W - 3), fg: isSel ? p.ink : p.muted, bold: isSel },
		];
	}

	private entryLines(e: TranscriptEntry, width: number): Cell[][] {
		const kind = e.kind ?? "entry";
		const data = e.data ?? {};
		const role = (data.role as string) ?? "";
		const headline = e.headline ?? "";
		const body = e.body ?? String(data.text ?? data.content ?? "");
		const ts = e.timestamp ? e.timestamp.slice(11, 16) : "";
		const lines: Cell[][] = [];

		let label = kind;
		let color: number = p.muted;
		if (role === "user" || kind === "user" || kind === "prompt") { label = "you"; color = p.gold; }
		else if (role === "assistant" || kind === "message") { label = "agent"; color = p.foam; }
		else if (kind === "tool-use" || kind === "tool" || kind === "tool_call") { label = "tool"; color = p.pine; }
		else if (kind === "tool-result" || kind === "tool_result") { label = "result"; color = p.iris; }
		else if (kind === "turn-review") { label = "review"; color = p.iris; }
		else if (kind === "error") { label = "error"; color = p.love; }
		else if (kind === "compaction") { label = "compact"; color = p.label; }

		const pad = Math.max(1, width - label.length - ts.length - 4);
		lines.push([
			{ text: ` ${label}`, fg: color, bold: true },
			{ text: ts ? `${" ".repeat(pad)}${ts}` : "", fg: p.ghost, dim: true },
		]);
		if (headline && headline !== label) {
			for (const line of wrap(headline, width - 2)) lines.push([{ text: `  ${line}`, fg: p.ink, bold: true }]);
		}
		if (body) {
			const dim = kind === "compaction" || /think/i.test(kind);
			for (const line of wrap(body, width - 2)) lines.push([{ text: `  ${line}`, fg: dim ? p.muted : p.body, dim }]);
		}
		if (lines.length === 1) lines.push([{ text: " ", fg: p.ghost }]);
		return lines;
	}

	private drawFiles(): void {
		const s = this.state;
		const bodyRows = this.bodyRows();
		if (s.fileView) {
			const v = s.fileView;
			this.screen.line([{ text: ` ${v.path}${v.truncated ? "  (truncated)" : ""}`, fg: p.accent, bold: true }]);
			const start = Math.min(v.scroll, Math.max(0, v.lines.length - (bodyRows - 1)));
			for (let i = 0; i < bodyRows - 1; i += 1) {
				const idx = start + i;
				if (idx >= v.lines.length) { this.screen.blank(); continue; }
				this.screen.line([
					{ text: `${String(idx + 1).padStart(5)} `, fg: p.ghost, dim: true },
					{ text: clip(v.lines[idx]!, this.screen.cols - 8), fg: p.body },
				]);
			}
			return;
		}
		this.screen.line([{ text: ` /${s.filePath}`, fg: p.accent, bold: true }, { text: `  ${s.fileEntries.length} entries`, fg: p.label, dim: true }]);
		const start = Math.min(s.fileScroll, Math.max(0, s.fileEntries.length - (bodyRows - 1)));
		for (let i = 0; i < bodyRows - 1; i += 1) {
			const idx = start + i;
			const entry = s.fileEntries[idx];
			if (!entry) { this.screen.blank(); continue; }
			const isSel = idx === s.fileSelected;
			const icon = entry.kind === "directory" ? "▸" : entry.kind === "symlink" ? "↪" : " ";
			const size = entry.size !== undefined && entry.kind !== "directory" ? `${entry.size}b` : "";
			this.screen.line([
				{ text: isSel ? "▌" : " ", fg: p.accent },
				{ text: `${icon} `, fg: entry.kind === "directory" ? p.pine : p.ghost },
				{ text: clip(entry.path, this.screen.cols - 18), fg: isSel ? p.ink : entry.kind === "directory" ? p.pine : p.body, bold: isSel },
				{ text: size ? ` ${size}` : "", fg: p.label, dim: true },
			]);
		}
	}

	private drawSearch(): void {
		const s = this.state;
		const bodyRows = this.bodyRows();
		this.screen.line([
			{ text: " /", fg: p.accent, bold: true },
			{ text: clip(s.searchQuery, this.screen.cols - 12), fg: p.ink },
			{ text: s.searching ? "  searching…" : s.searchQuery ? `  ${s.searchResults.length} matches` : "  search files by name", fg: p.label, dim: true },
		]);
		const start = Math.min(s.searchScroll, Math.max(0, s.searchResults.length - (bodyRows - 1)));
		for (let i = 0; i < bodyRows - 1; i += 1) {
			const idx = start + i;
			const path = s.searchResults[idx];
			if (!path) { this.screen.blank(); continue; }
			const isSel = idx === s.searchSelected;
			this.screen.line([
				{ text: isSel ? "▌" : " ", fg: p.accent },
				{ text: clip(path, this.screen.cols - 4), fg: isSel ? p.ink : p.body, bold: isSel },
			]);
		}
	}

	private drawDiff(): void {
		const s = this.state;
		const bodyRows = this.bodyRows();
		const start = Math.min(s.diffScroll, Math.max(0, s.diffLines.length - bodyRows));
		for (let i = 0; i < bodyRows; i += 1) {
			const line = s.diffLines[start + i];
			if (line === undefined) { this.screen.blank(); continue; }
			let fg: number = p.body;
			if (line.startsWith("+") && !line.startsWith("+++")) fg = p.ok;
			else if (line.startsWith("-") && !line.startsWith("---")) fg = p.love;
			else if (line.startsWith("@@")) fg = p.iris;
			else if (line.startsWith("diff ") || line.startsWith("index ")) fg = p.pine;
			this.screen.line([{ text: clip(line, this.screen.cols - 2), fg }]);
		}
	}

	private drawTerm(): void {
		const s = this.state;
		const bodyRows = this.bodyRows();
		const start = Math.max(0, s.termBuf.length - bodyRows - s.termScroll);
		const end = Math.max(0, s.termBuf.length - s.termScroll);
		const slice = s.termBuf.slice(start, end);
		for (let i = 0; i < bodyRows; i += 1) {
			const line = slice[i];
			if (line === undefined) { this.screen.blank(); continue; }
			this.screen.line([{ text: clip(line, this.screen.cols - 2), fg: p.body }]);
		}
	}

	private drawFooter(): void {
		const s = this.state;
		if (s.pane === "chat") {
			const focused = s.focus === "composer";
			const label = s.renameActive ? "rename: " : "› ";
			const before = s.composer.slice(0, s.cursorIdx);
			const at = s.composer[s.cursorIdx] ?? " ";
			const after = s.composer.slice(s.cursorIdx + 1);
			this.screen.line([
				{ text: focused ? label : `  ${label.trim()} `, fg: focused ? p.accent : p.label, bold: focused },
				...(s.composer
					? focused
						? [{ text: before, fg: p.ink }, { text: `${FG(p.accent)}\x1b[7m${at}${RESET}` }, { text: after, fg: p.ink }]
						: [{ text: clip(s.composer, this.screen.cols - 14), fg: p.ink }]
					: [{ text: "message the agent…  (tab to focus)", fg: p.ghost, dim: true }]),
			]);
			const hint = s.filtering
				? ` filter: ${s.filter}  (enter keep · esc clear)`
				: s.scroll > 0
					? ` scrolled ↑${s.scroll} — pgdn to follow · j/k move · 1-5 panes · ? help`
					: " j/k move · enter open · tab composer · f fork · x cancel · e rename · n new · / filter · 1-5 panes · ? help";
			this.screen.line([{ text: clip(hint, this.screen.cols - 2), fg: p.label }]);
			return;
		}
		const hints: Record<Pane, string> = {
			chat: "",
			files: " enter open · backspace up · esc chat · wheel scroll",
			search: " type to search · enter open file · esc chat",
			diff: " ↑/↓ wheel scroll · esc chat",
			term: " keys forwarded to the pty · ↑/↓ scrollback · esc chat",
		};
		this.screen.line([{ text: clip(hints[s.pane], this.screen.cols - 2), fg: p.label }]);
	}

	private drawHelp(): void {
		const lines: [string, string][] = [
			["j / k · ↑ / ↓", "move in rail · history in composer · scroll panes"],
			["enter", "open session · send message · open file"],
			["tab", "switch rail ↔ composer"],
			["mouse", "click tabs / rail / composer · wheel scrolls"],
			["1 – 5", "chat · files · search · diff · term"],
			["f · x · e · n", "fork · cancel turn · rename · new session"],
			["/", "filter the rail"],
			["pgup / pgdn", "page the transcript"],
			["r · g / G", "refresh · first / last session"],
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
		this.screen.finish();
	}
}
