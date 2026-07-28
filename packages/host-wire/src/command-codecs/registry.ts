import { decodeBrokerStatusResult } from "../broker.js";
import { decodeCiRunArguments, decodeCiRunResult, decodeClusterSessionCreateArguments, decodeClusterWorkspaceCreateArguments } from "../cluster.js";
import { decodeCursor } from "../cursor.js";
import { fail } from "../errors.js";
import { decodeTurnReviewSnapshot } from "../files-review.js";
import { boundedArray, boundedMap, boundedText, controlFree, safeRelativePath, safeSeq } from "../guards.js";
import { imageId, leaseId, projectId, turnId } from "../ids.js";
import { IMAGE_UPLOAD_CHUNK_BYTES, IMAGE_UPLOAD_MAX_BYTES, MAX_FILE_BYTES, MAX_STRING_BYTES } from "../limits.js";
import { decodeProjectFileSearchArguments, decodeProjectFileSearchResult } from "../project-file-search.js";
import { decodeTranscriptContextArguments, decodeTranscriptContextResult, decodeTranscriptSearchArguments, decodeTranscriptSearchResult } from "../transcript-search.js";
import { decodeTranscriptPageArguments, decodeTranscriptPageResult } from "../transcript-page.js";
import { decodeUsageReadResult } from "../usage.js";
import { PREVIEW_ARGUMENT_DECODERS, PREVIEW_RESULT_DECODERS } from "./preview.js";
import { decodeArtifactRead, decodeArtifactReadChunk, decodeImageBegin, decodeImageChunk, decodeImageDiscard, decodeImageRead, decodeImageReadResult, decodeSessionPromptArguments, decodeTurnReviewApplyResult } from "./prompt-media.js";
import { args, boolField, decodeAcceptedResult, decodeAttach, decodeAuditResult, decodeBooleanResult, decodeCatalogResult, decodeCreate, decodeEntries, decodeLeaseResult, decodeMessage, decodePauseResult, decodeSessions, decodeSessionState, decodeSessionUiResponse, decodeSettingsResult, decodeTerminalResult, decodeWatchResult, leasedArgs, metadata, noArgs, result, strictArgs, strictResult } from "./shared.js";
import { decodeRuntimeResultItem, decodeWorkspaceResultItem } from "./runtime-workspace.js";
import type { CommandArguments, CommandResult } from "./types.js";

