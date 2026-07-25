import { AppWireError, fail } from "./errors.js";
import {
	MAX_ARRAY_ITEMS,
	MAX_CAPABILITIES,
	MAX_INPUT_BYTES,
	MAX_JSON_DEPTH,
	MAX_JSON_NODES,
	MAX_MAP_KEYS,
	MAX_STRING_BYTES,
	MAX_TRANSCRIPT_LINE_BYTES,
} from "./limits.js";
export type JsonObject = Record<string, unknown>;
export function isSecretLikeKey(key: string): boolean {
	const normalized = key
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
	return [
		"password",
		"passwd",
		"secret",
		"token",
		"credential",
		"apikey",
		"privatekey",
		"cookie",
		"auth",
		"sessionkey",
	].some(marker => normalized.includes(marker));
}
export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c <= 0x7f) bytes++;
		else if (c <= 0x7ff) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) fail("INVALID_JSON", "unpaired UTF-16 surrogate");
			bytes += 4;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) fail("INVALID_JSON", "unpaired UTF-16 surrogate");
		else bytes += 3;
	}
	return bytes;
}
function plain(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
export function object(value: unknown, path = "frame"): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value) || !plain(value))
		fail("INVALID_FRAME", "expected plain object", path);
	return value as JsonObject;
}
export function string(value: unknown, path: string, max = MAX_STRING_BYTES): string {
	if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > max)
		fail("BOUNDS", "expected bounded non-empty UTF-8 string", path);
	return value;
}
export function optionalString(value: unknown, path: string, max = MAX_STRING_BYTES): void {
	if (value !== undefined) string(value, path, max);
}
export function boundedText(value: unknown, path: string, max = MAX_STRING_BYTES): string {
	if (typeof value !== "string" || utf8ByteLength(value) > max) fail("BOUNDS", "expected bounded UTF-8 text", path);
	return value;
}
export function boundedBase64(value: unknown, path: string, maxDecodedBytes: number): string {
	const text = boundedText(value, path, Math.ceil((maxDecodedBytes * 4) / 3) + 4);
	if (text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text))
		fail("BOUNDS", "invalid base64 payload", path);
	let decoded: string;
	try {
		decoded = atob(text);
	} catch {
		fail("BOUNDS", "invalid base64 payload", path);
	}
	if (decoded.length > maxDecodedBytes) fail("BOUNDS", "decoded payload exceeds protocol limit", path);
	return text;
}
export function controlFree(value: unknown, path: string, max = MAX_STRING_BYTES): string {
	const result = string(value, path, max);
	if ([...result].some(character => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	})) fail("BOUNDS", "control characters are not allowed", path);
	return result;
}
export function bool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail("INVALID_FRAME", "expected boolean", path);
	return value;
}
export function safeSeq(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		fail("UNSAFE_SEQUENCE", "sequence must be a safe non-negative integer", path);
	return value;
}
export function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("INVALID_FRAME", "expected finite number", path);
	return value;
}
export function boundedArray(value: unknown, path: string, max = MAX_ARRAY_ITEMS): unknown[] {
	if (!Array.isArray(value) || value.length > max) fail("BOUNDS", "expected bounded array", path);
	return value;
}
export function boundedMap(value: unknown, path: string, max = MAX_MAP_KEYS): JsonObject {
	const out = object(value, path);
	if (Object.keys(out).length > max) fail("BOUNDS", "too many object keys", path);
	return out;
}
export function capabilitiesArray(value: unknown, path: string): string[] {
	const items = boundedArray(value, path, MAX_CAPABILITIES);
	for (let i = 0; i < items.length; i++) controlFree(items[i], `${path}[${i}]`, 128);
	return items as string[];
}
function skip(text: string, i: number): number {
	while (i < text.length) {
		const char = text[i];
		if (char === undefined || !/\s/u.test(char)) break;
		i++;
	}
	return i;
}
function jsonString(text: string, start: number): number {
	let i = start + 1;
	for (; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 92) {
			i++;
			if (i >= text.length) fail("INVALID_JSON", "unterminated escape");
		} else if (c === 34) return i + 1;
		else if (c < 0x20) fail("INVALID_JSON", "control in JSON string");
	}
	fail("INVALID_JSON", "unterminated JSON string");
}
function scanValue(text: string, start: number, depth: number): number {
	if (depth > MAX_JSON_DEPTH) fail("BOUNDS", "JSON nesting exceeds protocol limit");
	const i = skip(text, start),
		c = text.charCodeAt(i);
	if (c === 34) return jsonString(text, i);
	if (c === 123) {
		let p = skip(text, i + 1),
			keys = 0;
		const seen = new Set<string>();
		if (text.charCodeAt(p) === 125) return p + 1;
		while (true) {
			if (text.charCodeAt(p) !== 34) fail("INVALID_JSON", "object key must be string");
			const end = jsonString(text, p);
			let key: string;
			try {
				key = JSON.parse(text.slice(p, end)) as string;
			} catch {
				fail("INVALID_JSON", "invalid JSON object key");
			}
			if (seen.has(key)) fail("INVALID_JSON", "duplicate JSON object key");
			seen.add(key);
			if (++keys > MAX_MAP_KEYS) fail("BOUNDS", "too many object keys");
			p = skip(text, end);
			if (text.charCodeAt(p++) !== 58) fail("INVALID_JSON", "expected object colon");
			p = scanValue(text, p, depth + 1);
			p = skip(text, p);
			if (text.charCodeAt(p) === 125) return p + 1;
			if (text.charCodeAt(p++) !== 44) fail("INVALID_JSON", "expected object comma");
			p = skip(text, p);
		}
	}
	if (c === 91) {
		let p = skip(text, i + 1),
			items = 0;
		if (text.charCodeAt(p) === 93) return p + 1;
		while (true) {
			if (++items > MAX_ARRAY_ITEMS) fail("BOUNDS", "too many array items");
			p = scanValue(text, p, depth + 1);
			p = skip(text, p);
			if (text.charCodeAt(p) === 93) return p + 1;
			if (text.charCodeAt(p++) !== 44) fail("INVALID_JSON", "expected array comma");
			p = skip(text, p);
		}
	}
	const match = text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
	if (!match) fail("INVALID_JSON", "invalid JSON value");
	return i + match[0].length;
}
function addApprox(bytes: number, amount: number, maxBytes: number, path: string): number {
	const next = bytes + amount;
	if (next > maxBytes) fail("OVERSIZED_INPUT", "JSON value exceeds protocol limit", path);
	return next;
}
function validateJson(root: unknown, maxBytes = MAX_INPUT_BYTES): void {
	const seen = new WeakSet<object>();
	const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: root, depth: 0, path: "frame" }];
	let nodes = 0,
		approx = 0;
	while (stack.length) {
		const current = stack.pop()!,
			value = current.value;
		if (++nodes > MAX_JSON_NODES) fail("BOUNDS", "JSON node limit exceeded", current.path);
		if (typeof value === "string") {
			approx = addApprox(approx, utf8ByteLength(value), maxBytes, current.path);
			continue;
		}
		if (value === null || typeof value === "boolean" || typeof value === "number") {
			if (typeof value === "number" && !Number.isFinite(value))
				fail("INVALID_JSON", "non-finite number", current.path);
			approx = addApprox(approx, 8, maxBytes, current.path);
			continue;
		}
		if (typeof value !== "object") fail("INVALID_JSON", "non-JSON value", current.path);
		if (seen.has(value)) fail("INVALID_JSON", "cyclic JSON value", current.path);
		seen.add(value);
		if (current.depth >= MAX_JSON_DEPTH) fail("BOUNDS", "JSON nesting exceeds protocol limit", current.path);
		if (Array.isArray(value)) {
			if (value.length > MAX_ARRAY_ITEMS) fail("BOUNDS", "too many array items", current.path);
			for (let i = value.length - 1; i >= 0; i--)
				stack.push({ value: value[i], depth: current.depth + 1, path: `${current.path}[${i}]` });
			continue;
		}
		if (!plain(value)) fail("INVALID_JSON", "non-plain object", current.path);
		const keys = Object.keys(value);
		if (keys.length > MAX_MAP_KEYS) fail("BOUNDS", "too many object keys", current.path);
		for (const key of keys) {
			approx = addApprox(approx, utf8ByteLength(key), maxBytes, current.path);
			stack.push({ value: (value as JsonObject)[key], depth: current.depth + 1, path: `${current.path}.${key}` });
		}
	}
}
export function parseBounded(input: string | Uint8Array, maxBytes = MAX_INPUT_BYTES): unknown {
	const bytes = typeof input === "string" ? utf8ByteLength(input) : input.byteLength;
	if (bytes > maxBytes) fail("OVERSIZED_INPUT", "input exceeds protocol limit");
	let text: string;
	try {
		text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		fail("INVALID_JSON", "input is not valid UTF-8");
	}
	const end = scanValue(text, 0, 0);
	if (skip(text, end) !== text.length) fail("INVALID_JSON", "trailing JSON data");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof AppWireError) throw error;
		fail("INVALID_JSON", "invalid JSON");
	}
	validateJson(value, maxBytes);
	return value;
}
export function parseBoundedTranscriptLine(input: string | Uint8Array): unknown {
	return parseBounded(input, MAX_TRANSCRIPT_LINE_BYTES);
}
export function inputObject(input: unknown): JsonObject {
	const value = typeof input === "string" || input instanceof Uint8Array ? parseBounded(input) : input;
	validateJson(value);
	return object(value);
}
export function safeRelativePath(value: unknown, path = "path", max = 4096): string {
	const result = controlFree(value, path, max);
	if (
		result.includes("\\") ||
		result.startsWith("/") ||
		result.startsWith("//") ||
		/^[A-Za-z]:/u.test(result) ||
		result.startsWith("~")
	)
		fail("UNSAFE_PATH", "path must be a safe relative POSIX path", path);
	const parts = result.split("/");
	if (parts.some(part => part.length === 0 || part === "." || part === ".."))
		fail("UNSAFE_PATH", "path contains an unsafe segment", path);
	return result;
}
export function boundedMetadata(value: unknown, path: string, secretKey: (key: string) => boolean): JsonObject {
	const root = inputObject(value);
	const stack: Array<{ value: unknown; path: string }> = [{ value: root, path }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (typeof current.value === "string") {
			if (utf8ByteLength(current.value) > MAX_STRING_BYTES)
				fail("BOUNDS", "metadata string exceeds protocol limit", current.path);
			continue;
		}
		if (current.value === null || typeof current.value !== "object") continue;
		if (Array.isArray(current.value)) {
			for (let i = current.value.length - 1; i >= 0; i--)
				stack.push({ value: current.value[i], path: `${current.path}[${i}]` });
			continue;
		}
		for (const [key, child] of Object.entries(current.value)) {
			if (secretKey(key)) fail("INVALID_FRAME", "secret-like metadata key is forbidden", `${current.path}.${key}`);
			stack.push({ value: child, path: `${current.path}.${key}` });
		}
	}
	return root;
}
export function boundedSettings(value: unknown, path = "settings"): JsonObject {
	const source = boundedMap(value, path);
	const settings: JsonObject = {};
	for (const [rawPath, rawMetadata] of Object.entries(source)) {
		const settingPath = controlFree(rawPath, `${path}.path`, 512);
		const item = boundedMetadata(rawMetadata, `${path}.${settingPath}`, isSecretLikeKey);
		if (item.sensitive === true && (Object.hasOwn(item, "default") || Object.hasOwn(item, "effective")))
			fail("INVALID_FRAME", "sensitive setting metadata must omit values", `${path}.${settingPath}`);
		Object.defineProperty(settings, settingPath, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return settings;
}
export interface DeviceAuthentication {
	deviceId: string;
	deviceToken: string;
}
export function deviceToken(value: unknown, path = "deviceToken"): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value))
		fail("INVALID_FRAME", "device token must be canonical base64url for 32 bytes", path);
	return value;
}
export function decodeAuthentication(value: unknown, path = "authentication"): DeviceAuthentication {
	const auth = boundedMap(value, path);
	const keys = Object.keys(auth);
	if (keys.length !== 2 || !Object.hasOwn(auth, "deviceId") || !Object.hasOwn(auth, "deviceToken"))
		fail("INVALID_FRAME", "authentication must contain only deviceId and deviceToken", path);
	return {
		deviceId: controlFree(auth.deviceId, `${path}.deviceId`, 256),
		deviceToken: deviceToken(auth.deviceToken, `${path}.deviceToken`),
	};
}
