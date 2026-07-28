import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LocalPairingTicketIssuer, SqliteDeviceRegistry } from "../security/index.ts";
import { isCapability, type DeviceCapability } from "@t4-code/host-wire";
import { appserverSupportedCapabilities, appserverSupportedFeatures, createAppserver } from "../server.ts";
import type { AppserverHandle, AppserverOptions } from "../types.ts";
import { deviceIdentityKeyForPeer, TailscaleRemotePolicy } from "./policy.ts";
import { TailscaleWhoisResolver } from "./resolver.ts";
import type { ProcessRunner, ProcessRunOptions, RemoteListenerConfig, RemotePeerIdentity } from "./types.ts";

const KEY_BYTES = 32;
const DEFAULT_WHOIS_OUTPUT = 256 * 1024;
const LOCAL_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Mint (or rotate) the device credential same-machine apps use to
 * autoconnect over the loopback listener, and publish it as a 0600 JSON file
 * next to the appserver socket. The record is bound to the host's own tailnet
 * node identity — exactly what registry.authenticate derives when the
 * loopback listener reports peers as that node. Every host start revokes the
 * previous file's device and issues a fresh one, killing old tokens. */
export async function publishLocalDevice(
	registry: SqliteDeviceRegistry,
	path: string,
	endpoint: string,
	selfIdentity: RemotePeerIdentity,
	capabilities: readonly string[],
): Promise<void> {
	try {
		const previous = JSON.parse(await readFile(path, "utf8")) as { deviceId?: unknown };
		if (typeof previous.deviceId === "string" && registry.get(previous.deviceId))
			registry.revoke(previous.deviceId);
	} catch {
		// No readable previous file — first start on this machine.
	}
	const now = Date.now();
	const deviceId = `local-${randomBytes(9).toString("base64url")}`;
	const token = randomBytes(32).toString("base64url");
	registry.create(
		{
			deviceId,
			identityKey: deviceIdentityKeyForPeer(selfIdentity),
			capabilities: capabilities.filter((value): value is DeviceCapability => isCapability(value)),
			metadata: {
				label: "This Mac (automatic)",
				platform: process.platform === "darwin" ? "macos" : process.platform,
			},
			createdAt: now,
			lastSeenAt: null,
			tokenExpiresAt: now + LOCAL_DEVICE_TTL_MS,
			revokedAt: null,
			epoch: 0,
		},
		token,
	);
	const payload = JSON.stringify({
		version: 1,
		endpoint,
		deviceId,
		deviceToken: token,
	});
	const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	await writeFile(tmp, payload, { mode: 0o600 });
	await rename(tmp, path);
}

async function withdrawLocalDevice(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}

export interface RemoteAppserverOptions {
	readonly stateDir: string;
	readonly remoteEndpoint: RemoteListenerConfig;
	readonly remoteEndpointTls?: RemoteListenerConfig;
	/** Same-machine clients: extra listener on 127.0.0.1. The host resolves its
	 * own tailnet identity once and reports every loopback peer as that node,
	 * so credentials bound to this machine (the local-device file below, or any
	 * device paired here) authenticate without pairing UI. */
	readonly remoteEndpointLoopback?: RemoteListenerConfig;
	/** Path of the 0600 JSON credential file same-machine apps read to
	 * autoconnect over the loopback listener. Requires remoteEndpointLoopback. */
	readonly localDevicePath?: string;
	readonly log?: (event: string, data?: Record<string, unknown>) => void;
	readonly appserver?: Omit<AppserverOptions, "remoteEndpoint" | "remoteEndpointLoopback" | "remotePolicy" | "remoteResolver" | "admin">;
	readonly processRunner?: ProcessRunner;
	readonly tailscaleExecutable?: string;
}

async function secureDirectory(path: string): Promise<void> {
	if (!isAbsolute(path)) throw new Error("remote state directory must be absolute");
	const existing = await lstat(path).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink()) throw new Error("remote state directory symlink rejected");
	await mkdir(path, { recursive: true, mode: 0o700 });
	const current = await lstat(path);
	if (!current.isDirectory() || (current.mode & 0o777) !== 0o700)
		throw new Error("remote state directory permissions denied");
	await chmod(path, 0o700);
}

async function loadPairingKey(stateDir: string): Promise<Uint8Array> {
	const keyPath = join(stateDir, "pairing.key");
	try {
		const info = await lstat(keyPath);
		if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600)
			throw new Error("pairing key permissions denied");
		const bytes = await readFile(keyPath);
		if (bytes.byteLength !== KEY_BYTES) throw new Error("pairing key length invalid");
		return new Uint8Array(bytes);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const handle = await open(
		keyPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const bytes = randomBytes(KEY_BYTES);
		await handle.write(bytes);
		await handle.sync();
		return bytes;
	} finally {
		await handle.close();
		await chmod(keyPath, 0o600);
	}
}

async function safeExecutable(path: string): Promise<string | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isSymbolicLink() && info.isFile()) {
			await access(path, constants.X_OK);
			return path;
		}
		const resolved = await realpath(path);
		const finalInfo = await stat(resolved);
		if (!finalInfo.isFile()) return undefined;
		await access(resolved, constants.X_OK);
		return resolved;
	} catch {
		return undefined;
	}
}

export async function discoverTailscaleExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const candidates: string[] = [];
	for (const directory of (env.PATH ?? "").split(":").filter(Boolean)) candidates.push(join(directory, "tailscale"));
	candidates.push(
		"/usr/bin/tailscale",
		"/opt/homebrew/bin/tailscale",
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	);
	for (const candidate of new Set(candidates)) {
		const executable = await safeExecutable(candidate);
		if (executable) return executable;
	}
	throw new Error("tailscale executable not found");
}

