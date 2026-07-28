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
	/** Loopback listeners only: every loopback peer is reported with this
	 * identity (the host's own tailnet node). Possession of a device credential
	 * bound to that node — e.g. the 0600 local-device file — is what
	 * authenticates the connection; the mapping itself grants nothing. */
	selfIdentity?: RemotePeerIdentity;
	/** PEM cert/key for a TLS (wss) listener; fingerprint is sha256 of the cert DER, hex. */
	tls?: { readonly cert: string; readonly key: string };
	tlsFingerprint?: string;
	originAllowlist?: readonly string[];
	maxConnections?: number;
	maxFrameBytes?: number;
	idleTimeoutSeconds?: number;
	backpressureLimit?: number;
	whoisTimeoutMs?: number;
	whoisMaxOutputBytes?: number;
}
/** Snapshot returned by `GET /healthz` on the remote listener. */
export interface HealthSnapshot {
	readonly ok: boolean;
	readonly hostId: string;
	readonly epoch: string;
	readonly draining: boolean;
	readonly version: string;
	readonly uptimeSec: number;
	readonly sessions: number;
	readonly supervisors: number;
	readonly watchdog: { readonly graceMs: number; readonly actions: number };
}
/** Provider the listener calls on each `/healthz` request to enrich the
 * response with live host state. Falls back to `{ ok: true }` when absent. */
export type HealthProvider = () => HealthSnapshot;
export interface ListenerPlan {
	mode: "direct" | "serve" | "loopback";
	address: string;
	port: number;
	path: "/v1/ws";
	trustedServeProxy: boolean;
}
