import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { chmod, type FileHandle, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import {
	COMMAND_DESCRIPTORS,
	type CommandDescriptor,
	DEVICE_CAPABILITIES,
	type DeviceCapability,
	isCapability,
} from "@t4-code/host-wire";

export type Capability = DeviceCapability;
export interface RemotePeerIdentity {
	readonly nodeId: string;
	readonly login: string;
	readonly hostId: string;
	readonly tailnetIp: string;
}
export interface Clock {
	now(): number;
}
export interface Random {
	bytes(size: number): Uint8Array;
}
const realClock: Clock = { now: () => Date.now() };
const realRandom: Random = { bytes: size => randomBytes(size) };
const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const hash = (salt: Uint8Array, token: string): Buffer => createHash("sha256").update(salt).update(token).digest();
const hasControl = (value: string): boolean => [...value].some(character => {
	const code = character.codePointAt(0) ?? 0;
	return code <= 0x1f || code === 0x7f;
});
const safe = (value: unknown, max = 256): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= max && !hasControl(value)
		? value
		: null;
const recordValue = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
const stringField = (row: Record<string, unknown>, key: string, max = 256): string => {
	const value = safe(row[key], max);
	if (!value) throw new Error("invalid persisted row");
	return value;
};
const numberField = (row: Record<string, unknown>, key: string): number => {
	const value = row[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid persisted row");
	return value;
};
const nullableNumber = (row: Record<string, unknown>, key: string): number | null => {
	const value = row[key];
	if (value === null) return null;
	return numberField(row, key);
};
const isTailnetIp = (value: string): boolean => {
	if (value.includes(":")) return isIP(value) === 6 && /^fd7a:115c:a1e0:/iu.test(value);
	const parts = value.split(".");
	return (
		parts.length === 4 &&
		parts.every(part => /^\d+$/u.test(part) && Number(part) >= 0 && Number(part) <= 255) &&
		parts[0] === "100" &&
		Number(parts[1]) >= 64 &&
		Number(parts[1]) <= 127
	);
};
const canonicalIdentity = (identity: RemotePeerIdentity): string => {
	if (
		!safe(identity.nodeId) ||
		!safe(identity.login) ||
		!safe(identity.hostId) ||
		!safe(identity.tailnetIp) ||
		!isTailnetIp(identity.tailnetIp)
	)
		throw new Error("invalid tailscale identity");
	return JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]);
};
/** Exported so the host can mint a device record offline (local autoconnect)
 * with the exact identity key registry.authenticate will derive at hello. */
export const canonicalDeviceIdentityKey = canonicalIdentity;
const normalizeSourceIp = (value: string): string | null => {
	const raw = safe(value, 128)?.trim();
	if (!raw) return null;
	const kind = isIP(raw);
	if (kind === 4) {
		const parts = raw.split(".");
		if (parts.length !== 4 || parts.some(part => !/^\d+$/u.test(part) || Number(part) > 255)) return null;
		return parts.map(part => String(Number(part))).join(".");
	}
	if (kind === 6) return raw.toLowerCase();
	return null;
};
const caps = (value: readonly string[]): readonly Capability[] => [...new Set(value.filter(isCapability))];
const DEVICE_SCHEMA_VERSION = 1;
const DEVICE_SCHEMA_COLUMNS = [
	"device_id",
	"identity_key",
	"node_id",
	"login",
	"host_id",
	"tailnet_ip",
	"metadata",
	"capabilities",
	"created_at",
	"last_seen_at",
	"token_expires_at",
	"revoked_at",
	"epoch",
	"revision",
	"salt",
	"token_digest",
] as const;
const deviceSchemaColumns = (database: Database): Set<string> =>
	new Set(
		(database.query("PRAGMA table_info(devices)").all() as Array<Record<string, unknown>>).map(row =>
			typeof row.name === "string" ? row.name : "",
		),
	);
const verifyDeviceSchema = (database: Database): void => {
	const columns = deviceSchemaColumns(database);
	if (DEVICE_SCHEMA_COLUMNS.some(column => !columns.has(column))) throw new Error("unsupported device schema");
};
const readDeviceSchemaVersion = (database: Database): number => {
	const row = recordValue(database.query("PRAGMA user_version").get());
	const value = row?.user_version;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error("invalid device schema version");
	return value;
};

export interface DeviceMetadata {
	readonly label: string;
	readonly platform?: string;
}
export interface PairingIssuer {
	readonly deviceId: string;
	readonly epoch: number;
	readonly identityKey: string;
}
export interface PairingService {
	start(
		connectionId: string,
		allowedCapabilities: readonly Capability[],
		ttlMs: number | undefined,
		issuer: PairingIssuer,
	): PairStart;
	complete(
		connectionId: string,
		code: string,
		identity: RemotePeerIdentity,
		metadata: DeviceMetadata,
		requestedCapabilities: readonly Capability[],
		issuer: PairingIssuer,
	): { readonly deviceId: string; readonly token: string; readonly tokenExpiresAt: number };
}
export interface AuthenticatedPrincipal extends DeviceRecord {
	readonly authenticatedAt: number;
	readonly connectionId: string;
}
export interface DeviceRecord {
	readonly deviceId: string;
	readonly identityKey: string;
	readonly capabilities: readonly Capability[];
	readonly metadata: DeviceMetadata;
	readonly createdAt: number;
	readonly lastSeenAt: number | null;
	readonly tokenExpiresAt: number;
	readonly revokedAt: number | null;
	readonly epoch: number;
	readonly revision?: string;
}
export interface DeviceRegistry {
	authenticate(
		deviceId: string,
		token: string,
		identity: RemotePeerIdentity,
		connectionId: string,
	): AuthenticatedPrincipal;
	get(deviceId: string): DeviceRecord | null;
	create(record: DeviceRecord, token: string): void;
	updateMetadata(deviceId: string, metadata: DeviceMetadata, capabilities: readonly Capability[]): void;
	revoke(deviceId: string, now?: number): void;
	list(): readonly DeviceRecord[];
	close(): void;
	getAuthenticatedPrincipal(connectionId: string, deviceId: string): AuthenticatedPrincipal | null;
	onInvalidation?(listener: (deviceId: string) => void): () => void;
}
export interface PairStart {
	readonly code: string;
	readonly expiresAt: number;
}

