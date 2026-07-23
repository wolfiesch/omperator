#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	OmpAuthorityBridgeClient,
	TranscriptSearchIndex,
	appserverSupportedCapabilities,
	appserverSupportedFeatures,
	createAppserver,
	type AppserverHandle,
} from "@t4-code/host-service";
import { hostId } from "@t4-code/host-wire";
import { ClusterInternalRemotePolicy, sessionHostConfigFromEnv, type SessionHostConfig } from "./session-host-policy.ts";
import { KubernetesTokenReviewer } from "./kubernetes-client.ts";

const OMP_VERSION = "17.0.5";
const OMP_COMMIT = "2eef185481d499c6e04323b71eda550a54bd4550";

export async function runSessionHost(
	config: SessionHostConfig,
	registerSignal: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void = (signal, listener) => process.on(signal, listener),
): Promise<void> {
	const home = join(config.stateRoot, "home");
	const runtime = join(config.stateRoot, "run");
	await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(runtime, { recursive: true, mode: 0o700 })]);
	const bridge = new OmpAuthorityBridgeClient({
		executable: config.ompExecutable,
		cwd: "/workspace",
		environment: {
			OMP_PROFILE: config.sessionName,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_RUNTIME_DIR: runtime,
		},
	});
	const ready = await bridge.start();
	if (ready.ompVersion !== OMP_VERSION || ready.ompBuild !== OMP_COMMIT) {
		await bridge.stop();
		throw new Error("session pod OMP authority identity does not match the pinned release");
	}
	let appserver: AppserverHandle | undefined;
	const search = new TranscriptSearchIndex(join(config.stateRoot, "transcript-search.sqlite"));
	try {
		const authorities = bridge.createAuthorities();
		const existing = await authorities.sessionAuthority.list();
		if (existing.length > 1) throw new Error("session pod contains more than one authoritative OMP session");
		if (existing.length === 0) await authorities.sessionAuthority.create("/workspace", config.sessionName);
		const hostInfo = await authorities.hostInfo();
		const base = {
			hostId: hostId(`pod:${config.sessionName}`),
			...(process.env.POD_UID ? { epoch: `pod:${process.env.POD_UID}` } : {}),
			socketPath: join(runtime, "appserver.sock"),
			attentionOutcomePath: join(config.stateRoot, "attention-outcomes.json"),
			ompVersion: ready.ompVersion,
			ompBuild: ready.ompBuild,
			appserverVersion: "0.1.31",
			appserverBuild: "cluster-session",
			sessionAuthority: authorities.sessionAuthority,
			discovery: authorities.discovery,
			operationsAuthority: authorities.operationsAuthority,
			...(authorities.usageAuthority ? { usageAuthority: authorities.usageAuthority } : {}),
			transcriptSearchAuthority: search,
			projectRootForProject: authorities.projectRootForProject,
			lockCheck: authorities.lockCheck,
			lockStatus: authorities.lockStatus,
			transcriptImageRoot: hostInfo.transcriptImageRoot,
			rpcChildInvocation: { executable: config.ompExecutable, prefixArgv: [] },
		};
		const policy = new ClusterInternalRemotePolicy({
			reviewer: new KubernetesTokenReviewer({
				baseUrl: config.kubernetesBaseUrl,
				tokenPath: config.kubernetesTokenPath,
				caPath: config.kubernetesCaPath,
				namespacePath: config.kubernetesNamespacePath,
				serverServiceAccountName: config.serverServiceAccountName,
			}),
			supportedCapabilities: appserverSupportedCapabilities(base),
			supportedFeatures: appserverSupportedFeatures(base, true),
		});
		appserver = createAppserver({
			...base,
			remoteEndpoint: {
				address: "0.0.0.0",
				port: config.port,
				internalPeerNodeId: "cluster-server",
				originAllowlist: [],
				maxConnections: 8,
				maxFrameBytes: 1_048_576,
				idleTimeoutSeconds: 120,
				backpressureLimit: 1_048_576,
			},
			remotePolicy: policy,
		});
		await appserver.start();
		const stopped = Promise.withResolvers<void>();
		let stopping = false;
		const stop = (): void => {
			if (stopping) return;
			stopping = true;
			void appserver!.stop().then(stopped.resolve, stopped.reject);
		};
		registerSignal("SIGINT", stop);
		registerSignal("SIGTERM", stop);
		await stopped.promise;
	} finally {
		await appserver?.stop().catch(() => undefined);
		await Promise.resolve(search.close()).catch(() => undefined);
		await bridge.stop();
	}
}

async function main(): Promise<void> {
	try { await runSessionHost(sessionHostConfigFromEnv(process.env)); }
	catch (error) {
		process.stderr.write(`${JSON.stringify({ component: "session-host", level: "error", message: error instanceof Error ? error.message : "session host failed" })}\n`);
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
