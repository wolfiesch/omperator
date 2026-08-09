import { decodeCapabilities, decodeFeatureList } from "./capabilities.js";
import { fail } from "./errors.js";
import { controlFree, deviceToken, inputObject, string } from "./guards.js";
import {
	type CommandId,
	type ConfirmationId,
	commandId,
	confirmationId,
	type HostId,
	hostId,
	type PairingId,
	pairingId,
	type RequestId,
	type Revision,
	requestId,
	revision,
	type SessionId,
	sessionId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface ConfirmationChallenge {
	v: typeof PROTOCOL_VERSION;
	type: "confirmation";
	confirmationId: ConfirmationId;
	commandId: CommandId;
	hostId: HostId;
	sessionId?: SessionId;
	commandHash: string;
	revision: Revision;
	expiresAt: string;
	summary: string;
	preview?: string;
}
export interface ConfirmFrame {
	v: typeof PROTOCOL_VERSION;
	type: "confirm";
	requestId: RequestId;
	confirmationId: ConfirmationId;
	commandId: CommandId;
	hostId: HostId;
	sessionId?: SessionId;
	decision: "approve" | "deny";
}
export interface PairStartFrame {
	v: typeof PROTOCOL_VERSION;
	type: "pair.start";
	requestId: RequestId;
	/** One-time six-digit pairing code. Omitted or empty when the peer requests
	 * tailnet-owner auto-approval; non-empty codes must still be six digits. */
	code?: string;
	deviceId: string;
	deviceName: string;
	platform: string;
	requestedCapabilities: string[];
}
export interface PairOkFrame {
	v: typeof PROTOCOL_VERSION;
	type: "pair.ok";
	requestId: RequestId;
	pairingId: PairingId;
	deviceId: string;
	deviceName: string;
	platform: string;
	requestedCapabilities: string[];
	grantedCapabilities: string[];
	deviceToken: string;
	expiresAt: string;
}
export interface PairErrorFrame {
	v: typeof PROTOCOL_VERSION;
	type: "pair.error";
	code: string;
	message: string;
	requestId?: RequestId;
}
export type PairingFrame = PairStartFrame | PairOkFrame | PairErrorFrame;
function version(frame: Record<string, unknown>): void {
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
}
function device(frame: Record<string, unknown>): void {
	controlFree(frame.deviceId, "deviceId", 256);
	controlFree(frame.deviceName, "deviceName", 256);
	controlFree(frame.platform, "platform", 128);
	const requested = decodeFeatureList(frame.requestedCapabilities, "requestedCapabilities");
	decodeCapabilities({ client: requested });
}
function pairingCode(value: unknown, path: string): string {
	const code = controlFree(value, path, 6);
	if (!/^\d{6}$/u.test(code)) fail("PAIRING_INVALID", "pairing code must be six digits", path);
	return code;
}
export function decodeConfirmation(input: unknown): ConfirmationChallenge {
	const frame = inputObject(input);
	version(frame);
	if (frame.type !== "confirmation") fail("INVALID_FRAME", "expected confirmation challenge", "type");
	confirmationId(frame.confirmationId);
	commandId(frame.commandId);
	hostId(frame.hostId);
	if (frame.sessionId !== undefined) sessionId(frame.sessionId);
	controlFree(frame.commandHash, "commandHash", 256);
	revision(frame.revision);
	controlFree(frame.expiresAt, "expiresAt", 128);
	string(frame.summary, "summary", 2048);
	if (frame.preview !== undefined) string(frame.preview, "preview", 8192);
	return frame as unknown as ConfirmationChallenge;
}
export function decodeConfirm(input: unknown): ConfirmFrame {
	const frame = inputObject(input);
	version(frame);
	if (frame.type !== "confirm") fail("INVALID_FRAME", "expected confirmation decision", "type");
	requestId(frame.requestId);
	confirmationId(frame.confirmationId);
	commandId(frame.commandId);
	hostId(frame.hostId);
	if (frame.sessionId !== undefined) sessionId(frame.sessionId);
	if (frame.decision !== "approve" && frame.decision !== "deny")
		fail("CONFIRMATION_INVALID", "decision must approve or deny", "decision");
	return frame as unknown as ConfirmFrame;
}
export function decodePairing(input: unknown): PairingFrame {
	const frame = inputObject(input);
	version(frame);
	if (frame.type === "pair.start") {
		requestId(frame.requestId);
		if (frame.code !== undefined && frame.code !== "") pairingCode(frame.code, "code");
		device(frame);
		return frame as unknown as PairStartFrame;
	}
	if (frame.type === "pair.ok") {
		requestId(frame.requestId);
		pairingId(frame.pairingId);
		device(frame);
		const granted = decodeFeatureList(frame.grantedCapabilities, "grantedCapabilities");
		decodeCapabilities({ client: granted });
		controlFree(frame.deviceToken, "deviceToken", 512);
		deviceToken(frame.deviceToken, "deviceToken");
		controlFree(frame.expiresAt, "expiresAt", 128);
		return frame as unknown as PairOkFrame;
	}
	if (frame.type === "pair.error") {
		controlFree(frame.code, "code", 128);
		string(frame.message, "message", 1024);
		if (frame.requestId !== undefined) requestId(frame.requestId);
		return frame as unknown as PairErrorFrame;
	}
	fail("INVALID_FRAME", "expected pairing frame", "type");
}
