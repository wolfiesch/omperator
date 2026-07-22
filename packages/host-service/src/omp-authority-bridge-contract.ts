export const OMP_AUTHORITY_BRIDGE_PROTOCOL = "t4-omp-authority/1" as const;
export const OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES = 1024 * 1024;

export const OMP_AUTHORITY_BRIDGE_METHODS = [
	"host.info",
	"session.create",
	"session.list",
	"session.archive",
	"session.restore",
	"session.delete",
	"discovery.load",
	"discovery.page",
	"project.rootForProject",
	"project.rootForSession",
	"lock.check",
	"lock.status",
	"operation.filesRead",
	"operation.filesList",
	"operation.filesDiff",
	"operation.filesWrite",
	"operation.filesPatch",
	"operation.reviewRead",
	"operation.reviewApply",
	"operation.bashRun",
	"operation.termOpen",
	"operation.catalogGet",
	"operation.settingsRead",
	"operation.brokerStatus",
	"operation.settingsWrite",
	"operation.configWrite",
	"terminal.input",
	"terminal.resize",
	"terminal.close",
	"usage.read",
] as const;

export type OmpAuthorityBridgeMethod = (typeof OMP_AUTHORITY_BRIDGE_METHODS)[number];

export interface OmpAuthorityBridgeReady {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "ready";
	readonly methods: readonly OmpAuthorityBridgeMethod[];
	readonly ompVersion: string;
	readonly ompBuild: string;
}

export interface OmpAuthorityBridgeRequest {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "request";
	readonly id: string;
	readonly method: OmpAuthorityBridgeMethod;
	readonly params: Record<string, unknown>;
}

export interface OmpAuthorityBridgeCancel {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "cancel";
	readonly id: string;
}

export interface OmpAuthorityBridgeSuccess {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "response";
	readonly id: string;
	readonly ok: true;
	readonly result: unknown;
}

export interface OmpAuthorityBridgeFailure {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "response";
	readonly id: string;
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

export interface OmpAuthorityBridgeTerminalEvent {
	readonly v: typeof OMP_AUTHORITY_BRIDGE_PROTOCOL;
	readonly type: "event";
	readonly id: string;
	readonly event: "terminal";
	readonly payload: unknown;
}

export type OmpAuthorityBridgeClientFrame = OmpAuthorityBridgeRequest | OmpAuthorityBridgeCancel;
export type OmpAuthorityBridgeServerFrame =
	| OmpAuthorityBridgeReady
	| OmpAuthorityBridgeSuccess
	| OmpAuthorityBridgeFailure
	| OmpAuthorityBridgeTerminalEvent;

const METHOD_SET = new Set<string>(OMP_AUTHORITY_BRIDGE_METHODS);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_RESULT_TEXT_BYTES = 512 * 1024;
const MAX_VALUE_DEPTH = 32;
const MAX_VALUE_NODES = 50_000;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
		throw new Error(`${label} has unknown or missing fields`);
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function boundedText(value: unknown, label: string, maxBytes = 4096): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes)
		throw new Error(`${label} is invalid`);
	return value;
}

function method(value: unknown): OmpAuthorityBridgeMethod {
	if (typeof value !== "string" || !METHOD_SET.has(value)) throw new Error("bridge method is unsupported");
	return value as OmpAuthorityBridgeMethod;
}

function boundedJson(value: unknown, label: string, maxTextBytes = MAX_TEXT_BYTES): unknown {
	let nodes = 0;
	let textBytes = 0;
	const visit = (item: unknown, depth: number): void => {
		nodes += 1;
		if (nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) throw new Error(`${label} exceeds bridge bounds`);
		if (item === null || typeof item === "boolean") return;
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new Error(`${label} contains an invalid number`);
			return;
		}
		if (typeof item === "string") {
			textBytes += Buffer.byteLength(item, "utf8");
			if (textBytes > maxTextBytes) throw new Error(`${label} exceeds bridge text bounds`);
			return;
		}
		if (Array.isArray(item)) {
			for (const child of item) visit(child, depth + 1);
			return;
		}
		if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype)
			throw new Error(`${label} contains a non-JSON value`);
		for (const [key, child] of Object.entries(item)) {
			textBytes += Buffer.byteLength(key, "utf8");
			if (textBytes > maxTextBytes) throw new Error(`${label} exceeds bridge text bounds`);
			visit(child, depth + 1);
		}
	};
	visit(value, 0);
	return value;
}

