import { expect, test } from "bun:test";
import {
  SharedControlLedgerConflictError,
  SharedControlStore,
  type SharedControlLedgerSnapshot,
  type SharedControlLedgerState,
  type SharedControlLedgerStorage,
} from "@t4-code/portable-control-store";
import { SharedProviderConnectionRegistry } from "../src/connection-registry.ts";

class MemoryStorage implements SharedControlLedgerStorage {
  #snapshot: SharedControlLedgerSnapshot | undefined;
  async read() { return structuredClone(this.#snapshot); }
  async create(state: SharedControlLedgerState) {
    if (this.#snapshot) throw new SharedControlLedgerConflictError();
    this.#snapshot = { resourceVersion: "1", state: structuredClone(state) };
    return structuredClone(this.#snapshot);
  }
  async replace(resourceVersion: string, state: SharedControlLedgerState) {
    if (!this.#snapshot || this.#snapshot.resourceVersion !== resourceVersion) throw new SharedControlLedgerConflictError();
    this.#snapshot = { resourceVersion: String(Number(resourceVersion) + 1), state: structuredClone(state) };
    return structuredClone(this.#snapshot);
  }
}

const binding = {
  principalId: "principal",
  scopeId: "scope",
  audience: "cmux-machine-provider",
  runtimeId: "runtime",
  runtimeGeneration: "runtime-generation",
  providerControlGeneration: "control-generation-a",
  purpose: "runtime.connect.cmux",
};

test("control on replica A activates stream on B and replacement revokes it", async () => {
  const storage = new MemoryStorage();
  const controlReplica = new SharedProviderConnectionRegistry(new SharedControlStore({ storage }), 10);
  const streamReplica = new SharedProviderConnectionRegistry(new SharedControlStore({ storage }), 10);
  expect(await controlReplica.installControlGeneration({ principalId: binding.principalId, generation: binding.providerControlGeneration })).toEqual({ outcome: "installed" });
  expect(await controlReplica.register({ ...binding, connectionId: "connection", ticket: "a".repeat(32) })).toEqual({ outcome: "registered" });
  const activated = await streamReplica.activate({ ...binding, ticket: "a".repeat(32) });
  expect(activated.outcome).toBe("active");
  if (activated.outcome !== "active") throw new Error("stream activation failed");
  const aborted = Promise.withResolvers<void>();
  activated.connection.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
  expect(await controlReplica.installControlGeneration({ principalId: binding.principalId, generation: "control-generation-b" })).toEqual({
    outcome: "installed",
    replaced: { generation: binding.providerControlGeneration, bindings: [binding] },
  });
  await aborted.promise;
  expect(activated.connection.signal.aborted).toBe(true);
});
