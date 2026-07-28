import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import {
	boundedMap,
	boundedMetadata,
	controlFree,
	inputObject,
	isSecretLikeKey,
} from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";

export function frame(input: unknown, expected: readonly string[]): Record<string, unknown> {
	const value = inputObject(input);
	if (value.v !== PROTOCOL_VERSION)
		fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (typeof value.type !== "string" || !expected.includes(value.type))
		fail("UNKNOWN_FRAME", "unknown discriminant", "type");
	if (value.metadata !== undefined)
		boundedMetadata(value.metadata, "metadata", isSecretLikeKey);
	return value;
}

export function own(value: Record<string, unknown>): {
	hostId: HostId;
	sessionId: SessionId;
} {
	return {
		hostId: hostId(value.hostId),
		sessionId: sessionId(value.sessionId),
	};
}

export function cur(value: unknown): Cursor {
	return decodeCursor(value);
}

export function known(
	value: unknown,
	path: string,
	values: readonly string[],
): string {
	const result = controlFree(value, path, 128);
	if (!values.includes(result))
		fail("UNKNOWN_FRAME", `unknown discriminant ${result}`, path);
	return result;
}

export function object(value: unknown, path: string): Record<string, unknown> {
	return boundedMap(value, path);
}
