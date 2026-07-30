import type { Cursor } from "./cursor.js";
import { fail } from "./errors.js";
import { boundedBase64, boundedText, controlFree, safeSeq } from "./guards.js";
import { type HostId, type SessionId, type TerminalId, terminalId } from "./ids.js";
import { MAX_TERMINAL_OUTPUT_BYTES, PROTOCOL_VERSION } from "./limits.js";
import { cur, frame, known, own } from "./additive-codec.js";

export interface TerminalInputFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.input";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	data: string;
	encoding?: "utf8" | "base64";
	[key: string]: unknown;
}
export interface TerminalOutputFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.output";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cursor: Cursor;
	stream: "stdout" | "stderr";
	data: string;
	encoding?: "utf8" | "base64";
	[key: string]: unknown;
}
export interface TerminalResizeFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.resize";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cols: number;
	rows: number;
	[key: string]: unknown;
}
export interface TerminalCloseFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.close";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	reason?: string;
	[key: string]: unknown;
}
export interface TerminalExitFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.exit";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cursor: Cursor;
	exitCode: number;
	signal?: string;
	[key: string]: unknown;
}
export type TerminalClientFrame = TerminalInputFrame | TerminalResizeFrame | TerminalCloseFrame;
export type TerminalServerFrame = TerminalOutputFrame | TerminalExitFrame;
function dimension(value: unknown, path: string): number {
	const n = safeSeq(value, path),
		max = path.endsWith("cols") ? 1000 : 500;
	if (n === 0 || n > max) fail("BOUNDS", "terminal dimension out of range", path);
	return n;
}
export function decodeTerminalClient(input: unknown): TerminalClientFrame {
	const x = frame(input, ["terminal.input", "terminal.resize", "terminal.close"]),
		type = x.type as string,
		ids = own(x),
		tid = terminalId(x.terminalId);
	if (type === "terminal.input") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			data =
				encoding === "base64"
					? boundedBase64(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES)
					: boundedText(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES),
			result = { ...x, type, ...ids, terminalId: tid, data } as TerminalInputFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	if (type === "terminal.resize")
		return {
			...x,
			type,
			...ids,
			terminalId: tid,
			cols: dimension(x.cols, "cols"),
			rows: dimension(x.rows, "rows"),
		} as TerminalResizeFrame;
	const result = { ...x, type, ...ids, terminalId: tid } as TerminalCloseFrame;
	if (x.reason !== undefined) result.reason = controlFree(x.reason, "reason", 256);
	return result;
}
export function decodeTerminalAdditive(input: unknown): TerminalServerFrame {
	const x = frame(input, ["terminal.output", "terminal.exit"]),
		type = x.type as string,
		ids = own(x),
		tid = terminalId(x.terminalId),
		cursor = cur(x.cursor);
	if (type === "terminal.output") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			data =
				encoding === "base64"
					? boundedBase64(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES)
					: boundedText(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES),
			result = {
				...x,
				type,
				...ids,
				terminalId: tid,
				cursor,
				stream: known(x.stream, "stream", ["stdout", "stderr"]) as "stdout" | "stderr",
				data,
			} as TerminalOutputFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	const code = x.exitCode;
	if (typeof code !== "number" || !Number.isSafeInteger(code))
		fail("INVALID_FRAME", "exitCode must be safe integer", "exitCode");
	const result = { ...x, type, ...ids, terminalId: tid, cursor, exitCode: code } as TerminalExitFrame;
	if (x.signal !== undefined) result.signal = controlFree(x.signal, "signal", 128);
	return result;
}
