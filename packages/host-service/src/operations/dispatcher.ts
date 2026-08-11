import {
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	type CommandResult,
	type DeviceCapability,
	decodeCommandArguments,
	decodeCommandResult,
	decodeTerminalAdditive,
	decodeTerminalClient,
	type HostId,
	type Revision,
	type SessionId,
	type TerminalClientFrame,
	type TerminalId,
} from "@t4-code/host-wire";

/**
 * Opt-in host command trace, off unless T4_TRACE_COMMANDS is set.
 *
 * Emits ONLY the wire requestId, the command name, a phase, and elapsed time.
 * Terminal and file commands cross a trust boundary, so session ids, args, cwd,
 * shell, and payloads must never appear. `dispatcher-trace.test.ts` enforces
 * that with a frame full of distinctive secrets.
 *
 * The wire requestId is the correlator: log the same id where the client
 * constructs and sends the CommandFrame to match the two sides under
 * concurrency. Server receipt and operation-dispatch phases distinguish
 * pre-dispatch stalls from stalls inside the authority.
 */
export type HostTraceSink = (line: string) => void;

export function formatHostTrace(
	requestId: string,
	command: string,
	phase: string,
	elapsedMs?: number,
): string {
	const elapsed = elapsedMs === undefined ? "" : ` ms=${elapsedMs}`;
	return `[t4-host-trace] req=${requestId} command=${command} phase=${phase}${elapsed}`;
}

/**
 * Diagnostics must never change dispatch behaviour, so a sink that throws is
 * swallowed rather than surfaced as a command failure.
 */
export function emitHostTrace(
	sink: HostTraceSink | undefined,
	requestId: string,
	command: string,
	phase: string,
	elapsedMs?: number,
): void {
	if (!sink) return;
	try {
		sink(formatHostTrace(requestId, command, phase, elapsedMs));
	} catch {
		// A broken diagnostic sink must not break the command it is observing.
	}
}

export interface OperationContext {
	hostId: HostId;
	sessionId?: SessionId;
	deviceId: string;
	connectionId: string;
	capabilities: ReadonlySet<DeviceCapability>;
	currentRevision?: Revision;
	expectedRevision?: Revision;
	abortSignal: AbortSignal;
	emitTerminalOutput?: (frame: unknown) => void;
}

/** Optional methods are deliberate: capability advertisement is based on the actual authority object. */
export interface DesktopOperationsAuthority {
	filesRead?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	filesList?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	filesSearch?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	filesDiff?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	filesWrite?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	filesPatch?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	reviewRead?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	reviewApply?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	bashRun?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	termOpen?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	catalogGet?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	settingsRead?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	brokerStatus?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	settingsWrite?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	configWrite?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewLaunch?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewState?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewActivate?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewNavigate?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewBack?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewForward?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewReload?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewClose?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewCapture?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewCaptureRead?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewClick?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewFill?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewScroll?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewType?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewSelect?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewPress?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewUpload?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewPolicyCheck?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewLeaseAcquire?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewLeaseRenew?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewLeaseRelease?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	previewHandoff?(args: CommandResult, context: OperationContext): Promise<CommandResult>;
	terminalInput?(frame: TerminalClientFrame, context: OperationContext): Promise<void>;
	terminalResize?(frame: TerminalClientFrame, context: OperationContext): Promise<void>;
	terminalClose?(frame: TerminalClientFrame, context: OperationContext): Promise<void>;
	terminalOutput?(frame: unknown, context: OperationContext): void;
}

export interface OperationCommandHandler {
	dispatch(command: CommandFrame, context: OperationContext): Promise<CommandResult>;
	routeTerminal(frame: unknown, context: OperationContext): Promise<void>;
	disconnect(
		connectionId: string,
		context: Omit<OperationContext, "connectionId" | "sessionId"> & { sessionId: SessionId },
	): Promise<void>;
	disconnectConnection(
		connectionId: string,
		context: Omit<OperationContext, "connectionId" | "sessionId">,
	): Promise<void>;
	closeSessionTerminals(sessionId: SessionId, abortSignal: AbortSignal): Promise<void>;
	hasOpenTerminals(sessionId: SessionId): boolean;
	publishTerminalOutput(frame: unknown, owner: TerminalOwner): void;
}

