import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import type { CommandResult, HostId, PreviewAction, PreviewSnapshot, SessionId } from "@t4-code/host-wire";
import { PREVIEW_CAPTURE_CHUNK_BYTES, PREVIEW_CAPTURE_MAX_BYTES } from "@t4-code/host-wire/limits";
import type { DesktopOperationsAuthority, OperationContext } from "@t4-code/host-service";

const DEFAULT_CDP_TIMEOUT_MS = 5_000;
const MAX_CDP_METADATA_BYTES = 64 * 1024;
const MAX_CDP_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_PENDING_CDP_COMMANDS = 64;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const MAX_PREVIEWS = 4;
const MAX_CAPTURE_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_UPLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const HANDOFF_POLL_MS = 100;
const HANDOFF_MAX_TIMEOUT_MS = 60_000;
const AVAILABLE_ACTIONS = Object.freeze([
	"activate", "navigate", "back", "forward", "reload", "close", "capture", "click", "fill",
	"type", "press", "scroll", "select", "upload", "handoff",
] as const satisfies readonly PreviewAction[]);

export type InternalBrowserProfilePolicy =
	| Readonly<{ mode: "disabled" }>
	| Readonly<{ mode: "durable"; stateDirectory: string }>
	| Readonly<{ mode: "ephemeral"; stateDirectory: string }>;

export interface BrowserRuntimeProjection {
	readonly enabled: boolean;
	readonly chromiumArguments: readonly string[];
	readonly cmuxEnvironment: Readonly<Record<string, string>>;
	readonly previewEnabled: boolean;
}

/** Internal-only projection. The CRD continues to expose only Allowed/Disabled. */
export function projectBrowserRuntime(
	policy: InternalBrowserProfilePolicy,
	cdpPort = 9222,
): BrowserRuntimeProjection {
	if (policy.mode === "disabled") return Object.freeze({ enabled: false, chromiumArguments: [], cmuxEnvironment: {}, previewEnabled: false });
	if (!isAbsolute(policy.stateDirectory) || policy.stateDirectory === "/") throw new Error("browser profile state directory must be a fenced absolute path");
	if (!Number.isSafeInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65_535) throw new Error("CDP port is invalid");
	const endpoint = `http://127.0.0.1:${cdpPort}`;
	return Object.freeze({
		enabled: true,
		chromiumArguments: Object.freeze([
			"--remote-debugging-address=127.0.0.1",
			`--remote-debugging-port=${cdpPort}`,
			`--user-data-dir=${policy.stateDirectory}`,
		]),
		cmuxEnvironment: Object.freeze({ CMUX_MUX_CDP_URL: endpoint }),
		previewEnabled: true,
	});
}

export interface CdpTargetTransport {
	readonly generation: number;
	onGenerationLoss(listener: (generation: number) => void): () => void;
	createTarget(url: string): Promise<string>;
	closeTarget(targetId: string): Promise<void>;
	activateTarget(targetId: string): Promise<void>;
	command<T extends Record<string, unknown> = Record<string, unknown>>(
		targetId: string,
		method: string,
		params?: Readonly<Record<string, unknown>>,
	): Promise<T>;
	checkpoint?(): Promise<void>;
	close(): Promise<void>;
}

interface PendingCommand {
	readonly resolve: (value: Record<string, unknown>) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

function loopbackHttpEndpoint(input: string): URL {
	const endpoint = new URL(input);
	if (endpoint.protocol !== "http:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost"))
		throw new Error("CDP endpoint must use loopback HTTP");
	if (!endpoint.port || endpoint.username || endpoint.password || (endpoint.pathname !== "/" && endpoint.pathname !== "") || endpoint.search || endpoint.hash)
		throw new Error("CDP endpoint contains forbidden address data");
	return endpoint;
}

function loopbackWebSocketEndpoint(input: string, expectedPort: string): URL {
	const endpoint = new URL(input);
	if (endpoint.protocol !== "ws:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost"))
		throw new Error("CDP websocket must use loopback");
	if (endpoint.username || endpoint.password || endpoint.port !== expectedPort)
		throw new Error("CDP websocket authority does not match the supervised endpoint");
	return endpoint;
}

export class LoopbackCdpTransport implements CdpTargetTransport {
	readonly #endpoint: URL;
	readonly #timeoutMs: number;
	#socket?: WebSocket;
	#connecting?: Promise<WebSocket>;
	#nextId = 1;
	readonly #pending = new Map<number, PendingCommand>();
	readonly #sessions = new Map<string, string>();
	readonly #generationLossListeners = new Set<(generation: number) => void>();
	#generation = 0;
	#browserContextId?: string;
	#browserContextPending?: Promise<string>;

