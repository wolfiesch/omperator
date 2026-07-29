import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import ElectronStore from "electron-store";
import { safeStorage } from "electron";
import {
  decodeProjectionCacheSaveRequestValue,
  MAX_PROJECTION_CACHE_BYTES,
  type ProjectionCacheLoadResult,
  type ProjectionCacheSaveResult,
} from "@t4-code/protocol/desktop-ipc";
import type { CursorRecord, CursorStore } from "@t4-code/client";
import type { CredentialEntry, CredentialVault, PairedHostRecord, TargetRegistry } from "@t4-code/remote";
import type { CredentialCiphertextStore, RemoteTargetRecord, RemoteTargetStore, SafeStorageAdapter } from "./remote-runtime/index.ts";
import {
  DEFAULT_LOCAL_PROFILE,
  decodeLocalProfileState,
  type LocalProfileRegistryState,
  type LocalProfileStore,
} from "./local-profiles.ts";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly deviceName: string;
}
interface CursorState { readonly cursors: Record<string, CursorRecord>; }
interface RegistryState { readonly targets: Record<string, PairedHostRecord>; }
interface VaultState { readonly ciphertext: Record<string, string>; }
interface RemoteRegistryState { readonly version: 1; readonly records: readonly RemoteTargetRecord[]; }
interface CredentialCiphertextState { readonly version: 1; readonly ciphertexts: Record<string, string>; }
interface ProjectionCacheCiphertextState {
  readonly version: 1;
  readonly ciphertext: string | null;
}

function recordKey(hostId: string, sessionId: string): string { return `${hostId}\u0000${sessionId}`; }
function decodeRemoteState(value: unknown): RemoteRegistryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote target state");
  const root = value as { version?: unknown; records?: unknown };
  if (root.version !== 1 || !Array.isArray(root.records) || root.records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) throw new Error("invalid remote target state");
  return { version: 1, records: [...root.records] as RemoteTargetRecord[] };
}
function decodeCredentialState(value: unknown): CredentialCiphertextState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid credential state");
  const root = value as { version?: unknown; ciphertexts?: unknown };
  if (root.version !== 1 || !root.ciphertexts || typeof root.ciphertexts !== "object" || Array.isArray(root.ciphertexts)) throw new Error("invalid credential state");
  const ciphertexts: Record<string, string> = {};
  for (const [key, encoded] of Object.entries(root.ciphertexts)) {
    if (typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("invalid credential state");
    ciphertexts[key] = encoded;
  }
  return { version: 1, ciphertexts };
}
const MAX_PROJECTION_CACHE_CIPHERTEXT_LENGTH =
  4 * Math.ceil((MAX_PROJECTION_CACHE_BYTES + 64) / 3);