const CAPABILITY_BY_COMMAND: Record<string, DeviceCapability> = Object.fromEntries(
	Object.entries(COMMAND_DESCRIPTORS).map(([name, descriptor]) => [name, descriptor.capability]),
) as Record<string, DeviceCapability>;
const OPERATION_METHOD_BY_COMMAND: Readonly<Record<string, keyof DesktopOperationsAuthority>> = {
	"files.read": "filesRead",
	"files.list": "filesList",
	"files.search": "filesSearch",
	"files.diff": "filesDiff",
	"files.write": "filesWrite",
	"files.patch": "filesPatch",
	"review.read": "reviewRead",
	"review.apply": "reviewApply",
	"bash.run": "bashRun",
	"term.open": "termOpen",
	"catalog.get": "catalogGet",
	"settings.read": "settingsRead",
	"broker.status": "brokerStatus",
	"settings.write": "settingsWrite",
	"config.write": "configWrite",
	"preview.launch": "previewLaunch",
	"preview.state": "previewState",
	"preview.activate": "previewActivate",
	"preview.navigate": "previewNavigate",
	"preview.back": "previewBack",
	"preview.forward": "previewForward",
	"preview.reload": "previewReload",
	"preview.close": "previewClose",
	"preview.capture": "previewCapture",
	"preview.capture.read": "previewCaptureRead",
	"preview.click": "previewClick",
	"preview.fill": "previewFill",
	"preview.scroll": "previewScroll",
	"preview.type": "previewType",
	"preview.select": "previewSelect",
	"preview.press": "previewPress",
	"preview.upload": "previewUpload",
	"preview.policy.check": "previewPolicyCheck",
	"preview.lease.acquire": "previewLeaseAcquire",
	"preview.lease.renew": "previewLeaseRenew",
	"preview.lease.release": "previewLeaseRelease",
	"preview.handoff": "previewHandoff",
};

/**
 * Additive protocol commands are intentionally not silently treated as
 * ordinary unsupported operations. A client can only use one after the
 * corresponding negotiated feature is granted.
 */
export const COMMAND_FEATURE_BY_COMMAND: Readonly<Record<string, string>> = {
	"runtime.list": "runtime.adapters",
	"workspace.list": "workspace.lifecycle",
	"workspace.create": "workspace.lifecycle",
	"workspace.import": "workspace.lifecycle",
	"workspace.archive": "workspace.lifecycle",
	"workspace.recover": "workspace.lifecycle",
	"host.watch": "host.watch",
	"session.watch": "session.watch",
	"session.release": "session.transfer",
	"session.reclaim": "session.transfer",
	"controller.lease.acquire": "controller.lease",
	"controller.lease.renew": "controller.lease",
	"controller.lease.release": "controller.lease",
	"prompt.lease.acquire": "prompt.lease",
	"prompt.lease.renew": "prompt.lease",
	"prompt.lease.release": "prompt.lease",
	"session.image.begin": "prompt.images",
	"session.image.chunk": "prompt.images",
	"session.image.discard": "prompt.images",
	"session.image.read": "transcript.images",
	"artifact.read": "artifacts.read",
	"transcript.search": "transcript.search",
	"transcript.context": "transcript.search",
	"project.reveal": "project.reveal",
	"files.search": "files.search",
	...Object.fromEntries(
		Object.keys(COMMAND_DESCRIPTORS)
			.filter(command => command.startsWith("preview."))
			.map(command => [command, "preview.control"]),
	),
};

export function commandFeature(command: string): string | undefined {
	return COMMAND_FEATURE_BY_COMMAND[command];
}