function digits(random: Random, count: number): string {
	let out = "";
	while (out.length < count)
		for (const byte of random.bytes(32)) {
			if (byte >= 250) continue;
			out += String(byte % 10);
			if (out.length === count) break;
		}
	return out;
}

export class SqliteDeviceRegistry implements DeviceRegistry {
	private readonly invalidationListeners = new Set<(deviceId: string) => void>();
	private readonly database: Database;
	private readonly active = new Map<string, AuthenticatedPrincipal>();
	private lastNow = Number.NEGATIVE_INFINITY;
	private read(rowValue: unknown): DeviceRecord | null {
		const row = recordValue(rowValue);
		if (!row) return null;
		const capabilityValue: unknown = JSON.parse(stringField(row, "capabilities", 4096));
		if (!Array.isArray(capabilityValue)) throw new Error("invalid persisted capability");
		const validCapabilities = capabilityValue.filter((value): value is Capability => isCapability(value));
		if (validCapabilities.length !== capabilityValue.length) throw new Error("invalid persisted capability");
		const metadataValue: unknown = JSON.parse(stringField(row, "metadata", 4096));
		const metadata = recordValue(metadataValue);
		if (
			!metadata ||
			typeof metadata.label !== "string" ||
			(metadata.platform !== undefined && typeof metadata.platform !== "string")
		)
			throw new Error("invalid persisted metadata");
		const deviceMetadata: DeviceMetadata =
			metadata.platform === undefined
				? { label: metadata.label }
				: { label: metadata.label, platform: metadata.platform };
		const revision = row.revision === null || row.revision === undefined ? undefined : safe(row.revision);
		return {
			deviceId: stringField(row, "device_id"),
			identityKey: stringField(row, "identity_key"),
			capabilities: validCapabilities,
			metadata: deviceMetadata,
			createdAt: numberField(row, "created_at"),
			lastSeenAt: nullableNumber(row, "last_seen_at"),
			tokenExpiresAt: numberField(row, "token_expires_at"),
			revokedAt: nullableNumber(row, "revoked_at"),
			epoch: numberField(row, "epoch"),
			...(revision ? { revision } : {}),
		};
	}
	constructor(
		path: string,
		private readonly clock: Clock = realClock,
		private readonly random: Random = realRandom,
	) {
		const parentPath = dirname(path);
		const existingParent = lstatSync(parentPath, { throwIfNoEntry: false });
		if (existingParent?.isSymbolicLink()) throw new Error("device database parent symlink rejected");
		mkdirSync(parentPath, { recursive: true, mode: 0o700 });
		const parent = lstatSync(parentPath);
		if (!parent?.isDirectory() || (existingParent && (parent.mode & 0o777) !== 0o700))
			throw new Error("device database parent permissions denied");
		if (!existingParent) chmodSync(parentPath, 0o700);
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("device database symlink rejected");
		this.database = new Database(path);
		chmodSync(path, 0o600);
		for (const suffix of ["-wal", "-shm"]) {
			try {
				chmodSync(`${path}${suffix}`, 0o600);
			} catch {
				if (lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }))
					throw new Error("database sidecar permissions denied");
			}
		}
		this.database.run("PRAGMA busy_timeout=5000");
		const version = readDeviceSchemaVersion(this.database);
		if (version > DEVICE_SCHEMA_VERSION) throw new Error("unsupported device schema");
		this.database.run("BEGIN IMMEDIATE");
		try {
			this.database.run(
				"CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL DEFAULT '', node_id TEXT NOT NULL DEFAULT '', login TEXT NOT NULL DEFAULT '', host_id TEXT NOT NULL DEFAULT '', tailnet_ip TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{\"label\":\"migrated\"}', capabilities TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER, token_expires_at INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, epoch INTEGER NOT NULL DEFAULT 0, revision TEXT, salt BLOB NOT NULL DEFAULT X'', token_digest BLOB NOT NULL DEFAULT X'')",
			);
			const columns = deviceSchemaColumns(this.database);
			const additions: Record<string, string> = {
				identity_key: "TEXT NOT NULL DEFAULT ''",
				node_id: "TEXT NOT NULL DEFAULT ''",
				login: "TEXT NOT NULL DEFAULT ''",
				host_id: "TEXT NOT NULL DEFAULT ''",
				tailnet_ip: "TEXT NOT NULL DEFAULT ''",
				metadata: 'TEXT NOT NULL DEFAULT \'{"label":"migrated"}\'',
				capabilities: "TEXT NOT NULL DEFAULT '[]'",
				created_at: "INTEGER NOT NULL DEFAULT 0",
				last_seen_at: "INTEGER",
				token_expires_at: "INTEGER NOT NULL DEFAULT 0",
				revoked_at: "INTEGER",
				epoch: "INTEGER NOT NULL DEFAULT 0",
				revision: "TEXT",
				salt: "BLOB NOT NULL DEFAULT X''",
				token_digest: "BLOB NOT NULL DEFAULT X''",
			};
			for (const [name, type] of Object.entries(additions))
				if (!columns.has(name)) this.database.run(`ALTER TABLE devices ADD COLUMN ${name} ${type}`);
			this.database.run(
				"UPDATE devices SET token_expires_at=created_at+7776000000 WHERE token_expires_at=0 AND created_at>0",
			);
			verifyDeviceSchema(this.database);
			this.database.run(`PRAGMA user_version = ${DEVICE_SCHEMA_VERSION}`);
			this.database.run("COMMIT");
		} catch (error) {
			try {
				this.database.run("ROLLBACK");
			} catch {}
			throw error;
		}
		if (readDeviceSchemaVersion(this.database) !== DEVICE_SCHEMA_VERSION)
			throw new Error("device schema verification failed");
	}
	get(deviceId: string): DeviceRecord | null {
		return this.read(this.database.query("SELECT * FROM devices WHERE device_id=?").get(deviceId));
	}
	create(record: DeviceRecord, token: string): void {
		const rawNow = this.clock.now();
		if (!Number.isFinite(rawNow)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, rawNow);
		const now = this.lastNow;
		const maxExpiry = now + 90 * 24 * 60 * 60 * 1000;
		if (
			!safe(token, 4096) ||
			!/^[A-Za-z0-9_-]{43}$/u.test(token) ||
			record.createdAt > now ||
			record.tokenExpiresAt <= now ||
			record.tokenExpiresAt > maxExpiry ||
			(record.revision !== undefined && !safe(record.revision))
		)
			throw new Error("token invalid");
		const salt = this.random.bytes(16);
		this.database
			.query(
				"INSERT INTO devices(device_id,identity_key,node_id,login,host_id,tailnet_ip,metadata,capabilities,created_at,last_seen_at,token_expires_at,revoked_at,epoch,revision,salt,token_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				record.deviceId,
				record.identityKey,
				record.identityKey,
				record.identityKey,
				record.identityKey,
				record.identityKey,
				JSON.stringify(record.metadata),
				JSON.stringify(record.capabilities),
				record.createdAt,
				record.lastSeenAt,
				record.tokenExpiresAt,
				record.revokedAt,
				record.epoch,
				record.revision ?? null,
				salt,
				hash(salt, token),
			);
	}
	updateMetadata(deviceId: string, metadata: DeviceMetadata, capabilities: readonly Capability[]): void {
		const record = this.get(deviceId);
		const next = caps(capabilities);
		if (
			!record ||
			!safe(metadata.label) ||
			capabilities.some(value => !isCapability(value)) ||
			next.some(value => !record.capabilities.includes(value))
		)
			throw new Error("metadata denied");
		const changed =
			next.length !== record.capabilities.length || next.some(value => !record.capabilities.includes(value));
		const epoch = changed ? record.epoch + 1 : record.epoch;
		this.database
			.query("UPDATE devices SET metadata=?, capabilities=?, epoch=? WHERE device_id=? AND epoch=?")
			.run(JSON.stringify(metadata), JSON.stringify(next), epoch, deviceId, record.epoch);
		if (changed) {
			for (const key of this.active.keys()) if (key.endsWith(`:${deviceId}`)) this.active.delete(key);
			for (const listener of this.invalidationListeners) listener(deviceId);
		}
	}
	authenticate(
		deviceId: string,
		token: string,
		identity: RemotePeerIdentity,
		connectionId: string,
	): AuthenticatedPrincipal {
		const rowValue = this.database.query("SELECT * FROM devices WHERE device_id=?").get(deviceId);
		const row = recordValue(rowValue);
		const principal = this.read(rowValue);
		const rawNow = this.clock.now();
		if (!Number.isFinite(rawNow)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, rawNow);
		const now = this.lastNow;
		if (
			!row ||
			!principal ||
			principal.revokedAt !== null ||
			principal.tokenExpiresAt <= now ||
			principal.identityKey !== canonicalIdentity(identity)
		) {
			if (principal && principal.tokenExpiresAt <= now && principal.revokedAt === null) this.revoke(deviceId, now);
			throw new Error("authentication denied");
		}
		const salt = row.salt;
		const storedDigest = row.token_digest;
		if (
			!(salt instanceof Uint8Array) ||
			!(storedDigest instanceof Uint8Array) ||
			storedDigest.length !== 32 ||
			!safe(token, 4096)
		)
			throw new Error("authentication denied");
		const actual = hash(salt, token);
		if (!timingSafeEqual(Buffer.from(storedDigest), actual)) throw new Error("authentication denied");
		this.database
			.query("UPDATE devices SET last_seen_at=? WHERE device_id=? AND epoch=?")
			.run(now, deviceId, principal.epoch);
		const authenticated = { ...principal, lastSeenAt: now, authenticatedAt: now, connectionId };
		this.active.set(`${connectionId}:${deviceId}`, authenticated);
		return authenticated;
	}
	getAuthenticatedPrincipal(connectionId: string, deviceId: string): AuthenticatedPrincipal | null {
		const principal = this.active.get(`${connectionId}:${deviceId}`);
		if (!principal) return null;
		const rawNow = this.clock.now();
		if (!Number.isFinite(rawNow)) return null;
		this.lastNow = Math.max(this.lastNow, rawNow);
		const current = this.get(deviceId);
		if (
			!current ||
			current.epoch !== principal.epoch ||
			current.revokedAt !== null ||
			current.tokenExpiresAt <= this.lastNow
		) {
			this.active.delete(`${connectionId}:${deviceId}`);
			return null;
		}
		return { ...principal, ...current, authenticatedAt: principal.authenticatedAt, connectionId };
	}
	revoke(deviceId: string, now = this.clock.now()): void {
		this.database.query("UPDATE devices SET revoked_at=?, epoch=epoch+1 WHERE device_id=?").run(now, deviceId);
		for (const key of this.active.keys()) if (key.endsWith(`:${deviceId}`)) this.active.delete(key);
		for (const listener of this.invalidationListeners) listener(deviceId);
	}
	list(): readonly DeviceRecord[] {
		return this.database
			.query("SELECT * FROM devices ORDER BY created_at")
			.all()
			.map(row => this.read(row))
			.filter((value): value is DeviceRecord => value !== null);
	}
	onInvalidation(listener: (deviceId: string) => void): () => void {
		this.invalidationListeners.add(listener);
		return () => this.invalidationListeners.delete(listener);
	}
	close(): void {
		this.database.close();
	}
}

