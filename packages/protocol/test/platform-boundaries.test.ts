import { describe, expect, it } from "vite-plus/test";
import {
  decodeAndroidUpdateState,
  decodePairLinkEvent,
  parsePairDeepLink,
  PendingPairQueue,
} from "../src/index.ts";
import { androidUpdateFixtures, pairLinkFixtures } from "./fixtures/platform-boundaries.ts";

describe("headless platform contracts", () => {
  it("parses only bounded, credential-free pairing links", () => {
    for (const [value, expected] of pairLinkFixtures.valid) {
      const result = parsePairDeepLink(value, 1234);
      expect(result).toEqual(expected);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("token");
    }
    for (const value of pairLinkFixtures.invalid) expect(parsePairDeepLink(value, 1234)).toBeNull();
    expect(parsePairDeepLink("t4-code://pair/host-a/123456", -1)).toBeNull();
  });

  it("validates queued pair events before deduplicating and bounding them", () => {
    const queue = new PendingPairQueue(8);
    for (let index = 0; index < 10; index += 1) {
      queue.push({ hostHint: `host-${index}`, code: "123456", issuedAt: index });
    }
    queue.push({ hostHint: "host-8", code: "654321", issuedAt: 99 });
    expect(queue.drain().map((item) => item.hostHint)).toEqual([
      "host-2",
      "host-3",
      "host-4",
      "host-5",
      "host-6",
      "host-7",
      "host-9",
      "host-8",
    ]);
    expect(queue.size()).toBe(0);
    expect(() => queue.push({ hostHint: "bad host", code: "123456", issuedAt: 1 })).toThrow();
  });

  it("strictly decodes Capacitor updater fixtures without Android", () => {
    for (const fixture of androidUpdateFixtures.valid) {
      const decoded = decodeAndroidUpdateState(fixture);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(decoded.currentVersion).toBe(fixture.currentVersion);
    }
    const cleaned = decodeAndroidUpdateState(androidUpdateFixtures.valid[2]);
    expect(cleaned.message).toBe("Installer opened. Review Android's prompt.");
    for (const fixture of androidUpdateFixtures.invalid) {
      expect(() => decodeAndroidUpdateState(fixture)).toThrow();
    }
    expect(() =>
      decodeAndroidUpdateState(
        Object.assign(new (class AndroidState {})(), {
          currentVersion: "0.1.22",
          phase: "idle",
          revision: 1,
        }),
      ),
    ).toThrow();
    expect(
      decodeAndroidUpdateState({
        currentVersion: "0.1.22",
        phase: "error",
        revision: 2,
        message: "x".repeat(1_000_000),
      }).message,
    ).toBe("x".repeat(512));
  });

  it("rejects malformed pair events before Electron IPC receives them", () => {
    expect(decodePairLinkEvent({ hostHint: "host-a", code: "123456", issuedAt: 1 })).toEqual({
      hostHint: "host-a",
      code: "123456",
      issuedAt: 1,
    });
    for (const fixture of [
      { hostHint: "host-a", code: "123456" },
      { hostHint: "host-a", code: "12345", issuedAt: 1 },
      { hostHint: "host-a", code: "123456", issuedAt: Number.NaN },
      { hostHint: "host-a", code: "123456", issuedAt: 1, token: "secret" },
      Object.assign(new (class PairLink {})(), {
        hostHint: "host-a",
        code: "123456",
        issuedAt: 1,
      }),
    ]) {
      expect(() => decodePairLinkEvent(fixture)).toThrow();
    }
    for (const capacity of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5]) {
      expect(() => new PendingPairQueue(capacity)).toThrow(/capacity/u);
    }
  });
});
