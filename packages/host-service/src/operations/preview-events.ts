import type { CommandFrame, CommandResult, PreviewSnapshot, ServerFrame } from "@t4-code/host-wire";

const MUTATION_EVENT_BY_COMMAND: Readonly<Record<string, "preview.launch" | "preview.navigation" | "preview.capture" | "preview.state">> = {
	"preview.launch": "preview.launch",
	"preview.activate": "preview.state",
	"preview.navigate": "preview.navigation",
	"preview.back": "preview.navigation",
	"preview.forward": "preview.navigation",
	"preview.reload": "preview.navigation",
	"preview.close": "preview.state",
	"preview.capture": "preview.capture",
	"preview.click": "preview.state",
	"preview.fill": "preview.state",
	"preview.scroll": "preview.state",
	"preview.type": "preview.state",
	"preview.select": "preview.state",
	"preview.press": "preview.state",
	"preview.upload": "preview.state",
	"preview.handoff": "preview.state",
};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Builds the existing omp-app/1 additive event(s) after a successful preview operation. */
export function previewOperationEvents(command: CommandFrame, result: CommandResult): readonly ServerFrame[] {
	if (!command.sessionId) return [];
	if (command.command === "preview.state") {
		const previews = object(result)?.previews;
		if (!Array.isArray(previews)) return [];
		return previews.map(preview => ({
			v: "omp-app/1",
			type: "preview.state",
			hostId: command.hostId,
			sessionId: command.sessionId!,
			...(preview as PreviewSnapshot),
		}) as ServerFrame);
	}
	const type = MUTATION_EVENT_BY_COMMAND[command.command];
	const preview = object(result)?.preview;
	if (!type || !preview) return [];
	return [{
		v: "omp-app/1",
		type,
		hostId: command.hostId,
		sessionId: command.sessionId,
		...(preview as unknown as PreviewSnapshot),
	} as ServerFrame];
}
