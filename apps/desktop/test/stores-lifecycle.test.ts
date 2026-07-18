import { describe, expect, it } from "vitest";
import type { CursorStore, OmpTransport } from "@t4-code/client";
import { hostId, type WelcomeFrame } from "@t4-code/protocol";
import { DeviceCredentialStore, type CredentialCiphertextStore, type RemoteTargetRecord, type RemoteTargetRegistry } from "../src/remote-runtime/index.ts";
import { DesktopTargetManager } from "../src/target-manager.ts";
import { ElectronCredentialCiphertextStore, ElectronProjectionCacheStore, ElectronRemoteTargetStore, loadDeviceIdentity } from "../src/stores.ts";

type State = Record<string, unknown>;
class MemoryStore<T extends State> {
  store: T;
  constructor(store: T) { this.store = store; }
  get<K extends keyof T>(key: K): T[K] { return this.store[key]; }
  set<K extends keyof T>(key: K, value: T[K]): void { this.store = { ...this.store, [key]: value }; }
}
const target = (targetId: string): RemoteTargetRecord => ({ targetId, label: targetId, mode: "direct", address: "100.64.0.1", port: 4210, requestedCapabilities: ["sessions.read"], grantedCapabilities: [], status: "unknown" });
const V = "omp-app/1" as const;
function welcome(authentication: WelcomeFrame["authentication"]): WelcomeFrame {
  return { v: V, type: "welcome", selectedProtocol: V, hostId: hostId("pair-host"), ompVersion: "fixture", ompBuild: "test", appserverVersion: "fixture", appserverBuild: "test", epoch: "epoch-a", grantedCapabilities: [], grantedFeatures: [], negotiatedLimits: {}, authentication, resumed: false };
}
class PairTransport implements OmpTransport {
  readonly sent: string[] = [];
  closed = false;
  private readonly messages = new Set<(data: string) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  async open(): Promise<void> {}
  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; requestId?: string };
    if (frame.type === "hello") this.emit(welcome("pairing-required"));
  }
  close(): void { if (this.closed) return; this.closed = true; for (const listener of this.closes) listener(1000, "closed"); this.messages.clear(); this.closes.clear(); }
  onMessage(listener: (data: string | Uint8Array) => void): () => void { const wrapped = (data: string) => listener(data); this.messages.add(wrapped); return () => this.messages.delete(wrapped); }
  onClose(listener: (code?: number, reason?: string) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(): () => void { return () => {}; }
  emit(frame: unknown): void { const data = JSON.stringify(frame); for (const listener of this.messages) listener(data); }
}
class Registry implements RemoteTargetRegistry {
  private readonly values = new Map<string, RemoteTargetRecord>();
  async list(): Promise<readonly RemoteTargetRecord[]> { return [...this.values.values()]; }
  async get(id: string): Promise<RemoteTargetRecord | null> { return this.values.get(id) ?? null; }
  async put(value: RemoteTargetRecord): Promise<void> { this.values.set(value.targetId, value); }
  async remove(id: string): Promise<void> { this.values.delete(id); }
}
class Cursor implements CursorStore { load(): readonly never[] { return []; } save(): void {} }
function pairingManager(transport: PairTransport, credentials?: { withCredential<T>(id: string, provider: (value: { token: string; deviceId: string }) => T): T; set(id: string, value: { token: string; deviceId: string }): Promise<void>; revoke(id: string): Promise<void> }): DesktopTargetManager {
  const registry = new Registry();
  void registry.put(target("remote"));
  const options = {
    cursorStore: new Cursor(), registry,
    remoteTransportFactory: () => transport as never,
    capabilities: ["sessions.read"] as const,
    events: { onEvent: () => {}, onState: () => {}, onError: () => {} },
    ...(credentials === undefined ? {} : { credentials }),
  };
  return new DesktopTargetManager(options);
}

