import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const DNS_SUBDOMAIN = /^(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/u;
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
export interface ClusterServerConfig {
	readonly namespace: string;
	readonly podName: string;
	readonly epoch: string;
	readonly hostName: string;
	readonly gatewayPort: number;
	readonly adminPort: number;
	readonly kubernetesBaseUrl: string;
	readonly kubernetesTokenPath: string;
	readonly kubernetesCaPath: string;
	readonly kubernetesApiAudience: string;
	readonly identityTokenPath: string;
	readonly serverServiceAccountName: string;
	readonly trustedProxyAddresses: readonly string[];
	readonly trustedProxyCidrs: readonly string[];
	readonly woodpecker?: {
		readonly baseUrl: string;
		readonly webBaseUrl?: string;
		readonly repositories: Readonly<Record<string, { readonly slug: string }>>;
		readonly token?: string;
		readonly tokenFile?: string;
	};
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function dns(value: string, name: string): string {
	if (!DNS_LABEL.test(value)) throw new Error(`${name} is invalid`);
	return value;
}
function dnsSubdomain(value: string, name: string): string {
	if (value.length > 253 || !DNS_SUBDOMAIN.test(value)) throw new Error(`${name} is invalid`);
	return value;
}
function audience(value: string, name: string): string {
	if (value.length > 253 || !AUDIENCE.test(value)) throw new Error(`${name} is invalid`);
	return value;
}
function port(value: string | undefined, fallback: number, name: string): number {
	const result = Number(value ?? fallback);
	if (!Number.isSafeInteger(result) || result < 1 || result > 65_535) throw new Error(`${name} is invalid`);
	return result;
}
function absolutePath(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}
function repositories(value: string): Readonly<Record<string, { readonly slug: string }>> {
	if (new TextEncoder().encode(value).byteLength > 65_536) throw new Error("T4_WOODPECKER_REPOSITORIES exceeds limit");
	let input: unknown;
	try { input = JSON.parse(value); } catch { throw new Error("T4_WOODPECKER_REPOSITORIES is invalid JSON"); }
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 128)
		throw new Error("T4_WOODPECKER_REPOSITORIES is invalid");
	const output: Record<string, { slug: string }> = {};
	for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || typeof (raw as Record<string, unknown>).slug !== "string")
			throw new Error("T4_WOODPECKER_REPOSITORIES entry is invalid");
		output[id] = { slug: (raw as { slug: string }).slug };
	}
	return Object.freeze(output);
}
function proxyAddresses(value: string | undefined): readonly string[] {
	if (!value) return [];
	const values = [...new Set(value.split(",").map(item => item.trim()))];
	if (values.length > 64 || values.some(item => !item || isIP(item) === 0))
		throw new Error("T4_CLUSTER_TRUSTED_PROXY_ADDRESSES is invalid");
	return Object.freeze(values);
}
function ipv6Value(value: string): bigint {
	const halves = value.split("::");
	if (halves.length > 2) throw new Error("invalid IPv6 address");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	if (words.length !== 8) throw new Error("invalid IPv6 address");
	return words.reduce((result, word) => (result << 16n) | BigInt(Number.parseInt(word, 16)), 0n);
}
function canonicalCidr(value: string): string {
	const pieces = value.split("/");
	if (pieces.length !== 2 || !/^(?:0|[1-9][0-9]*)$/u.test(pieces[1]!))
		throw new Error("T4_CLUSTER_TRUSTED_PROXY_CIDRS is invalid");
	const address = pieces[0]!;
	const family = isIP(address);
	const prefix = Number(pieces[1]);
	const width = family === 4 ? 32 : family === 6 ? 128 : 0;
	if (prefix < 1 || prefix > width) throw new Error("T4_CLUSTER_TRUSTED_PROXY_CIDRS is invalid");
	const canonicalAddress = family === 4
		? address.split(".").map(Number).join(".")
		: new URL(`http://[${address}]/`).hostname.slice(1, -1);
	if (canonicalAddress !== address.toLowerCase()) throw new Error("T4_CLUSTER_TRUSTED_PROXY_CIDRS must use canonical network addresses");
	const numeric = family === 4
		? address.split(".").map(Number).reduce((result, octet) => (result << 8n) | BigInt(octet), 0n)
		: ipv6Value(address);
	const hostBits = BigInt(width - prefix);
	if (hostBits > 0n && (numeric & ((1n << hostBits) - 1n)) !== 0n)
		throw new Error("T4_CLUSTER_TRUSTED_PROXY_CIDRS must use canonical network addresses");
	return `${canonicalAddress}/${prefix}`;
}
function proxyCidrs(value: string | undefined): readonly string[] {
	if (!value) return [];
	const values = [...new Set(value.split(",").map(item => canonicalCidr(item.trim())))];
	if (values.length > 64) throw new Error("T4_CLUSTER_TRUSTED_PROXY_CIDRS exceeds limit");
	return Object.freeze(values);
}


