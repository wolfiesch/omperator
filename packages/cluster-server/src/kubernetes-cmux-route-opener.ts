import { WebSocket, type ClientOptions, type RawData } from "ws";
import type { CmuxRouteOpener, DuplexByteStream, ResolvedCmuxRoute } from "@t4-code/provider-engine";
import type { CmuxWebSocketRoute, CmuxWebSocketRouteOpener, CmuxJsonlByteStream } from "./cmux-websocket.ts";
import type { KubernetesApiClient } from "./kubernetes-client.ts";
import type { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";

const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_SECRET_TEXT_BYTES = 128;

export interface CmuxUpstreamWebSocket {
	readonly readyState: number;
	readonly bufferedAmount: number;
	on(event: "message", listener: (value: RawData) => void): this;
	once(event: "close", listener: () => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "open", listener: () => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	off(event: "open", listener: () => void): this;
	send(chunk: Uint8Array, options: { readonly binary: true }, callback: (error?: Error) => void): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

function boundedRawData(value: RawData, maximumBytes: number): Uint8Array | undefined {
	if (!Array.isArray(value)) {
		if (value.byteLength > maximumBytes) return undefined;
		return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	}
	let total = 0;
	for (const part of value) {
		if (part.byteLength > maximumBytes - total) return undefined;
		total += part.byteLength;
	}
	const joined = Buffer.allocUnsafe(total);
	let offset = 0;
	for (const part of value) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function secretKey(value: unknown): Uint8Array {
	const encoded = object(object(value).data).key;
	if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_SECRET_TEXT_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
		throw new Error("runtime generation secret is invalid");
	const key = Buffer.from(encoded, "base64");
	if (key.byteLength !== 32 || key.toString("base64") !== encoded) throw new Error("runtime generation secret is invalid");
	return key;
}

export function websocketStream(socket: CmuxUpstreamWebSocket, signal: AbortSignal): CmuxJsonlByteStream {
	const chunks: Uint8Array[] = [];
	let queuedBytes = 0;
	const readers: Array<{ resolve: (value: IteratorResult<Uint8Array>) => void; reject: (error: unknown) => void }> = [];
	let ended = false;
	let failure: Error | undefined;
	const flush = (): void => {
		while (readers.length > 0 && chunks.length > 0) {
			const chunk = chunks.shift()!;
			queuedBytes -= chunk.byteLength;
			readers.shift()!.resolve({ done: false, value: chunk });
		}
		if (!ended || chunks.length > 0) return;
		while (readers.length > 0) {
			const reader = readers.shift()!;
			if (failure) reader.reject(failure); else reader.resolve({ done: true, value: undefined });
		}
	};
	const finish = (error?: Error): void => { if (ended) return; ended = true; failure = error; flush(); };
	socket.on("message", value => {
		const chunk = boundedRawData(value, MAX_BUFFERED_BYTES - queuedBytes);
		if (!chunk) {
			socket.terminate();
			finish(new Error("runtime cmux inbound queue limit exceeded"));
			return;
		}
		chunks.push(chunk);
		queuedBytes += chunk.byteLength;
		flush();
	});
	socket.once("close", () => finish());
	socket.once("error", error => finish(error instanceof Error ? error : new Error("runtime cmux WebSocket failed")));
	const abort = (): void => { socket.close(1000, "runtime cmux route cancelled"); finish(new Error("runtime cmux route cancelled")); };
	signal.addEventListener("abort", abort, { once: true });
	return {
		readable: {
			[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
				return { next: () => {
					const chunk = chunks.shift();
					if (chunk) {
						queuedBytes -= chunk.byteLength;
						return Promise.resolve({ done: false as const, value: chunk });
					}
					if (ended) return failure ? Promise.reject(failure) : Promise.resolve({ done: true as const, value: undefined });
					const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
					readers.push(pending);
					return pending.promise;
				} };
			},
		},
		write: chunk => new Promise<void>((resolve, reject) => {
			if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES - chunk.byteLength) { reject(new Error("runtime cmux WebSocket backpressure limit exceeded")); return; }
			socket.send(chunk, { binary: true }, error => error ? reject(error) : resolve());
		}),
		end: async () => { signal.removeEventListener("abort", abort); if (socket.readyState === WebSocket.OPEN) socket.close(1000, "runtime cmux input ended"); },
		close: async cause => { signal.removeEventListener("abort", abort); if (socket.readyState === WebSocket.OPEN) socket.close(1011, cause instanceof Error ? cause.message.slice(0, 100) : "runtime cmux route closed"); },
	};
}

export class KubernetesCmuxWebSocketRouteOpener implements CmuxWebSocketRouteOpener {
	constructor(
		readonly projection: ClusterInfrastructureProjection,
		readonly client: KubernetesApiClient,
		readonly webSocketFactory: (url: string, options: ClientOptions) => CmuxUpstreamWebSocket = (url, options) => new WebSocket(url, options),
	) {}

	async open(route: CmuxWebSocketRoute, signal: AbortSignal): Promise<CmuxJsonlByteStream> {
		const backend = this.projection.cmuxRuntimeBackend(route);
		if (!backend) throw new Error("runtime cmux route is no longer authoritative");
		const secret = secretKey(await this.client.request(`/api/v1/namespaces/${encodeURIComponent(backend.namespace)}/secrets/${encodeURIComponent(backend.generationSecretName)}`, { signal }));
		const socket = this.webSocketFactory(`ws://${backend.serviceName}.${backend.namespace}.svc:8788/internal/runtime/cmux`, {
			perMessageDeflate: false,
			maxPayload: 67_108_864,
			headers: {
				authorization: `Bearer ${Buffer.from(secret).toString("base64url")}`,
				"x-runtime-uid": backend.runtimeUid,
				"x-runtime-generation": backend.generation,
			},
		});
		await new Promise<void>((resolve, reject) => {
			const abort = (): void => { socket.close(); reject(new Error("runtime cmux route cancelled")); };
			const opened = (): void => { signal.removeEventListener("abort", abort); socket.off("error", failed); resolve(); };
			const failed = (error: Error): void => { signal.removeEventListener("abort", abort); socket.off("open", opened); reject(error); };
			signal.addEventListener("abort", abort, { once: true });
			socket.once("open", opened);
			socket.once("error", failed);
		});
		if (!this.projection.cmuxRuntimeBackend(route)) { socket.close(1008, "runtime route changed"); throw new Error("runtime cmux route changed while connecting"); }
		return websocketStream(socket, signal);
	}
}

/**
 * Adapts the provider engine's opaque, server-resolved route to the direct
 * principal-bound Kubernetes WebSocket route without trusting client input.
 */
export class KubernetesProviderCmuxRouteOpener implements CmuxRouteOpener {
	constructor(
		readonly projection: ClusterInfrastructureProjection,
		readonly direct: CmuxWebSocketRouteOpener,
		readonly principal: string,
	) {}

	async open(resolved: ResolvedCmuxRoute, signal = new AbortController().signal): Promise<DuplexByteStream> {
		if (resolved.route.kind !== "cmux-v10") throw new TypeError("route kind is not cmux-v10");
		const portable = this.projection.portableRuntimeRoute(
			this.principal,
			resolved.runtimeId,
			resolved.route.kind,
			resolved.runtimeGeneration,
		);
		if (
			portable.outcome !== "resolved"
			|| portable.generation !== resolved.runtimeGeneration
			|| portable.reference !== resolved.route.reference
		) throw new Error("provider cmux route is no longer authoritative");
		const directRoute = this.projection.cmuxWebSocketRoute(resolved.runtimeId, this.principal);
		if (!directRoute || directRoute.generation !== resolved.runtimeGeneration)
			throw new Error("provider cmux route is no longer authoritative");
		return await this.direct.open(directRoute, signal);
	}
}
