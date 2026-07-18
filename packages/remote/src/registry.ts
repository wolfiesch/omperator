import { isIP } from "node:net";
import { DEVICE_CAPABILITIES, isCapability, type DeviceCapability } from "@t4-code/protocol";

// Node-compatible registry policy belongs here. Platform shells supply the
// persistence and encryption adapters without leaking Electron into this package.

export const REMOTE_TARGET_SCHEMA_VERSION = 1 as const;
export const DEVICE_CREDENTIAL_SCHEMA_VERSION = 1 as const;
export type RemoteTargetMode = "direct" | "serve";
export type RemoteTargetStatus = "unknown" | "online" | "offline" | "revoked";

export interface RemoteTargetRecord {
  readonly targetId: string;
  readonly label: string;
  readonly mode: RemoteTargetMode;
  readonly address: string;
  readonly port: number;
  readonly expectedHostId?: string;
  readonly deviceId?: string;
  readonly requestedCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly lastSeen?: number;
  readonly status: RemoteTargetStatus;
  readonly autoConnect?: boolean;
}

export interface PublicRemoteTarget extends RemoteTargetRecord {}

export interface RemoteTargetStore {
  read(): unknown | Promise<unknown>;
  write(value: unknown): void | Promise<void>;
}

export interface RemoteTargetRegistry {
  list(): Promise<readonly PublicRemoteTarget[]>;
  get(targetId: string): Promise<PublicRemoteTarget | null>;
  put(target: RemoteTargetRecord): Promise<void>;
  remove(targetId: string): Promise<void>;
}

export interface CredentialStore {
  withCredential<T>(targetId: string, provider: CredentialAuthProvider<T>): T;
  set(targetId: string, credential: DeviceCredential): Promise<void>;
  revoke(targetId: string): Promise<void>;
}

export interface CredentialCiphertextStore {
  read(): unknown | Promise<unknown>;
  write(value: unknown): void | Promise<void>;
}

export interface SafeStorageAdapter {
  readonly isEncryptionAvailable: () => boolean;
  readonly selectedStorageBackend?: () => string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DeviceCredential {
  readonly token: string;
  readonly deviceId: string;
}

export interface CredentialAuthProvider<T> {
  (credential: DeviceCredential): T;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAGIC_DNS =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const MAX_CIPHERTEXT = 16_384;

type UnknownRecord = Record<string, unknown>;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid persisted remote state");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("invalid persisted remote state");
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("invalid persisted remote state");
}

function requiredText(value: unknown, name: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacter(value)
  )
    throw new Error(`invalid ${name}`);
  return value;
}

function targetId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_ID.test(value) ||
    value === "local" ||
    value.startsWith("local:")
  )
    throw new Error("invalid remote target id");
  return value;
}

function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 128 ||
    hasControlCharacter(value.trim())
  )
    throw new Error("invalid remote target label");
  return value.trim();
}

function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error("invalid remote port");
  return value;
}

function capabilities(value: unknown): readonly DeviceCapability[] {
  if (!Array.isArray(value)) throw new Error("invalid capabilities");
  return value.map((item) => {
    if (typeof item !== "string" || !isCapability(item) || !DEVICE_CAPABILITIES.includes(item))
      throw new Error("invalid capability");
    return item;
  });
}

function ipAddress(value: string): string | null {
  const normalized = value.toLowerCase();
  const kind = isIP(normalized);
  if (kind === 4) {
    const octets = normalized.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    if (
      first !== undefined &&
      second !== undefined &&
      first === 100 &&
      second >= 64 &&
      second <= 127
    )
      return normalized;
    return null;
  }
  if (kind !== 6) return null;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped !== undefined) return ipAddress(mapped);
  const compact = normalized
    .replace(/^\[|\]$/gu, "")
    .split(":")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 16));
  const first = compact.slice(0, 3);
  if (first.length === 3 && first[0] === 0xfd7a && first[1] === 0x115c && first[2] === 0xa1e0)
    return normalized;
  return null;
}

function host(value: string): string {
  const normalized = value.trim().toLowerCase();
  const direct = ipAddress(normalized);
  if (direct !== null) return direct;
  if (
    !MAGIC_DNS.test(normalized) ||
    normalized.endsWith(".local") ||
    !normalized.endsWith(".ts.net")
  )
    throw new Error("remote address must be a Tailscale address");
  return normalized;
}

