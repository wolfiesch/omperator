import { isAbsolute } from "node:path";
import {
	decodeClientFrame,
	requiredCapability,
	type ClientFrame,
	type HelloFrame,
} from "@t4-code/host-wire";
import type {
	RemoteAuthorizationContext,
	RemoteConnectionPolicy,
	RemoteHelloDecision,
} from "@t4-code/host-service";
import type { RemoteConnection } from "@t4-code/host-service";

const SESSION_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const INTERNAL_TOKEN_PLACEHOLDER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MAX_PROJECTED_TOKEN_BYTES = 16_384;
interface ConnectionGrant { capabilities: Set<string>; features: Set<string>; }
export interface ClusterIdentityReviewer {
	review(token: string): Promise<boolean>;
}
export interface ClusterInternalRemotePolicyOptions {
	readonly reviewer: ClusterIdentityReviewer;
	readonly supportedCapabilities: readonly string[];
	readonly supportedFeatures: readonly string[];
}

function projectedToken(value: unknown): string {
	if (typeof value !== "string") throw new Error("cluster identity token is invalid");
	const bytes = new TextEncoder().encode(value).byteLength;
	if (bytes < 32 || bytes > MAX_PROJECTED_TOKEN_BYTES || /\s/u.test(value)) throw new Error("cluster identity token is invalid");
	return value;
}
export function decodeClusterInternalClientFrame(input: unknown): ClientFrame {
	if (!input || typeof input !== "object" || Array.isArray(input)) return decodeClientFrame(input);
	const source = input as Record<string, unknown>;
	if (source.type !== "hello" || !source.authentication || typeof source.authentication !== "object" || Array.isArray(source.authentication))
		return decodeClientFrame(input);
	const authentication = source.authentication as Record<string, unknown>;
	const token = projectedToken(authentication.deviceToken);
	const decoded = decodeClientFrame({ ...source, authentication: { ...authentication, deviceToken: INTERNAL_TOKEN_PLACEHOLDER } });
	if (decoded.type !== "hello" || !decoded.authentication) throw new Error("cluster identity authentication is required");
	return { ...decoded, authentication: { ...decoded.authentication, deviceToken: token } };
}

export class ClusterInternalRemotePolicy implements RemoteConnectionPolicy {
	readonly #reviewer: ClusterIdentityReviewer;
	readonly #capabilities: readonly string[];
	readonly #features: readonly string[];
	readonly #connections = new Map<string, ConnectionGrant>();
	constructor(options: ClusterInternalRemotePolicyOptions) {
		this.#reviewer = options.reviewer;
		this.#capabilities = [...new Set(options.supportedCapabilities)].filter(value => value !== "ci.trigger");
		this.#features = [...new Set(options.supportedFeatures)].filter(value => value !== "cluster.operator");
	}
	decodeClientFrame(input: unknown): ClientFrame { return decodeClusterInternalClientFrame(input); }
	async authenticate(connection: RemoteConnection, hello: HelloFrame): Promise<RemoteHelloDecision> {
		const authentication = hello.authentication;
		if (connection.peer.identity.nodeId !== "cluster-server" || authentication?.deviceId !== "cluster-server") {
			this.#connections.delete(connection.connectionId);
			return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
		}
		try {
			if (!await this.#reviewer.review(authentication.deviceToken)) {
				this.#connections.delete(connection.connectionId);
				return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
			}
		} catch {
			this.#connections.delete(connection.connectionId);
			return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
		}
		const requestedCapabilities = new Set(hello.capabilities?.client ?? this.#capabilities);
		const requestedFeatures = new Set(hello.requestedFeatures);
		const grantedCapabilities = this.#capabilities.filter(value => requestedCapabilities.has(value));
		const grantedFeatures = this.#features.filter(value => requestedFeatures.has(value));
		this.#connections.set(connection.connectionId, { capabilities: new Set(grantedCapabilities), features: new Set(grantedFeatures) });
		return { authenticated: true, authentication: "paired", deviceId: "cluster-server", grantedCapabilities, grantedFeatures };
	}
	authorize(connection: RemoteConnection, frame: ClientFrame, _context: RemoteAuthorizationContext): boolean {
		const grant = this.#connections.get(connection.connectionId);
		if (!grant) return false;
		if (frame.type === "confirm") return true;
		if (frame.type === "ping") return true;
		if (frame.type === "terminal.input") return grant.features.has("terminal.io") && grant.capabilities.has("term.input");
		if (frame.type === "terminal.resize") return grant.features.has("terminal.io") && grant.capabilities.has("term.resize");
		if (frame.type === "terminal.close") return grant.features.has("terminal.io") && grant.capabilities.has("term.open");
		if (frame.type !== "command") return false;
		const capability = requiredCapability(frame.command);
		return capability !== undefined && grant.capabilities.has(capability);
	}
	disconnected(connection: RemoteConnection): void { this.#connections.delete(connection.connectionId); }
}

export interface SessionHostConfig {
	readonly credentialBrokerSocket: string;
	readonly runtimeId: string;
	readonly runtimeUid: string;
	readonly generation: string;
	readonly sessionName: string;
	readonly ompExecutable: string;
	readonly stateRoot: string;
	readonly runtimeRoot: string;
	readonly privateRuntimeRoot: string;
	readonly browserStateRoot: string;
	readonly browserEnabled: boolean;
	readonly readyPath: string;
	readonly workspaceRoot: string;
	readonly port: number;
	readonly idlePolicy: "allow-idle-sleep" | "keep-awake";
	readonly keepalive: boolean;

}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function dns(value: string, name: string): string {
	if (!SESSION_NAME.test(value)) throw new Error(`${name} is invalid`);
	return value;
}
function absolutePath(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}
export function sessionHostConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SessionHostConfig {
	const sessionName = dns(required(env, "T4_SESSION_NAME"), "T4_SESSION_NAME");
	const runtimeId = required(env, "T4_RUNTIME_ID");
	const generation = required(env, "T4_RUNTIME_GENERATION");
	const runtimeUid = required(env, "T4_RUNTIME_UID");
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtimeUid)) throw new Error("T4_RUNTIME_UID is invalid");