export class SqlitePairingService implements PairingService {
	private readonly pending = new Map<
		string,
		{
			issuerId: string;
			issuer: PairingIssuer;
			code: string;
			expiresAt: number;
			allowed: readonly Capability[];
			attempts: number;
		}
	>();
	private readonly failedAttempts = new Map<string, { count: number; expiresAt: number }>();
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly registry: DeviceRegistry,
		private readonly clock: Clock = realClock,
		private readonly random: Random = realRandom,
	) {}
	private now() {
		const value = this.clock.now();
		if (!Number.isFinite(value)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, value);
		return this.lastNow;
	}
	start(
		connectionId: string,
		allowedCapabilities: readonly Capability[],
		ttlMs = 120_000,
		issuer: PairingIssuer,
	): PairStart {
		this.prune();
		if (!safe(connectionId) || this.pending.size >= 5) throw new Error("pairing capacity reached");
		const verified = this.registry.getAuthenticatedPrincipal(connectionId, issuer.deviceId);
		if (!verified || verified.epoch !== issuer.epoch || verified.identityKey !== issuer.identityKey)
			throw new Error("pairing issuer denied");
		const code = digits(this.random, 6);
		const expiresAt = this.now() + Math.min(Math.max(ttlMs, 1), 120_000);
		this.pending.set(code, {
			issuerId: connectionId,
			issuer,
			code,
			expiresAt,
			allowed: caps(allowedCapabilities),
			attempts: 0,
		});
		return { code, expiresAt };
	}
	complete(
		connectionId: string,
		code: string,
		identity: RemotePeerIdentity,
		metadata: DeviceMetadata,
		requestedCapabilities: readonly Capability[],
		issuer: PairingIssuer,
	) {
		this.prune();
		const key = `${connectionId}:${issuer.deviceId}`;
		const now = this.now();
		const bucket = this.failedAttempts.get(key);
		const attempts = bucket && bucket.expiresAt > now ? bucket.count + 1 : 1;
		this.failedAttempts.set(key, { count: attempts, expiresAt: now + 120_000 });
		const verified = this.registry.getAuthenticatedPrincipal(connectionId, issuer.deviceId);
		const canonical = canonicalIdentity(identity);
		const match = [...this.pending.values()].find(entry => {
			const left = Buffer.from(entry.code);
			const right = Buffer.from(code);
			return left.length === right.length && timingSafeEqual(left, right);
		});
		if (
			!verified ||
			verified.epoch !== issuer.epoch ||
			verified.identityKey !== issuer.identityKey ||
			canonical !== issuer.identityKey ||
			!match ||
			match.issuerId !== connectionId ||
			match.expiresAt <= now ||
			match.attempts >= 5 ||
			attempts > 5 ||
			match.issuer.deviceId !== issuer.deviceId ||
			match.issuer.epoch !== issuer.epoch ||
			match.issuer.identityKey !== issuer.identityKey
		)
			throw new Error("pairing denied");
		match.attempts += 1;
		this.failedAttempts.delete(key);
		this.pending.delete(match.code);
		const granted = requestedCapabilities.filter(value => match.allowed.includes(value) && isCapability(value));
		const token = b64(this.random.bytes(32));
		const deviceId = b64(this.random.bytes(12));
		const tokenExpiresAt = now + 90 * 24 * 60 * 60 * 1000;
		this.registry.create(
			{
				deviceId,
				identityKey: canonical,
				capabilities: caps(granted),
				metadata,
				createdAt: now,
				lastSeenAt: now,
				tokenExpiresAt,
				revokedAt: null,
				epoch: 0,
			},
			token,
		);
		return { deviceId, token, tokenExpiresAt };
	}
	private prune() {
		const now = this.now();
		for (const [code, entry] of this.pending)
			if (entry.expiresAt <= now || entry.attempts >= 5) this.pending.delete(code);
		for (const [key, bucket] of this.failedAttempts) if (bucket.expiresAt <= now) this.failedAttempts.delete(key);
		while (this.failedAttempts.size > 2048) this.failedAttempts.delete(this.failedAttempts.keys().next().value ?? "");
	}
}
export interface LocalPairingTicket {
	readonly code: string;
	readonly expiresAt: number;
}
export interface LocalPairingResult {
	readonly deviceId: string;
	readonly token: string;
	readonly tokenExpiresAt: number;
	readonly capabilities: readonly Capability[];
}
export class LocalPairingTicketIssuer {
	private readonly key: Uint8Array;
	private readonly pending = new Map<
		string,
		{ digest: Buffer; expiresAt: number; nodeId?: string; allowed: readonly Capability[]; attempts: number }
	>();
	private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly registry: DeviceRegistry,
		key: Uint8Array,
		private readonly clock: Clock = realClock,
		private readonly random: Random = realRandom,
	) {
		if (key.byteLength < 32) throw new Error("local pairing key is too short");
		this.key = new Uint8Array(key);
	}
	private now(): number {
		const value = this.clock.now();
		if (!Number.isFinite(value)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, value);
		return this.lastNow;
	}
	issue(allowedCapabilities: readonly Capability[], ttlMs = 120_000, nodeId?: string): LocalPairingTicket {
		const allowed = caps(allowedCapabilities);
		if (
			allowed.length === 0 ||
			!Number.isSafeInteger(ttlMs) ||
			ttlMs <= 0 ||
			ttlMs > 600_000 ||
			(nodeId !== undefined && !safe(nodeId))
		)
			throw new Error("local pairing ticket invalid");
		const now = this.now();
		const code = digits(this.random, 6);
		const digest = createHmac("sha256", this.key).update("local-pair-code\0").update(code).digest();
		this.pending.set(digest.toString("hex"), {
			digest,
			expiresAt: now + ttlMs,
			...(nodeId ? { nodeId } : {}),
			allowed,
			attempts: 0,
		});
		return { code, expiresAt: now + ttlMs };
	}
	consume(
		code: string,
		identity: RemotePeerIdentity,
		deviceId: string,
		metadata: DeviceMetadata,
		requestedCapabilities: readonly Capability[],
	): LocalPairingResult {
		if (!/^\d{6}$/u.test(code) || !safe(deviceId) || !safe(metadata.label)) throw new Error("pairing denied");
		const now = this.now();
		const failure = this.failures.get(identity.nodeId);
		if (failure && failure.blockedUntil > now) throw new Error("pairing denied");
		const expected = createHmac("sha256", this.key).update("local-pair-code\0").update(code).digest();
		const match = [...this.pending.values()].find(
			entry => entry.digest.length === expected.length && timingSafeEqual(entry.digest, expected),
		);
		const denied = (): never => {
			const count = (failure?.count ?? 0) + 1;
			this.failures.set(identity.nodeId, { count, blockedUntil: count >= 5 ? now + 30_000 : now });
			throw new Error("pairing denied");
		};
		if (
			!match ||
			match.expiresAt <= now ||
			(match.nodeId !== undefined && match.nodeId !== identity.nodeId) ||
			match.attempts >= 5
		)
			return denied();
		match.attempts += 1;
		const requested = caps(requestedCapabilities);
		const granted = requested.filter(capability => match.allowed.includes(capability));
		if (granted.length === 0) return denied();
		if (this.registry.get(deviceId)) return denied();
		const token = b64(this.random.bytes(32));
		const tokenExpiresAt = now + 90 * 24 * 60 * 60 * 1000;
		const identityKey = JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]);
		this.registry.create(
			{
				deviceId,
				identityKey,
				capabilities: granted,
				metadata,
				createdAt: now,
				lastSeenAt: now,
				tokenExpiresAt,
				revokedAt: null,
				epoch: 0,
			},
			token,
		);
		this.pending.delete(match.digest.toString("hex"));
		this.failures.delete(identity.nodeId);
		return { deviceId, token, tokenExpiresAt, capabilities: granted };
	}
}

