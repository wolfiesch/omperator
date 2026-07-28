import { decodeWorkspaceInfrastructureProjection } from "../cluster.js";
import { fail } from "../errors.js";
import {
	boundedArray,
	boundedMap,
	boundedText,
	controlFree,
	finiteNumber,
} from "../guards.js";
import { projectId } from "../ids.js";
import { strictMap } from "./shared.js";

export const runtimeSupports = new Set(["native", "emulated", "unavailable"]);
export const workspaceOwnerships = new Set(["managed", "imported-user", "detected-external", "repository-root"]);
export const workspaceLifecycles = new Set(["creating", "active", "archiving", "archived", "recovery-required"]);
export function decodeRuntimeResultItem(value: unknown, path: string): Record<string, unknown> {
	const item = strictMap(value, path, ["id", "displayName", "command", "capabilities", "availability"]);
	const id = controlFree(item.id, `${path}.id`, 64);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("INVALID_FRAME", "invalid runtime adapter id", `${path}.id`);
	const displayName = controlFree(item.displayName, `${path}.displayName`, 128);
	const command = strictMap(item.command, `${path}.command`, ["executable", "arguments", "cwdArgument"]);
	const executable = controlFree(command.executable, `${path}.command.executable`, 512);
	const arguments_ = boundedArray(command.arguments, `${path}.command.arguments`, 64).map((argument, index) =>
		boundedText(argument, `${path}.command.arguments[${index}]`, 4096),
	);
	const cwdArgument =
		command.cwdArgument === undefined
			? undefined
			: controlFree(command.cwdArgument, `${path}.command.cwdArgument`, 128);
	const capabilities = boundedMap(item.capabilities, `${path}.capabilities`);
	const decodedCapabilities: Record<string, string> = {};
	for (const [capability, support] of Object.entries(capabilities)) {
		controlFree(capability, `${path}.capabilities`, 128);
		if (typeof support !== "string" || !runtimeSupports.has(support))
			fail("INVALID_FRAME", "invalid runtime capability support", `${path}.capabilities.${capability}`);
		decodedCapabilities[capability] = support;
	}
	const availability = boundedMap(item.availability, `${path}.availability`);
	const state = availability.state;
	let decodedAvailability: Record<string, unknown>;
	if (state === "available") {
		strictMap(availability, `${path}.availability`, ["state"]);
		decodedAvailability = { state };
	} else if (state === "unavailable") {
		strictMap(availability, `${path}.availability`, ["state", "executable"]);
		decodedAvailability = {
			state,
			executable: controlFree(availability.executable, `${path}.availability.executable`, 512),
		};
	} else if (state === "unknown") {
		strictMap(availability, `${path}.availability`, ["state"]);
		decodedAvailability = { state };
	} else fail("INVALID_FRAME", "invalid runtime availability", `${path}.availability.state`);
	return {
		id,
		displayName,
		command: { executable, arguments: arguments_, ...(cwdArgument === undefined ? {} : { cwdArgument }) },
		capabilities: decodedCapabilities,
		availability: decodedAvailability!,
	};
}
export function decodeWorkspaceResultItem(value: unknown, path: string): Record<string, unknown> {
	const candidate = boundedMap(value, path);
	if (Object.hasOwn(candidate, "id"))
		return decodeWorkspaceInfrastructureProjection(candidate, path) as unknown as Record<string, unknown>;
	const item = strictMap(candidate, path, [
		"repositoryId",
		"instanceId",
		"ownership",
		"branch",
		"sourceCommit",
		"expectedHead",
		"lifecycle",
		"createdAt",
		"updatedAt",
		"archivedAt",
	]);
	const repositoryId = projectId(item.repositoryId, `${path}.repositoryId`);
	const instanceId = controlFree(item.instanceId, `${path}.instanceId`, 128);
	const ownership = item.ownership;
	if (typeof ownership !== "string" || !workspaceOwnerships.has(ownership))
		fail("INVALID_FRAME", "invalid workspace ownership", `${path}.ownership`);
	const lifecycle = item.lifecycle;
	if (typeof lifecycle !== "string" || !workspaceLifecycles.has(lifecycle))
		fail("INVALID_FRAME", "invalid workspace lifecycle", `${path}.lifecycle`);
	const createdAt = finiteNumber(item.createdAt, `${path}.createdAt`);
	const updatedAt = finiteNumber(item.updatedAt, `${path}.updatedAt`);
	if (createdAt < 0 || updatedAt < 0) fail("INVALID_FRAME", "workspace timestamps must be non-negative", path);
	const archivedAt = item.archivedAt === undefined ? undefined : finiteNumber(item.archivedAt, `${path}.archivedAt`);
	if (archivedAt !== undefined && archivedAt < 0)
		fail("INVALID_FRAME", "workspace archivedAt must be non-negative", `${path}.archivedAt`);
	return {
		repositoryId,
		instanceId,
		ownership,
		branch: controlFree(item.branch, `${path}.branch`, 256),
		sourceCommit: controlFree(item.sourceCommit, `${path}.sourceCommit`, 256),
		expectedHead: controlFree(item.expectedHead, `${path}.expectedHead`, 256),
		lifecycle,
		createdAt,
		updatedAt,
		...(archivedAt === undefined ? {} : { archivedAt }),
	};
}
