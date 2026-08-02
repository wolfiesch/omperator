import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterServerConfigFromEnv, readClusterIdentityToken } from "../src/config.ts";

const BASE_ENV = {
	POD_NAMESPACE: "cluster-system",
	POD_NAME: "cluster-server-0",
	POD_UID: "12345678-abcd",
	KUBERNETES_SERVICE_HOST: "10.96.0.1",
	KUBERNETES_SERVICE_PORT_HTTPS: "443",
	T4_CLUSTER_HOST_NAME: "default",
	T4_CLUSTER_IDENTITY_TOKEN_FILE: "/var/run/secrets/t4-cluster-identity/token",
	T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "release-t4-cluster-server",
	T4_CLUSTER_IDENTITY_PROVIDER: "tailscale",
	T4_PUBLIC_REST_BASE_URL: "https://omp.example.test/v1",
	T4_PUBLIC_OMP_APP_WEBSOCKET_URL: "wss://omp.example.test/v1/ws",
	T4_BUILD_VERSION: "0.1.33",
	T4_BUILD_REVISION: "0123456789abcdef",
	T4_BUILD_BUILT_AT: "2026-07-29T12:00:00Z",
} as const;

describe("cluster server configuration", () => {
	it("selects the projected server identity independently from its Kubernetes watch credentials", () => {
		const config = clusterServerConfigFromEnv(BASE_ENV);
		expect(config).toMatchObject({
			identityTokenPath: "/var/run/secrets/t4-cluster-identity/token",
			serverServiceAccountName: "release-t4-cluster-server",
			kubernetesTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
			kubernetesCaPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
			kubernetesApiAudience: "https://kubernetes.default.svc",
		});
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_TOKEN_FILE: "relative/token" })).toThrow("absolute");
		expect(clusterServerConfigFromEnv({ ...BASE_ENV, T4_KUBERNETES_API_AUDIENCE: "kubernetes.custom.example" }).kubernetesApiAudience).toBe("kubernetes.custom.example");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_KUBERNETES_API_AUDIENCE: "/invalid" })).toThrow("T4_KUBERNETES_API_AUDIENCE");
	});

	it("requires explicit validated public endpoints and build identity", () => {
		expect(clusterServerConfigFromEnv(BASE_ENV).restApi).toEqual({
			restBaseUrl: "https://omp.example.test/v1",
			ompAppWebSocketUrl: "wss://omp.example.test/v1/ws",
			build: {
				version: "0.1.33",
				revision: "0123456789abcdef",
				builtAt: "2026-07-29T12:00:00.000Z",
			},
		});
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_PUBLIC_REST_BASE_URL: "http://internal/v1" })).toThrow("T4_PUBLIC_REST_BASE_URL");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_PUBLIC_OMP_APP_WEBSOCKET_URL: "wss://omp.example.test/internal" })).toThrow("T4_PUBLIC_OMP_APP_WEBSOCKET_URL");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_BUILD_BUILT_AT: "not-a-date" })).toThrow("T4_BUILD_BUILT_AT");
	});

	it("defaults admission fail closed and rejects malformed or unbounded overrides", () => {
		expect(clusterServerConfigFromEnv(BASE_ENV).admissionPolicy).toMatchObject({
			maxActiveRuntimes: 10,
			maxRetainedRuntimes: 100,
			maxGpuUnits: 0,
			browserEnabled: false,
			creationRate: { windowSeconds: 60, burst: 10, maximumRetryAfterSeconds: 30 },
		});
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_ADMISSION_BROWSER_ENABLED: "yes" })).toThrow("T4_ADMISSION_BROWSER_ENABLED");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_ADMISSION_MAX_WORKSPACE_CAPACITY_BYTES: "9007199254740992" })).toThrow("T4_ADMISSION_MAX_WORKSPACE_CAPACITY_BYTES");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_ADMISSION_CREATION_BURST: "0" })).toThrow("creationRate.burst");
	});

	it("accepts Kubernetes DNS subdomains as cluster host names", () => {
		const dottedHostName = "primary.us-west-2.example";
		expect(clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_HOST_NAME: dottedHostName }).hostName).toBe(dottedHostName);

		const maximumLengthHostName = [
			"a".repeat(63),
			"b".repeat(63),
			"c".repeat(63),
			"d".repeat(61),
		].join(".");
		expect(maximumLengthHostName).toHaveLength(253);
		expect(clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_HOST_NAME: maximumLengthHostName }).hostName).toBe(maximumLengthHostName);
	});

	it("rejects invalid Kubernetes DNS subdomains as cluster host names", () => {
		const overlongHostName = [
			"a".repeat(63),
			"b".repeat(63),
			"c".repeat(63),
			"d".repeat(62),
		].join(".");
		expect(overlongHostName).toHaveLength(254);

		for (const hostName of [
			"Cluster.example",
			"",
			overlongHostName,
			"-cluster.example",
			"cluster-.example",
			"cluster..example",
			`${"a".repeat(64)}.example`,
		]) {
			expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_HOST_NAME: hostName })).toThrow("T4_CLUSTER_HOST_NAME");
		}
	});

	it("keeps Kubernetes identity fields restricted to DNS labels", () => {
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, POD_NAMESPACE: "cluster.system" })).toThrow("POD_NAMESPACE");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, POD_NAME: "cluster.server" })).toThrow("POD_NAME");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "cluster.server" })).toThrow("T4_CLUSTER_SERVER_SERVICE_ACCOUNT");
	});

	it("reads only a bounded regular projected identity file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-cluster-identity-"));
		try {
			const path = join(directory, "token");
			const nextPath = `${path}.next`;
			const token = `header.payload.${"s".repeat(64)}`;
			await writeFile(nextPath, token, { mode: 0o400 });
			await rename(nextPath, path);
			expect(await readClusterIdentityToken(path)).toBe(token);
			await writeFile(nextPath, "x".repeat(16_385), { mode: 0o400 });
			await rename(nextPath, path);
			await expect(readClusterIdentityToken(path)).rejects.toThrow("invalid");
			await expect(readClusterIdentityToken(directory)).rejects.toThrow("invalid");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("accepts exactly one server-side Woodpecker credential source", () => {
		const common = {
			...BASE_ENV,
			T4_WOODPECKER_BASE_URL: "https://ci.example.test",
			T4_WOODPECKER_REPOSITORIES: '{"t4-code":{"slug":"owner/t4-code"}}',
		};
		expect(clusterServerConfigFromEnv({ ...common, T4_WOODPECKER_TOKEN_FILE: "/var/run/secrets/t4-ci/token" }).woodpecker).toMatchObject({
			tokenFile: "/var/run/secrets/t4-ci/token",
		});
		expect(clusterServerConfigFromEnv({ ...common, T4_WOODPECKER_TOKEN: "secret-from-kubernetes" }).woodpecker).toMatchObject({
			token: "secret-from-kubernetes",
		});
		expect(() => clusterServerConfigFromEnv(common)).toThrow("complete");
		expect(() => clusterServerConfigFromEnv({
			...common,
			T4_WOODPECKER_TOKEN: "secret-from-kubernetes",
			T4_WOODPECKER_TOKEN_FILE: "/var/run/secrets/t4-ci/token",
		})).toThrow("exactly one");
	});

});

