import { fail } from "./errors.js";
import { capabilitiesArray, controlFree, inputObject } from "./guards.js";
export const DEVICE_CAPABILITIES = [
	"sessions.read",
	"sessions.prompt",
	"sessions.control",
	"sessions.manage",
	"bash.run",
	"term.open",
	"term.input",
	"term.resize",
	"files.read",
	"files.write",
	"files.list",
	"files.diff",
	"agents.control",
	"audit.read",
	"config.read",
	"catalog.read",
	"config.write",
	"broker.read",
	"usage.read",
	"preview.read",
	"preview.control",
	"preview.input",
	"ci.trigger",
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];
export const PROTOCOL_FEATURES = [
	"resume",
	"host.watch",
	"session.watch",
	"session.state",
	"session.delta",
	"session.observer",
	"controller.lease",
	"prompt.lease",
	"prompt.images",
	"transcript.images",
	"transcript.search",
	"transcript.page",
	"project.reveal",
	"agent.lifecycle",
	"agent.progress",
	"agent.event",
	"agent.transcript",
	"terminal.io",
	"files.list",
	"files.search",
	"files.diff",
	"audit.tail",
	"catalog.metadata",
	"settings.metadata",
	"preview.control",
	"runtime.adapters",
	"workspace.lifecycle",
	"cluster.operator",
] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
export const REMOTE_DEFAULT_CAPABILITIES = [
	"sessions.read",
	"sessions.prompt",
	"sessions.control",
	"sessions.manage",
	"agents.control",
] as const;
export interface Capabilities {
	client: string[];
	server?: string[];
}
export function decodeCapabilities(value: unknown, path = "capabilities"): Capabilities {
	const input = inputObject(value);
	const client = capabilitiesArray(input.client, `${path}.client`);
	const server = input.server === undefined ? undefined : capabilitiesArray(input.server, `${path}.server`);
	for (const [i, capability] of client.entries())
		if (!(DEVICE_CAPABILITIES as readonly string[]).includes(capability))
			fail("INVALID_FRAME", "unknown device capability", `${path}.client[${i}]`);
	if (server !== undefined)
		for (const [i, capability] of server.entries())
			if (!(DEVICE_CAPABILITIES as readonly string[]).includes(capability))
				fail("INVALID_FRAME", "unknown device capability", `${path}.server[${i}]`);
	return server === undefined ? { client } : { client, server };
}
export function decodeFeatureList(value: unknown, path: string): string[] {
	const result = capabilitiesArray(value, path);
	for (const [i, feature] of result.entries()) controlFree(feature, `${path}[${i}]`, 128);
	return result;
}
export function decodeNegotiatedFeatureList(value: unknown, path: string): ProtocolFeature[] {
	const result = decodeFeatureList(value, path);
	for (const [i, feature] of result.entries())
		if (!(PROTOCOL_FEATURES as readonly string[]).includes(feature))
			fail("INVALID_FRAME", "unknown protocol feature", `${path}[${i}]`);
	return result as ProtocolFeature[];
}
export function isCapability(value: unknown): value is DeviceCapability {
	return typeof value === "string" && (DEVICE_CAPABILITIES as readonly string[]).includes(value);
}
export function isProtocolFeature(value: unknown): value is ProtocolFeature {
	return typeof value === "string" && (PROTOCOL_FEATURES as readonly string[]).includes(value);
}
