import { decodeWorkspaceState, type WorkspaceStateFrame } from "./cluster.js";
import { fail } from "./errors.js";
import { inputObject } from "./guards.js";
import { decodeAgentAdditive, type AgentAdditiveFrame } from "./additive-agent.js";
import { decodeAuditAdditive, decodeCatalog, type AuditEventFrame, type AuditTailFrame, type CatalogFrame, type SettingsFrame } from "./additive-catalog.js";
import { decodeFilesAdditive, type FilesAdditiveFrame } from "./additive-files.js";
import { decodePreview, type PreviewFrame } from "./additive-preview.js";
import { decodeLease, decodeWatch, type LeaseFrame, type PromptLeaseFrame, type WatchFrame } from "./additive-session.js";
import { decodeTerminalAdditive, type TerminalServerFrame } from "./additive-terminal.js";

export * from "./additive-agent.js";
export * from "./additive-catalog.js";
export * from "./additive-files.js";
export * from "./additive-preview.js";
export * from "./additive-session.js";
export * from "./additive-terminal.js";

export const ADDITIVE_FEATURES = [
	"host.watch",
	"session.watch",
	"session.state",
	"session.delta",
	"session.observer",
	"session.unverified",
	"session.transfer",
	"session.fork",
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
	"cluster.operator",
] as const;
export type AdditiveFeature = (typeof ADDITIVE_FEATURES)[number];
export type WireFeature = AdditiveFeature | "resume";

export type AdditiveServerFrame =
	| WatchFrame
	| LeaseFrame
	| PromptLeaseFrame
	| AgentAdditiveFrame
	| TerminalServerFrame
	| FilesAdditiveFrame
	| AuditTailFrame
	| AuditEventFrame
	| CatalogFrame
	| SettingsFrame
	| WorkspaceStateFrame
	| PreviewFrame;
export function decodeAdditiveServerFrame(input: unknown): AdditiveServerFrame {
	const type = inputObject(input).type;
	if (typeof type !== "string") fail("INVALID_FRAME", "frame type must be string", "type");
	if (type === "workspace.state") return decodeWorkspaceState(input);
	if (["host.watch", "session.watch", "session.state", "session.delta"].includes(type)) return decodeWatch(input);
	if (type === "lease" || type === "prompt.lease") return decodeLease(input);
	if (type.startsWith("agent.")) return decodeAgentAdditive(input);
	if (type === "terminal.output" || type === "terminal.exit") return decodeTerminalAdditive(input);
	if (type.startsWith("files.")) return decodeFilesAdditive(input);
	if (type === "audit.tail" || type === "audit.event") return decodeAuditAdditive(input);
	if (type === "catalog" || type === "settings") return decodeCatalog(input);
	if (type.startsWith("preview.")) return decodePreview(input);
	fail("UNKNOWN_FRAME", "unknown additive server frame family", "type");
}
export function isNegotiatedFeature(feature: string, granted: readonly string[]): boolean {
	return granted.includes(feature);
}
