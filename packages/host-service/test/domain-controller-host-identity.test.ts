import { expect, test } from "bun:test";
import {
	type CommandFrame,
	type HostId,
	hostId,
} from "@t4-code/host-wire";
import { AppserverCommandHandlers } from "../src/command-handler.ts";
import { registerPreviewCommandHandlers } from "../src/preview/command-handlers.ts";
import { PreviewService } from "../src/preview/preview-service.ts";
import { RuntimeAdapterRegistry } from "../src/runtime-adapter.ts";
import { WorkspaceRuntimeController } from "../src/workspace-runtime-controller.ts";

function command(
	name: string,
	args: Record<string, unknown> = {},
): CommandFrame {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: `${name}-request`,
		commandId: `${name}-command`,
		hostId: hostId("request-host"),
		command: name,
		args,
	} as CommandFrame;
}

test("workspace/runtime responses read the host identity at dispatch time", async () => {
	let currentHost: HostId = hostId("temporary-host");
	const controller = new WorkspaceRuntimeController({
		hostId: () => currentHost,
		runtimeAdapters: new RuntimeAdapterRegistry({
			executableAvailable: () => true,
		}),
		records: () => [],
		workspaceHasExternalRuntimeOwner: () => false,
	});

	currentHost = hostId("persisted-host");
	const outcome = await controller.runtimeList(command("runtime.list"));

	expect(outcome.frame).toMatchObject({
		type: "response",
		hostId: currentHost,
		ok: true,
		result: { runtimes: [] },
	});
});

test("preview responses read the host identity at dispatch time", async () => {
	let currentHost: HostId = hostId("temporary-host");
	const handlers = new AppserverCommandHandlers();
	const service = new PreviewService({
		chromiumResolver: async () => ({
			path: "/unused/chromium",
			browserVersion: "unused",
		}),
	});
	registerPreviewCommandHandlers({
		handlers,
		hostId: () => currentHost,
		service,
		log: () => {},
	});

	try {
		currentHost = hostId("persisted-host");
		const outcome = await handlers.dispatch(
			command("preview.policy.check", {
				action: "navigate",
				url: "http://localhost:3000",
			}),
		);

		expect(outcome?.frame).toMatchObject({
			type: "response",
			hostId: currentHost,
			ok: true,
			result: {
				allowed: true,
				confirmationRequired: true,
			},
		});
	} finally {
		await service.stop();
	}
});
