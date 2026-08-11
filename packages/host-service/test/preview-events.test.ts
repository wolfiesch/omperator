import { describe, expect, it } from "vite-plus/test";
import { commandId, hostId, requestId, sessionId, type CommandFrame, type PreviewSnapshot } from "@t4-code/host-wire";
import { previewOperationEvents } from "../src/operations/preview-events.ts";

const HOST = hostId("host-preview-events");
const SESSION = sessionId("session-preview-events");
const preview: PreviewSnapshot = {
	previewId: "preview-one" as never,
	state: "ready",
	url: "https://example.test/",
	revision: "preview-1" as never,
	cursor: { epoch: "preview-events", seq: 1 },
};
function command(name: string): CommandFrame {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: requestId(`request-${name}`),
		commandId: commandId(`command-${name}`),
		hostId: HOST,
		sessionId: SESSION,
		command: name,
		args: {},
	};
}

describe("preview operation additive events", () => {
	it("reuses launch, navigation, capture, and state omp-app/1 events", () => {
		expect(previewOperationEvents(command("preview.launch"), { preview })).toEqual([
			expect.objectContaining({ v: "omp-app/1", type: "preview.launch", hostId: HOST, sessionId: SESSION, previewId: "preview-one" }),
		]);
		expect(previewOperationEvents(command("preview.navigate"), { preview })[0]).toMatchObject({ type: "preview.navigation" });
		expect(previewOperationEvents(command("preview.capture"), { preview: { ...preview, capture: { captureId: "capture-one", mimeType: "image/png", size: 1, width: 1, height: 1, capturedAt: 1, sha256: "a".repeat(64) } } })[0]).toMatchObject({ type: "preview.capture" });
		expect(previewOperationEvents(command("preview.type"), { preview })[0]).toMatchObject({ type: "preview.state" });
	});

	it("emits each bounded preview state and no lease, policy, or capture-read event", () => {
		expect(previewOperationEvents(command("preview.state"), { previews: [preview, { ...preview, previewId: "preview-two" }] })).toHaveLength(2);
		for (const name of ["preview.capture.read", "preview.policy.check", "preview.lease.acquire", "preview.lease.renew", "preview.lease.release"])
			expect(previewOperationEvents(command(name), {})).toEqual([]);
	});
});
