import { describe, expect, it } from "vite-plus/test";
import {
  DeviceCredentialStore,
  validateRemoteTarget,
  VersionedRemoteTargetRegistry,
  type CredentialCiphertextStore,
  type RemoteTargetStore,
  type SafeStorageAdapter,
} from "../src/registry.ts";
import {
  invalidCredentialStateFixtures,
  invalidRegistryStateFixtures,
  invalidRemoteTargetFixtures,
  remoteTarget,
  validRemoteTargetFixtures,
} from "./fixtures/registry.ts";

class MemoryStore implements RemoteTargetStore, CredentialCiphertextStore {
  value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }

  read(): unknown {
    return this.value;
  }

  write(value: unknown): void {
    this.value = value;
  }
}

class AsyncStore extends MemoryStore {
  override async read(): Promise<unknown> {
    await Promise.resolve();
    return this.value;
  }

  override async write(value: unknown): Promise<void> {
    await Promise.resolve();
    this.value = value;
  }
}

class MutateThenFailStore extends MemoryStore {
  private fail = true;

  override write(value: unknown): void {
    this.value = value;
    if (this.fail) {
      this.fail = false;
      throw new Error("simulated write failure");
    }
  }
}

class TestSafeStorage implements SafeStorageAdapter {
  readonly isEncryptionAvailable = () => true;

  encryptString(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }

  decryptString(value: Buffer): string {
    return value.toString("utf8");
  }
}

const token = "A".repeat(43);
const deviceId = "device-01";

describe("remote target fixtures", () => {
  for (const fixture of validRemoteTargetFixtures) {
    it(`accepts ${fixture.name}`, () => {
      const result = validateRemoteTarget(fixture.target);
      expect(result.address).toBe(fixture.expectedAddress);
      expect(result.label).toBe("Bunker");
    });
  }

  for (const fixture of invalidRemoteTargetFixtures) {
    it(`rejects ${fixture.name}`, () => {
      expect(() => validateRemoteTarget(fixture.target)).toThrow();
    });
  }
});

describe("versioned remote target registry", () => {
  it("rejects malformed, unknown, and custom-prototype persisted state", async () => {
    for (const fixture of invalidRegistryStateFixtures) {
      const registry = new VersionedRemoteTargetRegistry(new MemoryStore(fixture));
      await expect(registry.list()).rejects.toThrow();
    }
  });

  it("returns frozen copies instead of mutable store records", async () => {
    const stored = remoteTarget("frozen");
    const registry = new VersionedRemoteTargetRegistry(
      new MemoryStore({ version: 1, records: [stored] }),
    );
    const [listed] = await registry.list();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed?.requestedCapabilities)).toBe(true);
    expect(listed).not.toBe(stored);
    expect(listed?.requestedCapabilities).not.toBe(stored.requestedCapabilities);
  });

  it("rejects duplicate IDs and endpoints", async () => {
    const registry = new VersionedRemoteTargetRegistry(
      new MemoryStore({ version: 1, records: [] }),
    );
    await registry.put(remoteTarget("first"));
    await expect(registry.put({ ...remoteTarget("first"), address: "100.64.0.2" })).rejects.toThrow(
      "duplicate remote target",
    );
    await expect(registry.put(remoteTarget("second"))).rejects.toThrow("duplicate remote target");
  });

  it("serializes simultaneous mutations without losing records", async () => {
    const registry = new VersionedRemoteTargetRegistry(new AsyncStore({ version: 1, records: [] }));
    await Promise.all([
      registry.put(remoteTarget("one", "100.64.0.2")),
      registry.put(remoteTarget("two", "100.64.0.3")),
    ]);
    expect((await registry.list()).map((target) => target.targetId)).toEqual(["one", "two"]);
  });

  it("restores the prior state when a write mutates and then fails", async () => {
    const store = new MutateThenFailStore({ version: 1, records: [] });
    const registry = new VersionedRemoteTargetRegistry(store);
    await expect(registry.put(remoteTarget("failed"))).rejects.toThrow("simulated write failure");
    expect(store.value).toEqual({ version: 1, records: [] });
  });
});

describe("device credential store", () => {
  it("fails closed when secure encryption is unavailable", () => {
    const store = new MemoryStore({ version: 1, ciphertexts: {} });
    expect(
      () =>
        new DeviceCredentialStore(store, {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.alloc(0),
          decryptString: () => "",
        }),
    ).toThrow("encrypted credential storage unavailable");
    expect(
      () =>
        new DeviceCredentialStore(store, {
          isEncryptionAvailable: () => true,
          selectedStorageBackend: () => "basic_text",
          encryptString: () => Buffer.alloc(0),
          decryptString: () => "",
        }),
    ).toThrow("encrypted credential storage unavailable");
  });

  it("rejects malformed and custom-prototype ciphertext state", () => {
    for (const fixture of invalidCredentialStateFixtures) {
      const credentials = new DeviceCredentialStore(
        new MemoryStore(fixture),
        new TestSafeStorage(),
      );
      expect(() => credentials.withCredential("remote", (value) => value.deviceId)).toThrow();
    }
  });

  it("encrypts, reads synchronously, and revokes credentials", async () => {
    const store = new MemoryStore({ version: 1, ciphertexts: {} });
    const credentials = new DeviceCredentialStore(store, new TestSafeStorage());
    await credentials.set("remote", { token, deviceId });
    expect(JSON.stringify(store.value)).not.toContain(token);
    expect(credentials.withCredential("remote", (credential) => credential.deviceId)).toBe(
      deviceId,
    );
    await credentials.revoke("remote");
    expect(() => credentials.withCredential("remote", (credential) => credential.token)).toThrow(
      "credential unavailable",
    );
  });

  it("rejects asynchronous credential providers", async () => {
    const store = new MemoryStore({ version: 1, ciphertexts: {} });
    const credentials = new DeviceCredentialStore(store, new TestSafeStorage());
    await credentials.set("remote", { token, deviceId });
    expect(() =>
      credentials.withCredential("remote", async (credential) => credential.deviceId),
    ).toThrow("credential provider must be synchronous");
  });
});
