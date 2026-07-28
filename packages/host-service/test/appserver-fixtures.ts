import { type DurableEntry, hostId, projectId, sessionId } from "@t4-code/host-wire";
import type {
	ChildHandle,
	RpcChildFactory,
	SessionDiscovery,
	SessionRecord,
} from "../src/types.ts";

export const host = hostId("host-test");
export function record(id: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("project-test"),
		title: id,
		updatedAt: new Date(0).toISOString(),
		status: "idle",
		entries: [],
	};
}
export class FakeChild implements ChildHandle {
	#queue = Promise.withResolvers<void>();
	output: string[] = [];
	killed = false;
	stdin = {
		write: (data: string) => {
			this.output.push(data);
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = Promise.resolve(0);
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#queue.promise;
	}
	push(value: Record<string, unknown>) {
		this.output.push(JSON.stringify(value));
	}
	kill() {
		this.killed = true;
		this.#queue.resolve();
	}
}
export class FakeFactory implements RpcChildFactory {
	children: FakeChild[] = [];
	spawnedSessionPaths: string[] = [];
	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }) {
		this.spawnedSessionPaths.push(spec.session.path);
		const child = new FakeChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
export class TransferChild implements ChildHandle {
	#output = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	stdin = { write: () => {} };
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#output.promise;
	}
	kill() {
		if (this.killed) return;
		this.killed = true;
		this.#output.resolve();
		this.#exited.resolve(0);
	}
}
export class TransferFactory implements RpcChildFactory {
	children: TransferChild[] = [];
	spawn() {
		const child = new TransferChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
export class DeferredPromptChild implements ChildHandle {
	#prompt = Promise.withResolvers<Record<string, unknown>>();
	#state = Promise.withResolvers<Record<string, unknown>>();
	#reply = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	promptReceived = this.#prompt.promise;
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type === "prompt") this.#prompt.resolve(frame);
			else if (frame.type === "get_state") this.#state.resolve(frame);
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		const prompt = await this.#prompt.promise;
		await this.#reply.promise;
		yield `${JSON.stringify({
			type: "response",
			id: prompt.id,
			command: "prompt",
			success: false,
		})}\n`;
		const state = await this.#state.promise;
		yield `${JSON.stringify({
			type: "response",
			id: state.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 0,
				queuedMessageCount: 0,
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "immediate",
			},
		})}\n`;
		await this.#finish.promise;
	}
	replyToPrompt() {
		this.#reply.resolve();
	}
	kill() {
		this.killed = true;
		this.#reply.resolve();
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
export class DeferredPromptFactory implements RpcChildFactory {
	children: DeferredPromptChild[] = [];
	spawn() {
		const child = new DeferredPromptChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
export class StatePhaseChild implements ChildHandle {
	#pending: Record<string, unknown>[] = [];
	#drained = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	todoPhases: unknown = [
		{
			name: "Research",
			tasks: [
				{ content: "Map the call sites", status: "completed" },
				{ content: "Note the shared helper", status: "in_progress" },
				{ content: "Sketch the contract", status: "pending" },
			],
		},
		{
			name: "Implement",
			tasks: [{ content: "Wire the decoder", status: "custom_status" }],
		},
	];
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type !== "get_state") return;
			this.#pending.push(frame);
			this.#drained.resolve();
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		for (;;) {
			if (this.killed) return;
			const frame = this.#pending.shift();
			if (!frame) {
				await Promise.race([this.#drained.promise, this.#finish.promise]);
				this.#drained = Promise.withResolvers<void>();
				continue;
			}
			yield `${JSON.stringify({
				type: "response",
				id: frame.id,
				command: "get_state",
				success: true,
				data: {
					isStreaming: false,
					isCompacting: false,
					isPaused: false,
					messageCount: 0,
					queuedMessageCount: 0,
					steeringMode: "all",
					followUpMode: "all",
					interruptMode: "immediate",
					...(this.todoPhases === undefined ? {} : { todoPhases: this.todoPhases }),
				},
			})}\n`;
		}
	}
	kill() {
		this.killed = true;
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
export class StatePhaseFactory implements RpcChildFactory {
	children: StatePhaseChild[] = [];
	spawn() {
		const child = new StatePhaseChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
/**
 * A child that answers prompt and get_state but never emits turn.end,
 * prompt_result, or session_entry — reproducing the silent-supervisor wedge
 * where OMP finishes the turn (isStreaming=false) yet the host never learns
 * completion. SIGTERM is ignored (trapped), so only SIGKILL ends it.
 */
export class SilentSupervisorChild implements ChildHandle {
	#pending: Record<string, unknown>[] = [];
	#drained = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#finished = false;
	#exited = Promise.withResolvers<number>();
	#promptReceived = Promise.withResolvers<Record<string, unknown>>();
	killed = false;
	readonly promptReceived = this.#promptReceived.promise;
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			this.#pending.push(frame);
			if (frame.type === "prompt") this.#promptReceived.resolve(frame);
			this.#drained.resolve();
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	private async *stream(): AsyncGenerator<string> {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		for (;;) {
			if (this.killed) return;
			const frame = this.#pending.shift();
			if (!frame) {
				await Promise.race([this.#drained.promise, this.#finish.promise]);
				this.#drained = Promise.withResolvers<void>();
				continue;
			}
			if (frame.type === "prompt") {
				yield `${JSON.stringify({
					type: "response",
					id: frame.id,
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				})}\n`;
			} else if (frame.type === "get_state") {
				yield `${JSON.stringify({
					type: "response",
					id: frame.id,
					command: "get_state",
					success: true,
					data: {
						isStreaming: false,
						isCompacting: false,
						isPaused: false,
						messageCount: 0,
						queuedMessageCount: 0,
						steeringMode: "all",
						followUpMode: "all",
						interruptMode: "immediate",
					},
				})}\n`;
			}
			// Deliberately never emits turn.end / prompt_result / session_entry.
		}
	}
	kill(signal?: string) {
		// SIGTERM is trapped (the wedge); only SIGKILL ends the child.
		if (signal !== "SIGKILL" || this.#finished) return;
		this.killed = true;
		this.#finished = true;
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
export class SilentSupervisorFactory implements RpcChildFactory {
	children: SilentSupervisorChild[] = [];
	spawn() {
		const child = new SilentSupervisorChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
export class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly records: SessionRecord[]) {}
	async list() {
		return this.records;
	}
}
export function entry(id: string, parentId: string | null = null): DurableEntry {
	return {
		id: id as DurableEntry["id"],
		parentId: parentId as DurableEntry["parentId"],
		hostId: host,
		sessionId: sessionId("s"),
		kind: "message",
		timestamp: new Date(0).toISOString(),
		data: { id },
	};
}