export function commandIsRoutable(authority: DesktopOperationsAuthority | undefined, command: string): boolean {
	const method = OPERATION_METHOD_BY_COMMAND[command];
	if (!method || !authority || typeof authority[method] !== "function") return false;
	return true;
}

function hasTerminalLifecycle(authority: DesktopOperationsAuthority): boolean {
	return (
		typeof authority.termOpen === "function" &&
		typeof authority.terminalInput === "function" &&
		typeof authority.terminalResize === "function" &&
		typeof authority.terminalClose === "function"
	);
}

export function operationCapabilities(authority: DesktopOperationsAuthority | undefined): Set<DeviceCapability> {
	const result = new Set<DeviceCapability>();
	if (!authority) return result;
	for (const [command, method] of Object.entries(OPERATION_METHOD_BY_COMMAND)) {
		if (command === "term.open") continue;
		const capability = CAPABILITY_BY_COMMAND[command];
		if (capability && typeof authority[method] === "function") result.add(capability);
	}
	if (hasTerminalLifecycle(authority)) {
		result.add("term.open");
		result.add("term.input");
		result.add("term.resize");
	}
	return result;
}

export function operationFeatures(authority: DesktopOperationsAuthority | undefined): Set<string> {
	const result = new Set<string>();
	if (
		authority &&
		Object.keys(OPERATION_METHOD_BY_COMMAND).some(
			command => command.startsWith("preview.") && commandIsRoutable(authority, command),
		)
	)
		result.add("preview.control");
	return result;
}

function safeError(error: unknown): { code: string; message: string } {
	const raw =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code
			: "OPERATION_FAILED";
	const known: Record<string, [string, string]> = {
		STALE_REVISION: ["STALE_REVISION", "resource revision is stale"],
		FORBIDDEN: ["FORBIDDEN", "operation is not permitted"],
		NOT_FOUND: ["NOT_FOUND", "resource was not found"],
		UNSUPPORTED: ["UNSUPPORTED", "operation is unsupported"],
		UNSUPPORTED_FEATURE: ["UNSUPPORTED_FEATURE", "negotiated feature is unavailable"],
		ABORTED: ["ABORTED", "operation was cancelled"],
		CONFLICT: ["CONFLICT", "operation conflicts with current state"],
		stale_revision: ["STALE_REVISION", "resource revision is stale"],
		forbidden: ["FORBIDDEN", "operation is not permitted"],
		not_found: ["NOT_FOUND", "resource was not found"],
		unsupported: ["UNSUPPORTED", "operation is unsupported"],
		unsupported_feature: ["UNSUPPORTED_FEATURE", "negotiated feature is unavailable"],
		aborted: ["ABORTED", "operation was cancelled"],
		conflict: ["CONFLICT", "operation conflicts with current state"],
		stale_turn: ["stale_turn", "turn targets are stale"],
	};
	const match = known[raw];
	return match ? { code: match[0], message: match[1] } : { code: "OPERATION_FAILED", message: "operation failed" };
}
function cloneFreeze<T>(value: T): T {
	const copy = structuredClone(value);
	const freeze = (item: unknown): unknown => {
		if (!item || typeof item === "function" || typeof item !== "object") return item;
		for (const child of Object.values(item)) freeze(child);
		return Object.freeze(item);
	};
	return freeze(copy) as T;
}

function invoke(
	authority: DesktopOperationsAuthority,
	command: string,
	args: CommandResult,
	context: OperationContext,
): Promise<CommandResult> {
	const methodName = OPERATION_METHOD_BY_COMMAND[command];
	const method = methodName ? authority[methodName] : undefined;
	if (typeof method !== "function")
		throw Object.assign(new Error("operation is unsupported"), { code: "UNSUPPORTED" });
	return (method as (args: CommandResult, context: OperationContext) => Promise<CommandResult>).call(
		authority,
		args,
		context,
	);
}

export interface TerminalOwner {
	connectionId: string;
	deviceId: string;
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
}