function decodeProjectionCacheState(value: unknown): ProjectionCacheCiphertextState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid projection cache state");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "version" && key !== "ciphertext"))
    throw new Error("invalid projection cache state");
  if (root.version !== 1) throw new Error("invalid projection cache state");
  const ciphertext = root.ciphertext;
  if (ciphertext === null) return { version: 1, ciphertext: null };
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length === 0 ||
    ciphertext.length > MAX_PROJECTION_CACHE_CIPHERTEXT_LENGTH ||
    ciphertext.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(ciphertext) ||
    Buffer.from(ciphertext, "base64").toString("base64") !== ciphertext
  )
    throw new Error("invalid projection cache state");
  return { version: 1, ciphertext };
}
function enqueueWrite(queue: { tail: Promise<void> }, operation: () => void): Promise<void> {
  const result = queue.tail.then(operation, operation);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

export class ElectronCursorStore implements CursorStore {
  private readonly store: ElectronStore<CursorState>;
  constructor(store = new ElectronStore<CursorState>({ name: "cursor-state", defaults: { cursors: {} } })) { this.store = store; }
  load(): CursorRecord[] { return Object.values(this.store.get("cursors")); }
  save(record: CursorRecord): void {
    const cursors = this.store.get("cursors");
    this.store.set("cursors", { ...cursors, [recordKey(record.hostId, record.sessionId)]: record });
  }
}

export class ElectronTargetRegistry implements TargetRegistry {
  private readonly store: ElectronStore<RegistryState>;
  constructor(store = new ElectronStore<RegistryState>({ name: "target-registry", defaults: { targets: {} } })) { this.store = store; }
  async get(targetId: string): Promise<PairedHostRecord | null> { return this.store.get("targets")[targetId] ?? null; }
  async put(record: PairedHostRecord): Promise<void> { this.store.set("targets", { ...this.store.get("targets"), [record.targetId]: record }); }
  async delete(targetId: string): Promise<void> {
    const targets = { ...this.store.get("targets") };
    delete targets[targetId];
    this.store.set("targets", targets);
  }
}

export class EncryptedCredentialVault implements CredentialVault {
  private readonly store: ElectronStore<VaultState>;
  constructor(store = new ElectronStore<VaultState>({ name: "credential-vault", defaults: { ciphertext: {} } })) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage is unavailable");
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("encrypted credential storage backend is unsafe");
    this.store = store;
  }
  async get(credentialRef: string): Promise<CredentialEntry | null> {
    const encoded = this.store.get("ciphertext")[credentialRef];
    if (encoded === undefined) return null;
    let value: unknown;
    try { value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64"))) as unknown; } catch { throw new Error("encrypted credential could not be decrypted"); }
    if (!value || typeof value !== "object") throw new Error("encrypted credential is invalid");
    const entry = value as { token?: unknown; expiresAt?: unknown };
    if (typeof entry.token !== "string" || typeof entry.expiresAt !== "string" && typeof entry.expiresAt !== "number") throw new Error("encrypted credential is invalid");
    const expiry = typeof entry.expiresAt === "number" ? entry.expiresAt : Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) { await this.delete(credentialRef); return null; }
    return { token: entry.token, expiresAt: entry.expiresAt };
  }
  async set(credentialRef: string, credential: string | CredentialEntry): Promise<void> {
    if (typeof credential === "string") throw new Error("credential expiry is required");
    const expiry = typeof credential.expiresAt === "number" ? credential.expiresAt : Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || credential.token.length === 0) throw new Error("credential expiry is invalid");
    const cleartext = JSON.stringify({ token: credential.token, expiresAt: credential.expiresAt });
    const encrypted = safeStorage.encryptString(cleartext).toString("base64");
    this.store.set("ciphertext", { ...this.store.get("ciphertext"), [credentialRef]: encrypted });
  }
  async delete(credentialRef: string): Promise<void> {
    const values = { ...this.store.get("ciphertext") };
    delete values[credentialRef];
    this.store.set("ciphertext", values);
  }
}

export class ElectronRemoteTargetStore implements RemoteTargetStore {
  private readonly store: ElectronStore<RemoteRegistryState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(store = new ElectronStore<RemoteRegistryState>({ name: "remote-target-registry", defaults: { version: 1, records: [] } })) { this.store = store; }
  read(): RemoteRegistryState { return decodeRemoteState(this.store.store); }
  write(value: unknown): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeRemoteState(value);
      this.store.set("version", state.version);
      this.store.set("records", state.records);
    });
  }
}

export class ElectronCredentialCiphertextStore implements CredentialCiphertextStore {
  private readonly store: ElectronStore<CredentialCiphertextState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(store = new ElectronStore<CredentialCiphertextState>({ name: "device-credentials", defaults: { version: 1, ciphertexts: {} } })) { this.store = store; }
  read(): CredentialCiphertextState { return decodeCredentialState(this.store.store); }
  write(value: unknown): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeCredentialState(value);
      this.store.set("version", state.version);
      this.store.set("ciphertexts", state.ciphertexts);
    });
  }
}

