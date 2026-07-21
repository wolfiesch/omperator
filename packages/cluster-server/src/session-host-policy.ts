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
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
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
	readonly kubernetesBaseUrl: string;
	readonly kubernetesTokenPath: string;
	readonly kubernetesCaPath: string;
	readonly kubernetesNamespacePath: string;
	readonly kubernetesApiAudience: string;
	readonly serverServiceAccountName: string;
	readonly sessionName: string;
	readonly ompExecutable: string;
	readonly stateRoot: string;
	readonly port: number;
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
function audience(value: string): string {
	if (value.length > 253 || !AUDIENCE.test(value)) throw new Error("T4_KUBERNETES_API_AUDIENCE is invalid");
	return value;
}
export function sessionHostConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SessionHostConfig {
	const serviceHost = required(env, "KUBERNETES_SERVICE_HOST");
	const servicePort = Number(env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? "443");
	if (!Number.isSafeInteger(servicePort) || servicePort < 1 || servicePort > 65_535) throw new Error("KUBERNETES_SERVICE_PORT is invalid");
	const serverServiceAccountName = dns(required(env, "T4_CLUSTER_SERVER_SERVICE_ACCOUNT"), "T4_CLUSTER_SERVER_SERVICE_ACCOUNT");
	const sessionName = dns(required(env, "T4_SESSION_NAME"), "T4_SESSION_NAME");
	const ompExecutable = env.T4_OMP_EXECUTABLE ?? "/opt/t4/bin/omp";
	if (!isAbsolute(ompExecutable)) throw new Error("T4_OMP_EXECUTABLE must be absolute");
	const stateRoot = absolutePath(required(env, "T4_SESSION_STATE_ROOT"), "T4_SESSION_STATE_ROOT");
	if (!/^\/workspace\/\.t4\/sessions\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(stateRoot))
		throw new Error("T4_SESSION_STATE_ROOT must select one isolated session directory");
	const port = Number(env.T4_SESSION_HOST_PORT ?? "8787");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("T4_SESSION_HOST_PORT is invalid");
	return {
		kubernetesBaseUrl: `https://${serviceHost}:${servicePort}`,
		kubernetesTokenPath: absolutePath(env.T4_KUBERNETES_TOKEN_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "T4_KUBERNETES_TOKEN_PATH"),
		kubernetesCaPath: absolutePath(env.T4_KUBERNETES_CA_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "T4_KUBERNETES_CA_PATH"),
		kubernetesNamespacePath: absolutePath(env.T4_KUBERNETES_NAMESPACE_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/namespace", "T4_KUBERNETES_NAMESPACE_PATH"),
		kubernetesApiAudience: audience(env.T4_KUBERNETES_API_AUDIENCE ?? "https://kubernetes.default.svc"),
		serverServiceAccountName,
		sessionName,
		ompExecutable,
		stateRoot,
		port,
	};
}
