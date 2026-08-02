#!/usr/bin/env bun

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const TIMEOUT_MS = 60_000;
const RUNTIME_ID = "runtime-live-proof";
const RUNTIME_UID = "runtime-resource-uid";
const GENERATION = "gen_abcdefghijklmnopqrstuvwx";
const SESSION_NAME = "live-proof";
const NAMESPACE = "proof";
const WRITER_LEASE = "writer-live-proof";
const POD_UID = "pod-live-proof-12345678";
const SERVER_SERVICE_ACCOUNT = "t4-cluster-server";
const SERVER_TOKEN = "server-identity-token-abcdefghijklmnopqrstuvwxyz-0123456789";
const REVIEWER_TOKEN = "runtime-reviewer-token-abcdefghijklmnopqrstuvwxyz-0123456789";

function option(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name) {
	const value = option(name);
	if (!value) throw new Error(`missing --${name}`);
	return value;
}

async function command(args, options = {}) {
	const result = await execute(args[0], args.slice(1), {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: options.timeoutMs ?? TIMEOUT_MS,
		...options,
	});
	return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function docker(...args) {
	return command(["docker", ...args]);
}

function delay(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorSummary(error) {
	if (!(error instanceof Error)) return String(error);
	return error.cause ? `${error.message}: ${errorSummary(error.cause)}` : error.message;
}

async function poll(label, operation, accept, timeoutMs = TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (accept(value)) return value;
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(`${label} did not become ready`, { cause: lastError });
}

async function listen(server, host = "0.0.0.0") {
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, host, resolvePromise);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("proof server did not bind TCP");
	return address.port;
}

async function closeServer(server) {
	if (!server.listening) return;
	await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function readBody(request, maximumBytes = 64 * 1024) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > maximumBytes) throw new Error("proof request exceeds its bound");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function json(response, status, body) {
	const payload = Buffer.from(JSON.stringify(body));
	response.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
	response.end(payload);
}

async function startProofServices(root, generationAuth) {
	const keyPath = join(root, "tls.key");
	const certificatePath = join(root, "tls.crt");
	await command([
		"openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
		"-keyout", keyPath, "-out", certificatePath, "-days", "1",
		"-subj", "/CN=host.docker.internal",
		"-addext", "subjectAltName=DNS:host.docker.internal",
	], { timeoutMs: 30_000 });
	const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
	let resourceVersion = 1;
	let lease = {
		apiVersion: "coordination.k8s.io/v1",
		kind: "Lease",
		metadata: {
			name: WRITER_LEASE,
			namespace: NAMESPACE,
			uid: "lease-live-proof-uid",
			resourceVersion: String(resourceVersion),
			annotations: { "cluster.t4.dev/runtime-generation": GENERATION },
		},
		spec: { holderIdentity: null, acquireTime: null, renewTime: null, leaseTransitions: 0 },
	};
	const requests = { tokenReviews: 0, leaseReads: 0, leaseWrites: 0, model: 0 };
	const leasePath = `/apis/coordination.k8s.io/v1/namespaces/${NAMESPACE}/leases/${WRITER_LEASE}`;
	const kubernetes = createHttpsServer({ key, cert: certificate }, (request, response) => {
		void (async () => {
			if (request.headers.authorization !== `Bearer ${REVIEWER_TOKEN}`) return json(response, 401, { message: "unauthorized" });
			if (request.method === "GET" && request.url === leasePath) {
				requests.leaseReads++;
				return json(response, 200, lease);
			}
			if (request.method === "PUT" && request.url === leasePath) {
				const next = JSON.parse((await readBody(request)).toString("utf8"));
				if (next?.metadata?.resourceVersion !== lease.metadata.resourceVersion) return json(response, 409, { message: "conflict" });
				resourceVersion++;
				lease = { ...next, metadata: { ...next.metadata, resourceVersion: String(resourceVersion) } };
				requests.leaseWrites++;
				return json(response, 200, lease);
			}
			if (request.method === "POST" && request.url === "/apis/authentication.k8s.io/v1/tokenreviews") {
				const body = JSON.parse((await readBody(request)).toString("utf8"));
				requests.tokenReviews++;
				return json(response, 200, {
					apiVersion: "authentication.k8s.io/v1",
					kind: "TokenReview",
					status: body?.spec?.token === SERVER_TOKEN ? {
						authenticated: true,
						audiences: ["t4-cluster-internal"],
						user: { username: `system:serviceaccount:${NAMESPACE}:${SERVER_SERVICE_ACCOUNT}` },
					} : { authenticated: false },
				});
			}
			json(response, 404, { message: "not found" });
		})().catch((error) => json(response, 500, { message: error instanceof Error ? error.message : "proof server failed" }));
	});
	const kubernetesPort = await listen(kubernetes);

	const model = createHttpServer((request, response) => {
		void (async () => {
			if (request.method === "GET" && request.url === "/proof") {
				const body = Buffer.from("<!doctype html><title>Runtime live proof</title><input id=proof-input>");
				response.writeHead(200, { "content-type": "text/html", "content-length": body.length });
				response.end(body);
				return;
			}
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			await readBody(request);
			requests.model++;
			const id = `chatcmpl-live-proof-${requests.model}`;
			const frames = [
				{ id, object: "chat.completion.chunk", created: 0, model: "deterministic", choices: [{ index: 0, delta: { role: "assistant", content: `Runtime proof response ${requests.model}` }, finish_reason: null }] },
				{ id, object: "chat.completion.chunk", created: 0, model: "deterministic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } },
			];
			const payload = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(payload) });
			response.end(payload);
		})().catch(() => response.destroy());
	});
	const modelPort = await listen(model);
	return { certificate, generationAuth, kubernetes, kubernetesPort, lease: () => lease, model, modelPort, requests };
}