	constructor(endpoint: string, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
		this.#endpoint = loopbackHttpEndpoint(endpoint);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("CDP timeout is invalid");
		this.#timeoutMs = timeoutMs;
	}
	get generation(): number { return this.#generation; }
	onGenerationLoss(listener: (generation: number) => void): () => void {
		this.#generationLossListeners.add(listener);
		return () => { this.#generationLossListeners.delete(listener); };
	}

	#loseGeneration(socket: WebSocket, error: Error): void {
		if (this.#socket !== socket) return;
		this.#socket = undefined;
		this.#browserContextId = undefined;
		this.#browserContextPending = undefined;
		this.#failPending(error);
		for (const listener of this.#generationLossListeners) listener(this.#generation);
	}

	async #connect(): Promise<WebSocket> {
		if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
		if (this.#connecting) return this.#connecting;
		this.#connecting = this.#open();
		try { return await this.#connecting; }
		finally { this.#connecting = undefined; }
	}

	async #open(): Promise<WebSocket> {
		const signal = AbortSignal.timeout(this.#timeoutMs);
		const response = await fetch(new URL("/json/version", this.#endpoint), { signal });
		if (!response.ok || !response.body) throw new Error("supervised CDP endpoint is unavailable");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_CDP_METADATA_BYTES) {
				await reader.cancel();
				throw new Error("supervised CDP metadata exceeds the byte limit");
			}
			chunks.push(chunk.value);
		}
		const version = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as Record<string, unknown>;
		if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("supervised CDP endpoint omitted its websocket");
		const websocket = loopbackWebSocketEndpoint(version.webSocketDebuggerUrl, this.#endpoint.port);
		const socket = new WebSocket(websocket, { maxPayload: MAX_CDP_MESSAGE_BYTES });
		await new Promise<void>((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error("CDP websocket timed out")), this.#timeoutMs);
			socket.once("open", () => { clearTimeout(timer); resolvePromise(); });
			socket.once("error", error => { clearTimeout(timer); reject(error); });
		});
		socket.on("message", raw => this.#onMessage(raw.toString()));
		socket.on("close", () => this.#loseGeneration(socket, new Error("CDP websocket closed")));
		this.#socket = socket;
		this.#generation += 1;
		return socket;
	}

	#onMessage(raw: string): void {
		let frame: Record<string, unknown>;
		try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
		if (typeof frame.id !== "number") return;
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		this.#pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.error && typeof frame.error === "object") pending.reject(new Error("CDP command failed"));
		else pending.resolve((frame.result && typeof frame.result === "object" ? frame.result : {}) as Record<string, unknown>);
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear();
		this.#sessions.clear();
	}

	async #send<T extends Record<string, unknown>>(
		method: string,
		params: Readonly<Record<string, unknown>> = {},
		sessionId?: string,
	): Promise<T> {
		const socket = await this.#connect();
		if (this.#pending.size >= MAX_PENDING_CDP_COMMANDS) throw new Error("CDP pending command limit reached");
		const id = this.#nextId++;
		const result = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("CDP command timed out"));
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve: resolvePromise, reject, timer });
		});
		socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return await result as T;
	}

	async #previewBrowserContext(): Promise<string> {
		const existing = this.#browserContextId;
		if (existing) return existing;
		if (this.#browserContextPending) return this.#browserContextPending;
		this.#browserContextPending = (async () => {
			await this.#connect();
			const generation = this.#generation;
			const created = await this.#send<{ browserContextId?: unknown }>("Target.createBrowserContext", { disposeOnDetach: true });
			if (typeof created.browserContextId !== "string" || this.#generation !== generation)
				throw new Error("CDP did not create a preview browser context");
			this.#browserContextId = created.browserContextId;
			return created.browserContextId;
		})();
		try { return await this.#browserContextPending; }
		finally { this.#browserContextPending = undefined; }
	}

	async createTarget(url: string): Promise<string> {
		const browserContextId = await this.#previewBrowserContext();
		const created = await this.#send<{ targetId?: unknown }>("Target.createTarget", {
			url,
			width: DEFAULT_VIEWPORT.width,
			height: DEFAULT_VIEWPORT.height,
			browserContextId,
		});
		if (typeof created.targetId !== "string") throw new Error("CDP did not create a target");
		const attached = await this.#send<{ sessionId?: unknown }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
		if (typeof attached.sessionId !== "string") {
			await this.#send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
			throw new Error("CDP did not attach to the target");
		}
		this.#sessions.set(created.targetId, attached.sessionId);
		try {
			await Promise.all([
				this.command(created.targetId, "Page.enable"),
				this.command(created.targetId, "Runtime.enable"),
				this.command(created.targetId, "Emulation.setDeviceMetricsOverride", DEFAULT_VIEWPORT),
			]);
			return created.targetId;
		} catch (error) {
			this.#sessions.delete(created.targetId);
			await this.#send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
			throw error;
		}
	}

