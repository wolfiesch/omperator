import type { ProjectionStore } from "./projection.ts";
import type { OmpClientError, OmpStateSnapshot, Unsubscribe } from "./omp-client-contracts.ts";
import type { PublicOmpServerEvent } from "./omp-protocol-provider.ts";

/** Isolates listener mutation and protects protocol callbacks from consumer exceptions. */
export class OmpClientEvents {
  private readonly stateListeners = new Set<(snapshot: OmpStateSnapshot) => void>();
  private readonly eventListeners = new Set<(event: PublicOmpServerEvent) => void>();
  private readonly errorListeners = new Set<(error: OmpClientError) => void>();
  get listenerCount(): number { return this.stateListeners.size + this.eventListeners.size + this.errorListeners.size; }
  onState(listener: (snapshot: OmpStateSnapshot) => void): Unsubscribe { return this.subscribe(this.stateListeners, listener); }
  onEvent(listener: (event: PublicOmpServerEvent) => void): Unsubscribe { return this.subscribe(this.eventListeners, listener); }
  onError(listener: (error: OmpClientError) => void): Unsubscribe { return this.subscribe(this.errorListeners, listener); }
  clear(): void {
    this.stateListeners.clear();
    this.eventListeners.clear();
    this.errorListeners.clear();
  }
  emitState(snapshot: OmpStateSnapshot): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks unsubscribe.
    for (const listener of [...this.stateListeners]) { try { listener(snapshot); } catch { /* isolated */ } }
  }
  emitError(error: OmpClientError): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks unsubscribe.
    for (const listener of [...this.errorListeners]) { try { listener(error); } catch { /* isolated */ } }
  }
  publish(event: PublicOmpServerEvent, projection: ProjectionStore | undefined): void {
    try { projection?.applyPublicEvent(event); } catch { /* observational */ }
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks unsubscribe.
    for (const listener of [...this.eventListeners]) { try { listener(event); } catch { /* isolated */ } }
  }
  private subscribe<T>(set: Set<T>, listener: T): Unsubscribe {
    set.add(listener); let active = true;
    return () => { if (!active) return; active = false; set.delete(listener); };
  }
}