function serveAddress(value: string, expectedPort: number): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid serve address");
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:")
    throw new Error("serve address must use HTTPS or WSS");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("serve address contains forbidden URL fields");
  host(url.hostname);
  const authorityPort = url.port === "" ? 443 : Number(url.port);
  if (authorityPort !== expectedPort)
    throw new Error("serve address port conflicts with target port");
  return url.toString();
}

export function validateRemoteTarget(input: RemoteTargetRecord): RemoteTargetRecord {
  if (input.mode !== "direct" && input.mode !== "serve")
    throw new Error("invalid remote target mode");
  const requested = capabilities(input.requestedCapabilities);
  const granted = capabilities(input.grantedCapabilities);
  const normalizedAddress =
    input.mode === "serve"
      ? serveAddress(requiredText(input.address, "address", 2048), port(input.port))
      : host(requiredText(input.address, "address"));
  if (input.lastSeen !== undefined && (!Number.isFinite(input.lastSeen) || input.lastSeen < 0))
    throw new Error("invalid lastSeen");
  if (!["unknown", "online", "offline", "revoked"].includes(input.status))
    throw new Error("invalid remote target status");
  if (input.autoConnect !== undefined && typeof input.autoConnect !== "boolean")
    throw new Error("invalid autoConnect");
  return {
    targetId: targetId(input.targetId),
    label: label(input.label),
    mode: input.mode,
    address: normalizedAddress,
    port: port(input.port),
    requestedCapabilities: [...requested],
    grantedCapabilities: [...granted],
    status: input.status,
    ...(input.expectedHostId === undefined
      ? {}
      : { expectedHostId: requiredText(input.expectedHostId, "expected host id") }),
    ...(input.deviceId === undefined
      ? {}
      : { deviceId: requiredText(input.deviceId, "device id") }),
    ...(input.lastSeen === undefined ? {} : { lastSeen: input.lastSeen }),
    ...(input.autoConnect === undefined ? {} : { autoConnect: input.autoConnect }),
  };
}

function decodeTarget(value: unknown): RemoteTargetRecord {
  const item = record(value);
  exactKeys(item, [
    "targetId",
    "label",
    "mode",
    "address",
    "port",
    "expectedHostId",
    "deviceId",
    "requestedCapabilities",
    "grantedCapabilities",
    "lastSeen",
    "status",
    "autoConnect",
  ]);
  const result = {
    targetId: item.targetId,
    label: item.label,
    mode: item.mode,
    address: item.address,
    port: item.port,
    requestedCapabilities: item.requestedCapabilities,
    grantedCapabilities: item.grantedCapabilities,
    status: item.status,
    ...(item.expectedHostId === undefined ? {} : { expectedHostId: item.expectedHostId }),
    ...(item.deviceId === undefined ? {} : { deviceId: item.deviceId }),
    ...(item.lastSeen === undefined ? {} : { lastSeen: item.lastSeen }),
    ...(item.autoConnect === undefined ? {} : { autoConnect: item.autoConnect }),
  };
  return validateRemoteTarget(result as RemoteTargetRecord);
}

function decodeRecords(value: unknown): RemoteTargetRecord[] {
  const root = record(value);
  exactKeys(root, ["version", "records"]);
  if (root.version !== REMOTE_TARGET_SCHEMA_VERSION || !Array.isArray(root.records))
    throw new Error("unsupported remote target store schema");
  return root.records.map(decodeTarget);
}

function cloneTarget(value: RemoteTargetRecord): PublicRemoteTarget {
  return Object.freeze({
    ...value,
    requestedCapabilities: Object.freeze([...value.requestedCapabilities]),
    grantedCapabilities: Object.freeze([...value.grantedCapabilities]),
  });
}