export interface AuthorizationRequest {
	readonly principal: AuthenticatedPrincipal;
	readonly command: string;
	readonly capabilities: readonly Capability[];
	readonly connectionId: string;
	readonly sessionId?: string;
	readonly revision?: string;
	readonly leaseId?: string;
	readonly confirmationId?: string;
	readonly args: Record<string, unknown>;
}
export interface AuthorizationGuard {
	authorize(request: AuthorizationRequest): void;
}

export type LeaseKind = "controller" | "prompt";
export class DefaultAuthorizationGuard implements AuthorizationGuard {
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly registry: DeviceRegistry,
		private readonly leases?: LeaseRegistry,
		private readonly confirmations?: SecureConfirmationStore,
		private readonly clock: Clock = realClock,
		private readonly revisionResolver?: (request: AuthorizationRequest) => string | undefined,
	) {
		if (registry.onInvalidation)
			registry.onInvalidation(deviceId => {
				leases?.invalidateDevice(deviceId);
				confirmations?.invalidateDevice(deviceId);
			});
	}
	authorize(request: AuthorizationRequest): void {
		const descriptor: CommandDescriptor | undefined = COMMAND_DESCRIPTORS[request.command];
		const verified = this.registry.getAuthenticatedPrincipal(request.connectionId, request.principal.deviceId);
		const current = verified ? this.registry.get(verified.deviceId) : null;
		const rawNow = this.clock.now();
		if (!Number.isFinite(rawNow)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, rawNow);
		const now = this.lastNow;
		const liveRevision = this.revisionResolver?.(request);
		const leaseCommand =
			request.command === "session.fast.set" ||
			[
				"session.prompt",
				"session.steer",
				"session.followUp",
				"session.ui.respond",
				"session.rename",
				"session.retry",
				"session.compact",
				"session.pause",
				"session.resume",
				"session.model.set",
				"session.thinking.set",
				"session.mode.set",
				"session.cancel",
				"session.close",
				"controller.lease.renew",
				"controller.lease.release",
				"prompt.lease.renew",
				"prompt.lease.release",
			].includes(request.command);
		if (
			!descriptor ||
			!verified ||
			!current ||
			current.tokenExpiresAt <= now ||
			(descriptor.revision === "required" &&
				(!this.revisionResolver || liveRevision === undefined || request.revision !== liveRevision)) ||
			verified.connectionId !== request.connectionId ||
			current.epoch !== verified.epoch ||
			current.identityKey !== verified.identityKey ||
			current.revokedAt !== null ||
			verified.revokedAt !== null ||
			!verified.capabilities.includes(descriptor.capability) ||
			!request.capabilities.includes(descriptor.capability)
		) {
			if (current && current.tokenExpiresAt <= now && current.revokedAt === null)
				this.registry.revoke(current.deviceId, now);
			throw new Error("command denied");
		}
		if (
			leaseCommand &&
			(!request.sessionId ||
				!request.leaseId ||
				!this.leases?.verify(
					request.leaseId,
					verified.deviceId,
					request.connectionId,
					request.sessionId,
					request.command,
					verified.epoch,
					liveRevision,
				))
		)
			throw new Error("session lease required");
		if (descriptor.revision === "required" && request.revision === undefined) throw new Error("revision required");
		if (descriptor.confirmation === "challenge") {
			if (
				!request.confirmationId ||
				!this.confirmations ||
				(descriptor.scope === "session" && !request.sessionId) ||
				(descriptor.revision === "required" && request.revision === undefined)
			)
				throw new Error("confirmation required");
			this.confirmations.consume(request.confirmationId, {
				connectionId: request.connectionId,
				deviceId: verified.deviceId,
				command: request.command,
				sessionId: request.sessionId ?? "",
				argsDigest: argsDigest(request.args),
				revision: request.revision ?? "",
				epoch: verified.epoch,
			});
		}
	}
}
export interface Lease {
	readonly leaseId: string;
	readonly owner: string;
	readonly deviceId: string;
	readonly connectionId: string;
	readonly sessionId: string;
	readonly kind: LeaseKind;
	readonly expiresAt: number;
	readonly epoch: number;
	readonly revision?: string;
}
export class LeaseRegistry {
	private readonly leases = new Map<string, Lease>();
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly clock: Clock = realClock,
		private readonly random: Random = realRandom,
	) {}
	private now() {
		const value = this.clock.now();
		if (!Number.isFinite(value)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, value);
		return this.lastNow;
	}
	private commandAllowed(kind: LeaseKind, command: string) {
		return kind === "controller"
			? command === "session.fast.set" ||
					[
						"controller.lease.renew",
						"controller.lease.release",
						"session.prompt",
						"session.steer",
						"session.followUp",
						"session.ui.respond",
						"session.close",
						"session.cancel",
						"session.rename",
						"session.retry",
						"session.compact",
						"session.pause",
						"session.resume",
						"session.model.set",
						"session.thinking.set",
						"session.mode.set",
						"files.write",
						"files.patch",
						"review.apply",
						"bash.run",
						"agent.cancel",
						"preview.launch",
						"preview.navigate",
					].includes(command)
			: [
					"prompt.lease.renew",
					"prompt.lease.release",
					"session.prompt",
					"session.steer",
					"session.followUp",
					"session.ui.respond",
				].includes(command);
	}
	acquire(
		deviceId: string,
		connectionId: string,
		sessionId: string,
		kind: LeaseKind,
		ttlMs = 30_000,
		epoch = 0,
		revision?: string,
	): Lease {
		this.expire();
		if (
			!safe(deviceId) ||
			!safe(connectionId) ||
			!safe(sessionId) ||
			ttlMs <= 0 ||
			ttlMs > 300_000 ||
			[...this.leases.values()].some(x => x.sessionId === sessionId && x.kind === kind)
		)
			throw new Error("lease held");
		const lease = {
			leaseId: b64(this.random.bytes(12)),
			owner: `${deviceId}:${connectionId}`,
			deviceId,
			connectionId,
			sessionId,
			kind,
			expiresAt: this.now() + ttlMs,
			epoch,
			...(revision ? { revision } : {}),
		};
		this.leases.set(lease.leaseId, lease);
		return lease;
	}
	renew(
		leaseId: string,
		deviceId: string,
		connectionId: string,
		ttlMs: number,
		epoch: number | undefined,
		revision: string | undefined,
		command: string,
	): Lease {
		this.expire();
		const old = this.leases.get(leaseId);
		if (
			!old ||
			old.deviceId !== deviceId ||
			old.connectionId !== connectionId ||
			!this.commandAllowed(old.kind, command) ||
			(epoch !== undefined && old.epoch !== epoch) ||
			(revision !== undefined && old.revision !== revision) ||
			ttlMs <= 0 ||
			ttlMs > 300_000
		)
			throw new Error("lease denied");
		const next = { ...old, expiresAt: this.now() + ttlMs };
		this.leases.set(leaseId, next);
		return next;
	}
	verify(
		leaseId: string,
		deviceId: string,
		connectionId: string,
		sessionId: string,
		command: string,
		epoch?: number,
		revision?: string,
	): boolean {
		this.expire();
		const lease = this.leases.get(leaseId);
		return (
			lease !== undefined &&
			lease.deviceId === deviceId &&
			lease.connectionId === connectionId &&
			lease.sessionId === sessionId &&
			(epoch === undefined || lease.epoch === epoch) &&
			(revision === undefined || lease.revision === revision) &&
			this.commandAllowed(lease.kind, command)
		);
	}
	release(
		leaseId: string,
		deviceId: string,
		connectionId: string,
		epoch: number | undefined,
		revision: string | undefined,
		command: string,
	): void {
		const old = this.leases.get(leaseId);
		if (
			old?.deviceId === deviceId &&
			old.connectionId === connectionId &&
			this.commandAllowed(old.kind, command) &&
			(epoch === undefined || old.epoch === epoch) &&
			(revision === undefined || old.revision === revision)
		)
			this.leases.delete(leaseId);
	}
	disconnect(deviceId: string, connectionId?: string) {
		for (const [id, lease] of this.leases)
			if (lease.deviceId === deviceId && (connectionId === undefined || lease.connectionId === connectionId))
				this.leases.delete(id);
	}
	invalidateDevice(deviceId: string) {
		this.disconnect(deviceId);
	}
	private expire() {
		const now = this.now();
		for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
	}
}