describe("desktop persisted lifecycle stores", () => {
  it("round-trips versioned remote target state and copies records", async () => {
    const backing = new MemoryStore({ version: 1 as const, records: [] as RemoteTargetRecord[] });
    const store = new ElectronRemoteTargetStore(backing as never);
    const record = target("roundtrip");
    await store.write({ version: 1, records: [record] });
    const loaded = store.read();
    expect(loaded).toEqual({ version: 1, records: [record] });
    expect(loaded.records).not.toBe(backing.store.records);
  });
  it("rejects malformed remote state on read and write", async () => {
    const backing = new MemoryStore({ version: 2 as never, records: [] as RemoteTargetRecord[] });
    const store = new ElectronRemoteTargetStore(backing as never);
    expect(() => store.read()).toThrow("invalid remote target state");
    await expect(store.write({ version: 1, records: [null] })).rejects.toThrow("invalid remote target state");
  });
  it("serializes concurrent remote writes with the last complete state", async () => {
    const backing = new MemoryStore({ version: 1 as const, records: [] as RemoteTargetRecord[] });
    const store = new ElectronRemoteTargetStore(backing as never);
    await Promise.all([store.write({ version: 1, records: [target("first")] }), store.write({ version: 1, records: [target("second")] })]);
    expect(store.read().records.map((item) => item.targetId)).toEqual(["second"]);
  });
  it("round-trips and rejects corrupt credential ciphertext state", async () => {
    const backing = new MemoryStore({ version: 1 as const, ciphertexts: {} as Record<string, string> });
    const store = new ElectronCredentialCiphertextStore(backing as never);
    await store.write({ version: 1, ciphertexts: { remote: "YWJj" } });
    expect(store.read()).toEqual({ version: 1, ciphertexts: { remote: "YWJj" } });
    backing.store = { version: 1, ciphertexts: { remote: "not base64!" } };
    expect(() => store.read()).toThrow("invalid credential state");
  });
  it("keeps device identity stable and bounds hostile device labels", () => {
    const backing = new MemoryStore<{ deviceId?: string; deviceName?: string }>({ deviceId: "device-fixed", deviceName: `${" name\n".repeat(40)}\u0000` });
    const first = loadDeviceIdentity(backing as never);
    const second = loadDeviceIdentity(backing as never);
    expect(second).toEqual(first);
    expect(first.deviceId).toBe("device-fixed");
    expect(first.deviceName.length).toBeLessThanOrEqual(64);
    expect([...first.deviceName].some((character) => { const code = character.charCodeAt(0); return code <= 0x1f || (code >= 0x7f && code <= 0x9f); })).toBe(false);
  });
  it("fails closed when credential encryption is unavailable or basic_text", () => {
    const store: CredentialCiphertextStore = { read: () => ({ version: 1, ciphertexts: {} }), write: () => {} };
    expect(() => new DeviceCredentialStore(store, { isEncryptionAvailable: () => false, encryptString: (_value: string) => Buffer.alloc(0), decryptString: (_value: Buffer) => "" })).toThrow();
    expect(() => new DeviceCredentialStore(store, { isEncryptionAvailable: () => true, selectedStorageBackend: () => "basic_text", encryptString: (_value: string) => Buffer.alloc(0), decryptString: (_value: Buffer) => "" })).toThrow();
  });
  it("stores only safeStorage ciphertext and restores valid projection cache", async () => {
    const backing = new MemoryStore({ version: 1 as const, ciphertext: null as string | null });
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`ciphertext:${value}`),
      decryptString: (value: Buffer) => {
        const encoded = value.toString();
        if (!encoded.startsWith("ciphertext:")) throw new Error("corrupt ciphertext");
        return encoded.slice("ciphertext:".length);
      },
    };
    const store = new ElectronProjectionCacheStore(backing as never, safeStorage);
    const value = JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: { sessions: [], sessionIndex: [], lru: [], freshness: "cached" },
    });
    expect(await store.save(value)).toEqual({ saved: true });
    expect(backing.store.ciphertext).not.toContain(value);
    expect(store.load()).toEqual({ available: true, value });
  });
  it("degrades when safeStorage is unavailable and clears incompatible state", async () => {
    const unavailableBacking = new MemoryStore({ version: 1 as const, ciphertext: null as string | null });
    const unavailable = new ElectronProjectionCacheStore(unavailableBacking as never, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from("unused"),
      decryptString: () => "unused",
    });
    expect(unavailable.load()).toEqual({ available: false, value: null });
    expect(await unavailable.save(JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: {},
    }))).toEqual({ saved: false });

    const corruptBacking = new MemoryStore({ version: 2 as never, ciphertext: "not-valid" });
    const corrupt = new ElectronProjectionCacheStore(corruptBacking as never, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    });
    expect(corrupt.load()).toEqual({ available: true, value: null });
    expect(corruptBacking.store).toEqual({ version: 1, ciphertext: null });
    const payloadBacking = new MemoryStore({
      version: 1 as const,
      ciphertext: Buffer.from("encrypted").toString("base64"),
    });
    const payloadCorrupt = new ElectronProjectionCacheStore(payloadBacking as never, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: () => JSON.stringify({ kind: "t4-code-projection", version: 2, data: {} }),
    });
    expect(payloadCorrupt.load()).toEqual({ available: true, value: null });
    expect(payloadBacking.store).toEqual({ version: 1, ciphertext: null });
  });
  it("serializes concurrent projection cache writes", async () => {
    const backing = new MemoryStore({ version: 1 as const, ciphertext: null as string | null });
    const store = new ElectronProjectionCacheStore(backing as never, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    });
    const makeValue = (marker: string) => JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: { marker },
    });
    const first = makeValue("first");
    const second = makeValue("second");
    expect(await Promise.all([store.save(first), store.save(second)])).toEqual([
      { saved: true },
      { saved: true },
    ]);
    expect(store.load()).toEqual({ available: true, value: second });
  });
});

describe("pairing credential sink boundaries", () => {
  it("does not pair or leak a token when the credential sink is absent", async () => {
    const transport = new PairTransport();
    const manager = pairingManager(transport);
    await manager.connect("remote");
    await expect(manager.pairStart("remote", "123456")).rejects.toThrow("credential storage");
    expect(manager.isPaired("remote")).toBe(false);
    expect(transport.sent.join(" ")).not.toContain("deviceToken");
    await manager.close();
  });
  it("keeps runtime unpaired when privileged credential persistence rejects", async () => {
    const transport = new PairTransport();
    const manager = pairingManager(transport, { withCredential: () => { throw new Error("missing"); }, set: async () => { throw new Error("sink rejected /home/private"); }, revoke: async () => {} });
    await manager.connect("remote");
    const pairing = manager.pairStart("remote", "123456");
    const request = JSON.parse(transport.sent.at(-1)!) as { requestId: string };
    transport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "pair-1", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    await expect(pairing).rejects.toThrow();
    expect(manager.isPaired("remote")).toBe(false);
    await manager.close();
  });
});