export class BunProcessRunner implements ProcessRunner {
	constructor(private readonly executable?: string) {}
	async run(argv: string[], options: ProcessRunOptions): Promise<{ stdout: string; exitCode: number }> {
		if (
			!Array.isArray(argv) ||
			argv.length === 0 ||
			argv.some(value => typeof value !== "string" || value.length === 0)
		)
			throw new Error("process argv invalid");
		if (
			!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs <= 0 ||
			!Number.isSafeInteger(options.maxOutputBytes) ||
			options.maxOutputBytes <= 0
		)
			throw new Error("process limits invalid");
		const command = this.executable ? [this.executable, ...argv.slice(1)] : argv;
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		const stdout = child.stdout as unknown as AsyncIterable<Uint8Array>;
		const stderr = child.stderr as unknown as AsyncIterable<Uint8Array>;
		const drain = (async () => {
			for await (const _chunk of stderr) {
			}
		})();
		const read = (async () => {
			const chunks: Uint8Array[] = [];
			let total = 0;
			for await (const chunk of stdout) {
				total += chunk.byteLength;
				if (total > options.maxOutputBytes) {
					child.kill("SIGKILL");
					throw new Error("process output exceeds limit");
				}
				chunks.push(chunk);
			}
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(merged);
		})();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		try {
			const [output, exitCode] = await Promise.all([read, child.exited]);
			await drain;
			if (timedOut) throw new Error("process timed out");
			return { stdout: output, exitCode };
		} finally {
			clearTimeout(timer);
			await Promise.allSettled([drain]);
		}
	}
}

export async function createRemoteAppserver(options: RemoteAppserverOptions): Promise<AppserverHandle> {
	await secureDirectory(options.stateDir);
	const key = await loadPairingKey(options.stateDir);
	const registry = new SqliteDeviceRegistry(join(options.stateDir, "devices.sqlite"));
	const issuer = new LocalPairingTicketIssuer(registry, key);
	const appserverOptions = options.appserver;
	const supportedCapabilities = appserverSupportedCapabilities(appserverOptions ?? {});
	const policy = new TailscaleRemotePolicy({
		registry,
		localPairing: issuer,
		supportedCapabilities,
		supportedFeatures: appserverSupportedFeatures(appserverOptions ?? {}, true),
	});
	const endpoint = options.remoteEndpoint;
	let resolver: TailscaleWhoisResolver | undefined;
	let loopbackEndpoint: RemoteListenerConfig | undefined;
	try {
		if (endpoint.serveProxy !== true) {
			const executable = options.tailscaleExecutable ?? (await discoverTailscaleExecutable());
			resolver = new TailscaleWhoisResolver(
				options.processRunner ?? new BunProcessRunner(executable),
				endpoint.whoisTimeoutMs ?? 2_000,
				endpoint.whoisMaxOutputBytes ?? DEFAULT_WHOIS_OUTPUT,
			);
		}
		if (options.remoteEndpointLoopback && resolver && options.localDevicePath) {
			// Local autoconnect: report loopback peers as this host's own tailnet
			// node and mint the device credential file apps read. A whois failure
			// (tailscaled down) must never keep the host from starting.
			try {
				const selfIdentity = await resolver.resolve(endpoint.address);
				loopbackEndpoint = { ...options.remoteEndpointLoopback, selfIdentity };
				await publishLocalDevice(
					registry,
					options.localDevicePath,
					`ws://${options.remoteEndpointLoopback.address}:${options.remoteEndpointLoopback.port}/v1/ws`,
					selfIdentity,
					supportedCapabilities,
				);
				options.log?.("remote.local_autoconnect", { address: options.remoteEndpointLoopback.address, port: options.remoteEndpointLoopback.port });
			} catch (error) {
				loopbackEndpoint = undefined;
				options.log?.("remote.local_autoconnect.disabled", { error: error instanceof Error ? error.message : String(error) });
			}
		}
		const inner = createAppserver({
			...options.appserver,
			remoteEndpoint: endpoint,
			...(options.remoteEndpointTls ? { remoteEndpointTls: options.remoteEndpointTls } : {}),
			...(loopbackEndpoint ? { remoteEndpointLoopback: loopbackEndpoint } : {}),
			remotePolicy: policy,
			...(resolver ? { remoteResolver: resolver } : undefined),
			admin: {
				issuePairingTicket: (capabilities, ttlMs, expectedNodeId) =>
					policy.issuePairingTicket(capabilities, ttlMs, expectedNodeId),
				listDevices: () => policy.listDeviceSummaries(),
				revokeDevice: deviceId => policy.revokeDevice(deviceId),
			},
		});
		let closed = false;
		const closePolicy = (): void => {
			if (!closed) {
				closed = true;
				policy.close();
			}
		};
		return {
			get hostId() {
				return inner.hostId;
			},
			get epoch() {
				return inner.epoch;
			},
			get socketPath() {
				return inner.socketPath;
			},
			async start() {
				try {
					await inner.start();
				} catch (error) {
					closePolicy();
					throw error;
				}
			},
			async stop() {
				try {
					await inner.stop();
				} finally {
					if (options.localDevicePath) await withdrawLocalDevice(options.localDevicePath);
					closePolicy();
				}
			},
			snapshot: sessionId => inner.snapshot(sessionId),
			replay: (sessionId, cursor) => inner.replay(sessionId, cursor),
			childFor: sessionId => inner.childFor(sessionId),
		};
	} catch (error) {
		policy.close();
		throw error;
	}
}
