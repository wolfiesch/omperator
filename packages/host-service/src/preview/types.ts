import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
	Cursor,
	LeaseId,
	PreviewAction,
	PreviewAuthorityDescriptor,
	PreviewCaptureId,
	PreviewCaptureMetadata,
	PreviewCaptureMimeType,
	PreviewId,
	PreviewSnapshot,
	PreviewState,
	PreviewViewport,
	Revision,
	SessionId,
} from "@t4-code/host-wire";

/** A staged Chromium executable resolved lazily on first preview.launch. */
export interface PreviewChromiumExecutable {
	readonly path: string;
	readonly browserVersion: string;
}

/** Resolves the pinned headless Chromium executable, staging it on first use. */
export type PreviewChromiumResolver = () => Promise<PreviewChromiumExecutable>;

/** Clock seam used for idle-timeout and capture timestamps. */
export interface PreviewClock {
	now(): Date;
}

/** A captured screenshot buffered for chunked reads via preview.capture.read. */
export interface PreviewCaptureRecord {
	readonly captureId: PreviewCaptureId;
	readonly mimeType: PreviewCaptureMimeType;
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly width: number;
	readonly height: number;
	readonly capturedAt: number;
}

/** An acquired preview lease. */
export interface PreviewLeaseRecord {
	readonly leaseId: LeaseId;
	readonly previewId: PreviewId;
	readonly expiresAt: number;
}

/** Internal per-preview state. */
export interface PreviewEntry {
	readonly previewId: PreviewId;
	readonly sessionId: SessionId;
	readonly authority?: PreviewAuthorityDescriptor;
	browser: Browser;
	context: BrowserContext;
	page: Page;
	state: PreviewState;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	revision: Revision;
	readonly createdAt: number;
	lastActivityAt: number;
	capture?: PreviewCaptureRecord;
	lease?: PreviewLeaseRecord;
}

/** Options for constructing a PreviewService. */
export interface PreviewServiceOptions {
	readonly chromiumResolver: PreviewChromiumResolver;
	readonly clock?: PreviewClock;
	/** Maximum concurrent browser contexts per service. Defaults to 2. */
	readonly maxConcurrent?: number;
	/** Idle timeout in ms before a preview's browser is closed. Defaults to 10 min. */
	readonly idleTimeoutMs?: number;
	/** Default viewport. Defaults to 1280x800 @ 1x. */
	readonly viewport?: PreviewViewport;
	/** Per-action timeout in ms. Defaults to 15 s. */
	readonly actionTimeoutMs?: number;
	/** Capture quality for jpeg (0-100). Defaults to 60. */
	readonly captureQuality?: number;
	/** Maximum capture bytes. Defaults to PREVIEW_CAPTURE_MAX_BYTES. */
	readonly captureMaxBytes?: number;
	/** Chunk size for capture.read in bytes. Defaults to PREVIEW_CAPTURE_CHUNK_BYTES. */
	readonly captureChunkBytes?: number;
}

/** Error thrown by the preview service, carrying a wire-stable code. */
export class PreviewServiceError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export type {
	Browser,
	BrowserContext,
	Cursor,
	LeaseId,
	Page,
	PreviewAction,
	PreviewAuthorityDescriptor,
	PreviewCaptureId,
	PreviewCaptureMetadata,
	PreviewCaptureMimeType,
	PreviewId,
	PreviewSnapshot,
	PreviewState,
	PreviewViewport,
	Revision,
	SessionId,
};
