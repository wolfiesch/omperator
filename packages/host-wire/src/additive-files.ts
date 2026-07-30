import type { Cursor } from "./cursor.js";
import { fail } from "./errors.js";
import { boundedArray, boundedBase64, boundedMap, boundedText, safeRelativePath, safeSeq } from "./guards.js";
import { type HostId, type Revision, revision, type SessionId } from "./ids.js";
import { MAX_FILE_BYTES, PROTOCOL_VERSION } from "./limits.js";
import { cur, frame, known, own } from "./additive-codec.js";

export interface FileListEntry {
	path: string;
	kind: "file" | "directory" | "symlink";
	size?: number;
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesListFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.list";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	entries: FileListEntry[];
	cursor?: Cursor;
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesReadFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.read";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesWriteFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.write";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
	revision: Revision;
	[key: string]: unknown;
}
export interface FilesPatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.patch";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	patch: string;
	revision: Revision;
	[key: string]: unknown;
}
export interface FilesDiffFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.diff";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	diff: string;
	fromRevision?: Revision;
	toRevision?: Revision;
	[key: string]: unknown;
}
export type FilesAdditiveFrame = FilesListFrame | FilesReadFrame | FilesWriteFrame | FilesPatchFrame | FilesDiffFrame;
export function decodeFileListEntry(value: unknown, path: string): FileListEntry {
	const x = boundedMap(value, path),
		result = {
			...x,
			path: safeRelativePath(x.path, `${path}.path`),
			kind: known(x.kind, `${path}.kind`, ["file", "directory", "symlink"]) as FileListEntry["kind"],
		} as FileListEntry;
	if (x.size !== undefined) {
		const size = safeSeq(x.size, `${path}.size`);
		if (size > MAX_FILE_BYTES * 1024) fail("BOUNDS", "file size exceeds limit", `${path}.size`);
		result.size = size;
	}
	if (x.revision !== undefined) result.revision = revision(x.revision);
	return result;
}
export function decodeFilesAdditive(input: unknown): FilesAdditiveFrame {
	const x = frame(input, ["files.list", "files.read", "files.write", "files.patch", "files.diff"]),
		type = x.type as string,
		ids = own(x),
		path = safeRelativePath(x.path);
	if (type === "files.list") {
		const result = {
			...x,
			type,
			...ids,
			path,
			entries: boundedArray(x.entries, "entries").map((v, i) => decodeFileListEntry(v, `entries[${i}]`)),
		} as FilesListFrame;
		if (x.cursor !== undefined) result.cursor = cur(x.cursor);
		if (x.revision !== undefined) result.revision = revision(x.revision);
		return result;
	}
	if (type === "files.read") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			result = {
				...x,
				type,
				...ids,
				path,
				content:
					encoding === "base64"
						? boundedBase64(x.content, "content", MAX_FILE_BYTES)
						: boundedText(x.content, "content", MAX_FILE_BYTES),
			} as FilesReadFrame;
		if (encoding !== undefined) result.encoding = encoding;
		if (x.revision !== undefined) result.revision = revision(x.revision);
		return result;
	}
	if (type === "files.write") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			result = {
				...x,
				type,
				...ids,
				path,
				content:
					encoding === "base64"
						? boundedBase64(x.content, "content", MAX_FILE_BYTES)
						: boundedText(x.content, "content", MAX_FILE_BYTES),
				revision: revision(x.revision),
			} as FilesWriteFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	if (type === "files.patch")
		return {
			...x,
			type,
			...ids,
			path,
			patch: boundedText(x.patch, "patch", MAX_FILE_BYTES),
			revision: revision(x.revision),
		} as FilesPatchFrame;
	const result = { ...x, type, ...ids, path, diff: boundedText(x.diff, "diff", MAX_FILE_BYTES) } as FilesDiffFrame;
	if (x.fromRevision !== undefined) result.fromRevision = revision(x.fromRevision);
	if (x.toRevision !== undefined) result.toRevision = revision(x.toRevision);
	return result;
}
