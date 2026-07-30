import type {
	AppserverCommandHandler,
	AppserverCommandHandlers,
} from "./command-handler.ts";

export interface CoreCommandRoutes {
	readonly sessionCreate: AppserverCommandHandler;
	readonly sessionFork: AppserverCommandHandler | undefined;
	readonly runtimeList: AppserverCommandHandler | undefined;
	readonly workspaceList: AppserverCommandHandler | undefined;
	readonly workspaceCreate: AppserverCommandHandler | undefined;
	readonly workspaceImport: AppserverCommandHandler | undefined;
	readonly workspaceArchive: AppserverCommandHandler | undefined;
	readonly workspaceRecover: AppserverCommandHandler | undefined;
	readonly projectReveal: AppserverCommandHandler | undefined;
	readonly sessionClose: AppserverCommandHandler;
	readonly sessionRelease: AppserverCommandHandler | undefined;
	readonly sessionReclaim: AppserverCommandHandler | undefined;
	readonly sessionArchive: AppserverCommandHandler;
	readonly sessionRestore: AppserverCommandHandler;
	readonly sessionDelete: AppserverCommandHandler;
	readonly sessionModeSet: AppserverCommandHandler;
}

export function registerCoreCommandHandlers(
	handlers: AppserverCommandHandlers,
	routes: CoreCommandRoutes,
): void {
	const entries: readonly [string, AppserverCommandHandler | undefined][] = [
		["session.create", routes.sessionCreate],
		["session.fork", routes.sessionFork],
		["runtime.list", routes.runtimeList],
		["workspace.list", routes.workspaceList],
		["workspace.create", routes.workspaceCreate],
		["workspace.import", routes.workspaceImport],
		["workspace.archive", routes.workspaceArchive],
		["workspace.recover", routes.workspaceRecover],
		["project.reveal", routes.projectReveal],
		["session.close", routes.sessionClose],
		["session.release", routes.sessionRelease],
		["session.reclaim", routes.sessionReclaim],
		["session.archive", routes.sessionArchive],
		["session.restore", routes.sessionRestore],
		["session.delete", routes.sessionDelete],
		["session.mode.set", routes.sessionModeSet],
	];
	for (const [command, handler] of entries)
		if (handler) handlers.register(command, handler);
}
