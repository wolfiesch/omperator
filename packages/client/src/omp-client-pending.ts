import { requestId } from "@t4-code/protocol";
import type { ClientTimer } from "./omp-client-timers.ts";
import type {
  CommandIntent,
  CommandOptions,
  OmpClientError,
  Pending,
  PendingMessage,
  PendingResult,
} from "./omp-client-contracts.ts";

type TimerSchedule = (callback: () => void, delayMs: number) => ClientTimer;
type TimerClear = (timer: ClientTimer) => void;
type ErrorFactory = (code: "invalid_state" | "timeout" | "aborted" | "protocol" | "transport", message: string, retryable?: boolean) => OmpClientError;

/** Correlates requests and guarantees one settlement, including no-auto-replay outcomes. */
export class PendingRequests {
  readonly entries = new Map<string, Pending>();
  private readonly max: number;
  private readonly defaultTimeout: number;
  private readonly schedule: TimerSchedule;
  private readonly clearTimer: TimerClear;
  private readonly makeError: ErrorFactory;
  constructor(
    max: number,
    defaultTimeout: number,
    schedule: TimerSchedule,
    clearTimer: TimerClear,
    makeError: ErrorFactory,
  ) {
    this.max = max;
    this.defaultTimeout = defaultTimeout;
    this.schedule = schedule;
    this.clearTimer = clearTimer;
    this.makeError = makeError;
  }
  get size(): number { return this.entries.size; }
  begin(
    message: PendingMessage,
    requestText: string,
    options: CommandOptions,
    kind: Pending["kind"],
    intent: CommandIntent | undefined,
    send: (message: PendingMessage, pending: Pending) => void,
  ): Promise<PendingResult> {
    if (this.entries.size >= this.max) return Promise.reject(this.makeError("invalid_state", "pending request limit reached"));
    let resolvePromise: (result: PendingResult) => void = () => undefined;
    let rejectPromise: (error: OmpClientError) => void = () => undefined;
    const promise = new Promise<PendingResult>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const id = requestId(requestText);
    const command = "commandId" in message ? String(message.commandId) : undefined;
    const pending: Pending = {
      requestId: id,
      ...(command === undefined ? {} : { commandId: command }),
      message,
      resolve: resolvePromise,
      reject: rejectPromise,
      handedToTransport: false,
      kind,
      ...(intent === undefined ? {} : { intent }),
    };
    this.entries.set(requestText, pending);
    pending.timer = this.schedule(() => this.settle(requestText, undefined, this.makeError("timeout", "request timed out")), options.timeoutMs ?? this.defaultTimeout);
    const signal = options.signal;
    if (signal !== undefined) {
      const abort = (): void => this.settle(requestText, undefined, this.makeError("aborted", "request aborted"));
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        pending.abort = (): void => signal.removeEventListener("abort", abort);
      }
    }
    if (!this.entries.has(requestText)) return promise;
    try { send(message, pending); }
    catch (error) {
      if (this.entries.has(requestText)) {
        pending.handedToTransport = false;
        this.settle(requestText, undefined, error as OmpClientError);
      }
    }
    return promise;
  }
  settle(id: string, result?: PendingResult, error?: OmpClientError): void {
    const pending = this.entries.get(id);
    if (pending === undefined) return;
    this.entries.delete(id);
    if (pending.timer !== undefined) this.clearTimer(pending.timer);
    pending.abort?.();
    if (error !== undefined) pending.reject(error);
    else if (result !== undefined) pending.resolve(result);
    else pending.reject(this.makeError("protocol", "request settled without a result"));
  }
  rejectAll(error: OmpClientError): void {
    for (const id of this.entries.keys()) this.settle(id, undefined, error);
  }
}
