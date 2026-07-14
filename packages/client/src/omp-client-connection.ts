import type { Clock, IdFactory, OmpTransport, OmpTransportFactory, Unsubscribe } from "./omp-client-contracts.ts";
import { ClientTimerRegistry, type ClientTimer } from "./omp-client-timers.ts";

export interface ConnectionCallbacks {
  connected(transport: OmpTransport, generation: number): void;
  message(raw: string | Uint8Array, generation: number): void;
  close(code?: number, reason?: string): void;
  error(error: unknown): void;
  reconnectLimit(): void;
  reconnectWait(): void;
  heartbeatFailure(): void;
}

interface ReconnectOptions { baseMs?: number; maxMs?: number; attemptCap?: number; }
interface HeartbeatOptions { intervalMs?: number; timeoutMs?: number; }

/** Owns transport generations, socket handlers, reconnect backoff, and heartbeat scheduling. */
export class OmpClientConnection {
  private transport: OmpTransport | undefined;
  private unsubscribes: Unsubscribe[] = [];
  private generationValue = 0;
  private attempt = 0;
  private reconnectTimer: ClientTimer | undefined;
  private heartbeatTimer: ClientTimer | undefined;
  private heartbeatTimeout: ClientTimer | undefined;
  private readonly factory: OmpTransportFactory;
  private readonly timers: ClientTimerRegistry;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly random: () => number;
  private readonly reconnect: ReconnectOptions | undefined;
  private readonly heartbeat: HeartbeatOptions | undefined;
  private readonly active: () => boolean;
  private readonly callbacks: ConnectionCallbacks;

  constructor(
    factory: OmpTransportFactory,
    timers: ClientTimerRegistry,
    clock: Clock,
    ids: IdFactory,
    random: () => number,
    reconnect: ReconnectOptions | undefined,
    heartbeat: HeartbeatOptions | undefined,
    active: () => boolean,
    callbacks: ConnectionCallbacks,
  ) {
    this.factory = factory;
    this.timers = timers;
    this.clock = clock;
    this.ids = ids;
    this.random = random;
    this.reconnect = reconnect;
    this.heartbeat = heartbeat;
    this.active = active;
    this.callbacks = callbacks;
  }

  get generation(): number { return this.generationValue; }
  get socket(): OmpTransport | undefined { return this.transport; }
  get socketHandlers(): number { return this.unsubscribes.length; }
  get attempts(): number { return this.attempt; }

  begin(): void {
    if (!this.active()) return;
    const generation = ++this.generationValue;
    Promise.resolve().then(() => this.factory()).then((transport) => {
      if (generation !== this.generationValue || !this.active()) {
        try { transport.close(); } catch { /* stale transport */ }
        return;
      }
      this.transport = transport;
      this.unsubscribes = [
        transport.onMessage((data) => {
          if (generation === this.generationValue) this.callbacks.message(data, generation);
        }),
        transport.onClose((code, reason) => {
          if (generation === this.generationValue) this.callbacks.close(code, reason);
        }),
        transport.onError((error) => {
          if (generation === this.generationValue) this.callbacks.error(error);
        }),
      ];
      this.callbacks.connected(transport, generation);
    }).catch((error: unknown) => {
      if (generation === this.generationValue) this.callbacks.error(error);
    });
  }

  send(data: string): void {
    const transport = this.transport;
    if (transport === undefined) throw new Error("transport unavailable");
    transport.send(data);
  }
  resetAttempts(): void {
    this.attempt = 0;
  }

  disconnect(): void {
    this.generationValue += 1;
    this.stopHeartbeat();
    this.clearReconnect();
    this.detach();
    const transport = this.transport;
    this.transport = undefined;
    try { transport?.close(); } catch { /* transport close is best effort */ }
  }

  scheduleReconnect(): void {
    if (!this.active()) return;
    const cap = this.reconnect?.attemptCap ?? 8;
    if (this.attempt >= cap) {
      this.callbacks.reconnectLimit();
      return;
    }
    this.attempt += 1;
    const base = this.reconnect?.baseMs ?? 250;
    const max = this.reconnect?.maxMs ?? 10_000;
    const random = Math.max(0, Math.min(1, this.random()));
    const ceiling = Math.min(max, base * 2 ** Math.max(0, this.attempt - 1));
    const floor = Math.floor(ceiling / 2);
    const delay = floor + Math.floor(random * (ceiling - floor));
    this.callbacks.reconnectWait();
    this.reconnectTimer = this.timers.schedule(() => this.begin(), delay);
  }

  startHeartbeat(active: () => boolean, tick: () => boolean): void {
    this.stopHeartbeat();
    if (!active() || this.transport === undefined) return;
    const interval = this.heartbeat?.intervalMs ?? 15_000;
    const timeout = this.heartbeat?.timeoutMs ?? 5_000;
    const heartbeatTick = (): void => {
      if (!active() || this.transport === undefined) return;
      // Install the timeout before send. A transport may synchronously deliver
      // the matching pong from inside send(), and that pong must be able to
      // cancel the timeout it acknowledges.
      this.heartbeatTimeout = this.timers.schedule(() => this.callbacks.heartbeatFailure(), timeout);
      if (!tick()) {
        this.clearHeartbeatTimeout();
        this.callbacks.heartbeatFailure();
        return;
      }
      this.heartbeatTimer = this.timers.schedule(heartbeatTick, interval);
    };
    this.heartbeatTimer = this.timers.schedule(heartbeatTick, interval);
  }

  clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout === undefined) return;
    this.timers.clear(this.heartbeatTimeout);
    this.heartbeatTimeout = undefined;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.timers.clear(this.heartbeatTimer);
    if (this.heartbeatTimeout !== undefined) this.timers.clear(this.heartbeatTimeout);
    this.heartbeatTimer = undefined;
    this.heartbeatTimeout = undefined;
  }

  clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.timers.clear(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private detach(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      try { unsubscribe(); } catch { /* unsubscribe is best effort */ }
    }
  }
}
