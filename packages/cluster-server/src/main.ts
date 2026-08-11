#!/usr/bin/env bun
import { CiProjectionRunner } from "./ci-projection-runner.ts";
import { clusterServerConfigFromEnv, loadKubernetesCa, loadRequestIdentityResolver } from "./config.ts";
import { ClusterGateway } from "./gateway.ts";
import { KubernetesApiClient, KubernetesGatewayMutationBackend } from "./kubernetes-client.ts";
import { createKubernetesControlStore } from "./kubernetes-control-store.ts";
import { KubernetesCmuxWebSocketRouteOpener, KubernetesProviderCmuxRouteOpener } from "./kubernetes-cmux-route-opener.ts";
import { ClusterProviderService, ProviderAssertionVerifier } from "./provider-service.ts";
import {
	KubernetesConfigMapLifecycleEventStorage,
	LifecycleProjectionNotifier,
	SharedLifecycleEventLedger,
} from "./lifecycle-events.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import { KubernetesProjectionRunner } from "./kubernetes-runner.ts";
import { ClusterMetrics, ClusterServerHealth, JsonLogger } from "./observability.ts";
import { WebSocketPodHostConnector } from "./pod-host-router.ts";
import { startClusterHttpServers, type ClusterHttpServers } from "./server.ts";
import { SessionAuthorityRunner } from "./session-authority-runner.ts";
import { WoodpeckerProvider } from "./woodpecker.ts";
import { Authorizer } from "./authorization.ts";
import { ScopeAdmissionAuthority } from "./scope-admission.ts";

export async function runClusterServer(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const config = clusterServerConfigFromEnv(env);
	const logger = new JsonLogger(undefined, { component: "cluster-server", version: "0.2.1", namespace: config.namespace });
	const auditLogger = new JsonLogger(undefined, { component: "cluster-server", version: "0.2.1", namespace: config.namespace });
	const authorizer = new Authorizer(event => auditLogger.info("access_decision", { ...event }));
	const health = new ClusterServerHealth();
	const metrics = new ClusterMetrics({ component: "cluster-server", version: "0.2.1", namespace: config.namespace });
	const ca = await loadKubernetesCa(config);
	const identityResolver = await loadRequestIdentityResolver(config);
	const kubernetes = new KubernetesApiClient({
		baseUrl: config.kubernetesBaseUrl,
		namespace: config.namespace,
		tokenFile: config.kubernetesTokenPath,
		ca,
	});
	const projection = new ClusterInfrastructureProjection({ epoch: config.epoch, namespace: config.namespace });
	const lifecycleEvents = new SharedLifecycleEventLedger({
		storage: new KubernetesConfigMapLifecycleEventStorage(kubernetes, config.hostName),
	});
	const controlStore = createKubernetesControlStore(kubernetes, `admission:${config.hostName}`);
	const admission = new ScopeAdmissionAuthority({
		projection,
		ledger: controlStore,
		policy: config.admissionPolicy,
	});
	const lifecycleNotifier = new LifecycleProjectionNotifier({
		projection,
		ledger: lifecycleEvents,
		onError: error => {
			health.markKubernetesUnavailable();
			metrics.set("omperator_gateway_ready", 0);
			logger.warn("lifecycle event append failed", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
		},
	});
	const runner = new KubernetesProjectionRunner({
		client: kubernetes,
		projection,
		hostName: config.hostName,
		onSynchronized: () => {
			health.markKubernetesSynced();
			metrics.set("omperator_gateway_ready", health.ready ? 1 : 0);
		},
		onError: error => {
			health.markKubernetesUnavailable();
			metrics.set("omperator_gateway_ready", 0);
			logger.warn("Kubernetes watch reconnecting", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
		},
		lifecycleNotifier,
	});

	const stopped = Promise.withResolvers<void>();
	const stop = (): void => stopped.resolve();
	let authority: SessionAuthorityRunner | undefined;
	let ciProjection: CiProjectionRunner | undefined;
	let servers: ClusterHttpServers | undefined;
	let signalsInstalled = false;
	try {
		await runner.start();
		lifecycleNotifier.start();
		const connector = new WebSocketPodHostConnector({ identityTokenFile: config.identityTokenPath });
		authority = new SessionAuthorityRunner({
			projection,
			connector,
			onError: error => logger.warn("session authority reconnecting", { condition: error instanceof Error ? error.name : "unknown", result: "failure" }),
		});
		authority.start();
		const ciProvider = config.woodpecker ? new WoodpeckerProvider(config.woodpecker) : undefined;
		if (ciProvider) {
			ciProjection = new CiProjectionRunner({
				projection,
				provider: ciProvider,
				onError: error => logger.warn("CI projection refresh failed", { condition: error instanceof Error ? error.name : "unknown", result: "failure" }),
			});
			ciProjection.start();
		}
		const mutations = new KubernetesGatewayMutationBackend({ client: kubernetes, hostRef: config.hostName });
		const cmuxWebSocketRouteOpener = new KubernetesCmuxWebSocketRouteOpener(projection, kubernetes);
		const providerService = new ClusterProviderService({
			api: kubernetes,
			projection,
			controlStore,
			hostRef: config.hostName,
			admissionPolicy: config.admissionPolicy,
			authorizer,
			metrics,
			routeOpener: authority => new KubernetesProviderCmuxRouteOpener(projection, cmuxWebSocketRouteOpener, authority.ownerPrincipal),
		});
		const providerAssertionVerifier = config.providerAssertionSecretPath && config.providerAssertionAudience
			? new ProviderAssertionVerifier({ keyringPath: config.providerAssertionSecretPath, ledger: controlStore, audience: config.providerAssertionAudience })
			: undefined;
		const gateway = new ClusterGateway({
			projection,
			connector,
			mutations,
			...(ciProvider ? { ciProvider } : {}),
			authorizer,
			runtimeIngress: controlStore,
			onProtocolMismatch: () => metrics.increment("omperator_omp_bridge_mismatch_total", {}),
		});
		servers = startClusterHttpServers({
			gateway,
			runtimeIngress: controlStore,
			projection,
			gatewayPort: config.gatewayPort,
			adminPort: config.adminPort,
			identityResolver,
			trustedProxyAddresses: config.trustedProxyAddresses,
			trustedProxyCidrs: config.trustedProxyCidrs,
			restApi: config.restApi,
			restMutations: mutations,
			admission,
			cmuxWebSocketRouteOpener,
			providerService,
			...(providerAssertionVerifier ? { providerAssertionVerifier } : {}),
			lifecycleEvents,
			health,
			metrics,
			logger,
			authorizer,
		});
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		signalsInstalled = true;
		await stopped.promise;
	} finally {
		if (signalsInstalled) {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
		}
		try {
			await servers?.drain();
		} finally {
			try {
				await lifecycleNotifier.stop();
			} finally {
				lifecycleEvents.close();
			}
			try {
				await ciProjection?.stop();
			} finally {
				try {
					await authority?.stop();
				} finally {
					try {
						await runner.stop();
					} finally {
						await servers?.stop();
					}
				}
			}
		}
	}
}

async function main(): Promise<void> {
	try { await runClusterServer(); }
	catch (error) {
		const logger = new JsonLogger(undefined, { component: "cluster-server", version: "0.2.1" });
		logger.error("cluster server failed", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
