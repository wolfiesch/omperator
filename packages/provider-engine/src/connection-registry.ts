import { createHash, timingSafeEqual } from "node:crypto";
import type { SharedProviderConnectionLedger, TicketBinding } from "@t4-code/portable-control-store";

export type ProviderConnectionState = "ticket" | "active" | "closed";
export interface ProviderConnectionRecord extends TicketBinding {
  readonly connectionId: string;
  readonly ticketDigest: string;
  readonly state: ProviderConnectionState;
}
export interface ProviderActiveConnection {
  readonly connectionId: string;
  readonly signal: AbortSignal;
  release(): Promise<void>;
}
export interface ProviderGenerationReplacement {
  readonly generation: string;
  readonly bindings: readonly TicketBinding[];
}
export type ProviderGenerationInstallOutcome = { readonly outcome: "installed"; readonly replaced?: ProviderGenerationReplacement } | { readonly outcome: "alreadyActive" };
/** Replica-capable port; shared implementations provide cross-process cancellation signals. */
export interface ProviderConnectionRegistry {
  installControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Promise<ProviderGenerationInstallOutcome>;
  isCurrentControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Promise<boolean>;
  register(request: TicketBinding & { readonly connectionId: string; readonly ticket: string }): Promise<{ outcome: "registered" } | { outcome: "conflict" | "staleGeneration" }>;
  activate(request: TicketBinding & { readonly ticket: string }): Promise<{ outcome: "active"; connection: ProviderActiveConnection } | { outcome: "rejected" }>;
  close(connectionId: string): Promise<{ outcome: "closed" | "notFound" }>;
  closeControlGeneration(request: { readonly principalId: string; readonly generation: string }): Promise<number>;
  releaseControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Promise<{ readonly outcome: "released"; readonly bindings: readonly TicketBinding[] } | { readonly outcome: "notCurrent" }>;
}
const digest = (ticket: string) => createHash("sha256").update(ticket).digest("hex");
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class MemoryProviderConnectionRegistry implements ProviderConnectionRegistry {
  readonly #records = new Map<string, { record: ProviderConnectionRecord; controller?: AbortController }>();
  readonly #generations = new Map<string, { readonly generation: string; readonly ownerId: string }>();
  async installControlGeneration(request: { principalId: string; generation: string; ownerId?: string }) {
    const ownerId = request.ownerId ?? "legacy-owner";
    const previous = this.#generations.get(request.principalId);
    if (previous?.generation === request.generation) return { outcome: previous.ownerId === ownerId ? "installed" as const : "alreadyActive" as const };
    const bindings = previous === undefined ? [] : this.#closeGeneration(request.principalId, previous.generation);
    this.#generations.set(request.principalId, { generation: request.generation, ownerId });
    return { outcome: "installed" as const, ...(previous === undefined ? {} : { replaced: { generation: previous.generation, bindings } }) };
  }
  async isCurrentControlGeneration(request: { principalId: string; generation: string; ownerId?: string }) {
    const current = this.#generations.get(request.principalId);
    return current?.generation === request.generation && current.ownerId === (request.ownerId ?? "legacy-owner");
  }
  async register(request: TicketBinding & { connectionId: string; ticket: string }) {
    if (this.#generations.get(request.principalId)?.generation !== request.providerControlGeneration) return { outcome: "staleGeneration" as const };
    if (this.#records.has(request.connectionId)) return { outcome: "conflict" as const };
    const { ticket, ...binding } = request;
    this.#records.set(request.connectionId, { record: { ...binding, ticketDigest: digest(ticket), state: "ticket" } });
    return { outcome: "registered" as const };
  }
  async activate(request: TicketBinding & { ticket: string }) {
    const ticketDigest = digest(request.ticket);
    for (const [connectionId, entry] of this.#records) {
      const value = entry.record;
      if (value.state !== "ticket" || !same(value.ticketDigest, ticketDigest) || value.principalId !== request.principalId || value.scopeId !== request.scopeId || value.audience !== request.audience || value.runtimeId !== request.runtimeId || value.runtimeGeneration !== request.runtimeGeneration || value.providerControlGeneration !== request.providerControlGeneration || value.purpose !== request.purpose) continue;
      const controller = new AbortController();
      entry.record = { ...value, state: "active" };
      entry.controller = controller;
      return {
        outcome: "active" as const,
        connection: {
          connectionId,
          signal: controller.signal,
          release: async () => {
            const current = this.#records.get(connectionId);
            if (current?.record.state === "active") this.#records.set(connectionId, { record: { ...current.record, state: "closed" } });
          },
        },
      };
    }
    return { outcome: "rejected" as const };
  }
  async close(connectionId: string) {
    const entry = this.#records.get(connectionId);
    if (!entry) return { outcome: "notFound" as const };
    entry.controller?.abort(new Error("provider connection closed"));
    this.#records.set(connectionId, { record: { ...entry.record, state: "closed" } });
    return { outcome: "closed" as const };
  }
  async releaseControlGeneration(request: { principalId: string; generation: string; ownerId?: string }) {
    const current = this.#generations.get(request.principalId);
    if (current?.generation !== request.generation || current.ownerId !== (request.ownerId ?? "legacy-owner")) return { outcome: "notCurrent" as const };
    this.#generations.delete(request.principalId);
    return { outcome: "released" as const, bindings: this.#closeGeneration(request.principalId, request.generation) };
  }
  async closeControlGeneration(request: { principalId: string; generation: string }) {
    return this.#closeGeneration(request.principalId, request.generation).length;
  }
  #closeGeneration(principalId: string, generation: string): readonly TicketBinding[] {
    const bindings: TicketBinding[] = [];
    for (const [connectionId, entry] of this.#records) {
      if (entry.record.principalId !== principalId || entry.record.providerControlGeneration !== generation || entry.record.state === "closed") continue;
      bindings.push(entry.record);
      entry.controller?.abort(new Error("provider control generation closed"));
      this.#records.set(connectionId, { record: { ...entry.record, state: "closed" } });
    }
    return bindings;
  }
}

const SHARED_CONNECTION_RENEWAL_MILLISECONDS = 10_000;
export class SharedProviderConnectionRegistry implements ProviderConnectionRegistry {
  readonly #ledger: SharedProviderConnectionLedger;
  readonly #pollMilliseconds: number;
  readonly #controllers = new Map<string, AbortController>();
  constructor(ledger: SharedProviderConnectionLedger, pollMilliseconds = 100) {
    if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 10_000)
      throw new TypeError("provider connection poll interval is invalid");
    this.#ledger = ledger;
    this.#pollMilliseconds = pollMilliseconds;
  }
  installControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }) {
    return Promise.resolve(this.#ledger.installProviderControlGeneration(request));
  }
  isCurrentControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }) {
    return Promise.resolve(this.#ledger.isCurrentProviderControlGeneration(request));
  }
  register(request: TicketBinding & { readonly connectionId: string; readonly ticket: string }) {
    return Promise.resolve(this.#ledger.registerProviderConnection(request));
  }
  async activate(request: TicketBinding & { readonly ticket: string }) {
    const result = await this.#ledger.activateProviderConnection(request);
    if (result.outcome !== "active") return { outcome: "rejected" as const };
    const controller = new AbortController();
    this.#controllers.set(result.connectionId, controller);
    void this.#watch(result.connectionId, controller);
    return {
      outcome: "active" as const,
      connection: {
        connectionId: result.connectionId,
        signal: controller.signal,
        release: async () => {
          this.#controllers.delete(result.connectionId);
          await this.#ledger.closeProviderConnection(result.connectionId);
        },
      },
    };
  }
  async close(connectionId: string) {
    this.#controllers.get(connectionId)?.abort(new Error("provider connection closed"));
    this.#controllers.delete(connectionId);
    return await this.#ledger.closeProviderConnection(connectionId);
  }
  closeControlGeneration(request: { readonly principalId: string; readonly generation: string }) {
    return Promise.resolve(this.#ledger.closeProviderControlGeneration(request));
  }
  releaseControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }) {
    return Promise.resolve(this.#ledger.releaseProviderControlGeneration(request));
  }
  async #watch(connectionId: string, controller: AbortController): Promise<void> {
    let renewedAt = Date.now();
    while (!controller.signal.aborted && this.#controllers.get(connectionId) === controller) {
      const waited = Promise.withResolvers<void>();
      const timer = setTimeout(waited.resolve, this.#pollMilliseconds);
      timer.unref?.();
      await waited.promise;
      if (controller.signal.aborted) break;
      try {
        const now = Date.now();
        if (now - renewedAt >= SHARED_CONNECTION_RENEWAL_MILLISECONDS) {
          if (await this.#ledger.renewProviderConnection(connectionId) === "renewed") {
            renewedAt = now;
            continue;
          }
        } else if (await this.#ledger.isProviderConnectionActive(connectionId)) continue;
      } catch {
        // Shared authority uncertainty is fail-closed.
      }
      this.#controllers.delete(connectionId);
      controller.abort(new Error("provider connection revoked"));
    }
  }
}