function envArguments(values) {
	return Object.entries(values).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function volumeArguments(volumes, temporaryRoot) {
	return [
		"--volume", `${volumes.state}:/runtime-state`,
		"--volume", `${volumes.runtime}:/run`,
		"--volume", `${volumes.workspace}:/workspace`,
		"--volume", `${temporaryRoot}/omp-config:/run/t4-omp-config-source:ro`,
		"--volume", `${temporaryRoot}/kubernetes:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
	];
}

async function main() {
	const image = requiredOption("image");
	const artifactRoot = resolve(option("artifact-root") ?? ".artifacts/p3-runtime-live");
	const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
	const prefix = `t4-p3-${suffix}`;
	const containers = { authority: `${prefix}-authority`, credential: `${prefix}-credential`, shell: `${prefix}-shell` };
	const volumes = Object.fromEntries(["state", "runtime", "workspace", "secrets", "authority-tmp", "shell-tmp", "shm"].map((name) => [name.replace("-", "_"), `${prefix}-${name}`]));
	const temporaryRoot = await mkdtemp(join(tmpdir(), "t4-p3-live-proof-"));
	const generationAuth = randomBytes(32);
	const services = await startProofServices(temporaryRoot, generationAuth);
	let passed = false;
	try {
		const inspected = JSON.parse((await docker("image", "inspect", image)).stdout)[0];
		assert.equal(inspected?.Architecture, "arm64");
		await Promise.all([
			mkdir(join(temporaryRoot, "omp-config")),
			mkdir(join(temporaryRoot, "kubernetes")),
			mkdir(artifactRoot, { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(temporaryRoot, "omp-config", "models.yml"), `providers:\n  proof:\n    baseUrl: http://host.docker.internal:${services.modelPort}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Runtime proof deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`, { mode: 0o444 }),
			writeFile(join(temporaryRoot, "omp-config", "config.yml"), "setupVersion: 1\nstartup:\n  setupWizard: false\n  checkUpdate: false\n", { mode: 0o444 }),
			writeFile(join(temporaryRoot, "kubernetes", "token"), `${REVIEWER_TOKEN}\n`, { mode: 0o444 }),
			writeFile(join(temporaryRoot, "kubernetes", "ca.crt"), services.certificate, { mode: 0o444 }),
			writeFile(join(temporaryRoot, "kubernetes", "namespace"), `${NAMESPACE}\n`, { mode: 0o444 }),
			writeFile(join(temporaryRoot, "generation.key"), generationAuth, { mode: 0o444 }),
		]);
		for (const volume of Object.values(volumes)) await docker("volume", "create", volume);
		await docker(
			"run", "--rm", "--platform", "linux/arm64", "--user", "0:0", "--entrypoint", "/bin/bash",
			"--volume", `${volumes.state}:/runtime-state`, "--volume", `${volumes.runtime}:/run`,
			"--volume", `${volumes.workspace}:/workspace`, "--volume", `${volumes.secrets}:/secrets`,
			"--volume", `${temporaryRoot}:/seed:ro`, image, "-ceu",
			"mkdir -p /run/t4 /run/t4-credential; chown 10001:20001 /runtime-state /workspace /run/t4; chmod 0770 /runtime-state /workspace; chmod 0711 /run/t4; chown 10003:20001 /run/t4-credential; chmod 0770 /run/t4-credential; cp /seed/generation.key /secrets/key; chown 10003:20001 /secrets/key; chmod 0400 /secrets/key",
		);
		const common = {
			T4_RUNTIME_ID: RUNTIME_ID,
			T4_SESSION_STATE_ID: RUNTIME_ID,
			T4_RUNTIME_GENERATION: GENERATION,
			T4_SESSION_NAME: SESSION_NAME,
			T4_WORKSPACE_ROOT: "/workspace",
			T4_SESSION_STATE_ROOT: `/runtime-state/${RUNTIME_ID}`,
			T4_CMUX_STATE_DIR: `/runtime-state/${RUNTIME_ID}/cmux`,
			T4_BROWSER_STATE_DIR: `/runtime-state/${RUNTIME_ID}/browser`,
			T4_HOST_RUNTIME_DIR: `/run/t4/${RUNTIME_ID}`,
			T4_CMUX_SOCKET_PATH: `/run/t4/${RUNTIME_ID}/c.sock`,
			T4_SESSION_HOST_READY_PATH: `/run/t4/${RUNTIME_ID}/host.ready`,
			T4_CMUX_SOCKET_MODE: "0660",
			T4_GUI_ENABLED: "true",
		};
		await docker(
			"run", "--detach", "--name", containers.authority, "--platform", "linux/arm64", "--pull", "never",
			"--read-only", "--user", "10001:20001", "--publish", "127.0.0.1::8787", "--publish", "127.0.0.1::8788",
			...volumeArguments(volumes, temporaryRoot), "--volume", `${volumes.authority_tmp}:/tmp`,
			...envArguments({
				...common,
				T4_RUNTIME_UID: RUNTIME_UID,
				T4_AUTHORITY_STATE_DIR: `/runtime-state/${RUNTIME_ID}/authority`,
				T4_ARTIFACT_ROOT: `/runtime-state/${RUNTIME_ID}/artifacts`,
				T4_PRIVATE_RUNTIME_DIR: `/runtime-state/${RUNTIME_ID}/private`,
				T4_OMP_HOME: `/runtime-state/${RUNTIME_ID}/home`,
				T4_WRITER_LEASE_PATH: `/runtime-state/${RUNTIME_ID}/private/writer-lease`,
				T4_CLUSTER_SERVER_SERVICE_ACCOUNT: SERVER_SERVICE_ACCOUNT,
				T4_CREDENTIAL_BROKER_SOCKET: "/run/t4-credential/broker.sock",
				T4_IDLE_POLICY: "allow-idle-sleep",
				T4_RUNTIME_KEEPALIVE: "false",
			}), image,
		);
		await docker(
			"run", "--detach", "--name", containers.credential, "--platform", "linux/arm64", "--pull", "never",
			"--read-only", "--user", "10003:20001", "--network", `container:${containers.authority}`,
			"--volume", `${volumes.runtime}:/run`, "--volume", `${volumes.secrets}:/run/t4-generation-auth:ro`,
			"--volume", `${temporaryRoot}/kubernetes:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
			...envArguments({
				KUBERNETES_SERVICE_HOST: "host.docker.internal",
				KUBERNETES_SERVICE_PORT_HTTPS: String(services.kubernetesPort),
				T4_CLUSTER_SERVER_SERVICE_ACCOUNT: SERVER_SERVICE_ACCOUNT,
				T4_KUBERNETES_TOKEN_PATH: "/var/run/secrets/kubernetes.io/serviceaccount/token",
				T4_KUBERNETES_CA_PATH: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
				T4_KUBERNETES_NAMESPACE_PATH: "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
				T4_RUNTIME_GENERATION: GENERATION,
				T4_RUNTIME_UID: RUNTIME_UID,
				T4_RUNTIME_ACTIVITY_PORT: "8788",
				T4_CMUX_SOCKET_PATH: `/run/t4/${RUNTIME_ID}/c.sock`,
				T4_RUNTIME_ACTIVITY_SOCKET: "/run/t4-credential/activity.sock",
				T4_WRITER_LEASE_NAME: WRITER_LEASE,
				T4_GENERATION_AUTH_PATH: "/run/t4-generation-auth/key",
				T4_CREDENTIAL_BROKER_SOCKET: "/run/t4-credential/broker.sock",
				POD_UID,
			}), "--entrypoint", "/usr/bin/tini", image, "--", "/usr/local/bin/bun", "/usr/local/lib/t4/session-credential-broker.js",
		);
		await docker(
			"run", "--detach", "--name", containers.shell, "--platform", "linux/arm64", "--pull", "never",
			"--read-only", "--user", "10002:20001", "--network", `container:${containers.authority}`,
			"--pid", `container:${containers.authority}`, "--volume", `${volumes.state}:/runtime-state`,
			"--volume", `${volumes.runtime}:/run`, "--volume", `${volumes.workspace}:/workspace`,
			"--volume", `${volumes.shell_tmp}:/tmp`, "--volume", `${volumes.shm}:/dev/shm`,
			...envArguments(common), "--entrypoint", "/usr/bin/tini", image, "--", "/usr/local/bin/t4-session-shell",
		);

		await poll("authority health", async () => docker("exec", containers.authority, "/usr/local/bin/bun", "/usr/local/lib/t4/session-authority-health.js"), () => true);
		await poll("shell readiness", async () => docker("exec", containers.shell, "/usr/local/bin/bun", "/usr/local/lib/t4/session-runtime-readiness.js", "readiness", "shell"), () => true);
		const identity = JSON.parse((await docker("exec", containers.shell, "/usr/local/bin/cmux-tui", "identify", "--socket", `/run/t4/${RUNTIME_ID}/c.sock`, "--json")).stdout);
		assert.equal(identity.protocol, 10);
		assert.equal(identity.session, SESSION_NAME);
		const socketMode = (await docker("exec", containers.shell, "stat", "-c", "%a", `/run/t4/${RUNTIME_ID}/c.sock`)).stdout;
		assert.equal(socketMode, "660");
		const credentialIdentity = JSON.parse((await docker("exec", containers.credential, "/usr/local/bin/cmux-tui", "identify", "--socket", `/run/t4/${RUNTIME_ID}/c.sock`, "--json")).stdout);
		assert.equal(credentialIdentity.pid, identity.pid);
		const activityPort = Number((await docker("port", containers.authority, "8788/tcp")).stdout.split(":").at(-1));
		const activity = await fetch(`http://127.0.0.1:${activityPort}/internal/runtime/activity`, {
			method: "POST",
			headers: { authorization: `Bearer ${generationAuth.toString("base64url")}`, "content-type": "application/json" },
			body: JSON.stringify({ expectedRuntimeUid: RUNTIME_UID, expectedGeneration: GENERATION }),
		});
		assert.equal(activity.status, 200);
		const activityBody = await activity.json();
		assert.equal(activityBody.policy, "allow-idle-sleep");
		assert.equal(services.lease().spec.holderIdentity, POD_UID);
		const imageRevision = inspected?.Config?.Labels?.["org.opencontainers.image.revision"];
		const evidence = {
			schemaVersion: 1,
			passed: true,
			image: { reference: image, architecture: inspected.Architecture, revision: imageRevision },
			runtime: { runtimeId: RUNTIME_ID, runtimeUid: RUNTIME_UID, generation: GENERATION, cmux: identity, socketMode },
			boundaries: { authorityHealth: true, shellReadiness: true, credentialCmuxAccess: true, activityRuntimeUid: true, writerLeaseHeld: true },
			requests: services.requests,
		};
		await writeFile(join(artifactRoot, "proof.json"), `${JSON.stringify(evidence, null, 2)}\n`);
		process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
		passed = true;
	} catch (error) {
		await mkdir(artifactRoot, { recursive: true });
		const containerStates = {};
		for (const [role, name] of Object.entries(containers)) {
			containerStates[role] = await docker("inspect", "--format", "{{json .State}}", name)
				.then(({ stdout }) => JSON.parse(stdout))
				.catch(() => ({ missing: true }));
			const logs = await docker("logs", name)
				.then(({ stdout, stderr }) => [stdout, stderr].filter(Boolean).join("\n"))
				.catch((logError) => `logs unavailable: ${errorSummary(logError)}`);
			await writeFile(join(artifactRoot, `${role}.log`), `${logs}\n`);
		}
		await writeFile(join(artifactRoot, "failure.json"), `${JSON.stringify({
			schemaVersion: 1,
			passed: false,
			image,
			error: errorSummary(error),
			containerStates,
		}, null, 2)}\n`);
		throw error;
	} finally {
		await Promise.all(Object.values(containers).map((name) => docker("rm", "--force", name).catch(() => undefined)));
		await Promise.all(Object.values(volumes).map((name) => docker("volume", "rm", name).catch(() => undefined)));
		await Promise.all([closeServer(services.kubernetes), closeServer(services.model)]);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
	if (!passed) throw new Error("packaged session runtime live proof failed");
}

await main();