export function clusterServerConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ClusterServerConfig {
	const namespace = dns(required(env, "POD_NAMESPACE"), "POD_NAMESPACE");
	const podName = dns(required(env, "POD_NAME"), "POD_NAME");
	const podUid = required(env, "POD_UID");
	if (!/^[A-Za-z0-9-]{8,128}$/u.test(podUid)) throw new Error("POD_UID is invalid");
	const serviceHost = required(env, "KUBERNETES_SERVICE_HOST");
	const servicePort = port(env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT, 443, "KUBERNETES_SERVICE_PORT");
	const identityTokenPath = absolutePath(required(env, "T4_CLUSTER_IDENTITY_TOKEN_FILE"), "T4_CLUSTER_IDENTITY_TOKEN_FILE");
	const serverServiceAccountName = dns(required(env, "T4_CLUSTER_SERVER_SERVICE_ACCOUNT"), "T4_CLUSTER_SERVER_SERVICE_ACCOUNT");
	const woodpeckerBaseUrl = env.T4_WOODPECKER_BASE_URL;
	const woodpeckerWebBaseUrl = env.T4_WOODPECKER_WEB_BASE_URL;
	const woodpeckerRepositories = env.T4_WOODPECKER_REPOSITORIES;
	const woodpeckerToken = env.T4_WOODPECKER_TOKEN;
	const woodpeckerTokenFile = env.T4_WOODPECKER_TOKEN_FILE;
	if (woodpeckerToken && woodpeckerTokenFile) throw new Error("Woodpecker configuration requires exactly one credential source");
	const woodpeckerConfigured = Boolean(woodpeckerBaseUrl || woodpeckerRepositories || woodpeckerToken || woodpeckerTokenFile);
	if (woodpeckerConfigured && (!woodpeckerBaseUrl || !woodpeckerRepositories || !(woodpeckerToken || woodpeckerTokenFile)))
		throw new Error("Woodpecker configuration must be complete");
	return {
		namespace,
		podName,
		epoch: `replica:${podUid}`,
		hostName: dnsSubdomain(required(env, "T4_CLUSTER_HOST_NAME"), "T4_CLUSTER_HOST_NAME"),
		gatewayPort: port(env.T4_CLUSTER_SERVER_PORT, 8080, "T4_CLUSTER_SERVER_PORT"),
		adminPort: port(env.T4_CLUSTER_ADMIN_PORT, 9090, "T4_CLUSTER_ADMIN_PORT"),
		trustedProxyAddresses: proxyAddresses(env.T4_CLUSTER_TRUSTED_PROXY_ADDRESSES),
		trustedProxyCidrs: proxyCidrs(env.T4_CLUSTER_TRUSTED_PROXY_CIDRS),
		kubernetesBaseUrl: `https://${serviceHost}:${servicePort}`,
		kubernetesTokenPath: absolutePath(env.T4_KUBERNETES_TOKEN_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "T4_KUBERNETES_TOKEN_PATH"),
		kubernetesCaPath: absolutePath(env.T4_KUBERNETES_CA_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "T4_KUBERNETES_CA_PATH"),
		kubernetesApiAudience: audience(env.T4_KUBERNETES_API_AUDIENCE ?? "https://kubernetes.default.svc", "T4_KUBERNETES_API_AUDIENCE"),
		identityTokenPath,
		serverServiceAccountName,
		...(woodpeckerConfigured ? {
			woodpecker: {
				baseUrl: woodpeckerBaseUrl!,
				...(woodpeckerWebBaseUrl ? { webBaseUrl: woodpeckerWebBaseUrl } : {}),
				repositories: repositories(woodpeckerRepositories!),
				...(woodpeckerToken ? { token: woodpeckerToken } : { tokenFile: absolutePath(woodpeckerTokenFile!, "T4_WOODPECKER_TOKEN_FILE") }),
			},
		} : {}),
	};
}
export async function readBoundedRegularFile(path: string, maximumBytes: number, description: string): Promise<string> {
	const invalid = `${description} file is invalid`;
	let file: FileHandle | undefined;
	try {
		file = await open(path, "r");
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) throw new Error(invalid);
		const buffer = Buffer.allocUnsafe(metadata.size + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.byteLength) {
			const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead < 1 || bytesRead > metadata.size || bytesRead > maximumBytes) throw new Error(invalid);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
		} catch {
			throw new Error(invalid);
		}
	} catch (error) {
		if (error instanceof Error && error.message === invalid) throw error;
		throw new Error(invalid);
	} finally {
		await file?.close().catch(() => undefined);
	}
}
export async function readClusterIdentityToken(path: string): Promise<string> {
	const token = (await readBoundedRegularFile(path, 16_384, "cluster identity token")).trim();
	if (new TextEncoder().encode(token).byteLength < 32 || /\s/u.test(token)) throw new Error("cluster identity token file is invalid");
	return token;
}
export async function readKubernetesToken(path: string): Promise<string> {
	const token = (await readBoundedRegularFile(path, 16_384, "Kubernetes token")).trim();
	if (!token || /\s/u.test(token)) throw new Error("Kubernetes token file is invalid");
	return token;
}
export async function loadKubernetesCa(config: ClusterServerConfig): Promise<string> {
	const ca = await readBoundedRegularFile(config.kubernetesCaPath, 1024 * 1024, "Kubernetes CA");
	if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("Kubernetes CA file is invalid");
	return ca;
}