function decodeVersion(value: Record<string, unknown>): void {
	if (value.v !== OMP_AUTHORITY_BRIDGE_PROTOCOL) throw new Error("bridge protocol version is unsupported");
}

export function decodeOmpAuthorityBridgeClientFrame(value: unknown): OmpAuthorityBridgeClientFrame {
	const frame = record(value, "bridge frame");
	decodeVersion(frame);
	if (frame.type === "cancel") {
		exactKeys(frame, ["v", "type", "id"], "bridge cancel");
		return { v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "cancel", id: identifier(frame.id, "bridge id") };
	}
	if (frame.type !== "request") throw new Error("bridge client frame type is unsupported");
	exactKeys(frame, ["v", "type", "id", "method", "params"], "bridge request");
	return {
		v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
		type: "request",
		id: identifier(frame.id, "bridge id"),
		method: method(frame.method),
		params: boundedJson(record(frame.params, "bridge params"), "bridge params") as Record<string, unknown>,
	};
}

export function decodeOmpAuthorityBridgeServerFrame(value: unknown): OmpAuthorityBridgeServerFrame {
	const frame = record(value, "bridge frame");
	decodeVersion(frame);
	if (frame.type === "ready") {
		exactKeys(frame, ["v", "type", "methods", "ompVersion", "ompBuild"], "bridge ready");
		if (!Array.isArray(frame.methods) || new Set(frame.methods).size !== frame.methods.length)
			throw new Error("bridge methods are invalid");
		return {
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "ready",
			methods: frame.methods.map(method),
			ompVersion: boundedText(frame.ompVersion, "OMP version", 128),
			ompBuild: boundedText(frame.ompBuild, "OMP build", 256),
		};
	}
	if (frame.type === "event") {
		exactKeys(frame, ["v", "type", "id", "event", "payload"], "bridge event");
		if (frame.event !== "terminal") throw new Error("bridge event is unsupported");
		return {
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "event",
			id: identifier(frame.id, "bridge id"),
			event: "terminal",
			payload: boundedJson(frame.payload, "bridge event payload"),
		};
	}
	if (frame.type !== "response") throw new Error("bridge server frame type is unsupported");
	const id = identifier(frame.id, "bridge id");
	if (frame.ok === true) {
		exactKeys(frame, ["v", "type", "id", "ok", "result"], "bridge response");
		return {
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id,
			ok: true,
			result: boundedJson(frame.result, "bridge result", MAX_RESULT_TEXT_BYTES),
		};
	}
	if (frame.ok !== false) throw new Error("bridge response status is invalid");
	exactKeys(frame, ["v", "type", "id", "ok", "error"], "bridge response");
	const error = record(frame.error, "bridge error");
	exactKeys(error, ["code", "message"], "bridge error");
	if (typeof error.code !== "string" || !ERROR_CODE.test(error.code)) throw new Error("bridge error code is invalid");
	return {
		v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
		type: "response",
		id,
		ok: false,
		error: { code: error.code, message: boundedText(error.message, "bridge error message") },
	};
}

export function encodeOmpAuthorityBridgeFrame(frame: OmpAuthorityBridgeClientFrame | OmpAuthorityBridgeServerFrame): string {
	const text = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(text, "utf8") > OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)
		throw new Error("bridge frame exceeds the line limit");
	return text;
}

export function parseOmpAuthorityBridgeLine(line: string, side: "client" | "server"):
	| OmpAuthorityBridgeClientFrame
	| OmpAuthorityBridgeServerFrame {
	if (Buffer.byteLength(line, "utf8") > OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)
		throw new Error("bridge frame exceeds the line limit");
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("bridge frame is not valid JSON");
	}
	return side === "client" ? decodeOmpAuthorityBridgeClientFrame(value) : decodeOmpAuthorityBridgeServerFrame(value);
}