	async closeTarget(targetId: string): Promise<void> {
		this.#sessions.delete(targetId);
		await this.#send("Target.closeTarget", { targetId });
	}
	async activateTarget(targetId: string): Promise<void> { await this.#send("Target.activateTarget", { targetId }); }
	async command<T extends Record<string, unknown> = Record<string, unknown>>(targetId: string, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
		const session = this.#sessions.get(targetId);
		if (!session) throw new Error("CDP target is not owned by this authority");
		return this.#send<T>(method, params, session);
	}
	async checkpoint(): Promise<void> {
		if (!this.#socket) return;
		await this.#send("Browser.close");
		await this.close();
	}
	async close(): Promise<void> {
		const socket = this.#socket;
		if (!socket) return;
		this.#loseGeneration(socket, new Error("CDP transport closed"));
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
	}
}

interface CaptureRecord { readonly id: string; readonly bytes: Buffer; readonly createdAt: number; }
interface LeaseRecord { readonly id: string; readonly connectionId: string; readonly deviceId: string; expiresAt: number; }
interface PreviewRecord {
	readonly id: string;
	readonly targetId: string;
	state: "ready" | "running" | "stopped" | "failed";
	url: string;
	title?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	revision: number;
	capture?: CaptureRecord;
	lease?: LeaseRecord;
}

export interface BrowserPreviewAuthorityOptions {
	readonly hostId: HostId;
	readonly sessionId: SessionId;
	readonly workspaceRoot: string;
	readonly transport: CdpTargetTransport;
	readonly now?: () => number;
	readonly epoch?: string;
	readonly maxPreviews?: number;
	readonly maxCaptureMemoryBytes?: number;
}

function operationError(code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNSUPPORTED" | "ABORTED", message: string): Error {
	return Object.assign(new Error(message), { code });
}
function stringArg(args: CommandResult, name: string): string {
	const value = (args as Record<string, unknown>)[name];
	if (typeof value !== "string") throw operationError("CONFLICT", "preview argument is invalid");
	return value;
}
function optionalStringArg(args: CommandResult, name: string): string | undefined {
	const value = (args as Record<string, unknown>)[name];
	return typeof value === "string" ? value : undefined;
}
function numberArg(args: CommandResult, name: string, fallback?: number): number {
	const value = (args as Record<string, unknown>)[name];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (fallback !== undefined) return fallback;
	throw operationError("CONFLICT", "preview argument is invalid");
}
function publicUrl(input: string): string {
	const value = new URL(input);
	value.username = ""; value.password = ""; value.search = ""; value.hash = "";
	return value.toString();
}
function evaluationValue(result: Record<string, unknown>): unknown {
	const nested = result.result;
	return nested && typeof nested === "object" ? (nested as Record<string, unknown>).value : undefined;
}

interface CanonicalUpload {
	readonly path: string;
	readonly name: string;
	readonly device: number;
	readonly inode: number;
	readonly size: number;
}

async function canonicalUpload(workspaceRoot: string, requestedPath: string): Promise<CanonicalUpload> {
	const selectedPath = resolve(workspaceRoot, requestedPath);
	if (selectedPath === workspaceRoot || !selectedPath.startsWith(`${workspaceRoot}${sep}`))
		throw operationError("FORBIDDEN", "preview upload path escapes the workspace");
	for (const path of [workspaceRoot, selectedPath]) {
		let current: string = sep;
		for (const component of path.split(sep).filter(Boolean)) {
			current = join(current, component);
			if ((await lstat(current)).isSymbolicLink())
				throw operationError("FORBIDDEN", "preview upload path contains a symlink");
		}
	}
	const [canonicalRoot, canonicalFile, rootStat, fileStat] = await Promise.all([
		realpath(workspaceRoot),
		realpath(selectedPath),
		lstat(workspaceRoot),
		lstat(selectedPath),
	]);
	if (!rootStat.isDirectory() || canonicalFile === canonicalRoot || !canonicalFile.startsWith(`${canonicalRoot}${sep}`))
		throw operationError("FORBIDDEN", "preview upload path escapes the workspace");
	if (fileStat.isSymbolicLink() || !fileStat.isFile())
		throw operationError("CONFLICT", "preview upload path is not a regular file");
	if (fileStat.size > MAX_PREVIEW_UPLOAD_BYTES)
		throw operationError("CONFLICT", "preview upload file exceeds the byte limit");
	return { path: canonicalFile, name: basename(canonicalFile), device: fileStat.dev, inode: fileStat.ino, size: fileStat.size };
}

async function readCanonicalUpload(upload: CanonicalUpload): Promise<string> {
	const handle = await open(upload.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.dev !== upload.device || stat.ino !== upload.inode || stat.size !== upload.size)
			throw operationError("CONFLICT", "preview upload file changed during validation");
		const bytes = Buffer.allocUnsafe(upload.size + 1);
		let offset = 0;
		for (;;) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
			if (offset === bytes.byteLength) throw operationError("CONFLICT", "preview upload file changed during validation");
		}
		if (offset !== upload.size) throw operationError("CONFLICT", "preview upload file changed during validation");
		return bytes.subarray(0, offset).toString("base64");
	} finally {
		await handle.close();
	}
}

