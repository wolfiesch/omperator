import { stat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	type CommandFrame,
	type HostId,
	projectId,
	type ProjectId,
} from "@t4-code/host-wire";
import { appserverResponse as response } from "./appserver-response.ts";
import { stableProjectId } from "./discovery.ts";
import type { RuntimeAdapterRegistry } from "./runtime-adapter.ts";
import type { AppserverOptions, CommandOutcome, SessionRecord } from "./types.ts";
import {
	type WorkspaceAuthority,
	WorkspaceAuthorityError,
	type WorkspaceRecord,
} from "./workspace-authority.ts";

interface WorkspaceRuntimeControllerOptions {
	readonly hostId: HostId;
	readonly runtimeAdapters?: RuntimeAdapterRegistry;
	readonly workspaceAuthority?: WorkspaceAuthority;
	readonly projectRootForProject?: AppserverOptions["projectRootForProject"];
	readonly projectRevealer?: AppserverOptions["projectRevealer"];
	readonly workspaceTargetPathForProject?: AppserverOptions["workspaceTargetPathForProject"];
	readonly records: () => Iterable<SessionRecord>;
	readonly workspaceHasExternalRuntimeOwner: (instanceId: string) => boolean;
}

export class WorkspaceRuntimeController {
	readonly #hostId: HostId;
	readonly #runtimeAdapters?: RuntimeAdapterRegistry;
	readonly #workspaceAuthority?: WorkspaceAuthority;
	readonly #projectRootForProject?: AppserverOptions["projectRootForProject"];
	readonly #projectRevealer?: AppserverOptions["projectRevealer"];
	readonly #workspaceTargetPathForProject?: AppserverOptions["workspaceTargetPathForProject"];
	readonly #records: () => Iterable<SessionRecord>;
	readonly #workspaceHasExternalRuntimeOwner: (instanceId: string) => boolean;
	readonly #archiving = new Set<string>();

	constructor(options: WorkspaceRuntimeControllerOptions) {
		this.#hostId = options.hostId;
		this.#runtimeAdapters = options.runtimeAdapters;
		this.#workspaceAuthority = options.workspaceAuthority;
		this.#projectRootForProject = options.projectRootForProject;
		this.#projectRevealer = options.projectRevealer;
		this.#workspaceTargetPathForProject = options.workspaceTargetPathForProject;
		this.#records = options.records;
		this.#workspaceHasExternalRuntimeOwner = options.workspaceHasExternalRuntimeOwner;
	}

	get runtimeListEnabled(): boolean {
		return this.#runtimeAdapters !== undefined;
	}

	get workspaceEnabled(): boolean {
		return this.#workspaceAuthority !== undefined;
	}

	get workspaceMutationEnabled(): boolean {
		return (
			this.#workspaceAuthority !== undefined &&
			this.#workspaceTargetPathForProject !== undefined &&
			this.#projectRootForProject !== undefined
		);
	}

	get projectRevealEnabled(): boolean {
		return this.#projectRootForProject !== undefined && this.#projectRevealer !== undefined;
	}

	workspaceArchiveInProgress(instanceId: string): boolean {
		return this.#archiving.has(instanceId);
	}