export class TerminalOwnerRegistry {
	readonly #owners = new Map<string, TerminalOwner>();
	claim(owner: TerminalOwner): void {
		if (this.#owners.has(owner.terminalId))
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
		this.#owners.set(owner.terminalId, owner);
	}
	get(connectionId: string): TerminalOwner[] {
		return [...this.#owners.values()].filter(owner => owner.connectionId === connectionId);
	}
	forSession(sessionId: SessionId): TerminalOwner[] {
		return [...this.#owners.values()].filter(owner => owner.sessionId === sessionId);
	}
	isCurrent(owner: TerminalOwner): boolean {
		const current = this.#owners.get(owner.terminalId);
		return (
			current?.connectionId === owner.connectionId &&
			current.deviceId === owner.deviceId &&
			current.hostId === owner.hostId &&
			current.sessionId === owner.sessionId
		);
	}
	assert(owner: TerminalOwner): void {
		const current = this.#owners.get(owner.terminalId);
		if (
			!current ||
			current.connectionId !== owner.connectionId ||
			current.deviceId !== owner.deviceId ||
			current.hostId !== owner.hostId ||
			current.sessionId !== owner.sessionId
		)
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
	}
	release(terminalId: TerminalId): void {
		this.#owners.delete(terminalId);
	}
	releaseConnection(connectionId: string): void {
		for (const [id, owner] of this.#owners) if (owner.connectionId === connectionId) this.#owners.delete(id);
	}
}
export class DesktopOperationDispatcher implements OperationCommandHandler {
	private readonly authority: DesktopOperationsAuthority;
	private readonly terminalOwners: TerminalOwnerRegistry;
	private readonly output: ((frame: unknown, owner: TerminalOwner) => void) | undefined;
	private readonly trace: HostTraceSink | undefined;

	constructor(
		authority: DesktopOperationsAuthority,
		terminalOwners = new TerminalOwnerRegistry(),
		output?: (frame: unknown, owner: TerminalOwner) => void,
		trace: HostTraceSink | undefined = process.env.T4_TRACE_COMMANDS === "1"
			? line => console.error(line)
			: undefined,
	) {
		this.authority = authority;
		this.terminalOwners = terminalOwners;
		this.output = output;
		this.trace = trace;
	}
	hasCommand(command: string): boolean {
		return commandIsRoutable(this.authority, command);
	}

	async dispatch(command: CommandFrame, context: OperationContext): Promise<CommandResult> {
		if (!this.trace) return this.dispatchInner(command, context);
		// Trace before operation validation. The server emits `received` at its
		// command entry, so absence of this phase localizes a stall to server
		// pre-dispatch work rather than transport receipt.
		const startedAt = performance.now();
		emitHostTrace(this.trace, command.requestId, command.command, "operation-ingress");
		try {
			const result = await this.dispatchInner(command, context);
			const ms = Math.round(performance.now() - startedAt);
			emitHostTrace(this.trace, command.requestId, command.command, "returned", ms);
			return result;
		} catch (error) {
			const ms = Math.round(performance.now() - startedAt);
			emitHostTrace(this.trace, command.requestId, command.command, "threw", ms);
			throw error;
		}
	}

	private async dispatchInner(command: CommandFrame, context: OperationContext): Promise<CommandResult> {
		const descriptor = COMMAND_DESCRIPTORS[command.command];
		const required = CAPABILITY_BY_COMMAND[command.command];
		if (commandFeature(command.command) && !OPERATION_METHOD_BY_COMMAND[command.command])
			throw Object.assign(new Error("negotiated feature is unavailable"), { code: "UNSUPPORTED_FEATURE" });
		if (!descriptor || !required || !OPERATION_METHOD_BY_COMMAND[command.command])
			throw Object.assign(new Error("operation is unsupported"), { code: "UNSUPPORTED" });
		if (
			command.hostId !== context.hostId ||
			(descriptor.scope === "session" && (!command.sessionId || command.sessionId !== context.sessionId)) ||
			(descriptor.scope === "host" && command.sessionId !== undefined)
		)
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
		if (!context.capabilities.has(required))
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
		if (context.abortSignal.aborted) throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
		if (descriptor.revision === "required" && command.expectedRevision === undefined)
			throw Object.assign(new Error("expectedRevision is required"), { code: "STALE_REVISION" });
		if (descriptor.revisionOwner === "session") {
			if (
				descriptor.revision === "required" &&
				(!context.currentRevision || command.expectedRevision !== context.currentRevision)
			)
				throw Object.assign(new Error("session revision is stale"), { code: "STALE_REVISION" });
			if (
				descriptor.revision === "optional" &&
				command.expectedRevision !== undefined &&
				(!context.currentRevision || command.expectedRevision !== context.currentRevision)
			)
				throw Object.assign(new Error("session revision is stale"), { code: "STALE_REVISION" });
		}
		if (descriptor.revision === "none" && command.expectedRevision !== undefined)
			throw Object.assign(new Error("expectedRevision is forbidden"), { code: "STALE_REVISION" });
		const args = cloneFreeze(decodeCommandArguments(command.command, command.args));
		let owner: TerminalOwner | undefined;
		const pendingTerminalFrames: unknown[] = [];
		const operationContext: OperationContext = {
			...context,
			emitTerminalOutput: frame => {
				if (owner) this.publishTerminalOutput(frame, owner);
				else pendingTerminalFrames.push(frame);
			},
		};
		if (command.expectedRevision === undefined) delete operationContext.expectedRevision;
		else operationContext.expectedRevision = command.expectedRevision;
		try {
			// `authority-invoke` with no matching `authority-ok` means the command
			// reached the host and stalled inside the authority, which is the case
			// a client-side timeout alone cannot distinguish.
			emitHostTrace(this.trace, command.requestId, command.command, "authority-invoke");
			const authorityStartedAt = performance.now();
			const result = await invoke(this.authority, command.command, args, operationContext);
			emitHostTrace(
				this.trace,
				command.requestId,
				command.command,
				"authority-ok",
				Math.round(performance.now() - authorityStartedAt),
			);
			const decoded = cloneFreeze(decodeCommandResult(command.command, result));
			if (command.command === "term.open" && typeof decoded.terminalId === "string" && context.sessionId) {
				owner = {
					connectionId: context.connectionId,
					deviceId: context.deviceId,
					hostId: context.hostId,
					sessionId: context.sessionId,
					terminalId: decoded.terminalId as TerminalId,
				};
				let claimed = false;
				try {
					this.terminalOwners.claim(owner);
					claimed = true;
					for (const frame of pendingTerminalFrames.splice(0)) this.publishTerminalOutput(frame, owner);
				} catch (error) {
					pendingTerminalFrames.length = 0;
					if (claimed) this.terminalOwners.release(owner.terminalId);
					if (this.authority.terminalClose)
						await this.authority.terminalClose(
							{
								v: "omp-app/1",
								type: "terminal.close",
								hostId: context.hostId,
								sessionId: context.sessionId,
								terminalId: decoded.terminalId as TerminalId,
							},
							operationContext,
						);
					throw error;
				}
			}
			return decoded;
		} catch (error) {
			const safe = safeError(error);
			throw Object.assign(new Error(safe.message), { code: safe.code });
		}
	}

	async routeTerminal(input: unknown, context: OperationContext): Promise<void> {
		const frame = decodeTerminalClient(input);
		const lifecycle = hasTerminalLifecycle(this.authority);
		const allowed =
			frame.type === "terminal.input"
				? lifecycle && context.capabilities.has("term.input")
				: frame.type === "terminal.resize"
					? lifecycle && context.capabilities.has("term.resize")
					: lifecycle && context.capabilities.has("term.open");
		if (frame.hostId !== context.hostId || frame.sessionId !== context.sessionId || !allowed)
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
		const owner: TerminalOwner = {
			connectionId: context.connectionId,
			deviceId: context.deviceId,
			hostId: context.hostId,
			sessionId: frame.sessionId,
			terminalId: frame.terminalId,
		};
		this.terminalOwners.assert(owner);
		if (frame.type === "terminal.input") await this.authority.terminalInput!(frame, context);
		else if (frame.type === "terminal.resize") await this.authority.terminalResize!(frame, context);
		else {
			await this.authority.terminalClose!(frame, context);
			this.terminalOwners.release(frame.terminalId);
		}
	}

	async disconnect(
		connectionId: string,
		context: Omit<OperationContext, "connectionId" | "sessionId"> & { sessionId: SessionId },
	): Promise<void> {
		const disconnectedContext: Omit<OperationContext, "connectionId" | "sessionId"> = {
			hostId: context.hostId,
			deviceId: context.deviceId,
			capabilities: context.capabilities,
			abortSignal: context.abortSignal,
		};
		if (context.currentRevision !== undefined) disconnectedContext.currentRevision = context.currentRevision;
		if (context.expectedRevision !== undefined) disconnectedContext.expectedRevision = context.expectedRevision;
		return this.disconnectConnection(connectionId, disconnectedContext);
	}

	async disconnectConnection(
		connectionId: string,
		context: Omit<OperationContext, "connectionId" | "sessionId">,
	): Promise<void> {
		const owners = this.terminalOwners.get(connectionId);
		await this.closeOwners(owners, context.abortSignal, true, context.capabilities);
	}

	hasOpenTerminals(sessionId: SessionId): boolean {
		return this.terminalOwners.forSession(sessionId).length > 0;
	}

	async closeSessionTerminals(sessionId: SessionId, abortSignal: AbortSignal): Promise<void> {
		await this.closeOwners(this.terminalOwners.forSession(sessionId), abortSignal, false, new Set(["term.open"]));
	}

	private async closeOwners(
		owners: readonly TerminalOwner[],
		abortSignal: AbortSignal,
		releaseOnFailure: boolean,
		capabilities: ReadonlySet<DeviceCapability>,
	): Promise<void> {
		const failures: unknown[] = [];
		for (const owner of owners) {
			let closed = false;
			try {
				if (this.authority.terminalClose)
					await this.authority.terminalClose(
						{
							v: "omp-app/1",
							type: "terminal.close",
							hostId: owner.hostId,
							sessionId: owner.sessionId,
							terminalId: owner.terminalId,
						},
						{
							hostId: owner.hostId,
							sessionId: owner.sessionId,
							deviceId: owner.deviceId,
							connectionId: owner.connectionId,
							capabilities,
							abortSignal,
						},
					);
				closed = true;
			} catch (error) {
				failures.push(error);
			} finally {
				if (closed || releaseOnFailure) this.terminalOwners.release(owner.terminalId);
			}
		}
		if (failures.length)
			throw Object.assign(new Error("one or more terminals failed to close"), { code: "OPERATION_FAILED" });
	}
	publishTerminalOutput(frame: unknown, owner: TerminalOwner): void {
		if (!this.terminalOwners.isCurrent(owner)) return;
		const decoded = decodeTerminalAdditive(frame);
		if (
			decoded.hostId !== owner.hostId ||
			decoded.sessionId !== owner.sessionId ||
			decoded.terminalId !== owner.terminalId
		)
			throw Object.assign(new Error("operation is not permitted"), { code: "FORBIDDEN" });
		this.authority.terminalOutput?.(cloneFreeze(decoded), {
			hostId: owner.hostId,
			sessionId: owner.sessionId,
			deviceId: owner.deviceId,
			connectionId: owner.connectionId,
			capabilities: new Set(["term.open"]),
			abortSignal: new AbortController().signal,
		});
		this.output?.(decoded, owner);
		if (decoded.type === "terminal.exit") this.terminalOwners.release(owner.terminalId);
	}
}
