import {
	COMMAND_ARGUMENT_DECODERS,
	COMMAND_RESULT_DECODERS,
} from "./command-codecs/registry.js";
export {
	decodeArtifactReadChunk,
	decodeSessionPromptArguments,
	decodeTurnReviewApplyResult,
} from "./command-codecs/prompt-media.js";
export {
	COMMAND_ARGUMENT_DECODERS,
	COMMAND_RESULT_DECODERS,
} from "./command-codecs/registry.js";
import type {
	CommandArguments,
	CommandFrame,
	CommandResult,
} from "./command-codecs/types.js";
export * from "./command-codecs/types.js";
import {
	COMMAND_DESCRIPTORS,
	type CommandDescriptor,
} from "./command-descriptors/index.js";
export {
	COMMAND_DESCRIPTORS,
	type CommandDescriptor,
	type RevisionOwner,
} from "./command-descriptors/index.js";
import type { DeviceCapability } from "./capabilities.js";
import { fail } from "./errors.js";
import { controlFree, inputObject } from "./guards.js";
import {
	commandId,
	confirmationId,
	hostId,
	requestId,
	revision,
	sessionId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";

export const DESKTOP_CATALOG_COMMANDS: readonly string[] = Object.freeze(
	Object.entries(COMMAND_DESCRIPTORS)
		.filter(([, descriptor]) => descriptor.desktopCatalog === true)
		.map(([name]) => name),
);
export const COMMAND_CAPABILITIES: Readonly<Record<string, DeviceCapability>> = Object.fromEntries(
	Object.entries(COMMAND_DESCRIPTORS).map(([name, descriptor]) => [name, descriptor.capability]),
);
export function validateCommandDescriptor(command: string, descriptor: CommandDescriptor): void {
	const validRevision =
		descriptor.revision === "none" || descriptor.revision === "optional" || descriptor.revision === "required";
	const validOwner =
		descriptor.revisionOwner === "none" ||
		descriptor.revisionOwner === "session" ||
		descriptor.revisionOwner === "authority";
	const ownerMatchesRevision =
		descriptor.revision === "none" ? descriptor.revisionOwner === "none" : descriptor.revisionOwner !== "none";
	if (!validRevision || !validOwner || !ownerMatchesRevision)
		fail("INVALID_FRAME", "invalid command revision descriptor", `command.${command}`);
}
for (const [command, descriptor] of Object.entries(COMMAND_DESCRIPTORS)) validateCommandDescriptor(command, descriptor);
export function decodeCommand(input: unknown): CommandFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
	requestId(frame.requestId);
	commandId(frame.commandId);
	const host = hostId(frame.hostId);
	const command = controlFree(frame.command, "command", 128);
	const descriptor = COMMAND_DESCRIPTORS[command];
	if (descriptor === undefined) fail("INVALID_FRAME", "unknown command", "command");
	validateCommandDescriptor(command, descriptor);
	const session = frame.sessionId === undefined ? undefined : sessionId(frame.sessionId);
	if (descriptor.scope === "session" && session === undefined)
		fail("INVALID_FRAME", "sessionId is required for session command", "sessionId");
	if (descriptor.scope === "host" && session !== undefined)
		fail("INVALID_FRAME", "sessionId is forbidden for host command", "sessionId");
	if (descriptor.revision === "none" && frame.expectedRevision !== undefined)
		fail("STALE_REVISION", "expectedRevision is forbidden", "expectedRevision");
	if (descriptor.revision === "required" && frame.expectedRevision === undefined)
		fail("STALE_REVISION", "expectedRevision is required", "expectedRevision");
	if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
	if (descriptor.confirmation === "none" && frame.confirmationId !== undefined)
		fail("CONFIRMATION_INVALID", "confirmationId is not valid", "confirmationId");
	if (frame.confirmationId !== undefined) confirmationId(frame.confirmationId);
	const args = decodeCommandArguments(command, frame.args === undefined ? {} : frame.args);
	return { ...frame, hostId: host, sessionId: session, command, args } as unknown as CommandFrame;
}
export function requiredCapability(command: string): DeviceCapability | undefined {
	return COMMAND_DESCRIPTORS[command]?.capability;
}
export function decodeCommandArguments(command: string, value: unknown): CommandArguments {
	const decoder = COMMAND_ARGUMENT_DECODERS[command];
	if (decoder === undefined) fail("INVALID_FRAME", "command has no typed argument decoder", "command");
	return decoder(value);
}
export function decodeCommandResult(command: string, value: unknown): CommandResult {
	const decoder = COMMAND_RESULT_DECODERS[command];
	if (decoder === undefined) fail("INVALID_FRAME", "command has no typed result decoder", "command");
	return decoder(value);
}