	async runtimeList(command: CommandFrame): Promise<CommandOutcome> {
		if (!this.#runtimeAdapters) throw new Error("runtime adapters are unavailable");
		const runtimes = await Promise.all(
			this.#runtimeAdapters.list().map(async manifest => {
				try {
					return { ...manifest, availability: await this.#runtimeAdapters?.availability(manifest.id) };
				} catch {
					return { ...manifest, availability: { state: "unknown" as const } };
				}
			}),
		);
		return { frame: response(this.#hostId, command, true, { runtimes }) };
	}

	workspaceList(command: CommandFrame): Promise<CommandOutcome> {
		return this.#workspaceCommand(command, () => ({
			workspaces: this.#workspaceAuthority?.list().map(record => workspaceProjection(record)) ?? [],
		}));
	}

	workspaceCreate(command: CommandFrame): Promise<CommandOutcome> {
		return this.#workspaceCommand(command, async () => {
			if (!this.#workspaceAuthority || !this.#workspaceTargetPathForProject)
				throw new Error("workspace mutation is unavailable");
			const repositoryId = projectId(command.args.projectId as string);
			const repositoryPath = await this.resolveProjectRoot(repositoryId);
			const targetPath = await this.#workspaceTargetPathForProject(repositoryId, command.args.name as string);
			if (!isAbsolute(targetPath))
				throw new WorkspaceAuthorityError(
					"invalid-path",
					"Workspace target resolver returned a non-absolute path",
				);
			const workspace = await this.#workspaceAuthority.create({
				repositoryId,
				repositoryPath,
				targetPath,
				branch: command.args.branch as string,
				sourceCommit: command.args.sourceCommit as string,
			});
			return { workspace: workspaceProjection(workspace) };
		});
	}

	workspaceImport(command: CommandFrame): Promise<CommandOutcome> {
		return this.#workspaceCommand(command, async () => {
			if (!this.#workspaceAuthority || !this.#workspaceTargetPathForProject)
				throw new Error("workspace mutation is unavailable");
			const repositoryId = projectId(command.args.projectId as string);
			const repositoryPath = await this.resolveProjectRoot(repositoryId);
			const workspacePath = await this.#workspaceTargetPathForProject(repositoryId, command.args.name as string);
			if (!isAbsolute(workspacePath))
				throw new WorkspaceAuthorityError(
					"invalid-path",
					"Workspace target resolver returned a non-absolute path",
				);
			const workspace = await this.#workspaceAuthority.import({
				repositoryId,
				repositoryPath,
				workspacePath,
			});
			return { workspace: workspaceProjection(workspace) };
		});
	}

	workspaceArchive(command: CommandFrame): Promise<CommandOutcome> {
		return this.#workspaceCommand(command, async () => {
			if (!this.#workspaceAuthority) throw new Error("workspace authority is unavailable");
			const instanceId = command.args.instanceId as string;
			const workspace = this.#workspaceAuthority.get(instanceId);
			if (!workspace) throw new WorkspaceAuthorityError("worktree-not-found", "Workspace record was not found");
			if (workspace.ownership === "repository-root")
				throw new WorkspaceAuthorityError(
					"repository-root-protected",
					"Repository root worktrees cannot be archived",
				);
			if (workspace.ownership !== "managed")
				throw new WorkspaceAuthorityError(
					"ownership-protected",
					"Imported and detected worktrees are never deleted by the authority",
				);
			if (this.#archiving.has(instanceId))
				throw new WorkspaceAuthorityError(
					"mutation-in-progress",
					"Workspace archive is already in progress",
				);
			if (this.#workspaceHasExternalRuntimeOwner(instanceId))
				throw new WorkspaceAuthorityError(
					"mutation-in-progress",
					"Workspace is owned by a live external runtime",
				);
			this.#archiving.add(instanceId);
			try {
				const sealed = await this.#workspaceAuthority.seal({ instanceId });
				return {
					workspace: workspaceProjection(
						await this.#workspaceAuthority.archive({ instanceId: sealed.instanceId }),
					),
				};
			} finally {
				this.#archiving.delete(instanceId);
			}
		});
	}

	workspaceRecover(command: CommandFrame): Promise<CommandOutcome> {
		return this.#workspaceCommand(command, async () => {
			if (!this.#workspaceAuthority) throw new Error("workspace authority is unavailable");
			return {
				workspaces: (await this.#workspaceAuthority.recover()).map(record =>
					workspaceProjection(record),
				),
			};
		});
	}

	async projectReveal(command: CommandFrame): Promise<CommandOutcome> {
		if (!this.#projectRevealer) throw new Error("project reveal is unavailable");
		const root = await this.resolveProjectRoot(command.args.projectId);
		const revealed = await this.#projectRevealer(root);
		return { frame: response(this.#hostId, command, true, { revealed }) };
	}

	async #workspaceCommand(
		command: CommandFrame,
		action: () => Promise<Record<string, unknown>> | Record<string, unknown>,
	): Promise<CommandOutcome> {
		try {
			return { frame: response(this.#hostId, command, true, await action()) };
		} catch (cause) {
			const code =
				cause instanceof WorkspaceAuthorityError
					? cause.code
					: "workspace-command-failed";
			const message =
				cause instanceof WorkspaceAuthorityError
					? cause.message
					: "workspace command failed";
			return {
				frame: response(this.#hostId, command, false, undefined, { code, message }),
			};
		}
	}

	async resolveProjectRoot(value: unknown): Promise<string> {
		if (!this.#projectRootForProject) throw new Error("project resolver is unavailable");
		if (typeof value !== "string") throw new Error("projectId is invalid");
		const requestedProject = projectId(value);
		const indexed = [...this.#records()].filter(
			record => record.runtime === undefined && record.projectId === requestedProject,
		);
		for (const record of indexed) {
			const canonical = await canonicalProjectRoot(record.cwd, requestedProject);
			if (canonical !== undefined) return canonical;
		}
		const requestedCwd = await this.#projectRootForProject(requestedProject);
		if (typeof requestedCwd !== "string" || !requestedCwd.startsWith("/"))
			throw new Error("project resolver returned an invalid local root");
		const canonical = await canonicalProjectRoot(requestedCwd, requestedProject);
		if (canonical === undefined) {
			let available = false;
			try {
				available = (await stat(await realpath(requestedCwd))).isDirectory();
			} catch {}
			if (available) throw new Error("project resolver returned a mismatched local root");
			throw new Error("project resolver returned an unavailable local root");
		}
		return canonical;
	}
}

async function canonicalProjectRoot(
	candidate: string,
	requestedProject: ProjectId,
): Promise<string | undefined> {
	if (!candidate.startsWith("/")) return undefined;
	try {
		const canonical = await realpath(candidate);
		if (!(await stat(canonical)).isDirectory()) return undefined;
		return stableProjectId(canonical) === requestedProject ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function workspaceProjection(record: WorkspaceRecord): Record<string, unknown> {
	return {
		repositoryId: record.repositoryId,
		instanceId: record.instanceId,
		ownership: record.ownership,
		branch: record.branch,
		sourceCommit: record.sourceCommit,
		expectedHead: record.expectedHead,
		lifecycle: record.lifecycle,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.archivedAt === undefined ? {} : { archivedAt: record.archivedAt }),
	};
}