export class ElectronProjectionCacheStore {
  private readonly store: ElectronStore<ProjectionCacheCiphertextState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  private readonly safeStorage: SafeStorageAdapter;
  constructor(
    store = new ElectronStore<ProjectionCacheCiphertextState>({
      name: "projection-cache",
      defaults: { version: 1, ciphertext: null },
    }),
    safeStorage: SafeStorageAdapter = electronSafeStorage,
  ) {
    this.store = store;
    this.safeStorage = safeStorage;
  }
  load(): ProjectionCacheLoadResult {
    if (!this.safeStorage.isEncryptionAvailable()) return { available: false, value: null };
    let state: ProjectionCacheCiphertextState;
    try {
      state = decodeProjectionCacheState(this.store.store);
    } catch {
      this.clear();
      return { available: true, value: null };
    }
    if (state.ciphertext === null) return { available: true, value: null };
    try {
      const value = this.safeStorage.decryptString(Buffer.from(state.ciphertext, "base64"));
      decodeProjectionCacheSaveRequestValue(value);
      return { available: true, value };
    } catch {
      this.clear();
      return { available: true, value: null };
    }
  }
  save(value: string): Promise<ProjectionCacheSaveResult> {
    try {
      decodeProjectionCacheSaveRequestValue(value);
    } catch {
      return Promise.resolve({ saved: false });
    }
    return enqueueWrite(this.writeQueue, () => {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error("projection cache encryption unavailable");
      const ciphertext = this.safeStorage.encryptString(value).toString("base64");
      if (
        ciphertext.length === 0 ||
        ciphertext.length > MAX_PROJECTION_CACHE_CIPHERTEXT_LENGTH ||
        ciphertext.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(ciphertext) ||
        Buffer.from(ciphertext, "base64").toString("base64") !== ciphertext
      )
        throw new Error("projection cache ciphertext is invalid");
      this.store.store = { version: 1, ciphertext };
    }).then(
      () => ({ saved: true }),
      () => ({ saved: false }),
    );
  }
  private clear(): void {
    try {
      this.store.store = { version: 1, ciphertext: null };
    } catch {
      /* best-effort removal of corrupt state */
    }
  }
}

export class ElectronLocalProfileStore implements LocalProfileStore {
  private readonly store: ElectronStore<LocalProfileRegistryState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(
    store = new ElectronStore<LocalProfileRegistryState>({
      name: "local-profile-registry",
      defaults: {
        version: 1,
        records: [DEFAULT_LOCAL_PROFILE],
        ignoredProfileIds: [],
      },
    }),
  ) {
    this.store = store;
  }
  read(): unknown { return this.store.store; }
  write(value: LocalProfileRegistryState): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeLocalProfileState(value);
      this.store.set("version", state.version);
      this.store.set("records", state.records);
      this.store.set("ignoredProfileIds", state.ignoredProfileIds);
    });
  }
}

export const electronSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
    } catch { return false; }
  },
  selectedStorageBackend: () => { try { return safeStorage.getSelectedStorageBackend(); } catch { return "unknown"; } },
  encryptString: (value) => { if (!electronSafeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage unavailable"); return safeStorage.encryptString(value); },
  decryptString: (value) => { if (!electronSafeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage unavailable"); return safeStorage.decryptString(value); },
};

const identityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function hasControlCodePoint(value: string): boolean {
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
function boundedDeviceName(value: string): string {
  let cleaned = "";
  for (const codePoint of value) cleaned += hasControlCodePoint(codePoint) ? " " : codePoint;
  cleaned = cleaned.trim().replace(/\s+/gu, " ").slice(0, 64);
  return cleaned || "T4 Code Desktop";
}
export function loadDeviceIdentity(store = new ElectronStore<{ deviceId?: string; deviceName?: string }>({ name: "device-identity", defaults: {} })): DeviceIdentity {
  const existing = store.get("deviceId");
  const deviceId = typeof existing === "string" && identityId.test(existing) ? existing : randomBytes(24).toString("base64url");
  if (existing !== deviceId) store.set("deviceId", deviceId);
  const existingName = store.get("deviceName");
  const deviceName = boundedDeviceName(typeof existingName === "string" && existingName.length > 0 ? existingName : hostname());
  if (existingName !== deviceName) store.set("deviceName", deviceName);
  return { deviceId, deviceName };
}