	if (!/^runtime-[a-z0-9](?:[-a-z0-9]{0,53}[a-z0-9])?$/u.test(runtimeId)) throw new Error("T4_RUNTIME_ID is invalid");
	if (!/^gen_[A-Za-z0-9_-]{24}$/u.test(generation)) throw new Error("T4_RUNTIME_GENERATION is invalid");
	const ompExecutable = env.T4_OMP_EXECUTABLE ?? "/opt/t4/libexec/omp-authority";
	if (ompExecutable !== "/opt/t4/libexec/omp-authority") throw new Error("T4_OMP_EXECUTABLE must select the authority-principal wrapper");
	const stateRoot = absolutePath(required(env, "T4_SESSION_STATE_ROOT"), "T4_SESSION_STATE_ROOT");
	if (!/^\/runtime-state\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(stateRoot))
		throw new Error("T4_SESSION_STATE_ROOT must select one isolated session directory");
	if (stateRoot !== `/runtime-state/${runtimeId}`) throw new Error("T4_SESSION_STATE_ROOT must match T4_RUNTIME_ID");
	const runtimeRoot = absolutePath(required(env, "T4_HOST_RUNTIME_DIR"), "T4_HOST_RUNTIME_DIR");
	if (runtimeRoot !== `/run/t4/${runtimeId}`) throw new Error("T4_HOST_RUNTIME_DIR must match T4_RUNTIME_ID");
	const privateRuntimeRoot = absolutePath(required(env, "T4_PRIVATE_RUNTIME_DIR"), "T4_PRIVATE_RUNTIME_DIR");
	if (privateRuntimeRoot !== `${stateRoot}/private`) throw new Error("T4_PRIVATE_RUNTIME_DIR must select the session private runtime");
	const browserStateRoot = absolutePath(required(env, "T4_BROWSER_STATE_DIR"), "T4_BROWSER_STATE_DIR");
	if (browserStateRoot !== `${stateRoot}/browser`) throw new Error("T4_BROWSER_STATE_DIR must select the session browser state");
	const browserEnabled = env.T4_GUI_ENABLED === "true" ? true : env.T4_GUI_ENABLED === "false" ? false : undefined;
	if (browserEnabled === undefined) throw new Error("T4_GUI_ENABLED must be true or false");
	const readyPath = absolutePath(required(env, "T4_SESSION_HOST_READY_PATH"), "T4_SESSION_HOST_READY_PATH");
	if (readyPath !== `${runtimeRoot}/host.ready`) throw new Error("T4_SESSION_HOST_READY_PATH must match T4_HOST_RUNTIME_DIR");
	const workspaceRoot = absolutePath(required(env, "T4_WORKSPACE_ROOT"), "T4_WORKSPACE_ROOT");
	if (workspaceRoot === stateRoot || workspaceRoot.startsWith(`${stateRoot}/`) || stateRoot.startsWith(`${workspaceRoot}/`))
		throw new Error("T4_WORKSPACE_ROOT must not overlap T4_SESSION_STATE_ROOT");
	const credentialBrokerSocket = absolutePath(required(env, "T4_CREDENTIAL_BROKER_SOCKET"), "T4_CREDENTIAL_BROKER_SOCKET");
	if (credentialBrokerSocket !== "/run/t4-credential/broker.sock") throw new Error("T4_CREDENTIAL_BROKER_SOCKET must select the private broker mount");
	const port = Number(env.T4_SESSION_HOST_PORT ?? "8787");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("T4_SESSION_HOST_PORT is invalid");
	const idlePolicy = env.T4_IDLE_POLICY === "keep-awake" ? "keep-awake" : env.T4_IDLE_POLICY === "allow-idle-sleep" ? "allow-idle-sleep" : undefined;
	if (!idlePolicy) throw new Error("T4_IDLE_POLICY must be allow-idle-sleep or keep-awake");
	const keepalive = env.T4_RUNTIME_KEEPALIVE === "true" ? true : env.T4_RUNTIME_KEEPALIVE === "false" ? false : undefined;
	if (keepalive === undefined) throw new Error("T4_RUNTIME_KEEPALIVE must be true or false");

	return {
		credentialBrokerSocket,
		runtimeId,
		runtimeUid,
		generation,
		sessionName,
		ompExecutable,
		stateRoot,
		runtimeRoot,
		privateRuntimeRoot,
		browserStateRoot,
		browserEnabled,
		readyPath,
		workspaceRoot,
		port,
		idlePolicy,
		keepalive,
	};
}