export class BrowserPreviewAuthority {
	readonly #hostId: HostId;
	readonly #sessionId: SessionId;
	readonly #workspaceRoot: string;
	readonly #transport: CdpTargetTransport;
	readonly #now: () => number;
	readonly #epoch: string;
	readonly #maxPreviews: number;
	readonly #maxCaptureMemoryBytes: number;
	readonly #previews = new Map<string, PreviewRecord>();
	readonly #unsubscribeGenerationLoss: () => void;
	#sequence = 0;
	#captureBytes = 0;
	#draining = false;

	constructor(options: BrowserPreviewAuthorityOptions) {
		this.#hostId = options.hostId;
		this.#sessionId = options.sessionId;
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#transport = options.transport;
		this.#now = options.now ?? Date.now;
		this.#epoch = options.epoch ?? `preview-${randomUUID()}`;
		this.#maxPreviews = options.maxPreviews ?? MAX_PREVIEWS;
		this.#maxCaptureMemoryBytes = options.maxCaptureMemoryBytes ?? MAX_CAPTURE_MEMORY_BYTES;
		if (!Number.isSafeInteger(this.#maxPreviews) || this.#maxPreviews < 1 || this.#maxPreviews > MAX_PREVIEWS) throw new Error("preview target limit is invalid");
		if (!Number.isSafeInteger(this.#maxCaptureMemoryBytes) || this.#maxCaptureMemoryBytes < PREVIEW_CAPTURE_MAX_BYTES) throw new Error("preview memory limit is invalid");
		this.#unsubscribeGenerationLoss = this.#transport.onGenerationLoss(() => {
			this.#previews.clear();
			this.#captureBytes = 0;
			this.#sequence += 1;
		});
	}

	#assertContext(context: OperationContext): void {
		if (this.#draining) throw operationError("ABORTED", "browser authority is draining");
		if (context.hostId !== this.#hostId || context.sessionId !== this.#sessionId) throw operationError("FORBIDDEN", "preview belongs to another runtime session");
		if (context.abortSignal.aborted) throw operationError("ABORTED", "preview operation was cancelled");
	}
	#record(args: CommandResult, context: OperationContext): PreviewRecord {
		this.#assertContext(context);
		const preview = this.#previews.get(stringArg(args, "previewId"));
		if (!preview) throw operationError("NOT_FOUND", "preview was not found");
		return preview;
	}
	#assertLease(preview: PreviewRecord, args: CommandResult, context: OperationContext): void {
		const lease = preview.lease;
		if (!lease) return;
		if (lease.expiresAt <= this.#now()) { preview.lease = undefined; return; }
		if (optionalStringArg(args, "leaseId") !== lease.id || lease.connectionId !== context.connectionId || lease.deviceId !== context.deviceId)
			throw operationError("CONFLICT", "preview lease is held by another controller");
	}
	#bump(preview: PreviewRecord): void { preview.revision += 1; this.#sequence += 1; }
	#snapshot(preview: PreviewRecord): PreviewSnapshot {
		return Object.freeze({
			previewId: preview.id as never,
			state: preview.state,
			url: publicUrl(preview.url),
			revision: `preview-${preview.revision}` as never,
			cursor: { epoch: this.#epoch, seq: this.#sequence },
			...(preview.title ? { title: preview.title.slice(0, 512) } : {}),
			canGoBack: preview.canGoBack,
			canGoForward: preview.canGoForward,
			viewport: DEFAULT_VIEWPORT,
			...(preview.capture ? { capture: {
				captureId: preview.capture.id as never,
				mimeType: "image/png" as const,
				size: preview.capture.bytes.byteLength,
				width: DEFAULT_VIEWPORT.width,
				height: DEFAULT_VIEWPORT.height,
				capturedAt: preview.capture.createdAt,
				sha256: createHash("sha256").update(preview.capture.bytes).digest("hex"),
			} } : {}),
			authority: { id: "cluster-session-browser", label: "Session browser", kind: "isolated-session" as const, requiresExplicitOptIn: false },
			availableActions: AVAILABLE_ACTIONS,
		});
	}
	async #refresh(preview: PreviewRecord): Promise<void> {
		const [location, title, history] = await Promise.all([
			this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: "location.href", returnByValue: true }),
			this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: "document.title", returnByValue: true }),
			this.#transport.command(preview.targetId, "Page.getNavigationHistory"),
		]);
		const url = evaluationValue(location);
		const pageTitle = evaluationValue(title);
		if (typeof url === "string") preview.url = url;
		if (typeof pageTitle === "string") preview.title = pageTitle;
		const entries = Array.isArray(history.entries) ? history.entries : [];
		const currentIndex = typeof history.currentIndex === "number" ? history.currentIndex : 0;
		preview.canGoBack = currentIndex > 0;
		preview.canGoForward = currentIndex + 1 < entries.length;
	}
	async #mutation(args: CommandResult, context: OperationContext, operation: (preview: PreviewRecord) => Promise<void>): Promise<CommandResult> {
		const preview = this.#record(args, context);
		this.#assertLease(preview, args, context);
		if (preview.state === "stopped") throw operationError("CONFLICT", "preview is stopped");
		await operation(preview);
		await this.#refresh(preview);
		this.#bump(preview);
		return { preview: this.#snapshot(preview) };
	}
	#expression(functionBody: string, ...values: unknown[]): string {
		return `(${functionBody})(...${JSON.stringify(values)})`;
	}

	operations(): DesktopOperationsAuthority {
		return {
			previewLaunch: async (args, context) => {
				this.#assertContext(context);
				if (this.#previews.size >= this.#maxPreviews) {
					const stopped = [...this.#previews.values()].find(preview => preview.state === "stopped");
					if (stopped) {
						this.#captureBytes -= stopped.capture?.bytes.byteLength ?? 0;
						this.#previews.delete(stopped.id);
					}
				}
				if (this.#previews.size >= this.#maxPreviews) throw operationError("CONFLICT", "preview target limit reached");
				const authorityId = optionalStringArg(args, "authorityId");
				if (authorityId !== undefined && authorityId !== "cluster-session-browser") throw operationError("FORBIDDEN", "preview authority is unavailable");
				const url = stringArg(args, "url");
				const targetId = await this.#transport.createTarget(url);
				const preview: PreviewRecord = { id: `preview-${randomUUID()}`, targetId, state: "ready", url, canGoBack: false, canGoForward: false, revision: 1 };
				this.#previews.set(preview.id, preview);
				await this.#refresh(preview).catch(async error => { this.#previews.delete(preview.id); await this.#transport.closeTarget(targetId).catch(() => undefined); throw error; });
				this.#sequence += 1;
				return { preview: this.#snapshot(preview) };
			},
			previewState: async (args, context) => {
				this.#assertContext(context);
				const requested = optionalStringArg(args, "previewId");
				const previews = requested ? [this.#previews.get(requested)].filter((value): value is PreviewRecord => value !== undefined) : [...this.#previews.values()];
				return { previews: previews.map(preview => { this.#sequence += 1; return this.#snapshot(preview); }) };
			},
			previewActivate: (args, context) => this.#mutation(args, context, async preview => { await this.#transport.activateTarget(preview.targetId); preview.state = "running"; }),
			previewNavigate: (args, context) => this.#mutation(args, context, async preview => { await this.#transport.command(preview.targetId, "Page.navigate", { url: stringArg(args, "url") }); }),
			previewBack: (args, context) => this.#mutation(args, context, async preview => {
				const history = await this.#transport.command(preview.targetId, "Page.getNavigationHistory");
				const entries = Array.isArray(history.entries) ? history.entries as Record<string, unknown>[] : [];
				const index = typeof history.currentIndex === "number" ? history.currentIndex : 0;
				const entryId = entries[index - 1]?.id;
				if (typeof entryId === "number") await this.#transport.command(preview.targetId, "Page.navigateToHistoryEntry", { entryId });
			}),
			previewForward: (args, context) => this.#mutation(args, context, async preview => {
				const history = await this.#transport.command(preview.targetId, "Page.getNavigationHistory");
				const entries = Array.isArray(history.entries) ? history.entries as Record<string, unknown>[] : [];
				const index = typeof history.currentIndex === "number" ? history.currentIndex : 0;
				const entryId = entries[index + 1]?.id;
				if (typeof entryId === "number") await this.#transport.command(preview.targetId, "Page.navigateToHistoryEntry", { entryId });
			}),
			previewReload: (args, context) => this.#mutation(args, context, async preview => { await this.#transport.command(preview.targetId, "Page.reload", { ignoreCache: false }); }),
			previewClose: async (args, context) => {
				const preview = this.#record(args, context); this.#assertLease(preview, args, context);
				if (preview.state !== "stopped") await this.#transport.closeTarget(preview.targetId);
				preview.state = "stopped"; preview.lease = undefined; this.#bump(preview);
				return { preview: this.#snapshot(preview) };
			},
			previewCapture: (args, context) => this.#mutation(args, context, async preview => {
				const result = await this.#transport.command(preview.targetId, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
				if (typeof result.data !== "string") throw operationError("CONFLICT", "CDP capture did not return PNG data");
				const bytes = Buffer.from(result.data, "base64");
				if (bytes.byteLength === 0 || bytes.byteLength > PREVIEW_CAPTURE_MAX_BYTES) throw operationError("CONFLICT", "preview capture exceeds the byte limit");
				const replaced = preview.capture?.bytes.byteLength ?? 0;
				if (this.#captureBytes - replaced + bytes.byteLength > this.#maxCaptureMemoryBytes) throw operationError("CONFLICT", "preview capture memory limit reached");
				this.#captureBytes = this.#captureBytes - replaced + bytes.byteLength;
				preview.capture = { id: `capture-${randomUUID()}`, bytes, createdAt: this.#now() };
			}),
			previewCaptureRead: async (args, context) => {
				const preview = this.#record(args, context);
				const capture = preview.capture;
				if (!capture || capture.id !== stringArg(args, "captureId")) throw operationError("NOT_FOUND", "preview capture was not found");
				const offset = numberArg(args, "offset");
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > capture.bytes.byteLength) throw operationError("CONFLICT", "preview capture offset is invalid");
				const nextOffset = Math.min(capture.bytes.byteLength, offset + PREVIEW_CAPTURE_CHUNK_BYTES);
				return { previewId: preview.id, captureId: capture.id, size: capture.bytes.byteLength, offset, nextOffset, complete: nextOffset === capture.bytes.byteLength, content: capture.bytes.subarray(offset, nextOffset).toString("base64") };
			},
			previewClick: (args, context) => this.#mutation(args, context, async preview => {
				let x = numberArg(args, "x", -1), y = numberArg(args, "y", -1);
				const selector = optionalStringArg(args, "selector");
				if (selector) {
					const box = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: this.#expression("(selector) => { const e=document.querySelector(selector); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }", selector), returnByValue: true });
					const value = evaluationValue(box) as Record<string, unknown> | undefined;
					if (!value || typeof value.x !== "number" || typeof value.y !== "number") throw operationError("NOT_FOUND", "preview selector was not found");
					x = value.x; y = value.y;
				}
				const button = optionalStringArg(args, "button") ?? "left"; const clickCount = numberArg(args, "clickCount", 1);
				await this.#transport.command(preview.targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
				await this.#transport.command(preview.targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
			}),
			previewFill: (args, context) => this.#mutation(args, context, async preview => {
				const selector = optionalStringArg(args, "selector") ?? "input:focus,textarea:focus,[contenteditable=true]:focus";
				const output = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: this.#expression("(selector,text) => { const e=document.querySelector(selector); if(!e) return false; e.focus(); if('value' in e) e.value=text; else e.textContent=text; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; }", selector, stringArg(args, "text")), returnByValue: true });
				if (evaluationValue(output) !== true) throw operationError("NOT_FOUND", "preview selector was not found");
			}),
			previewType: (args, context) => this.#mutation(args, context, async preview => {
				const selector = optionalStringArg(args, "selector");
				if (selector) {
					const focused = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: this.#expression("(selector) => { const e=document.querySelector(selector); if(!e) return false; e.focus(); return true; }", selector), returnByValue: true });
					if (evaluationValue(focused) !== true) throw operationError("NOT_FOUND", "preview selector was not found");
				}
				await this.#transport.command(preview.targetId, "Input.insertText", { text: stringArg(args, "text") });
			}),
			previewPress: (args, context) => this.#mutation(args, context, async preview => {
				const key = stringArg(args, "key");
				await this.#transport.command(preview.targetId, "Input.dispatchKeyEvent", { type: "keyDown", key });
				await this.#transport.command(preview.targetId, "Input.dispatchKeyEvent", { type: "keyUp", key });
			}),
			previewScroll: (args, context) => this.#mutation(args, context, async preview => {
				const selector = optionalStringArg(args, "selector");
				const output = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: this.#expression("(selector,x,y) => { const e=selector?document.querySelector(selector):window; if(!e) return false; e.scrollBy(x,y); return true; }", selector, numberArg(args, "deltaX"), numberArg(args, "deltaY")), returnByValue: true });
				if (evaluationValue(output) !== true) throw operationError("NOT_FOUND", "preview selector was not found");
			}),
			previewSelect: (args, context) => this.#mutation(args, context, async preview => {
				const output = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: this.#expression("(selector,value) => { const e=document.querySelector(selector); if(!(e instanceof HTMLSelectElement)) return false; e.value=value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; }", stringArg(args, "selector"), stringArg(args, "value")), returnByValue: true });
				if (evaluationValue(output) !== true) throw operationError("NOT_FOUND", "preview select was not found");
			}),
			previewUpload: (args, context) => this.#mutation(args, context, async preview => {
				const requestedPath = stringArg(args, "path");
				const document = await this.#transport.command(preview.targetId, "DOM.getDocument", { depth: 0 });
				const root = document.root as Record<string, unknown> | undefined;
				if (!root || typeof root.nodeId !== "number") throw operationError("CONFLICT", "preview document is unavailable");
				const selected = await this.#transport.command(preview.targetId, "DOM.querySelector", { nodeId: root.nodeId, selector: stringArg(args, "selector") });
				if (typeof selected.nodeId !== "number" || selected.nodeId === 0) throw operationError("NOT_FOUND", "preview upload selector was not found");
				const upload = await canonicalUpload(this.#workspaceRoot, requestedPath).catch(error => {
					if (error && typeof error === "object" && "code" in error) throw error;
					throw operationError("FORBIDDEN", "preview upload path is unavailable");
				});
				const content = await readCanonicalUpload(upload).catch(error => {
					if (error && typeof error === "object" && "code" in error) throw error;
					throw operationError("FORBIDDEN", "preview upload file is unavailable");
				});
				const output = await this.#transport.command(preview.targetId, "Runtime.evaluate", {
					expression: this.#expression("(selector,name,content) => { const e=document.querySelector(selector); if(!(e instanceof HTMLInputElement)||e.type!=='file') return false; const binary=atob(content); const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes],name,{type:'application/octet-stream'})); e.files=transfer.files; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; }", stringArg(args, "selector"), upload.name, content),
					returnByValue: true,
				});
				if (evaluationValue(output) !== true) throw operationError("NOT_FOUND", "preview upload selector was not a file input");
			}),
			previewPolicyCheck: async (args, context) => {
				this.#assertContext(context);
				const authorityId = optionalStringArg(args, "authorityId");
				const previewId = optionalStringArg(args, "previewId");
				const allowed = (authorityId === undefined || authorityId === "cluster-session-browser") && (previewId === undefined || this.#previews.has(previewId));
				return { allowed, confirmationRequired: ["navigate", "upload"].includes(stringArg(args, "action")), ...(allowed ? {} : { reason: "preview authority or target is unavailable" }) };
			},
			previewLeaseAcquire: async (args, context) => {
				const preview = this.#record(args, context); const now = this.#now();
				if (preview.lease && preview.lease.expiresAt > now) throw operationError("CONFLICT", "preview lease is already held");
				const ttl = Math.min(numberArg(args, "ttlMs", DEFAULT_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
				preview.lease = { id: `lease-${randomUUID()}`, connectionId: context.connectionId, deviceId: context.deviceId, expiresAt: now + ttl };
				return { previewId: preview.id, leaseId: preview.lease.id, expiresAt: preview.lease.expiresAt };
			},
			previewLeaseRenew: async (args, context) => {
				const preview = this.#record(args, context); this.#assertLease(preview, args, context);
				if (!preview.lease) throw operationError("CONFLICT", "preview lease expired");
				preview.lease.expiresAt = this.#now() + Math.min(numberArg(args, "ttlMs", DEFAULT_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
				return { previewId: preview.id, leaseId: preview.lease.id, expiresAt: preview.lease.expiresAt };
			},
			previewLeaseRelease: async (args, context) => {
				const preview = this.#record(args, context); this.#assertLease(preview, args, context);
				const released = preview.lease !== undefined; preview.lease = undefined;
				return { previewId: preview.id, released };
			},
			previewHandoff: async (args, context) => {
				const preview = this.#record(args, context); this.#assertLease(preview, args, context); preview.lease = undefined;
				const mode = optionalStringArg(args, "mode") ?? "manual";
				if (mode !== "manual") {
					const timeout = Math.min(numberArg(args, "timeoutMs", 30_000), HANDOFF_MAX_TIMEOUT_MS); const deadline = this.#now() + timeout;
					let complete = false;
					while (!complete && this.#now() < deadline) {
						if (context.abortSignal.aborted) throw operationError("ABORTED", "preview handoff was cancelled");
						const condition = mode === "selector"
							? this.#expression("(selector) => document.querySelector(selector) !== null", stringArg(args, "selector"))
							: mode === "url" ? this.#expression("(part) => location.href.includes(part)", stringArg(args, "urlSubstring"))
							: this.#expression("(text) => (document.body?.innerText ?? '').includes(text)", stringArg(args, "text"));
						const evaluated = await this.#transport.command(preview.targetId, "Runtime.evaluate", { expression: condition, returnByValue: true });
						complete = evaluationValue(evaluated) === true;
						if (!complete) await new Promise<void>(resolvePromise => setTimeout(resolvePromise, HANDOFF_POLL_MS));
					}
					if (!complete) throw operationError("CONFLICT", "preview handoff timed out");
				}
				await this.#refresh(preview); this.#bump(preview); return { preview: this.#snapshot(preview) };
			},
		};
	}

	activity(): Readonly<{ browserPreviews: number; browserLeases: number }> {
		const now = this.#now();
		let browserPreviews = 0;
		let browserLeases = 0;
		for (const preview of this.#previews.values()) {
			if (preview.state !== "stopped") browserPreviews += 1;
			if (preview.lease && preview.lease.expiresAt > now) browserLeases += 1;
		}
		return { browserPreviews, browserLeases };
	}

	beginDrain(): void { this.#draining = true; }
	rollbackDrain(): void { this.#draining = false; }
	async quiesce(): Promise<void> {
		await Promise.all([...this.#previews.values()]
			.filter(preview => preview.state !== "stopped")
			.map(preview => this.#transport.closeTarget(preview.targetId)));
		this.#previews.clear();
		this.#captureBytes = 0;
	}

	async checkpoint(): Promise<void> {
		await this.quiesce();
		if (!this.#transport.checkpoint) throw new Error("browser transport does not support durable checkpoint");
		await this.#transport.checkpoint();
	}

	async close(): Promise<void> {
		this.#draining = true;
		await this.quiesce();
		this.#unsubscribeGenerationLoss();
		await this.#transport.close();
	}
}

/** Removes any upstream preview methods before applying the profile-authorized CDP authority. */
export function mergeBrowserPreviewOperations(
	base: DesktopOperationsAuthority,
	browser: DesktopOperationsAuthority,
): DesktopOperationsAuthority {
	const merged: Record<string, unknown> = {};
	for (const [name, method] of Object.entries(base))
		if (!name.startsWith("preview")) merged[name] = method;
	Object.assign(merged, browser);
	return merged as DesktopOperationsAuthority;
}

export function createBrowserPreviewOperations(
	policy: InternalBrowserProfilePolicy,
	options: Omit<BrowserPreviewAuthorityOptions, "transport"> & { readonly cdpEndpoint?: string; readonly transport?: CdpTargetTransport },
): Readonly<{ authority?: BrowserPreviewAuthority; operations: DesktopOperationsAuthority }> {
	if (policy.mode === "disabled") return Object.freeze({ operations: Object.freeze({}) });
	projectBrowserRuntime(policy);
	const transport = options.transport ?? new LoopbackCdpTransport(options.cdpEndpoint ?? "http://127.0.0.1:9222");
	const authority = new BrowserPreviewAuthority({ ...options, transport });
	return Object.freeze({ authority, operations: authority.operations() });
}