describe("trusted cluster gateway proxy sources", () => {
	it("preserves legacy Tailscale defaults or accepts exactly one referenced adapter configuration file", () => {
		expect(clusterServerConfigFromEnv(BASE_ENV).identityConfigPath).toBeUndefined();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_PROVIDER: undefined })).toThrow("T4_CLUSTER_IDENTITY_PROVIDER is required");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_PROVIDER: "generic" })).toThrow("must be tailscale");
		expect(clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_PROVIDER: undefined, T4_CLUSTER_IDENTITY_CONFIG_FILE: "/var/run/t4-identity/config.json" }).identityConfigPath).toBe("/var/run/t4-identity/config.json");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_CONFIG_FILE: "/var/run/t4-identity/config.json" })).toThrow("ambiguous");
	});

	it("accepts bounded canonical IPv4 and IPv6 networks", () => {
		const config = clusterServerConfigFromEnv({
			...BASE_ENV,
			T4_CLUSTER_TRUSTED_PROXY_ADDRESSES: "10.42.1.7,fd7a:115c:a1e0::1",
			T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.0.0/16,fd7a:115c:a1e0::/48",
		});
		expect(config.trustedProxyAddresses).toEqual(["10.42.1.7", "fd7a:115c:a1e0::1"]);
		expect(config.trustedProxyCidrs).toEqual(["10.42.0.0/16", "fd7a:115c:a1e0::/48"]);
	});

	it("rejects CIDRs with host bits or non-canonical notation", () => {
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.1.7/16" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "fd7a:115c:a1e0:0::/48" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "::/0" })).toThrow();
	});

	it("bounds the trusted CIDR list", () => {
		const cidrs = Array.from({ length: 65 }, (_, index) => `10.${index}.0.0/16`).join(",");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: cidrs })).toThrow();
	});
});
