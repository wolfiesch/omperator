import { isCursor, type Cursor } from "@t4-code/protocol";
import type { OmpResponse } from "./omp-protocol-provider.ts";

interface ReplayProbe {
  readonly generation: number;
  responseReceived: boolean;
  sawSnapshot: boolean;
  targetCursor?: Cursor;
}

/** Gates reconnect-budget recovery on transport and session-replay health. */
export class OmpClientReconnectHealth {
  private heartbeatGeneration: number | undefined;
  private readonly replay = new Map<string, ReplayProbe>();
  private readonly resetAttempts: () => void;

  constructor(resetAttempts: () => void) {
    this.resetAttempts = resetAttempts;
  }

  clear(): void {
    this.heartbeatGeneration = undefined;
    this.replay.clear();
  }

  beginWelcome(generation: number, sessionKeys: Iterable<string>): void {
    this.clear();
    for (const key of sessionKeys) {
      this.replay.set(key, {
        generation,
        responseReceived: false,
        sawSnapshot: false,
      });
    }
  }

  acceptPong(generation: number): void {
    this.heartbeatGeneration = generation;
    this.maybeReset(generation);
  }

  acceptAttachResponse(generation: number, key: string, frame: OmpResponse, current: Cursor | undefined): void {
    const probe = this.currentProbe(generation, key);
    if (probe === undefined) return;
    probe.responseReceived = true;
    const result = frame.result;
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const cursor = Reflect.get(result, "cursor");
      if (isCursor(cursor)) probe.targetCursor = cursor;
    }
    if (this.isComplete(probe, current)) {
      this.replay.delete(key);
      this.maybeReset(generation);
    }
  }

  acceptReplayProgress(generation: number, key: string, cursor: Cursor, snapshot: boolean): void {
    const probe = this.currentProbe(generation, key);
    if (probe === undefined) return;
    if (snapshot) probe.sawSnapshot = true;
    if (this.isComplete(probe, cursor)) {
      this.replay.delete(key);
      this.maybeReset(generation);
    }
  }

  private currentProbe(generation: number, key: string): ReplayProbe | undefined {
    const probe = this.replay.get(key);
    return probe?.generation === generation ? probe : undefined;
  }

  private isComplete(probe: ReplayProbe, current: Cursor | undefined): boolean {
    if (!probe.responseReceived) return false;
    if (probe.targetCursor === undefined) return probe.sawSnapshot;
    return current !== undefined
      && current.epoch === probe.targetCursor.epoch
      && current.seq >= probe.targetCursor.seq;
  }

  private maybeReset(generation: number): void {
    if (this.heartbeatGeneration === generation && this.replay.size === 0) this.resetAttempts();
  }
}
