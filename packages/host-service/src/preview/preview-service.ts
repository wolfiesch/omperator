import { createHash, randomUUID } from "node:crypto";
import type { chromium as ChromiumLauncher } from "playwright-core";
import {
	type Cursor,
	type LeaseId,
	type PreviewAction,
	type PreviewAuthorityDescriptor,
	type PreviewCaptureId,
	type PreviewCaptureMetadata,
	type PreviewId,
	type PreviewSnapshot,
	PREVIEW_ACTIONS,
	PREVIEW_CAPTURE_CHUNK_BYTES,
	PREVIEW_CAPTURE_MAX_BYTES,
	PREVIEW_LEASE_TTL_MAX_MS,
	type Revision,
	type SessionId,
} from "@t4-code/host-wire";
import { validatePreviewUrl } from "./url-policy.ts";

let chromiumPromise: Promise<typeof ChromiumLauncher> | undefined;

/**
 * playwright-core is loaded lazily: it cannot be bundled into the compiled
 * single-file host (dynamic deep requires), so a deployed binary resolves it
 * from node_modules only when a preview is actually launched. Without it the
 * host boots and serves everything else; preview commands fail with a clear
 * `unavailable` instead of a startup crash.
 */
function loadChromium(): Promise<typeof ChromiumLauncher> {
	if (!chromiumPromise)
		chromiumPromise = import("playwright-core").then(
			module => module.chromium,
			(error: unknown) => {
				throw new PreviewServiceError(
					"unavailable",
					`playwright-core is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		);
	return chromiumPromise;
}
import type {
	PreviewCaptureRecord,
	PreviewChromiumResolver,
	PreviewClock,
	PreviewEntry,
	PreviewLeaseRecord,
	PreviewServiceOptions,
} from "./types.ts";
import { PreviewServiceError } from "./types.ts";

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_CAPTURE_QUALITY = 60;
const IDLE_SWEEP_INTERVAL_MS = 30_000;

const AVAILABLE_ACTIONS: readonly PreviewAction[] = PREVIEW_ACTIONS;

function defaultClock(): PreviewClock {
	return { now: () => new Date() };
}

function makeCursor(epoch: string, seq: number): Cursor {
	return { epoch, seq };
}

function makeRevision(seq: number): Revision {
	return `rev-${seq}` as Revision;
}

function makePreviewId(): PreviewId {
	return `pv_${randomUUID()}` as PreviewId;
}

function makeCaptureId(): PreviewCaptureId {
	return `cap_${randomUUID()}` as PreviewCaptureId;
}

function makeLeaseId(): LeaseId {
	return `lease_${randomUUID()}` as LeaseId;
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}


/**
 * Host-side preview service: runs a headless Chromium per session preview so
 * remote clients get live previews with no desktop running. Each preview owns
 * a browser context with a single page at a fixed viewport. Bounded by max
 * concurrent contexts, an idle timeout, and per-action timeouts.
 */
export class PreviewService {
	readonly #chromiumResolver: PreviewChromiumResolver;
	readonly #clock: PreviewClock;
	readonly #maxConcurrent: number;
	readonly #idleTimeoutMs: number;
	readonly #viewport: { width: number; height: number; deviceScaleFactor?: number };
	readonly #actionTimeoutMs: number;
	readonly #captureQuality: number;
	readonly #captureMaxBytes: number;
	readonly #captureChunkBytes: number;
	readonly #previews = new Map<PreviewId, PreviewEntry>();
	readonly #bySession = new Map<SessionId, Set<PreviewId>>();
	#chromiumPromise: Promise<{ path: string; browserVersion: string }> | undefined;
	#idleTimer: ReturnType<typeof setInterval> | undefined;
	#stopped = false;
	readonly #epoch = `pv_${randomUUID()}`;
	#seq = 0;

	constructor(options: PreviewServiceOptions) {
		this.#chromiumResolver = options.chromiumResolver;
		this.#clock = options.clock ?? defaultClock();
		this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.#viewport = options.viewport ?? DEFAULT_VIEWPORT;
		this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		this.#captureQuality = options.captureQuality ?? DEFAULT_CAPTURE_QUALITY;
		this.#captureMaxBytes = options.captureMaxBytes ?? PREVIEW_CAPTURE_MAX_BYTES;
		this.#captureChunkBytes = options.captureChunkBytes ?? PREVIEW_CAPTURE_CHUNK_BYTES;
	}

	#nextSeq(): number {
		return ++this.#seq;
	}

	#touch(entry: PreviewEntry): void {
		entry.lastActivityAt = this.#clock.now().getTime();
	}

	async #resolveChromium(): Promise<{ path: string; browserVersion: string }> {
		if (this.#stopped) throw new PreviewServiceError("stopped", "preview service is stopped");
		if (!this.#chromiumPromise) this.#chromiumPromise = this.#chromiumResolver();
		return this.#chromiumPromise;
	}

	#startIdleSweep(): void {
		if (this.#idleTimer) return;
		this.#idleTimer = setInterval(() => void this.#sweepIdle(), IDLE_SWEEP_INTERVAL_MS);
	}

	async #sweepIdle(): Promise<void> {
		const now = this.#clock.now().getTime();
		const expired: PreviewId[] = [];
		for (const [id, entry] of this.#previews) {
			if (now - entry.lastActivityAt > this.#idleTimeoutMs) expired.push(id);
		}
		for (const id of expired) await this.#closePreview(id, "idle");
	}

	#requirePreview(previewId: PreviewId): PreviewEntry {
		const entry = this.#previews.get(previewId);
		if (!entry) throw new PreviewServiceError("not_found", "preview was not found");
		return entry;
	}

	#snapshot(entry: PreviewEntry): PreviewSnapshot {
		const cursor = makeCursor(this.#epoch, this.#seq);
		return {
			previewId: entry.previewId,
			state: entry.state,
			url: entry.url,
			revision: entry.revision,
			cursor,
			title: entry.title,
			canGoBack: entry.canGoBack,
			canGoForward: entry.canGoForward,
			viewport: this.#viewport,
			capture: entry.capture ? this.#captureMetadata(entry.capture) : undefined,
			authority: entry.authority,
			availableActions: AVAILABLE_ACTIONS,
		};
	}

	#captureMetadata(record: PreviewCaptureRecord): PreviewCaptureMetadata {
		return {
			captureId: record.captureId,
			mimeType: record.mimeType,
			size: record.bytes.length,
			width: record.width,
			height: record.height,
			capturedAt: record.capturedAt,
			sha256: record.sha256,
		};
	}

	#checkLease(entry: PreviewEntry, leaseId?: LeaseId): void {
		if (!entry.lease) return;
		if (!leaseId || leaseId !== entry.lease.leaseId) {
			const now = this.#clock.now().getTime();
			if (now < entry.lease.expiresAt)
				throw new PreviewServiceError("lease_held", "preview is held by another lease");
		}
	}

	#refreshNavigation(entry: PreviewEntry): void {
		entry.url = entry.page.url();
		entry.canGoBack = Boolean(entry.page.url() && entry.context.pages().length > 0);
	}

	async #updateFromPage(entry: PreviewEntry): Promise<void> {
		entry.url = entry.page.url();
		try {
			entry.title = await entry.page.title();
		} catch {
			entry.title = "";
		}
		entry.canGoBack = await entry.page.evaluate(() => history.length > 1).catch(() => false);
		entry.canGoForward = false;
		entry.revision = makeRevision(this.#nextSeq());
		this.#touch(entry);
	}

	async launch(params: {
		sessionId: SessionId;
		url: string;
		authorityId?: string;
		authority?: PreviewAuthorityDescriptor;
	}): Promise<PreviewSnapshot> {
		validatePreviewUrl(params.url);
		if (this.#stopped) throw new PreviewServiceError("stopped", "preview service is stopped");
		const sessionPreviews = this.#bySession.get(params.sessionId) ?? new Set();
		const activeCount = [...this.#previews.values()].filter(e => e.state !== "stopped").length;
		if (activeCount >= this.#maxConcurrent)
			throw new PreviewServiceError("busy", "maximum concurrent previews reached");
		const chromiumInfo = await this.#resolveChromium();
		const previewId = makePreviewId();
		const chromium = await loadChromium();
		const browser = await chromium.launch({
			executablePath: chromiumInfo.path,
			headless: true,
			args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		});
		let context, page;
		try {
			context = await browser.newContext({ viewport: this.#viewport });
			page = await context.newPage();
			page.setDefaultTimeout(this.#actionTimeoutMs);
		} catch (error) {
			await browser.close().catch(() => undefined);
			throw error;
		}
		const entry: PreviewEntry = {
			previewId,
			sessionId: params.sessionId,
			authority: params.authority,
			browser,
			context,
			page,
			state: "launching",
			url: params.url,
			title: "",
			canGoBack: false,
			canGoForward: false,
			revision: makeRevision(this.#nextSeq()),
			createdAt: this.#clock.now().getTime(),
			lastActivityAt: this.#clock.now().getTime(),
		};
		this.#previews.set(previewId, entry);
		sessionPreviews.add(previewId);
		this.#bySession.set(params.sessionId, sessionPreviews);
		this.#startIdleSweep();
		try {
			entry.state = "running";
			await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: this.#actionTimeoutMs });
			await this.#updateFromPage(entry);
			entry.state = "ready";
		} catch (error) {
			entry.state = "failed";
			await this.#closePreview(previewId, "launch_failed");
			throw new PreviewServiceError(
				"launch_failed",
				error instanceof Error ? error.message : "preview navigation failed",
			);
		}
		return this.#snapshot(entry);
	}

	async state(params: { sessionId: SessionId; previewId?: PreviewId }): Promise<{ previews: PreviewSnapshot[] }> {
		if (params.previewId) {
			const entry = this.#requirePreview(params.previewId);
			return { previews: [this.#snapshot(entry)] };
		}
		const ids = this.#bySession.get(params.sessionId) ?? new Set();
		const previews: PreviewSnapshot[] = [];
		for (const id of ids) {
			const entry = this.#previews.get(id);
			if (entry) previews.push(this.#snapshot(entry));
		}
		return { previews };
	}

	async navigate(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		url: string;
		leaseId?: LeaseId;
	}): Promise<PreviewSnapshot> {
		validatePreviewUrl(params.url);
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.goto(params.url, { waitUntil: "domcontentloaded", timeout: this.#actionTimeoutMs });
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async back(params: { sessionId: SessionId; previewId: PreviewId; leaseId?: LeaseId }): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.goBack({ waitUntil: "domcontentloaded", timeout: this.#actionTimeoutMs }).catch(() => undefined);
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async forward(params: { sessionId: SessionId; previewId: PreviewId; leaseId?: LeaseId }): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page
			.goForward({ waitUntil: "domcontentloaded", timeout: this.#actionTimeoutMs })
			.catch(() => undefined);
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async reload(params: { sessionId: SessionId; previewId: PreviewId; leaseId?: LeaseId }): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.reload({ waitUntil: "domcontentloaded", timeout: this.#actionTimeoutMs });
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async activate(params: { sessionId: SessionId; previewId: PreviewId; leaseId?: LeaseId }): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.bringToFront().catch(() => undefined);
		this.#touch(entry);
		return this.#snapshot(entry);
	}

	async close(params: { sessionId: SessionId; previewId: PreviewId; leaseId?: LeaseId }): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await this.#closePreview(params.previewId, "closed");
		return this.#snapshot(entry);
	}

	async #closePreview(previewId: PreviewId, _reason: string): Promise<void> {
		const entry = this.#previews.get(previewId);
		if (!entry) return;
		entry.state = "stopped";
		await entry.browser.close().catch(() => undefined);
		this.#previews.delete(previewId);
		const sessionSet = this.#bySession.get(entry.sessionId);
		sessionSet?.delete(previewId);
		if (sessionSet && sessionSet.size === 0) this.#bySession.delete(entry.sessionId);
	}

	async capture(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		const buffer = await entry.page.screenshot({
			type: "jpeg",
			quality: this.#captureQuality,
			timeout: this.#actionTimeoutMs,
		});
		const bytes = new Uint8Array(buffer);
		if (bytes.length > this.#captureMaxBytes)
			throw new PreviewServiceError("capture_too_large", "preview capture exceeds the maximum size");
		const viewport = entry.page.viewportSize();
		const record: PreviewCaptureRecord = {
			captureId: makeCaptureId(),
			mimeType: "image/jpeg",
			bytes,
			sha256: sha256(bytes),
			width: viewport?.width ?? this.#viewport.width,
			height: viewport?.height ?? this.#viewport.height,
			capturedAt: this.#clock.now().getTime(),
		};
		entry.capture = record;
		entry.revision = makeRevision(this.#nextSeq());
		this.#touch(entry);
		return this.#snapshot(entry);
	}

	captureRead(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		captureId: PreviewCaptureId;
		offset: number;
	}): { previewId: PreviewId; captureId: PreviewCaptureId; size: number; offset: number; nextOffset: number; complete: boolean; content: string } {
		const entry = this.#requirePreview(params.previewId);
		const record = entry.capture;
		if (!record || record.captureId !== params.captureId)
			throw new PreviewServiceError("not_found", "capture was not found");
		const size = record.bytes.length;
		const offset = Math.max(0, Math.floor(params.offset));
		if (offset > size)
			throw new PreviewServiceError("invalid_offset", "capture offset exceeds size");
		const end = Math.min(offset + this.#captureChunkBytes, size);
		const chunk = record.bytes.subarray(offset, end);
		const nextOffset = end;
		const complete = nextOffset === size;
		return {
			previewId: params.previewId,
			captureId: params.captureId,
			size,
			offset,
			nextOffset,
			complete,
			content: toBase64(chunk),
		};
	}

	async click(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		selector?: string;
		x?: number;
		y?: number;
		button?: "left" | "middle" | "right";
		clickCount?: number;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		if (params.selector !== undefined) {
			await entry.page.click(params.selector, {
				button: params.button,
				clickCount: params.clickCount,
				timeout: this.#actionTimeoutMs,
			});
		} else if (params.x !== undefined && params.y !== undefined) {
			await entry.page.mouse.click(params.x, params.y, {
				button: params.button,
				clickCount: params.clickCount,
			});
		} else {
			throw new PreviewServiceError("invalid_frame", "click requires selector or coordinates");
		}
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async fill(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		selector: string;
		text: string;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.fill(params.selector, params.text, { timeout: this.#actionTimeoutMs });
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async type(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		selector?: string;
		text: string;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		if (params.selector) {
			await entry.page.type(params.selector, params.text, { timeout: this.#actionTimeoutMs });
		} else {
			await entry.page.keyboard.type(params.text);
		}
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async scroll(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		deltaX: number;
		deltaY: number;
		selector?: string;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		if (params.selector) {
			await entry.page
				.locator(params.selector)
				.scrollIntoViewIfNeeded({ timeout: this.#actionTimeoutMs })
				.catch(() => undefined);
		}
		await entry.page.mouse.wheel(params.deltaX, params.deltaY);
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async selectOption(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		selector: string;
		value: string;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.selectOption(params.selector, params.value, { timeout: this.#actionTimeoutMs });
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	async press(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		key: string;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		await entry.page.keyboard.press(params.key);
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	policyCheck(params: {
		action: PreviewAction;
		previewId?: PreviewId;
		url?: string;
		authorityId?: string;
	}): { allowed: boolean; confirmationRequired: boolean; reason?: string } {
		const action = params.action;
		if (!PREVIEW_ACTIONS.includes(action))
			return { allowed: false, confirmationRequired: false, reason: "unknown action" };
		if (params.url !== undefined) {
			try {
				validatePreviewUrl(params.url);
			} catch (error) {
				return {
					allowed: false,
					confirmationRequired: false,
					reason: error instanceof PreviewServiceError ? error.message : "url rejected",
				};
			}
		}
		const challengeActions: ReadonlySet<PreviewAction> = new Set(["navigate", "upload"]);
		return {
			allowed: true,
			confirmationRequired: challengeActions.has(action),
		};
	}

	leaseAcquire(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		ttlMs?: number;
	}): { previewId: PreviewId; leaseId: LeaseId; expiresAt: number } {
		const entry = this.#requirePreview(params.previewId);
		const now = this.#clock.now().getTime();
		if (entry.lease && entry.lease.expiresAt > now)
			throw new PreviewServiceError("lease_held", "preview already holds an active lease");
		const ttl = params.ttlMs ?? PREVIEW_LEASE_TTL_MAX_MS;
		const lease: PreviewLeaseRecord = {
			leaseId: makeLeaseId(),
			previewId: params.previewId,
			expiresAt: now + Math.min(ttl, PREVIEW_LEASE_TTL_MAX_MS),
		};
		entry.lease = lease;
		this.#touch(entry);
		return { previewId: params.previewId, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
	}

	leaseRenew(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId: LeaseId;
		ttlMs?: number;
	}): { previewId: PreviewId; leaseId: LeaseId; expiresAt: number } {
		const entry = this.#requirePreview(params.previewId);
		if (!entry.lease || entry.lease.leaseId !== params.leaseId)
			throw new PreviewServiceError("not_found", "lease was not found");
		const now = this.#clock.now().getTime();
		const ttl = params.ttlMs ?? PREVIEW_LEASE_TTL_MAX_MS;
		entry.lease = {
			...entry.lease,
			expiresAt: now + Math.min(ttl, PREVIEW_LEASE_TTL_MAX_MS),
		};
		this.#touch(entry);
		return { previewId: params.previewId, leaseId: entry.lease.leaseId, expiresAt: entry.lease.expiresAt };
	}

	leaseRelease(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId: LeaseId;
	}): { previewId: PreviewId; released: boolean } {
		const entry = this.#requirePreview(params.previewId);
		if (!entry.lease || entry.lease.leaseId !== params.leaseId)
			return { previewId: params.previewId, released: false };
		entry.lease = undefined;
		this.#touch(entry);
		return { previewId: params.previewId, released: true };
	}

	async handoff(params: {
		sessionId: SessionId;
		previewId: PreviewId;
		leaseId?: LeaseId;
		message: string;
		mode?: "manual" | "selector" | "url" | "text";
		selector?: string;
		urlSubstring?: string;
		text?: string;
		timeoutMs?: number;
	}): Promise<PreviewSnapshot> {
		const entry = this.#requirePreview(params.previewId);
		this.#checkLease(entry, params.leaseId);
		const mode = params.mode ?? "manual";
		const timeout = params.timeoutMs ?? this.#actionTimeoutMs;
		if (mode === "selector" && params.selector) {
			await entry.page.waitForSelector(params.selector, { timeout }).catch(() => undefined);
		} else if (mode === "url" && params.urlSubstring) {
			await entry.page
				.waitForURL(`**/*${params.urlSubstring}*`, { timeout })
				.catch(() => undefined);
		} else if (mode === "text" && params.text) {
			await entry.page.waitForSelector(`text=${params.text}`, { timeout }).catch(() => undefined);
		}
		await this.#updateFromPage(entry);
		return this.#snapshot(entry);
	}

	/** Closes all previews for a session. Called on session close. */
	async closeSession(sessionId: SessionId): Promise<void> {
		const ids = this.#bySession.get(sessionId);
		if (!ids) return;
		for (const id of [...ids]) await this.#closePreview(id, "session_closed");
	}

	/** Stops the service: closes all previews and the idle sweep. */
	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#idleTimer) {
			clearInterval(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		for (const id of [...this.#previews.keys()]) await this.#closePreview(id, "stopped");
	}
}

export { validatePreviewUrl };
export type { PreviewServiceOptions, PreviewSnapshot };
