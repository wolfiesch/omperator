import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ArtifactDescriptor,
	DurableEntry,
	EntryId,
	HostId,
	ProjectId,
	SessionId,
	TranscriptImageMetadata,
	TurnId,
} from "@t4-code/host-wire";
import {
	ARTIFACT_MAX_BYTES,
	artifactId,
	decodeArtifactDescriptorList,
	decodeTurnReviewSnapshot,
	entryId,
	hostId,
	parseBounded,
	projectId,
	sessionId,
	TRANSCRIPT_IMAGE_MAX_COUNT,
	TRANSCRIPT_IMAGE_MIME_TYPES,
	turnId,
} from "@t4-code/host-wire";
import { boundSnapshotEntries, uniqueEntryId } from "./snapshot-limits.ts";
import { TranscriptPageReader } from "./transcript-page-reader.ts";
import type { FileSystem, SessionDiscovery, SessionRecord } from "./types.ts";
import { type XdevWriteCall, xdevExecutionMatches, xdevResultEnvelope, xdevWriteCall } from "./xdev-envelope.ts";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_DETAILS_BYTES = 128 * 1024;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_CUSTOM_TYPE_BYTES = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type DiscoveryFileSystem = FileSystem & {
	readFileSlice?: (path: string, maxBytes: number) => Promise<string | Uint8Array>;
	readFileRange?: (
		path: string,
		offset: number,
		maxBytes: number,
		expectedIdentity?: string,
	) => Promise<string | Uint8Array>;
};
const OBSERVER_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const OBSERVER_TAIL_ANCHOR_BYTES = 4 * 1024;
const realFs: DiscoveryFileSystem = {
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	chmod: async (path, mode) => {
		await chmod(path, mode);
	},
	unlink: async path => {
		try {
			await unlink(path);
		} catch {}
	},
	stat: async path => await stat(path),
	readdir: async path => (await readdir(path, { withFileTypes: true })).map(entry => join(path, entry.name)),
	readFile: async path => await readFile(path),
	readFileSlice: async (path, maxBytes) => {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
	readFileRange: async (path, offset, maxBytes, expectedIdentity) => {
		const handle = await open(path, "r");
		try {
			const opened = await handle.stat();
			const openedIdentity = `${opened.dev ?? ""}:${opened.ino ?? ""}`;
			if (expectedIdentity !== undefined && openedIdentity !== expectedIdentity)
				throw new Error("transcript inode changed while opening range");
			const buffer = Buffer.allocUnsafe(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
};
function boundUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return decoder.decode(bytes.slice(0, end));
}

function redactString(value: string): string {
	return value
		.replace(/(?<![:/A-Za-z0-9_])\/(?:[^\s"'`/]+\/)+[^\s"'`]+/g, "[path]")
		.replace(/(?:\/(?:home|tmp|var|root|Users|private|workspace)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g, "[path]")
		.replace(
			/\b(token|password|passwd|secret|credential|authorization|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
			"$1=[redacted]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

export function cleanText(value: string, maxBytes: number, collapseWhitespace = false): string {
	const withoutControls = [...value].filter(character => {
		const code = character.codePointAt(0) ?? 0;
		return code > 0x1f && code !== 0x7f || code === 0x09 || code === 0x0a || code === 0x0d;
	}).join("");
	const normalized = collapseWhitespace ? withoutControls.replace(/\s+/gu, " ").trim() : withoutControls;
	return boundUtf8(redactString(normalized), maxBytes);
}

function isSensitiveKey(key: string): boolean {
	return /(?:secret|token|password|api[_-]?key|authorization|cookie|credential|auth)/iu.test(key);
}

function isEmbeddedImageData(value: string): boolean {
	if (/^data:image\//iu.test(value)) return true;
	return value.length >= 32 && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/u.test(value);
}

function safeValue(value: unknown, key = "", depth = 0, omitImagePayloads = false): unknown {
	if (isSensitiveKey(key)) return "[redacted]";
	if (depth >= 8) return "[omitted]";
	if (typeof value === "string") {
		if (omitImagePayloads && isEmbeddedImageData(value)) return "[image omitted]";
		return cleanText(value, MAX_TEXT_BYTES);
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 64).map(item => safeValue(item, "", depth + 1, omitImagePayloads));
	if (typeof value === "object") {
		const output: Record<string, unknown> = {};
		const record = value as Record<string, unknown>;
		const imageObject =
			omitImagePayloads &&
			(record.type === "image" || (typeof record.mimeType === "string" && record.mimeType.startsWith("image/")));
		for (const [name, item] of Object.entries(value).slice(0, 64)) {
			if (isSensitiveKey(name)) continue;
			if (
				omitImagePayloads &&
				name === "images" &&
				Array.isArray(item) &&
				item.some(image => {
					const candidate = asObject(image);
					return (
						candidate?.type === "image" ||
						(typeof candidate?.mimeType === "string" && candidate.mimeType.startsWith("image/"))
					);
				})
			)
				continue;
			if (imageObject && ["appImageSha256", "base64", "bytes", "content", "data"].includes(name)) continue;
			output[name] = safeValue(item, name, depth + 1, omitImagePayloads);
		}
		return output;
	}
	return undefined;
}
function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(content: unknown, maxBytes = MAX_TEXT_BYTES): string {
	if (typeof content === "string") return cleanText(content, maxBytes);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const block = asObject(item);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return cleanText(parts.join(""), maxBytes);
}

/** Project prompt text through the exact sanitizer and byte budget used by durable messages. */
export function projectMessageText(content: unknown, maxBytes = MAX_TEXT_BYTES): string {
	return contentText(content, maxBytes);
}

interface ProjectedToolResultText {
	type: "text";
	text: string;
}

function toolResultContent(content: unknown): ProjectedToolResultText[] {
	const values = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (!Array.isArray(values)) return [];
	const blocks: ProjectedToolResultText[] = [];
	let remainingBytes = MAX_RESULT_BYTES;
	for (const value of values) {
		const block = asObject(value);
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const text = cleanText(block.text, remainingBytes);
		if (text) blocks.push({ type: "text", text });
		remainingBytes -= encoder.encode(text).byteLength;
		if (remainingBytes <= 0) break;
	}
	return blocks;
}

type ArtifactDescriptorResolver = (id: string) => ArtifactDescriptor | undefined;
function toolResultArtifacts(
	content: unknown,
	resolveArtifact: ArtifactDescriptorResolver | undefined,
): ArtifactDescriptor[] {
	if (!resolveArtifact) return [];
	const text =
		typeof content === "string" ? content : Array.isArray(content) ? contentText(content, MAX_RESULT_BYTES) : "";
	const artifacts: ArtifactDescriptor[] = [];
	const seen = new Set<string>();
	for (const match of text
		.slice(0, MAX_RESULT_BYTES)
		.matchAll(/(?:^|[^A-Za-z0-9_])artifact:\/\/([0-9]+)(?![A-Za-z0-9_])/gu)) {
		const id = match[1]!;
		if (seen.has(id)) continue;
		seen.add(id);
		const descriptor = resolveArtifact(id);
		if (descriptor) artifacts.push(descriptor);
		if (artifacts.length >= 64) break;
	}
	return artifacts;
}
export function artifactDescriptorForRoot(root: string, id: string): ArtifactDescriptor | undefined {
	try {
		const uid = process.getuid?.();
		if (uid === undefined) return undefined;
		const rootInfo = lstatSync(root);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o002) !== 0)
			return undefined;
		const file = readdirSync(root).find(
			name => name.startsWith(`${id}.`) && /^[0-9]+\.[A-Za-z0-9_-]+\.log$/u.test(name),
		);
		if (!file) return undefined;
		const info = lstatSync(join(root, file));
		if (
			info.isSymbolicLink() ||
			!info.isFile() ||
			info.uid !== uid ||
			(info.mode & 0o002) !== 0 ||
			info.size <= 0 ||
			info.size > ARTIFACT_MAX_BYTES
		)
			return undefined;
		return {
			artifactId: artifactId(id),
			kind: "text",
			mediaType: "text/plain",
			size: info.size,
			name: file,
			disposition: "attachment",
			retention: "session",
		};
	} catch {
		return undefined;
	}
}

export function projectToolResultDetails(details: unknown): unknown {
	if (details === undefined) return undefined;
	const projected = safeValue(details, "", 0, true);
	if (projected === undefined) return undefined;
	const serialized = JSON.stringify(projected);
	if (serialized !== undefined && encoder.encode(serialized).byteLength <= MAX_RESULT_DETAILS_BYTES) return projected;
	return { omitted: "Tool result details exceeded the app-wire display budget." };
}

export function projectToolArguments(value: unknown): unknown {
	const args = safeValue(value, "", 0, true);
	const serialized = JSON.stringify(args) ?? "";
	return encoder.encode(serialized).byteLength <= MAX_ARGUMENT_BYTES
		? args
		: { omitted: "Tool arguments exceeded the app-wire display budget." };
}

function contentImages(
	content: unknown,
	allowManagedMarker: boolean,
	allowUntypedImagePayloads = false,
): TranscriptImageMetadata[] {
	if (!Array.isArray(content)) return [];
	const images: TranscriptImageMetadata[] = [];
	for (const item of content) {
		if (images.length >= TRANSCRIPT_IMAGE_MAX_COUNT) break;
		const block = asObject(item);
		if (!block) continue;
		if (
			(block.type !== "image" && !(allowUntypedImagePayloads && block.type === undefined)) ||
			typeof block.mimeType !== "string" ||
			!(TRANSCRIPT_IMAGE_MIME_TYPES as readonly string[]).includes(block.mimeType)
		)
			continue;
		const marked = allowManagedMarker && typeof block.appImageSha256 === "string" ? block.appImageSha256 : undefined;
		const stored = typeof block.data === "string" ? /^blob:sha256:([a-f0-9]{64})$/u.exec(block.data)?.[1] : undefined;
		const sha256 = marked && /^[a-f0-9]{64}$/u.test(marked) ? marked : stored;
		if (!sha256) continue;
		images.push({ sha256, mimeType: block.mimeType as TranscriptImageMetadata["mimeType"] });
	}
	return images;
}

function toolResultImages(content: unknown, details: unknown, allowManagedMarker: boolean): TranscriptImageMetadata[] {
	const images: TranscriptImageMetadata[] = [];
	const seen = new Set<string>();
	for (const [source, allowUntypedImagePayloads] of [
		[content, false],
		[asObject(details)?.images, true],
	] as const) {
		for (const image of contentImages(source, allowManagedMarker, allowUntypedImagePayloads)) {
			if (seen.has(image.sha256)) continue;
			seen.add(image.sha256);
			images.push(image);
			if (images.length >= TRANSCRIPT_IMAGE_MAX_COUNT) return images;
		}
	}
	return images;
}

export function projectNameFromCwd(cwd: string): string {
	const pieces = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
	const name = cleanText(pieces.at(-1) ?? "", 256, true);
	if (name) return name;
	if (/^[\\/]+$/u.test(cwd)) return cwd[0]!;
	return "Project";
}

type ProjectionMode = "batch" | "live";

interface PendingToolCall {
	callId: string;
	tool: string;
	title: string;
	args: unknown;
	parentId: EntryId | null;
	idBase: string;
	timestamp: string;
	xdevCall?: XdevWriteCall;
}

interface ProjectedXdevResult {
	tool: string;
	args: unknown;
	correlationArgs: Record<string, unknown>;
	details?: unknown;
	images: TranscriptImageMetadata[];
}

interface ProjectedToolResult {
	ok: boolean;
	content: ProjectedToolResultText[];
	details?: unknown;
	images: TranscriptImageMetadata[];
	timestamp: string;
	xdev?: ProjectedXdevResult;
	artifacts: ArtifactDescriptor[];
}

function mergeImages(
	first: readonly TranscriptImageMetadata[],
	second: readonly TranscriptImageMetadata[],
): TranscriptImageMetadata[] {
	const images: TranscriptImageMetadata[] = [];
	const seen = new Set<string>();
	for (const image of [...first, ...second]) {
		if (seen.has(image.sha256)) continue;
		seen.add(image.sha256);
		images.push(image);
		if (images.length >= TRANSCRIPT_IMAGE_MAX_COUNT) break;
	}
	return images;
}

function validRawEntry(raw: Record<string, unknown>): boolean {
	if (
		typeof raw.id !== "string" ||
		!raw.id ||
		typeof raw.type !== "string" ||
		!raw.type ||
		(raw.parentId !== undefined && raw.parentId !== null && typeof raw.parentId !== "string") ||
		typeof raw.timestamp !== "string" ||
		!Number.isFinite(Date.parse(raw.timestamp))
	)
		return false;
	try {
		entryId(raw.id);
	} catch {
		return false;
	}
	return true;
}

export class SessionEntryProjector {
	readonly entries: DurableEntry[] = [];
	readonly mode: ProjectionMode;
	#host: HostId;
	#session: SessionId;
	#aliases = new Map<string, EntryId | null>();
	#pendingCalls = new Map<string, PendingToolCall>();
	#pendingResults = new Map<string, ProjectedToolResult>();
	#settledCalls = new Set<string>();
	#usedIds = new Set<string>();
	#firstUserText?: string;
	#titleChange?: string;
	#model?: string;
	#thinking?: string;
	#knownEntryIds = new Set<string>();
	#artifactResolver?: ArtifactDescriptorResolver;
	#turnByRawId = new Map<string, TurnId>();
	#turnReviewEntries = new Map<TurnId, DurableEntry>();
	#turnActions = new Map<string, "applied" | "discarded">();

	constructor(
		host: HostId,
		session: SessionId,
		mode: ProjectionMode,
		knownEntries: readonly DurableEntry[] = [],
		artifactResolver?: ArtifactDescriptorResolver,
	) {
		this.#host = host;
		this.#session = session;
		this.mode = mode;
		this.#artifactResolver = artifactResolver;
		for (const entry of knownEntries) this.#knownEntryIds.add(entry.id);
	}

	get firstUserText(): string | undefined {
		return this.#firstUserText;
	}
	get titleChange(): string | undefined {
		return this.#titleChange;
	}
	get model(): string | undefined {
		return this.#model;
	}
	get unresolvedPendingCount(): number {
		return this.#pendingCalls.size + this.#pendingResults.size;
	}
	get thinking(): string | undefined {
		return this.#thinking;
	}

	#resolveParent(raw: unknown): EntryId | null {
		if (typeof raw !== "string") return null;
		const seen = new Set<string>();
		let current: string | undefined = raw;
		while (current && !seen.has(current)) {
			seen.add(current);
			const alias = this.#aliases.get(current);
			if (alias === undefined) {
				try {
					const known = entryId(current);
					return this.#knownEntryIds.has(known) ? known : null;
				} catch {
					return null;
				}
			}
			if (alias !== null) return alias;
			current = undefined;
		}
		return null;
	}
	#turnFor(raw: Record<string, unknown>): TurnId | undefined {
		const rawId = String(raw.id);
		const own = this.#turnByRawId.get(rawId);
		if (own) return own;
		const inherited = typeof raw.parentId === "string" ? this.#turnByRawId.get(raw.parentId) : undefined;
		if (inherited) this.#turnByRawId.set(rawId, inherited);
		return inherited;
	}
	#turnActionKey(id: TurnId, path: string): string {
		return `${id}\u0000${path}`;
	}
	#applyTurnAction(entry: DurableEntry, path: string, state: "applied" | "discarded"): void {
		const changes = entry.data.changes;
		if (!Array.isArray(changes)) return;
		for (const change of changes) {
			if (!change || typeof change !== "object") continue;
			const candidate = change as Record<string, unknown>;
			if (candidate.path === path) candidate.state = state;
		}
	}

	#add(
		raw: Record<string, unknown>,
		kind: string,
		data: Record<string, unknown>,
		parentId: EntryId | null,
		idBase = String(raw.id),
	): DurableEntry {
		const id = uniqueEntryId(idBase, this.#usedIds);
		this.#usedIds.add(id);
		const inheritedTurn = this.#turnFor(raw);
		const entry: DurableEntry = {
			id,
			parentId,
			hostId: this.#host,
			sessionId: this.#session,
			...(inheritedTurn === undefined ? {} : { turnId: inheritedTurn }),
			kind,
			timestamp: String(raw.timestamp),
			data,
		};
		this.entries.push(entry);
		return entry;
	}

	#tool(raw: Record<string, unknown>, call: PendingToolCall, result: ProjectedToolResult): DurableEntry {
		const output = result.content.map(block => block.text).join("");
		const xdev = xdevExecutionMatches(
			call.xdevCall,
			result.xdev
				? {
						tool: result.xdev.tool,
						mode: "execute",
						args: result.xdev.correlationArgs,
						inner: undefined,
					}
				: undefined,
		)
			? result.xdev
			: undefined;
		const tool = xdev?.tool ?? call.tool;
		const details = xdev ? xdev.details : result.details;
		const images = xdev ? mergeImages(result.images, xdev.images) : result.images;
		return this.#add(
			{ ...raw, timestamp: result.timestamp },
			"tool-use",
			{
				toolCallId: call.callId,
				tool,
				title: xdev ? tool : call.title,
				args: xdev?.args ?? call.args,
				ok: result.ok,
				result: {
					output: boundUtf8(output, MAX_RESULT_BYTES),
					content: result.content,
					...(details === undefined ? {} : { details }),
					isError: !result.ok,
				},
				...(images.length > 0 ? { images } : {}),
				...(result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
			},
			call.parentId,
			call.idBase,
		);
	}

	#rememberUserText(role: string, text: string): void {
		if (role === "user" && text && this.#firstUserText === undefined) this.#firstUserText = text;
	}

	project(raw: Record<string, unknown>): DurableEntry[] {
		if (!validRawEntry(raw)) return [];
		const before = this.entries.length;
		const parentId = this.#resolveParent(raw.parentId);
		const nested = asObject(raw.message);
		const message = nested ?? raw;
		const role =
			typeof message.role === "string"
				? message.role
				: raw.type === "message" && typeof raw.text === "string"
					? "assistant"
					: raw.type === "message" && typeof raw.message === "string"
						? "user"
						: undefined;
		if (role === "user") this.#turnByRawId.set(String(raw.id), turnId(String(raw.id)));

		if (raw.type === "message" && (role === "user" || role === "assistant")) {
			const content = message.content ?? message.text ?? (nested ? message.message : (raw.text ?? raw.message));
			const text = contentText(content);
			const images = contentImages(content, this.mode === "live");
			const reasoningParts: string[] = [];
			const toolCalls: PendingToolCall[] = [];
			if (role === "assistant" && Array.isArray(message.content)) {
				for (const item of message.content) {
					const block = asObject(item);
					if (block?.type === "thinking" && typeof block.thinking === "string")
						reasoningParts.push(block.thinking);
					if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
						const rawArgs = block.arguments ?? block.args ?? {};
						const args = projectToolArguments(rawArgs);
						const xdev = xdevWriteCall(block.name, rawArgs);
						toolCalls.push({
							callId: block.id,
							tool: cleanText(block.name, 256, true),
							title:
								typeof block.title === "string"
									? cleanText(block.title, 256, true)
									: cleanText(block.name, 256, true),
							args,
							parentId: null,
							idBase: `${raw.id}:tool:${block.id}`,
							timestamp: String(raw.timestamp),
							...(xdev ? { xdevCall: xdev } : {}),
						});
					}
				}
			}
			const reasoning = cleanText(reasoningParts.join(""), MAX_TEXT_BYTES);
			const messageEntry =
				text || reasoning || images.length > 0 || role === "user"
					? this.#add(
							raw,
							"message",
							{ role, text, ...(reasoning ? { reasoning } : {}), ...(images.length > 0 ? { images } : {}) },
							parentId,
						)
					: undefined;
			this.#rememberUserText(role, text);
			const alias = messageEntry?.id ?? parentId;
			this.#aliases.set(String(raw.id), alias);
			for (const call of toolCalls) {
				call.parentId = alias;
				this.#pendingCalls.set(call.callId, call);
				const pending = this.#pendingResults.get(call.callId);
				if (pending) {
					this.#tool(raw, call, pending);
					this.#pendingResults.delete(call.callId);
					this.#pendingCalls.delete(call.callId);
					this.#settledCalls.add(call.callId);
				}
			}
		} else if (raw.type === "message" && role === "toolResult") {
			const callId =
				typeof message.toolCallId === "string"
					? message.toolCallId
					: typeof raw.toolCallId === "string"
						? raw.toolCallId
						: undefined;
			if (callId && !this.#settledCalls.has(callId)) {
				const rawContent = message.content ?? message.text ?? raw.text;
				const xdev = xdevResultEnvelope(message.details);
				const result: ProjectedToolResult = {
					ok: message.isError !== true,
					content: toolResultContent(rawContent),
					details: projectToolResultDetails(message.details),
					images: toolResultImages(rawContent, message.details, this.mode === "live"),
					artifacts: toolResultArtifacts(rawContent, this.#artifactResolver),
					timestamp: String(raw.timestamp),
					...(xdev
						? {
								xdev: {
									tool: xdev.tool,
									args: projectToolArguments(xdev.args),
									correlationArgs: xdev.args,
									details: projectToolResultDetails(xdev.inner),
									images: toolResultImages([], xdev.inner, this.mode === "live"),
								},
							}
						: {}),
				};
				const call = this.#pendingCalls.get(callId);
				if (call) {
					this.#tool(raw, call, result);
					this.#pendingCalls.delete(callId);
					this.#settledCalls.add(callId);
				} else {
					this.#pendingResults.set(callId, result);
				}
			}
			this.#aliases.set(String(raw.id), parentId);
		} else if (raw.type === "custom" && raw.customType === "turn-review") {
			const data = asObject(raw.data);
			try {
				if (
					!data ||
					Object.keys(data).some(
						key => !["turnId", "baseTree", "headTree", "changes", "patch", "artifacts"].includes(key),
					)
				)
					throw new Error("invalid turn review");
				const review = decodeTurnReviewSnapshot(
					{
						turnId: data.turnId,
						baseTree: data.baseTree,
						headTree: data.headTree,
						changes: data.changes,
						...(data.patch === undefined ? {} : { patch: data.patch }),
					},
					"turn-review",
				);
				const artifacts = decodeArtifactDescriptorList(data.artifacts, "turn-review.artifacts");
				if (
					(review.patch === undefined && artifacts.length !== 0) ||
					(review.patch !== undefined &&
						(artifacts.length !== 1 || artifacts[0]?.artifactId !== review.patch.artifactId))
				)
					throw new Error("invalid turn review artifacts");
				this.#turnByRawId.set(String(raw.id), review.turnId);
				const entry = this.#add(
					raw,
					"turn-review",
					{
						baseTree: review.baseTree,
						headTree: review.headTree,
						changes: review.changes.map(change => ({ ...change })),
						...(review.patch === undefined ? {} : { patch: review.patch }),
						artifacts,
					},
					parentId,
				);
				this.#turnReviewEntries.set(review.turnId, entry);
				for (const change of review.changes) {
					const state = this.#turnActions.get(this.#turnActionKey(review.turnId, change.path));
					if (state) this.#applyTurnAction(entry, change.path, state);
				}
				this.#aliases.set(String(raw.id), entry.id);
			} catch {
				this.#aliases.set(String(raw.id), parentId);
			}
		} else if (raw.type === "custom" && raw.customType === "turn-review-action") {
			const data = asObject(raw.data);
			if (
				data &&
				(data.action === "keep" || data.action === "discard") &&
				typeof data.path === "string" &&
				data.path.length > 0 &&
				!data.path.startsWith("/") &&
				!data.path.split(/[\\/]/u).includes("..")
			) {
				try {
					const id = turnId(data.turnId);
					const state = data.action === "keep" ? "applied" : "discarded";
					this.#turnActions.set(this.#turnActionKey(id, data.path), state);
					const entry = this.#turnReviewEntries.get(id);
					if (entry) this.#applyTurnAction(entry, data.path, state);
				} catch {}
			}
			this.#aliases.set(String(raw.id), parentId);
		} else if (raw.type === "custom_message" && raw.display === true) {
			const content = raw.content ?? raw.text;
			const text = contentText(content);
			const images = contentImages(content, this.mode === "live");
			const customRole = raw.attribution === "agent" ? "assistant" : "user";
			const customType =
				typeof raw.customType === "string" ? cleanText(raw.customType, MAX_CUSTOM_TYPE_BYTES, true) : "";
			const customDetails = customType ? projectToolResultDetails(raw.details) : undefined;
			const entry = this.#add(
				raw,
				"message",
				{
					role: customRole,
					text,
					...(customType ? { customType } : {}),
					...(customDetails === undefined ? {} : { customDetails }),
					...(images.length > 0 ? { images } : {}),
				},
				parentId,
			);
			this.#aliases.set(String(raw.id), entry.id);
			this.#rememberUserText(customRole, text);
		} else if (raw.type === "compaction" && typeof raw.summary === "string") {
			const entry = this.#add(
				raw,
				"compaction",
				{
					summary: cleanText(raw.summary, MAX_RESULT_BYTES),
					...(typeof raw.shortSummary === "string"
						? { shortSummary: cleanText(raw.shortSummary, MAX_TEXT_BYTES) }
						: {}),
				},
				parentId,
			);
			this.#aliases.set(String(raw.id), entry.id);
		} else {
			if (raw.type === "title_change" && typeof raw.title === "string" && cleanText(raw.title, 512, true))
				this.#titleChange = cleanText(raw.title, 512, true);
			if (raw.type === "model_change" && typeof raw.model === "string" && cleanText(raw.model, 256, true))
				this.#model = cleanText(raw.model, 256, true);
			if (raw.type === "thinking_level_change") {
				const candidate = typeof raw.configured === "string" ? raw.configured : raw.thinkingLevel;
				if (typeof candidate === "string" && cleanText(candidate, 256, true))
					this.#thinking = cleanText(candidate, 256, true);
			}
			this.#aliases.set(String(raw.id), parentId);
		}
		return this.entries.slice(before);
	}

	finish(): DurableEntry[] {
		const before = this.entries.length;
		if (this.mode === "batch") {
			for (const call of this.#pendingCalls.values()) {
				this.#tool({ id: call.idBase, timestamp: call.timestamp }, call, {
					ok: false,
					content: [],
					images: [],
					artifacts: [],
					timestamp: call.timestamp,
				});
				this.#settledCalls.add(call.callId);
			}
		}
		this.#pendingCalls.clear();
		this.#pendingResults.clear();
		return this.entries.slice(before);
	}
}