export interface ConfirmationGrant {
	readonly id: string;
	readonly connectionId: string;
	readonly deviceId: string;
	readonly command: string;
	readonly sessionId: string;
	readonly argsDigest: string;
	readonly revision: string;
	readonly epoch: number;
	readonly expiresAt: number;
}
const canonicalArgs = (value: unknown, seen = new WeakSet<object>(), depth = 0): string => {
	if (depth > 16) throw new Error("args too deep");
	if (value === undefined) throw new Error("undefined args");
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("nonfinite args");
		return Object.is(value, -0) ? "-0" : String(value);
	}
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value !== "object") throw new Error("unsupported args");
	if (seen.has(value)) throw new Error("args cycle");
	seen.add(value);
	let result: string;
	if (Array.isArray(value)) result = `[${value.map(entry => canonicalArgs(entry, seen, depth + 1)).join(",")}]`;
	else
		result = `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalArgs(entry, seen, depth + 1)}`)
			.join(",")}}`;
	seen.delete(value);
	return result;
};
export const argsDigest = (args: Record<string, unknown>): string =>
	createHash("sha256").update(canonicalArgs(args)).digest("hex");
interface Bucket {
	tokens: number;
	at: number;
}
export class TokenBucketLimiter {
	private readonly buckets = new Map<string, Bucket>();
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly capacity = 30,
		private readonly refillPerSecond = 10,
		private readonly clock: Clock = realClock,
	) {}
	private allow(key: string, cost = 1): boolean {
		if (!safe(key) || !Number.isFinite(cost) || cost <= 0 || cost > this.capacity) return false;
		const rawNow = this.clock.now();
		if (!Number.isFinite(rawNow)) return false;
		this.lastNow = Math.max(this.lastNow, rawNow);
		const now = this.lastNow;
		const old = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
		const elapsed = Math.max(0, now - old.at);
		const tokens = Math.min(this.capacity, old.tokens + (elapsed / 1000) * this.refillPerSecond);
		if (tokens < cost) {
			this.buckets.set(key, { tokens, at: now });
			return false;
		}
		this.buckets.set(key, { tokens: tokens - cost, at: now });
		if (this.buckets.size > 2048) this.buckets.delete(this.buckets.keys().next().value ?? key);
		return true;
	}
	allowAuthenticated(
		principal: AuthenticatedPrincipal,
		identity: RemotePeerIdentity,
		sourceAddress: string,
		cost = 1,
	): boolean {
		let identityKey: string;
		const sourceIp = normalizeSourceIp(sourceAddress);
		try {
			identityKey = canonicalIdentity(identity);
		} catch {
			return false;
		}
		if (
			!sourceIp ||
			principal.identityKey !== identityKey ||
			!safe(principal.deviceId) ||
			!safe(principal.connectionId)
		)
			return false;
		return this.allow(
			JSON.stringify(["authenticated", principal.deviceId, principal.connectionId, identityKey, sourceIp]),
			cost,
		);
	}
	allowPairing(identity: RemotePeerIdentity, sourceAddress: string, cost = 1): boolean {
		let identityKey: string;
		const sourceIp = normalizeSourceIp(sourceAddress);
		try {
			identityKey = canonicalIdentity(identity);
		} catch {
			return false;
		}
		if (!sourceIp) return false;
		return this.allow(JSON.stringify(["pairing", identityKey, sourceIp]), cost);
	}
	allowUnauthenticatedPairing(identity: RemotePeerIdentity, sourceAddress: string, cost = 1): boolean {
		return this.allowPairing(identity, sourceAddress, cost);
	}
}
export class SecureConfirmationStore {
	private readonly grants = new Map<string, ConfirmationGrant>();
	private lastNow = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly clock: Clock = realClock,
		private readonly random: Random = realRandom,
	) {}
	private now() {
		const value = this.clock.now();
		if (!Number.isFinite(value)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, value);
		return this.lastNow;
	}
	issue(input: Omit<ConfirmationGrant, "id" | "expiresAt">, ttlMs = 60_000): ConfirmationGrant {
		this.prune();
		if (this.grants.size >= 5 || ttlMs <= 0) throw new Error("confirmation capacity");
		const grant = { ...input, id: b64(this.random.bytes(12)), expiresAt: this.now() + Math.min(ttlMs, 60_000) };
		this.grants.set(grant.id, grant);
		return grant;
	}
	consume(id: string, expected: Omit<ConfirmationGrant, "id" | "expiresAt">): void {
		const grant = this.grants.get(id);
		const now = this.now();
		if (
			!grant ||
			grant.expiresAt <= now ||
			grant.connectionId !== expected.connectionId ||
			grant.deviceId !== expected.deviceId ||
			grant.command !== expected.command ||
			grant.sessionId !== expected.sessionId ||
			grant.argsDigest !== expected.argsDigest ||
			grant.revision !== expected.revision ||
			grant.epoch !== expected.epoch
		)
			throw new Error("confirmation denied");
		if (this.grants.get(id) !== grant) throw new Error("confirmation denied");
		this.grants.delete(id);
	}
	invalidateDevice(deviceId: string): void {
		for (const [id, grant] of this.grants) if (grant.deviceId === deviceId) this.grants.delete(id);
	}
	private prune() {
		const now = this.now();
		for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
	}
}
export interface OutboundMessage {
	readonly kind: "event" | "result" | "error" | "confirmation" | "lease" | "revoke" | "terminal";
	readonly payload: unknown;
	readonly coalesceKey?: string;
}
export class OutboundQueue {
	private readonly items: OutboundMessage[] = [];
	private bytes = 0;
	private closed = false;
	constructor(
		private readonly hardCap = 1_048_576,
		private readonly hardCount = 1024,
	) {}
	push(item: OutboundMessage): void {
		if (this.closed) throw new Error("queue closed");
		let encoded: string;
		try {
			encoded = JSON.stringify(item);
		} catch {
			this.closed = true;
			throw new Error("outbound payload invalid");
		}
		if (encoded === undefined) {
			this.closed = true;
			throw new Error("outbound payload invalid");
		}
		const next = JSON.parse(encoded) as OutboundMessage;
		const bytes = Buffer.byteLength(encoded);
		if (bytes > this.hardCap || (this.items.length >= this.hardCount && !this.items.some(x => x.kind === "event"))) {
			this.closed = true;
			throw new Error("outbound queue hard cap");
		}
		if (item.kind === "event" && item.coalesceKey) {
			const index = this.items.findIndex(x => x.kind === "event" && x.coalesceKey === item.coalesceKey);
			if (index >= 0) {
				const oldBytes = Buffer.byteLength(JSON.stringify(this.items[index]));
				if (this.bytes - oldBytes + bytes > this.hardCap) {
					this.closed = true;
					throw new Error("outbound queue hard cap");
				}
				this.bytes -= oldBytes;
				this.items[index] = next;
				this.bytes += bytes;
				return;
			}
		}
		while (this.bytes + bytes > this.hardCap || this.items.length >= this.hardCount) {
			const index = this.items.findIndex(x => x.kind === "event");
			if (index < 0) {
				this.closed = true;
				throw new Error("outbound queue hard cap");
			}
			this.bytes -= Buffer.byteLength(JSON.stringify(this.items[index]));
			this.items.splice(index, 1);
		}
		this.items.push(next);
		this.bytes += bytes;
	}
	shift(): OutboundMessage | undefined {
		const item = this.items.shift();
		if (item) this.bytes -= Buffer.byteLength(JSON.stringify(item));
		return item;
	}
	drain(): readonly OutboundMessage[] {
		const values = [...this.items];
		this.items.length = 0;
		this.bytes = 0;
		return values;
	}
	close(): void {
		this.closed = true;
		this.items.length = 0;
		this.bytes = 0;
	}
	get sizeBytes() {
		return this.bytes;
	}
	get isClosed() {
		return this.closed;
	}
}
export interface Redactor {
	redact(value: unknown): unknown;
}
export class DefaultRedactor implements Redactor {
	redact(value: unknown): unknown {
		const seen = new WeakSet<object>();
		const walk = (input: unknown, depth: number): unknown => {
			if (depth > 12) return "[redacted]";
			if (Array.isArray(input)) {
				if (seen.has(input)) return "[redacted]";
				seen.add(input);
				return input.slice(0, 128).map(x => walk(x, depth + 1));
			}
			if (input && typeof input === "object") {
				if (seen.has(input)) return "[redacted]";
				seen.add(input);
				const out: Record<string, unknown> = {};
				for (const [key, raw] of Object.entries(input).slice(0, 128)) {
					const normalizedKey = key.normalize("NFKC");
					out[key] = /secret|token|auth|password|cookie|credential|private|session|api[-_]?key/iu.test(
						normalizedKey,
					)
						? "[redacted]"
						: walk(raw, depth + 1);
				}
				return out;
			}
			if (typeof input === "string") {
				const normalized = input.normalize("NFKC");
				if (
					/bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]+PRIVATE KEY-----|[A-Za-z0-9_-]{32,}/iu.test(
						normalized,
					)
				)
					return "[redacted]";
			}
			return input;
		};
		return walk(value, 0);
	}
}
export interface AuditSink {
	write(event: Record<string, unknown>): Promise<void>;
}
type AuditLockRecord = {
	readonly pid: number;
	readonly ownerId: string;
	readonly processStart: string;
	readonly createdAt: number;
};
type FileIdentity = { readonly dev: number; readonly ino: number };
const auditLockRecord = (value: unknown): AuditLockRecord | null => {
	const row = recordValue(value);
	if (
		!row ||
		Object.keys(row).length !== 4 ||
		!Object.keys(row).every(key => ["pid", "ownerId", "processStart", "createdAt"].includes(key))
	)
		return null;
	if (
		!Number.isInteger(row.pid) ||
		(row.pid as number) <= 0 ||
		!safe(row.ownerId, 128) ||
		!safe(row.processStart, 128) ||
		typeof row.createdAt !== "number" ||
		!Number.isInteger(row.createdAt)
	)
		return null;
	return {
		pid: row.pid as number,
		ownerId: row.ownerId as string,
		processStart: row.processStart as string,
		createdAt: row.createdAt,
	};
};
const processStartToken = async (pid: number): Promise<string | null> => {
	try {
		const text = await readFile(`/proc/${pid}/stat`, "utf8");
		const close = text.lastIndexOf(")");
		const fields =
			close < 0
				? []
				: text
						.slice(close + 2)
						.trim()
						.split(/\s+/u);
		return safe(fields[19] ?? null, 128);
	} catch {
		return null;
	}
};
const fileIdentity = (value: { dev: number; ino: number }): FileIdentity => ({ dev: value.dev, ino: value.ino });
const sameFile = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;
const syncDirectory = async (path: string): Promise<void> => {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
};
const errorCode = (error: unknown): string | undefined =>
	error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
const ownerAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
};

export class JsonlAuditSink implements AuditSink {
	private static readonly owners = new Set<string>();
	private readonly ownerId = randomBytes(16).toString("hex");
	private writing: Promise<void> = Promise.resolve();
	private disposing: Promise<void> | undefined;
	private disposed = false;
	constructor(
		private readonly path: string,
		private readonly redactor: Redactor = new DefaultRedactor(),
		private readonly maxBytes = 1_048_576,
	) {
		if (JsonlAuditSink.owners.has(path)) throw new Error("audit writer already owned");
		JsonlAuditSink.owners.add(path);
	}
	private async recoverStale(lockPath: string): Promise<boolean> {
		const before = await lstat(lockPath).catch(() => null);
		if (!before?.isFile()) return false;
		let record: AuditLockRecord | null = null;
		try {
			record = auditLockRecord(JSON.parse(await readFile(lockPath, "utf8")));
		} catch {
			return false;
		}
		if (!record) return false;
		const observedStart = await processStartToken(record.pid);
		const live = ownerAlive(record.pid);
		if (
			live &&
			(record.processStart === "unknown" || observedStart === null || observedStart === record.processStart)
		)
			return false;
		const latest = await lstat(lockPath).catch(() => null);
		if (!latest?.isFile() || !sameFile(fileIdentity(before), fileIdentity(latest))) return false;
		await unlink(lockPath);
		await syncDirectory(dirname(lockPath));
		return true;
	}
	private async acquireLock(
		lockPath: string,
	): Promise<{ readonly record: AuditLockRecord; readonly identity: FileIdentity }> {
		const parentPath = dirname(lockPath);
		const processStart = (await processStartToken(process.pid)) ?? "unknown";
		const record: AuditLockRecord = { pid: process.pid, ownerId: this.ownerId, processStart, createdAt: Date.now() };
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const tempPath = `${lockPath}.tmp-${this.ownerId}-${randomBytes(8).toString("hex")}`;
			let temp: FileHandle | undefined;
			try {
				temp = await open(tempPath, "wx", 0o600);
				await temp.write(JSON.stringify(record), undefined, "utf8");
				await temp.sync();
				await temp.close();
				temp = undefined;
				await link(tempPath, lockPath);
				await syncDirectory(parentPath);
				await unlink(tempPath);
				const published = await lstat(lockPath);
				if (!published.isFile()) throw new Error("audit lock invalid");
				return { record, identity: fileIdentity(published) };
			} catch (error) {
				if (temp) await temp.close().catch(() => undefined);
				await unlink(tempPath).catch(() => undefined);
				if (errorCode(error) !== "EEXIST" || !(await this.recoverStale(lockPath)))
					throw new Error("audit writer busy");
			}
		}
		throw new Error("audit writer busy");
	}
	private async releaseLock(
		lockPath: string,
		lock: { readonly record: AuditLockRecord; readonly identity: FileIdentity },
	): Promise<void> {
		const current = await lstat(lockPath).catch(() => null);
		if (!current?.isFile() || !sameFile(lock.identity, fileIdentity(current))) return;
		let record: AuditLockRecord | null = null;
		try {
			record = auditLockRecord(JSON.parse(await readFile(lockPath, "utf8")));
		} catch {}
		if (
			!record ||
			record.ownerId !== lock.record.ownerId ||
			record.pid !== lock.record.pid ||
			record.processStart !== lock.record.processStart ||
			record.createdAt !== lock.record.createdAt
		)
			return;
		await unlink(lockPath);
		await syncDirectory(dirname(lockPath));
	}
	write(event: Record<string, unknown>): Promise<void> {
		if (this.disposed || this.disposing) return Promise.reject(new Error("audit writer disposed"));
		const task = async () => {
			if (this.disposed || this.disposing) throw new Error("audit writer disposed");
			const line = JSON.stringify(this.redactor.redact(event));
			if (line === undefined || Buffer.byteLength(line, "utf8") > this.maxBytes)
				throw new Error("audit event too large");
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const parent = await lstat(dirname(this.path));
			if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700)
				throw new Error("audit parent permissions denied");
			const lockPath = `${this.path}.lock`;
			const lock = await this.acquireLock(lockPath);
			try {
				const info = await lstat(this.path).catch(() => null);
				if (info?.isSymbolicLink()) throw new Error("audit symlink rejected");
				if (info && info.size + Buffer.byteLength(line, "utf8") + 1 > this.maxBytes) {
					const rotated = `${this.path}.${Date.now()}-${randomBytes(4).toString("hex")}`;
					await rename(this.path, rotated);
					await chmod(rotated, 0o600);
				}
				const handle = await open(this.path, "a", 0o600);
				try {
					await handle.write(`${line}\n`, undefined, "utf8");
				} finally {
					await handle.close();
				}
				await chmod(this.path, 0o600);
			} finally {
				await this.releaseLock(lockPath, lock);
			}
		};
		this.writing = this.writing.catch(() => undefined).then(task);
		return this.writing;
	}
	async dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposing = (async () => {
			await this.writing.catch(() => undefined);
			this.disposed = true;
			const lockPath = `${this.path}.lock`;
			const current = await lstat(lockPath).catch(() => null);
			if (current?.isFile()) {
				let record: AuditLockRecord | null = null;
				try {
					record = auditLockRecord(JSON.parse(await readFile(lockPath, "utf8")));
				} catch {}
				const currentStart = await processStartToken(process.pid);
				if (
					record &&
					record.ownerId === this.ownerId &&
					record.pid === process.pid &&
					(record.processStart === "unknown" || currentStart === record.processStart)
				) {
					const latest = await lstat(lockPath).catch(() => null);
					if (latest?.isFile() && sameFile(fileIdentity(current), fileIdentity(latest))) {
						await unlink(lockPath);
						await syncDirectory(dirname(lockPath));
					}
				}
			}
			JsonlAuditSink.owners.delete(this.path);
		})();
		return this.disposing;
	}
	async close(): Promise<void> {
		await this.dispose();
	}
}

export { COMMAND_DESCRIPTORS, DEVICE_CAPABILITIES };