export const COMMAND_ARGUMENT_DECODERS: Readonly<Record<string, (value: unknown) => CommandArguments>> = {
	"runtime.list": noArgs,
	"workspace.list": noArgs,
	"workspace.create": value => {
		const candidate = boundedMap(value, "args");
		if (Object.hasOwn(candidate, "displayName"))
			return decodeClusterWorkspaceCreateArguments(candidate) as unknown as CommandArguments;
		const x = strictArgs(candidate, ["projectId", "name", "branch", "sourceCommit"]);
		projectId(x.projectId, "args.projectId");
		controlFree(x.name, "args.name", 128);
		controlFree(x.branch, "args.branch", 256);
		controlFree(x.sourceCommit, "args.sourceCommit", 256);
		return x;
	},
	"workspace.import": value => {
		const x = strictArgs(value, ["projectId", "name"]);
		projectId(x.projectId, "args.projectId");
		controlFree(x.name, "args.name", 128);
		return x;
	},
	"workspace.archive": value => {
		const x = strictArgs(value, ["instanceId"]);
		controlFree(x.instanceId, "args.instanceId", 128);
		return x;
	},
	"workspace.recover": noArgs,
	"host.list": args,
	"session.list": args,
	"transcript.search": value => decodeTranscriptSearchArguments(value) as unknown as CommandArguments,
	"transcript.context": value => decodeTranscriptContextArguments(value) as unknown as CommandArguments,
	"transcript.page": value => decodeTranscriptPageArguments(value) as unknown as CommandArguments,
	"project.reveal": value => {
		const x = strictArgs(value, ["projectId"]);
		projectId(x.projectId, "args.projectId");
		return x;
	},
	"session.create": value => {
		const candidate = boundedMap(value, "args");
		if (Object.hasOwn(candidate, "workspaceId"))
			return decodeClusterSessionCreateArguments(candidate) as unknown as CommandArguments;
		const x = strictArgs(candidate, ["projectId", "title", "runtimeId", "workspaceInstanceId"]);
		projectId(x.projectId, "args.projectId");
		if (x.title !== undefined) boundedText(x.title, "args.title", 512);
		const runtimeId = x.runtimeId === undefined ? undefined : controlFree(x.runtimeId, "args.runtimeId", 64);
		const workspaceInstanceId =
			x.workspaceInstanceId === undefined
				? undefined
				: controlFree(x.workspaceInstanceId, "args.workspaceInstanceId", 128);
		if ((runtimeId === undefined) !== (workspaceInstanceId === undefined))
			fail("INVALID_FRAME", "runtimeId and workspaceInstanceId must be provided together", "args");
		return x;
	},
	// A copy of a historic session may need a working directory of its own: the
	// transcript's recorded project directory is often long gone.
	"session.fork": value => {
		const x = strictArgs(value, ["cwd"]);
		if (x.cwd !== undefined) boundedText(x.cwd, "args.cwd", 4096);
		return x as CommandArguments;
	},
	"session.attach": value => {
		const x = args(value);
		if (x.cursor !== undefined) decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"session.prompt": value => decodeSessionPromptArguments(value) as unknown as CommandArguments,
	"session.image.begin": value => decodeImageBegin(value) as unknown as CommandArguments,
	"session.image.chunk": value => decodeImageChunk(value) as unknown as CommandArguments,
	"session.image.discard": value => decodeImageDiscard(value) as unknown as CommandArguments,
	"session.image.read": value => decodeImageRead(value) as unknown as CommandArguments,
	"artifact.read": value => decodeArtifactRead(value) as unknown as CommandArguments,
	"session.state.get": noArgs,
	"session.steer": decodeMessage,
	"session.followUp": decodeMessage,
	"session.rename": value => {
		const x = leasedArgs(value, ["name"]);
		controlFree(x.name, "args.name", 512);
		return x;
	},
	"session.retry": value => leasedArgs(value, []),
	"session.compact": value => {
		const x = leasedArgs(value, ["instructions"]);
		if (x.instructions !== undefined) boundedText(x.instructions, "args.instructions", MAX_STRING_BYTES);
		return x;
	},
	"session.pause": value => leasedArgs(value, []),
	"session.resume": value => leasedArgs(value, []),
	"session.archive": noArgs,
	"session.restore": noArgs,
	"session.delete": noArgs,
	"session.model.set": value => {
		const x = leasedArgs(value, ["selector", "role", "persistence"]);
		const selector = x.selector === undefined ? undefined : controlFree(x.selector, "args.selector", 512);
		const role = x.role === undefined ? undefined : controlFree(x.role, "args.role", 256);
		if ((selector === undefined) === (role === undefined))
			fail("INVALID_FRAME", "provide exactly one selector or role", "args");
		const persistence = controlFree(x.persistence, "args.persistence", 32);
		if (persistence !== "session" && persistence !== "settings")
			fail("INVALID_FRAME", "invalid model persistence", "args.persistence");
		return x;
	},
	"session.thinking.set": value => {
		const x = leasedArgs(value, ["level"]);
		const level = controlFree(x.level, "args.level", 64);
		if (!["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
			fail("INVALID_FRAME", "invalid thinking level", "args.level");
		return x;
	},
	"session.fast.set": value => {
		const x = leasedArgs(value, ["enabled"]);
		if (typeof x.enabled !== "boolean") fail("INVALID_FRAME", "enabled must be boolean", "args.enabled");
		return x;
	},
	"session.mode.set": value => {
		const x = leasedArgs(value, ["mode"]);
		const mode = controlFree(x.mode, "args.mode", 32);
		if (mode !== "build" && mode !== "plan" && mode !== "readOnly")
			fail("INVALID_FRAME", "invalid session mode", "args.mode");
		return x;
	},
	"session.ui.respond": decodeSessionUiResponse,
	"session.cancel": value => leasedArgs(value, []),
	"session.close": value => leasedArgs(value, []),
	"session.release": value => leasedArgs(value, []),
	"session.reclaim": noArgs,
	"files.read": value => {
		const x = args(value);
		safeRelativePath(x.path);
		return x;
	},
	"files.write": value => {
		const x = args(value);
		safeRelativePath(x.path);
		boundedText(x.content, "args.content", MAX_FILE_BYTES);
		return x;
	},
	"files.patch": value => {
		const x = args(value);
		safeRelativePath(x.path);
		boundedText(x.patch, "args.patch", MAX_FILE_BYTES);
		return x;
	},
	"files.list": value => {
		const x = args(value);
		if (x.path !== undefined) safeRelativePath(x.path, "args.path");
		return x;
	},
	"files.search": value => decodeProjectFileSearchArguments(value) as unknown as CommandArguments,
	"files.diff": value => {
		const x = args(value);
		if (x.turnId !== undefined) {
			if (Object.keys(x).length !== 1) fail("INVALID_FRAME", "turn diff accepts only turnId", "args");
			turnId(x.turnId, "args.turnId");
			return x;
		}
		if (x.path !== undefined) safeRelativePath(x.path);
		return x;
	},
	"review.read": value => {
		const x = strictArgs(value, ["reviewId"]);
		controlFree(x.reviewId, "args.reviewId", 256);
		return x;
	},
	"review.apply": value => {
		const x = args(value);
		if (x.turnId === undefined) {
			if (Object.keys(x).length !== 1) fail("INVALID_FRAME", "legacy review apply accepts only reviewId", "args");
			controlFree(x.reviewId, "args.reviewId", 256);
			return x;
		}
		if (Object.keys(x).length !== 3) fail("INVALID_FRAME", "turn review action has invalid fields", "args");
		turnId(x.turnId, "args.turnId");
		safeRelativePath(x.path, "args.path");
		if (x.action !== "keep" && x.action !== "discard")
			fail("INVALID_FRAME", "turn review action must be keep or discard", "args.action");
		return x;
	},
	"agent.cancel": value => {
		const x = args(value);
		controlFree(x.agentId, "args.agentId", 256);
		return x;
	},
	"bash.run": value => {
		const x = args(value);
		boundedText(x.command, "args.command", MAX_FILE_BYTES);
		return x;
	},
	"term.open": value => {
		const x = args(value);
		if (x.cwd !== undefined) safeRelativePath(x.cwd, "args.cwd");
		if (x.shell !== undefined) controlFree(x.shell, "args.shell", 256);
		if (x.env !== undefined) {
			const env = boundedMap(x.env, "args.env");
			for (const [key, val] of Object.entries(env)) {
				controlFree(key, `args.env.${key}`, 128);
				boundedText(val, `args.env.${key}`, 4096);
			}
		}
		if (x.cols !== undefined) {
			const cols = safeSeq(x.cols, "args.cols");
			if (cols === 0 || cols > 1000) fail("BOUNDS", "invalid cols", "args.cols");
		}
		if (x.rows !== undefined) {
			const rows = safeSeq(x.rows, "args.rows");
			if (rows === 0 || rows > 500) fail("BOUNDS", "invalid rows", "args.rows");
		}
		return x;
	},
	"audit.read": args,
	"audit.tail": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"config.write": value => metadata(value, "args"),
	"settings.read": args,
	"settings.write": value => metadata(value, "args"),
	"catalog.get": args,
	"broker.status": noArgs,
	"usage.read": noArgs,
	"host.watch": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"session.watch": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"controller.lease.acquire": value => {
		const x = args(value);
		controlFree(x.ownerId, "args.ownerId", 256);
		return x;
	},
	"controller.lease.renew": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"controller.lease.release": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"prompt.lease.acquire": value => {
		const x = args(value);
		controlFree(x.ownerId, "args.ownerId", 256);
		return x;
	},
	"prompt.lease.renew": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"prompt.lease.release": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	...PREVIEW_ARGUMENT_DECODERS,
	"ci.run": value => decodeCiRunArguments(value) as unknown as CommandArguments,
};
export const COMMAND_RESULT_DECODERS: Readonly<Record<string, (value: unknown) => CommandResult>> = {
	"runtime.list": value => {
		const x = strictResult(value, ["runtimes"]);
		return {
			runtimes: boundedArray(x.runtimes, "result.runtimes", 64).map((runtime, index) =>
				decodeRuntimeResultItem(runtime, `result.runtimes[${index}]`),
			),
		};
	},
	"workspace.list": value => {
		const x = strictResult(value, ["workspaces", "cursor"]);
		return {
			workspaces: boundedArray(x.workspaces, "result.workspaces", 256).map((workspace, index) =>
				decodeWorkspaceResultItem(workspace, `result.workspaces[${index}]`),
			),
			...(x.cursor === undefined ? {} : { cursor: decodeCursor(x.cursor, "result.cursor") }),
		};
	},
	"workspace.create": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.import": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.archive": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.recover": value => {
		const x = strictResult(value, ["workspaces"]);
		return {
			workspaces: boundedArray(x.workspaces, "result.workspaces", 256).map((workspace, index) =>
				decodeWorkspaceResultItem(workspace, `result.workspaces[${index}]`),
			),
		};
	},
	"host.list": decodeSessions,
	"session.list": decodeSessions,
	"transcript.search": value => decodeTranscriptSearchResult(value) as unknown as CommandResult,
	"transcript.context": value => decodeTranscriptContextResult(value) as unknown as CommandResult,
	"transcript.page": value => decodeTranscriptPageResult(value) as unknown as CommandResult,
	"project.reveal": value => boolField(value, "revealed"),
	"session.create": decodeCreate,
	"session.fork": decodeCreate,
	"session.attach": decodeAttach,
	"session.prompt": value => boolField(value, "accepted"),
	"session.image.begin": value => {
		const x = result(value);
		if (Object.keys(x).length !== 2 || !Object.hasOwn(x, "imageId") || !Object.hasOwn(x, "chunkBytes"))
			fail("INVALID_FRAME", "invalid image begin result", "result");
		imageId(x.imageId, "result.imageId");
		if (x.chunkBytes !== IMAGE_UPLOAD_CHUNK_BYTES)
			fail("INVALID_FRAME", "image begin result has an invalid chunk size", "result.chunkBytes");
		return x;
	},
	"session.image.chunk": value => {
		const x = result(value);
		if (
			Object.keys(x).length !== 3 ||
			!Object.hasOwn(x, "imageId") ||
			!Object.hasOwn(x, "received") ||
			!Object.hasOwn(x, "complete")
		)
			fail("INVALID_FRAME", "invalid image chunk result", "result");
		imageId(x.imageId, "result.imageId");
		const received = safeSeq(x.received, "result.received");
		if (received > IMAGE_UPLOAD_MAX_BYTES) fail("BOUNDS", "received exceeds the upload limit", "result.received");
		if (typeof x.complete !== "boolean") fail("INVALID_FRAME", "complete must be boolean", "result.complete");
		return x;
	},
	"session.image.discard": value => decodeBooleanResult(value, "discarded"),
	"session.image.read": decodeImageReadResult,
	"artifact.read": value => decodeArtifactReadChunk(value) as unknown as CommandResult,
	"session.state.get": decodeSessionState,
	"session.steer": decodeAcceptedResult,
	"session.followUp": decodeAcceptedResult,
	"session.rename": value => decodeBooleanResult(value, "renamed"),
	"session.retry": value => decodeBooleanResult(value, "retried"),
	"session.compact": value => decodeBooleanResult(value, "compacted"),
	"session.pause": decodePauseResult,
	"session.resume": value => {
		const x = result(value);
		if (Object.keys(x).length !== 2 || typeof x.resumed !== "boolean" || typeof x.paused !== "boolean")
			fail("INVALID_FRAME", "invalid resume result", "result");
		return { resumed: x.resumed, paused: x.paused };
	},
	"session.archive": value => decodeBooleanResult(value, "archived"),
	"session.restore": value => decodeBooleanResult(value, "restored"),
	"session.delete": value => decodeBooleanResult(value, "deleted"),
	"session.model.set": decodeAcceptedResult,
	"session.thinking.set": decodeAcceptedResult,
	"session.fast.set": decodeAcceptedResult,
	"session.mode.set": value => {
		const x = strictResult(value, ["mode"]);
		const mode = controlFree(x.mode, "result.mode", 32);
		if (mode !== "build" && mode !== "plan" && mode !== "readOnly")
			fail("INVALID_FRAME", "invalid session mode", "result.mode");
		return { mode };
	},
	"session.ui.respond": decodeAcceptedResult,
	"session.cancel": value => boolField(value, "cancelled"),
	"session.close": value => boolField(value, "closed"),
	"session.release": value => {
		const x = result(value);
		if (
			Object.keys(x).length !== 2 ||
			x.released !== true ||
			typeof x.resumeCommand !== "string"
		)
			fail("INVALID_FRAME", "invalid session release result", "result");
		controlFree(x.resumeCommand, "result.resumeCommand", 1024);
		return { released: true as const, resumeCommand: x.resumeCommand };
	},
	"session.reclaim": value => boolField(value, "reclaimed"),
	"files.read": value => {
		const x = result(value);
		boundedText(x.content, "result.content", MAX_FILE_BYTES);
		return x;
	},
	"files.write": result,
	"files.patch": result,
	"files.list": decodeEntries,
	"files.search": value => decodeProjectFileSearchResult(value) as unknown as CommandResult,
	"files.diff": value => {
		const x = result(value);
		if (x.turnId !== undefined) return decodeTurnReviewSnapshot(x, "result") as unknown as CommandResult;
		boundedText(x.diff, "result.diff", MAX_FILE_BYTES);
		return x;
	},
	"review.read": result,
	"review.apply": value => {
		const x = result(value);
		return x.turnId === undefined ? x : (decodeTurnReviewApplyResult(x) as unknown as CommandResult);
	},
	"agent.cancel": value => boolField(value, "cancelled"),
	"bash.run": result,
	"term.open": decodeTerminalResult,
	"audit.read": decodeAuditResult,
	"audit.tail": decodeAuditResult,
	"config.write": value => metadata(value, "result"),
	"settings.read": decodeSettingsResult,
	"settings.write": value => metadata(value, "result"),
	"catalog.get": decodeCatalogResult,
	"broker.status": value => decodeBrokerStatusResult(value) as unknown as CommandResult,
	"usage.read": value => decodeUsageReadResult(value) as unknown as CommandResult,
	"host.watch": decodeWatchResult,
	"session.watch": decodeWatchResult,
	"controller.lease.acquire": decodeLeaseResult,
	"controller.lease.renew": decodeLeaseResult,
	"controller.lease.release": decodeLeaseResult,
	"prompt.lease.acquire": decodeLeaseResult,
	"prompt.lease.renew": decodeLeaseResult,
	"prompt.lease.release": decodeLeaseResult,
	...PREVIEW_RESULT_DECODERS,
	"ci.run": value => decodeCiRunResult(value) as unknown as CommandResult,
};