export function projectSessionEntries(
	values: readonly unknown[],
	host: HostId,
	sid: SessionId,
	headerTimestamp: string,
	artifactResolver?: ArtifactDescriptorResolver,
): {
	entries: DurableEntry[];
	firstUserText?: string;
	titleChange?: string;
	model?: string;
	thinking?: string;
} {
	const projector = new SessionEntryProjector(host, sid, "batch", [], artifactResolver);
	for (const value of values) {
		const raw = asObject(value);
		if (!raw) continue;
		if (!validRawEntry(raw)) continue;
		try {
			entryId(String(raw.id));
		} catch {
			continue;
		}
		projector.project(raw);
	}
	projector.finish();
	const entries = projector.entries;
	return {
		entries: boundSnapshotEntries(entries, host, sid, headerTimestamp),
		firstUserText: projector.firstUserText,
		titleChange: projector.titleChange,
		model: projector.model,
		thinking: projector.thinking,
	};
}

export function stableProjectId(cwd: string): ProjectId {
	let canonical = resolve(cwd);
	try {
		canonical = realpathSync.native(canonical);
	} catch {}
	return projectId(`project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`);
}

export function fallbackSessionTitle(firstUserText: string | undefined): string | undefined {
	if (!firstUserText) return undefined;
	const lines = firstUserText.split(/\r?\n/u);
	const wrapper = /^Complete the assignment below,\s*thoroughly:\s*$/iu.test(lines[0]?.trim() ?? "");
	const changeIndex = wrapper ? lines.findIndex(line => /^#{1,6}\s*change\s*$/iu.test(line.trim())) : -1;
	const candidates = wrapper ? lines.slice(changeIndex >= 0 ? changeIndex + 1 : 1) : lines;
	for (const line of candidates) {
		const trimmed = line.trim();
		if (!trimmed || /^#{1,6}(?:\s|$)/u.test(trimmed)) continue;
		return cleanText(trimmed.replace(/^\d+[.)]\s*/u, ""), 120, true) || undefined;
	}
	return undefined;
}

function parseTranscript(input: string | Uint8Array, path: string, host: HostId): SessionRecord {
	const bytes = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
	if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error("transcript exceeds limit");
	const lines: Array<string | Uint8Array> = [];
	if (typeof input === "string") {
		for (const line of input.split(/\r?\n/).filter(Boolean)) lines.push(line);
	} else {
		let start = 0;
		for (let i = 0; i <= input.byteLength; i++)
			if (i === input.byteLength || input[i] === 10) {
				const line = input.slice(start, i);
				if (line.byteLength) lines.push(line);
				start = i + 1;
			}
	}
	if (!lines.length) throw new Error("empty transcript");
	const parseTranscriptObject = (line: string | Uint8Array): Record<string, unknown> => {
		if ((typeof line === "string" ? encoder.encode(line).byteLength : line.byteLength) > MAX_LINE_BYTES)
			throw new Error("transcript line exceeds limit");
		const value = parseBounded(line);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript entry");
		return value as Record<string, unknown>;
	};
	let headerIndex = 0;
	const first = parseTranscriptObject(lines[0]);
	const fixedTitle =
		first.type === "title" && first.v === 1 && typeof first.title === "string"
			? cleanText(first.title, 512, true)
			: undefined;
	if (first.type === "title") {
		if (first.v !== 1 || typeof first.title !== "string") throw new Error("invalid transcript prelude");
		headerIndex = 1;
	}
	const headerLine = lines[headerIndex];
	if (!headerLine) throw new Error("invalid transcript header");
	const header = headerIndex === 0 ? first : parseTranscriptObject(headerLine);
	if (
		header?.type !== "session" ||
		typeof header.id !== "string" ||
		!header.id ||
		typeof header.cwd !== "string" ||
		!header.cwd ||
		typeof header.timestamp !== "string" ||
		!Number.isFinite(Date.parse(header.timestamp))
	)
		throw new Error("invalid transcript header");
	const sid = sessionId(header.id);
	const cwd = resolve(header.cwd);
	const values: Record<string, unknown>[] = [];
	for (const line of lines.slice(headerIndex + 1)) {
		try {
			values.push(parseTranscriptObject(line));
		} catch {
			// Session files may contain a crash-truncated final write or a malformed
			// legacy/foreign entry. The validated header remains authoritative; drop
			// only the bad entry so one partial write cannot hide the whole session.
		}
	}
	const normalized = projectSessionEntries(
		values,
		host,
		sid,
		header.timestamp,
		path.endsWith(".jsonl") ? id => artifactDescriptorForRoot(path.slice(0, -".jsonl".length), id) : undefined,
	);
	const sessionTitle = typeof header.title === "string" ? cleanText(header.title, 512, true) : undefined;
	const title =
		fixedTitle ||
		normalized.titleChange ||
		sessionTitle ||
		fallbackSessionTitle(normalized.firstUserText) ||
		"Untitled";
	return {
		sessionId: sid,
		path,
		cwd,
		projectId: stableProjectId(cwd),
		projectName: projectNameFromCwd(cwd),
		title: cleanText(title, 512, true) || "Untitled",
		updatedAt: "",
		status: "idle",
		...(normalized.model ? { model: normalized.model } : {}),
		...(normalized.thinking ? { thinking: normalized.thinking } : {}),
		entries: normalized.entries,
	};
}
/** Build a metadata-only record for oversized transcripts; entries stay empty because SessionRecord has no truncation flag. */
export function parseSessionTranscriptMetadata(input: string | Uint8Array, path: string): SessionRecord {
	const bytes = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
	if (bytes > MAX_METADATA_BYTES) throw new Error("metadata prefix exceeds limit");
	const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
	let fixedTitle: string | undefined;
	let header: Record<string, unknown> | undefined;
	for (const line of text.split(/\r?\n/u)) {
		if (!line) continue;
		if (encoder.encode(line).byteLength > MAX_LINE_BYTES) throw new Error("transcript line exceeds limit");
		const value = parseBounded(line);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript entry");
		const entry = value as Record<string, unknown>;
		if (!header && entry.type === "title") {
			if (entry.v !== 1 || typeof entry.title !== "string") throw new Error("invalid transcript prelude");
			fixedTitle = cleanText(entry.title, 512, true) || undefined;
			continue;
		}
		if (entry.type === "session") {
			header = entry;
			break;
		}
		if (!header) throw new Error("invalid transcript header");
	}
	if (
		!header ||
		typeof header.id !== "string" ||
		!header.id ||
		typeof header.cwd !== "string" ||
		!header.cwd ||
		typeof header.timestamp !== "string" ||
		!Number.isFinite(Date.parse(header.timestamp))
	)
		throw new Error("invalid transcript header");
	const cwd = resolve(header.cwd);
	return {
		sessionId: sessionId(header.id),
		path,
		cwd,
		projectId: stableProjectId(cwd),
		projectName: projectNameFromCwd(cwd),
		title:
			cleanText(
				fixedTitle || (typeof header.title === "string" ? header.title : undefined) || "Untitled",
				512,
				true,
			) || "Untitled",
		updatedAt: "",
		status: "idle",
		entries: [],
	};
}

interface FileIndexEntry {
	readonly signature: string;
	readonly record: SessionRecord;
	readonly misses: number;
}

export function compareSessionRecords(a: SessionRecord, b: SessionRecord): number {
	if (a.updatedAt < b.updatedAt) return 1;
	if (a.updatedAt > b.updatedAt) return -1;
	if (a.sessionId < b.sessionId) return -1;
	if (a.sessionId > b.sessionId) return 1;
	return 0;
}

interface DiscoveryStat {
	size: number;
	mtimeMs: number;
	ctimeMs?: number;
	dev?: number;
	ino?: number;
}
export interface SessionTranscriptWatermark {
	readonly entryCount: number;
	readonly lastEntryId: string | null;
}

export interface SessionTranscriptPoll {
	readonly record?: SessionRecord;
	readonly entries: readonly DurableEntry[];
	readonly reset: boolean;
	readonly changed: boolean;
	readonly watermark: SessionTranscriptWatermark;
	readonly unresolvedPendingCount: number;
	readonly stable: boolean;
	readonly transcript: "live" | "snapshot";
}

/**
 * Incrementally consumes complete JSONL records. The byte watermark advances
 * over partial lines. Partial records stay bounded as raw bytes until a newline
 * proves them durable; oversized records are discarded without losing the
 * following transcript.
 */
export class SessionTranscriptObserver {
	#identity = "";
	#offset = 0;
	#pending = new Uint8Array();
	#skippingOversizedLine = false;
	#oversizedLineCount = 0;
	#rawCount = 0;
	#rawLastId: string | null = null;
	#stableSamples = 0;
	#stableIdentity = "";
	#stableSize = -1;
	#forceReset = false;
	#observedSize = -1;
	#observedStamp = "";
	#tailAnchor = new Uint8Array();
	#slotTitle?: string;
	#headerTitle?: string;
	#projector?: SessionEntryProjector;
	#record?: SessionRecord;
	#fs: DiscoveryFileSystem;
	#path: string;
	#host: HostId;
	constructor(path: string, host: HostId, fs: DiscoveryFileSystem = realFs) {
		this.#path = path;
		this.#host = host;
		this.#fs = fs;
	}
	#identityOf(info: DiscoveryStat): string {
		return `${info.dev ?? ""}:${info.ino ?? ""}`;
	}
	#stampOf(info: DiscoveryStat): string {
		return `${info.mtimeMs}:${info.ctimeMs ?? ""}`;
	}
	async #tailStillMatches(identity: string): Promise<boolean> {
		if (this.#tailAnchor.byteLength === 0 || this.#offset < this.#tailAnchor.byteLength) return true;
		const start = this.#offset - this.#tailAnchor.byteLength;
		const chunk = this.#fs.readFileRange
			? await this.#fs.readFileRange(this.#path, start, this.#tailAnchor.byteLength, identity)
			: await this.#fs.readFile(this.#path);
		const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
		const candidate = this.#fs.readFileRange
			? bytes.slice(0, this.#tailAnchor.byteLength)
			: bytes.slice(start, start + this.#tailAnchor.byteLength);
		if (candidate.byteLength !== this.#tailAnchor.byteLength) return false;
		for (let index = 0; index < candidate.byteLength; index++)
			if (candidate[index] !== this.#tailAnchor[index]) return false;
		return true;
	}
	#rememberTail(bytes: Uint8Array): void {
		const length = Math.min(OBSERVER_TAIL_ANCHOR_BYTES, this.#tailAnchor.byteLength + bytes.byteLength);
		const next = new Uint8Array(length);
		const fromPrior = Math.min(this.#tailAnchor.byteLength, Math.max(0, length - bytes.byteLength));
		if (fromPrior > 0) next.set(this.#tailAnchor.subarray(this.#tailAnchor.byteLength - fromPrior), 0);
		const fromCurrent = Math.min(bytes.byteLength, length);
		if (fromCurrent > 0) next.set(bytes.subarray(bytes.byteLength - fromCurrent), length - fromCurrent);
		this.#tailAnchor = next;
	}
	#appendPending(bytes: Uint8Array): void {
		if (bytes.byteLength === 0) return;
		if (this.#pending.byteLength === 0) {
			this.#pending = bytes.slice();
			return;
		}
		const joined = new Uint8Array(this.#pending.byteLength + bytes.byteLength);
		joined.set(this.#pending);
		joined.set(bytes, this.#pending.byteLength);
		this.#pending = joined;
	}
	#consumeLines(bytes: Uint8Array): Array<Uint8Array | null> {
		const complete: Array<Uint8Array | null> = [];
		let cursor = 0;
		while (cursor < bytes.byteLength) {
			const newline = bytes.indexOf(0x0a, cursor);
			const end = newline < 0 ? bytes.byteLength : newline;
			const segment = bytes.subarray(cursor, end);
			if (this.#skippingOversizedLine) {
				if (newline < 0) break;
				this.#skippingOversizedLine = false;
				this.#oversizedLineCount += 1;
				complete.push(null);
			} else if (this.#pending.byteLength + segment.byteLength > MAX_LINE_BYTES) {
				this.#pending = new Uint8Array();
				if (newline < 0) {
					this.#skippingOversizedLine = true;
					break;
				}
				this.#oversizedLineCount += 1;
				complete.push(null);
			} else if (newline < 0) {
				this.#appendPending(segment);
				break;
			} else {
				let line: Uint8Array;
				if (this.#pending.byteLength === 0) line = segment;
				else {
					this.#appendPending(segment);
					line = this.#pending;
				}
				if (line.at(-1) === 0x0d) line = line.subarray(0, line.byteLength - 1);
				complete.push(line);
				this.#pending = new Uint8Array();
			}
			cursor = end + 1;
		}
		return complete;
	}
	#oversizedLineNotice(info: DiscoveryStat): DurableEntry | undefined {
		const projector = this.#projector;
		const record = this.#record;
		if (!projector || !record) return undefined;
		const entry: DurableEntry = {
			id: uniqueEntryId(
				`oversized-transcript-record-${this.#oversizedLineCount}`,
				new Set(projector.entries.map(candidate => candidate.id)),
			),
			parentId: null,
			hostId: this.#host,
			sessionId: record.sessionId,
			kind: "compaction",
			timestamp: new Date(info.mtimeMs).toISOString(),
			data: {
				summary: "One transcript record was omitted because it exceeded the 1 MiB safety limit.",
				oversizedRecordOmission: true,
			},
		};
		projector.entries.push(entry);
		return entry;
	}
	#result(
		entries: readonly DurableEntry[],
		reset: boolean,
		changed: boolean,
		transcript: "live" | "snapshot" = "live",
	): SessionTranscriptPoll {
		const effectiveTranscript = transcript === "live" && this.#record ? "live" : "snapshot";
		return {
			record: this.#record,
			entries,
			reset,
			changed,
			watermark: { entryCount: this.#rawCount, lastEntryId: this.#rawLastId },
			unresolvedPendingCount: this.#projector?.unresolvedPendingCount ?? 0,
			stable: effectiveTranscript === "live" && this.#stableSamples >= 2,
			transcript: effectiveTranscript,
		};
	}
	#invalidate(forceReset = false): void {
		this.#stableSamples = 0;
		this.#stableIdentity = "";
		this.#stableSize = -1;
		if (forceReset) this.#forceReset = true;
	}
	#reset(identity: string): void {
		this.#identity = identity;
		this.#offset = 0;
		this.#pending = new Uint8Array();
		this.#skippingOversizedLine = false;
		this.#oversizedLineCount = 0;
		this.#projector = undefined;
		this.#record = undefined;
		this.#rawCount = 0;
		this.#rawLastId = null;
		this.#stableSamples = 0;
		this.#stableIdentity = "";
		this.#stableSize = -1;
		this.#forceReset = false;
		this.#observedSize = -1;
		this.#observedStamp = "";
		this.#slotTitle = undefined;
		this.#headerTitle = undefined;
		this.#tailAnchor = new Uint8Array();
	}
	#observeEof(identity: string, size: number): boolean {
		if (this.#pending.byteLength > 0) {
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(this.#pending);
			} catch {
				this.#invalidate(true);
				return false;
			}
			this.#invalidate();
			return true;
		}
		if (this.#skippingOversizedLine) {
			this.#invalidate();
			return true;
		}
		if (this.#stableIdentity === identity && this.#stableSize === size)
			this.#stableSamples = Math.min(2, this.#stableSamples + 1);
		else {
			this.#stableIdentity = identity;
			this.#stableSize = size;
			this.#stableSamples = 1;
		}
		return true;
	}
	async poll(): Promise<SessionTranscriptPoll> {
		let info: DiscoveryStat;
		try {
			info = await this.#fs.stat(this.#path);
		} catch {
			this.#invalidate();
			return this.#result([], false, false, "snapshot");
		}
		const identity = this.#identityOf(info);
		const rewrittenInPlace =
			identity === this.#identity &&
			this.#observedSize >= 0 &&
			(info.size < this.#observedSize ||
				(info.size === this.#observedSize && this.#stampOf(info) !== this.#observedStamp));
		let rewrittenWhileGrowing = false;
		if (
			identity === this.#identity &&
			this.#observedSize >= 0 &&
			info.size > this.#observedSize &&
			this.#stampOf(info) !== this.#observedStamp
		) {
			try {
				rewrittenWhileGrowing = !(await this.#tailStillMatches(identity));
			} catch {
				this.#invalidate(true);
				return this.#result([], false, false, "snapshot");
			}
		}
		const reset =
			this.#forceReset ||
			identity !== this.#identity ||
			info.size < this.#offset ||
			rewrittenInPlace ||
			rewrittenWhileGrowing;
		if (reset) this.#reset(identity);
		if (!reset && info.size === this.#offset) {
			if (!this.#observeEof(identity, info.size)) return this.#result([], false, false, "snapshot");
			this.#observedSize = info.size;
			this.#observedStamp = this.#stampOf(info);
			return this.#result([], false, false);
		}
		const bytesToRead = Math.min(OBSERVER_MAX_BUFFER_BYTES, Math.max(0, info.size - this.#offset));
		if (bytesToRead === 0) {
			if (!this.#observeEof(identity, info.size)) return this.#result([], reset, false, "snapshot");
			this.#observedSize = info.size;
			this.#observedStamp = this.#stampOf(info);
			return this.#result([], reset, reset);
		}
		const readOffset = this.#offset;
		let chunk: string | Uint8Array;
		let fullFallback = false;
		try {
			if (this.#fs.readFileRange)
				chunk = await this.#fs.readFileRange(this.#path, readOffset, bytesToRead, identity);
			else {
				chunk = await this.#fs.readFile(this.#path);
				fullFallback = true;
			}
			const afterRead = await this.#fs.stat(this.#path);
			if (
				this.#identityOf(afterRead) !== identity ||
				afterRead.size !== info.size ||
				this.#stampOf(afterRead) !== this.#stampOf(info)
			)
				throw new Error("transcript changed while reading");
		} catch {
			this.#invalidate(true);
			return this.#result([], reset, false, "snapshot");
		}
		this.#observedSize = info.size;
		this.#observedStamp = this.#stampOf(info);
		const fullBytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
		if (fullFallback && fullBytes.byteLength < readOffset) {
			this.#invalidate(true);
			return this.#result([], reset, false, "snapshot");
		}
		const raw = fullFallback
			? fullBytes.slice(readOffset, readOffset + bytesToRead)
			: fullBytes.slice(0, bytesToRead);
		this.#rememberTail(raw);
		this.#offset = readOffset + raw.byteLength;
		const complete = this.#consumeLines(raw);
		const entries: DurableEntry[] = [];
		for (const encodedLine of complete) {
			if (encodedLine === null) {
				const notice = this.#oversizedLineNotice(info);
				if (notice) entries.push(notice);
				continue;
			}
			if (encodedLine.byteLength === 0) continue;
			let line: string;
			try {
				line = new TextDecoder("utf-8", { fatal: true }).decode(encodedLine);
			} catch {
				this.#invalidate(true);
				return this.#result([], reset, false, "snapshot");
			}
			let rawValue: Record<string, unknown>;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				rawValue = parsed as Record<string, unknown>;
			} catch {
				continue;
			}
			if (!this.#record && rawValue.type === "title" && rawValue.v === 1 && typeof rawValue.title === "string") {
				this.#slotTitle = cleanText(rawValue.title, 512, true);
				continue;
			}
			if (!this.#record) {
				let value: Record<string, unknown>;
				try {
					const parsed = parseBounded(JSON.stringify(rawValue));
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
					value = parsed as Record<string, unknown>;
				} catch {
					continue;
				}
				if (
					value.type !== "session" ||
					typeof value.id !== "string" ||
					!value.id ||
					typeof value.cwd !== "string" ||
					!value.cwd ||
					typeof value.timestamp !== "string" ||
					!Number.isFinite(Date.parse(value.timestamp))
				)
					continue;
				let sid: SessionId;
				try {
					sid = sessionId(value.id);
				} catch {
					continue;
				}
				const cwd = resolve(value.cwd);
				this.#headerTitle =
					typeof value.title === "string" ? cleanText(value.title, 512, true) || undefined : undefined;
				this.#projector = new SessionEntryProjector(this.#host, sid, "live", [], id =>
					artifactDescriptorForRoot(this.#path.slice(0, -".jsonl".length), id),
				);
				this.#record = {
					sessionId: sid,
					path: this.#path,
					cwd,
					projectId: stableProjectId(cwd),
					projectName: projectNameFromCwd(cwd),
					title: this.#slotTitle || this.#headerTitle || "Untitled",
					updatedAt: new Date(info.mtimeMs).toISOString(),
					status: "idle",
					entries: this.#projector.entries,
				};
				continue;
			}
			if (!validRawEntry(rawValue)) continue;
			this.#rawCount += 1;
			this.#rawLastId = String(rawValue.id);
			let value: Record<string, unknown>;
			try {
				// The coding-agent loader accepts JSON duplicate keys with the
				// platform parser's last-key-wins semantics. Validate and project
				// that same parsed value so the promotion watermark cannot agree
				// while the observer silently drops the record.
				const parsed = parseBounded(JSON.stringify(rawValue));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				value = parsed as Record<string, unknown>;
			} catch {
				continue;
			}
			if (!validRawEntry(value)) continue;
			let projected: DurableEntry[];
			try {
				projected = this.#projector!.project(value);
			} catch {
				this.#invalidate(true);
				return this.#result([], reset, false, "snapshot");
			}
			entries.push(...projected);
			if (this.#slotTitle) this.#record.title = this.#slotTitle;
			else if (this.#projector!.titleChange) this.#record.title = this.#projector!.titleChange;
			else if (!this.#headerTitle) {
				const fallback = fallbackSessionTitle(this.#projector!.firstUserText);
				if (fallback) this.#record.title = fallback;
			}
			if (this.#projector!.model) this.#record.model = this.#projector!.model;
			if (this.#projector!.thinking) this.#record.thinking = this.#projector!.thinking;
		}
		if (this.#record) {
			this.#record.updatedAt = new Date(info.mtimeMs).toISOString();
			this.#record.entries = this.#projector?.entries ?? [];
		}
		if (this.#offset === info.size && !this.#observeEof(identity, info.size))
			return this.#result([], reset, false, "snapshot");
		if (this.#offset !== info.size) this.#invalidate();
		this.#observedSize = info.size;
		this.#observedStamp = this.#stampOf(info);
		return this.#result(entries, reset, true);
	}
}

function isEncodedProjectDirectory(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name === "-" || name.startsWith("-");
}

export class FileSessionDiscovery implements SessionDiscovery {
	private readonly index = new Map<string, FileIndexEntry>();
	private rootMisses = 0;
	readonly page?: SessionDiscovery["page"];

	constructor(
		private readonly root: string,
		private readonly fs: DiscoveryFileSystem = realFs,
		private readonly host: HostId = hostId("discovery"),
		private readonly lazyEntries = false,
	) {
		if (fs.readFileSlice && fs.readFileRange) {
			const pageReader = new TranscriptPageReader(host, {
				stat: path => fs.stat(path),
				readFileSlice: (path, maxBytes) => fs.readFileSlice!(path, maxBytes),
				readFileRange: (path, offset, maxBytes, expectedIdentity) =>
					fs.readFileRange!(path, offset, maxBytes, expectedIdentity),
			});
			this.page = (session, args) => pageReader.page(session, args);
		}
	}
	private async parse(path: string, size: number, metadataOnly: boolean): Promise<SessionRecord> {
		if (size > MAX_TRANSCRIPT_BYTES) {
			const readSlice = this.fs.readFileSlice;
			if (!readSlice) throw new Error("oversized transcript has no bounded reader");
			return parseSessionTranscriptMetadata(await readSlice(path, MAX_METADATA_BYTES), path);
		}
		if (!metadataOnly) return parseTranscript(await this.fs.readFile(path), path, this.host);
		if (!this.fs.readFileSlice) throw new Error("lazy transcript discovery has no bounded reader");
		const preview = parseTranscript(await this.fs.readFileSlice(path, MAX_METADATA_BYTES), path, this.host);
		return { ...preview, entries: [], entriesLoaded: false };
	}
	async load(session: SessionRecord): Promise<SessionRecord> {
		if (!this.lazyEntries || session.entriesLoaded !== false) return session;
		const path = session.path;
		const fileStat = await this.fs.stat(path);
		const loaded = await this.parse(path, fileStat.size, false);
		if (loaded.sessionId !== session.sessionId) throw new Error("session identity changed while loading transcript");
		loaded.updatedAt = new Date(fileStat.mtimeMs).toISOString();
		const identity = (() => {
			try {
				return realpathSync.native(path);
			} catch {
				return resolve(path);
			}
		})();
		const signature = `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs ?? ""}:${fileStat.dev ?? ""}:${fileStat.ino ?? ""}`;
		this.index.set(identity, { signature, record: loaded, misses: 0 });
		return loaded;
	}
	private async isSessionArtifactDirectory(path: string): Promise<boolean> {
		try {
			const sibling = await this.fs.stat(`${path}.jsonl`);
			return sibling.isFile();
		} catch {
			return false;
		}
	}
	private async files(path: string, depth = 0): Promise<string[]> {
		const children = await this.fs.readdir(path);
		const output: string[] = [];
		for (const child of children.sort()) {
			const info = await this.fs.stat(child).catch(() => null);
			if (!info) continue;
			if (info.isFile() && child.endsWith(".jsonl")) {
				if (depth <= 1) output.push(child);
			} else if (
				depth === 0 &&
				info.isDirectory() &&
				isEncodedProjectDirectory(child) &&
				!(await this.isSessionArtifactDirectory(child))
			) {
				output.push(...(await this.files(child, 1)));
			}
		}
		return output;
	}
	private retainMiss(identity: string): SessionRecord | undefined {
		const cached = this.index.get(identity);
		if (!cached) return undefined;
		if (cached.misses >= 1) {
			this.index.delete(identity);
			return undefined;
		}
		this.index.set(identity, { ...cached, misses: 1 });
		return cached.record;
	}
	forget(path: string): void {
		const target = resolve(path);
		for (const [identity, cached] of this.index)
			if (resolve(cached.record.path) === target) this.index.delete(identity);
	}
	async list(): Promise<SessionRecord[]> {
		let files: string[];
		try {
			files = await this.files(this.root);
			this.rootMisses = 0;
		} catch {
			this.rootMisses += 1;
			if (this.rootMisses >= 2) this.index.clear();
			const retained = this.rootMisses === 1 ? [...this.index.values()].map(value => value.record) : [];
			retained.sort(compareSessionRecords);
			return retained;
		}
		const found: SessionRecord[] = [];
		const seen = new Set<string>();
		files.sort();
		for (const path of files) {
			let identity: string;
			try {
				identity = realpathSync.native(path);
			} catch {
				identity = resolve(path);
			}
			if (seen.has(identity)) continue;
			seen.add(identity);
			try {
				const fileStat = await this.fs.stat(path);
				const signature = `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs ?? ""}:${fileStat.dev ?? ""}:${fileStat.ino ?? ""}`;
				const cached = this.index.get(identity);
				let record = cached?.signature === signature ? cached.record : undefined;
				if (!record) {
					if ((fileStat.size > MAX_TRANSCRIPT_BYTES || this.lazyEntries) && !this.fs.readFileSlice)
						throw new Error("bounded transcript discovery has no bounded reader");
					record = await this.parse(path, fileStat.size, this.lazyEntries);
					record.updatedAt = new Date(fileStat.mtimeMs).toISOString();
				} else if (record.path !== path) {
					record = { ...record, path };
				}
				this.index.set(identity, { signature, record, misses: 0 });
				found.push(record);
			} catch {
				const retained = this.retainMiss(identity);
				if (retained) found.push(retained);
			}
		}
		for (const [identity] of this.index) {
			if (seen.has(identity)) continue;
			const retained = this.retainMiss(identity);
			if (retained) found.push(retained);
		}
		found.sort(compareSessionRecords);
		return found;
	}
}
export { realFs };