function enqueue(queue: { tail: Promise<void> }, operation: () => Promise<void>): Promise<void> {
  const run = queue.tail.then(operation, operation);
  queue.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readRecords(store: RemoteTargetStore): Promise<RemoteTargetRecord[]> {
  return decodeRecords(await store.read());
}

export class VersionedRemoteTargetRegistry implements RemoteTargetRegistry {
  private readonly store: RemoteTargetStore;
  private readonly queue = { tail: Promise.resolve() };

  constructor(store: RemoteTargetStore) {
    this.store = store;
  }

  list(): Promise<readonly PublicRemoteTarget[]> {
    return this.queueRead(async () => (await readRecords(this.store)).map(cloneTarget));
  }

  get(value: string): Promise<PublicRemoteTarget | null> {
    return this.queueRead(async () => {
      const id = targetId(value);
      const found = (await readRecords(this.store)).find((item) => item.targetId === id);
      return found === undefined ? null : cloneTarget(found);
    });
  }

  put(input: RemoteTargetRecord): Promise<void> {
    return enqueue(this.queue, async () => {
      const next = validateRemoteTarget(input);
      const current = await readRecords(this.store);
      if (
        current.some(
          (item) =>
            item.targetId === next.targetId ||
            (item.address === next.address && item.port === next.port),
        )
      )
        throw new Error("duplicate remote target");
      const previous = { version: REMOTE_TARGET_SCHEMA_VERSION, records: current };
      try {
        await this.store.write({
          version: REMOTE_TARGET_SCHEMA_VERSION,
          records: [...current, next],
        });
      } catch (error) {
        try {
          await this.store.write(previous);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
    });
  }

  remove(value: string): Promise<void> {
    return enqueue(this.queue, async () => {
      const id = targetId(value);
      const current = await readRecords(this.store);
      await this.store.write({
        version: REMOTE_TARGET_SCHEMA_VERSION,
        records: current.filter((item) => item.targetId !== id),
      });
    });
  }

  private queueRead<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.tail.then(operation, operation);
    this.queue.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function decodeCiphertexts(value: unknown): Record<string, string> {
  const root = record(value);
  exactKeys(root, ["version", "ciphertexts"]);
  if (root.version !== DEVICE_CREDENTIAL_SCHEMA_VERSION)
    throw new Error("invalid credential store");
  const ciphertexts = record(root.ciphertexts);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(ciphertexts)) {
    if (
      !OPAQUE_ID.test(key) ||
      typeof raw !== "string" ||
      raw.length > MAX_CIPHERTEXT ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw) ||
      Buffer.from(raw, "base64").toString("base64") !== raw
    )
      throw new Error("invalid credential store");
    result[key] = raw;
  }
  return result;
}

export class DeviceCredentialStore implements CredentialStore {
  private readonly store: CredentialCiphertextStore;
  private readonly safeStorage: SafeStorageAdapter;
  private readonly queue = { tail: Promise.resolve() };

  constructor(store: CredentialCiphertextStore, safeStorage: SafeStorageAdapter) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.selectedStorageBackend?.() === "basic_text"
    )
      throw new Error("encrypted credential storage unavailable");
    this.store = store;
    this.safeStorage = safeStorage;
  }

  set(ref: string, credential: DeviceCredential): Promise<void> {
    return enqueue(this.queue, async () => {
      if (
        !OPAQUE_ID.test(ref) ||
        !TOKEN.test(credential.token) ||
        !OPAQUE_ID.test(credential.deviceId)
      )
        throw new Error("invalid device credential");
      const current = decodeCiphertexts(await this.store.read());
      let ciphertext: string;
      try {
        ciphertext = this.safeStorage.encryptString(JSON.stringify(credential)).toString("base64");
      } catch {
        throw new Error("credential encryption failed");
      }
      if (ciphertext.length > MAX_CIPHERTEXT) throw new Error("credential ciphertext too large");
      await this.store.write({
        version: DEVICE_CREDENTIAL_SCHEMA_VERSION,
        ciphertexts: { ...current, [ref]: ciphertext },
      });
    });
  }

  withCredential<T>(ref: string, provider: CredentialAuthProvider<T>): T {
    if (!OPAQUE_ID.test(ref)) throw new Error("invalid credential reference");
    const raw = this.store.read();
    if (raw instanceof Promise) throw new Error("credential storage is not synchronously readable");
    const encoded = decodeCiphertexts(raw)[ref];
    if (encoded === undefined) throw new Error("credential unavailable");
    let value: unknown;
    try {
      value = JSON.parse(this.safeStorage.decryptString(Buffer.from(encoded, "base64"))) as unknown;
    } catch {
      throw new Error("credential decryption failed");
    }
    const item = record(value);
    exactKeys(item, ["token", "deviceId"]);
    if (
      typeof item.token !== "string" ||
      typeof item.deviceId !== "string" ||
      !TOKEN.test(item.token) ||
      !OPAQUE_ID.test(item.deviceId)
    )
      throw new Error("corrupt device credential");
    const result = provider({ token: item.token, deviceId: item.deviceId });
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    )
      throw new Error("credential provider must be synchronous");
    return result;
  }

  revoke(ref: string): Promise<void> {
    return enqueue(this.queue, async () => {
      if (!OPAQUE_ID.test(ref)) throw new Error("invalid credential reference");
      const current = decodeCiphertexts(await this.store.read());
      delete current[ref];
      await this.store.write({
        version: DEVICE_CREDENTIAL_SCHEMA_VERSION,
        ciphertexts: current,
      });
    });
  }
}
