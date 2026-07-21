export interface RemotePeerIdentity {
	readonly nodeId: string;
	readonly hostname?: string;
	readonly user?: string;
	readonly addresses: readonly string[];
	readonly source: "tailscale" | "serve" | "direct";
}
export interface ListenerPeerContext {
	readonly identity: RemotePeerIdentity;
	readonly address: string;
	readonly source: "direct" | "serve";
}
export interface RemoteSocket {
	readonly connectionId: string;
	readonly peer: ListenerPeerContext;
	send(text: string): boolean;
	close(code?: number, reason?: string): void;
}
export interface RemoteConnection {
	readonly connectionId: string;
	readonly peer: ListenerPeerContext;
	readonly socket: RemoteSocket;
}
export interface RemoteConnectionHooks {
	connected?(connection: RemoteConnection): void | Promise<void>;
	message?(connection: RemoteConnection, message: string | Uint8Array): void | Promise<void>;
	disconnected?(connection: RemoteConnection): void | Promise<void>;
}
export interface ProcessRunOptions {
	timeoutMs: number;
	maxOutputBytes: number;
}
export interface ProcessRunner {
	run(argv: string[], options: ProcessRunOptions): Promise<{ stdout: string | Uint8Array; exitCode: number }>;
}
export interface RemoteListenerConfig {
	address: string;
	port: number;
	trustedServeProxy?: boolean;
	serveProxy?: boolean;
	/** Fixed peer identity for a pod-network listener whose omp-app hello is authenticated by a dedicated policy. */
	internalPeerNodeId?: string;
	originAllowlist?: readonly string[];
	maxConnections?: number;
	maxFrameBytes?: number;
	idleTimeoutSeconds?: number;
	backpressureLimit?: number;
	whoisTimeoutMs?: number;
	whoisMaxOutputBytes?: number;
}
export interface ListenerPlan {
	mode: "direct" | "serve";
	address: string;
	port: number;
	path: "/v1/ws";
	trustedServeProxy: boolean;
}
