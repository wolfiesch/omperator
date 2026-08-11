// Pairing machine contract: codes expire on the clock, retries burn a
// bounded attempt budget, the grant is editable but never below the observe
// floor, and the bearer token from the wire never survives into renderer
// state.
import { describe, expect, it } from "vite-plus/test";

import {
  ONBOARDING_EPOCH_MS,
  PAIRING_REQUEST_FIXTURE,
  WIRE_PAIR_RESULT_FIXTURE,
} from "../src/features/onboarding/fixtures.ts";
import { deviceFromPairResult } from "../src/features/onboarding/model.ts";
import {
  approveGrant,
  canRetry,
  codeSecondsLeft,
  denyRequest,
  deviceRequested,
  issueCode,
  MEMBERSHIP_NOT_TRUST_COPY,
  PAIRING_CODE_TTL_MS,
  PAIRING_IDLE,
  PAIRING_MAX_ATTEMPTS,
  tick,
  toggleGrant,
} from "../src/features/onboarding/pairing.ts";

const T0 = ONBOARDING_EPOCH_MS;

describe("code lifetime", () => {
  it("expires exactly at the TTL boundary, not before", () => {
    const issued = issueCode(PAIRING_IDLE, "739 214", T0);
    expect(tick(issued, T0 + PAIRING_CODE_TTL_MS - 1)).toBe(issued);
    const expired = tick(issued, T0 + PAIRING_CODE_TTL_MS);
    expect(expired.kind).toBe("expired");
  });

  it("counts down whole seconds and floors at zero", () => {
    const issued = issueCode(PAIRING_IDLE, "739 214", T0);
    expect(codeSecondsLeft(issued, T0)).toBe(120);
    expect(codeSecondsLeft(issued, T0 + 500)).toBe(120);
    expect(codeSecondsLeft(issued, T0 + 1_000)).toBe(119);
    expect(codeSecondsLeft(issued, T0 + PAIRING_CODE_TTL_MS + 5_000)).toBe(0);
  });

  it("retry from expired burns attempts until the budget is gone", () => {
    let phase = issueCode(PAIRING_IDLE, "code-1", T0);
    for (let attempt = 1; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
      phase = tick(phase, T0 + PAIRING_CODE_TTL_MS * attempt * 2);
      expect(phase.kind).toBe("expired");
      expect(canRetry(phase)).toBe(true);
      phase = issueCode(phase, `code-${attempt + 1}`, T0 + PAIRING_CODE_TTL_MS * attempt * 2);
      expect(phase.kind).toBe("code-issued");
    }
    phase = tick(phase, T0 + PAIRING_CODE_TTL_MS * 100);
    expect(phase).toEqual({ kind: "expired", attemptsLeft: 0 });
    expect(canRetry(phase)).toBe(false);
    // Minting anyway is refused.
    expect(issueCode(phase, "one-more", T0)).toBe(phase);
  });
});

describe("capability review", () => {
  const review = deviceRequested(issueCode(PAIRING_IDLE, "739 214", T0), PAIRING_REQUEST_FIXTURE);

  it("starts from exactly what the device requested", () => {
    expect(review.kind).toBe("capability-review");
    if (review.kind !== "capability-review") return;
    expect(review.grant).toEqual(PAIRING_REQUEST_FIXTURE.requested);
  });

  it("toggles requested capabilities off and back on", () => {
    const narrowed = toggleGrant(review, "shell");
    if (narrowed.kind !== "capability-review") throw new Error("phase changed");
    expect(narrowed.grant).toEqual(["observe", "control"]);
    const restored = toggleGrant(narrowed, "shell");
    if (restored.kind !== "capability-review") throw new Error("phase changed");
    expect(restored.grant).toContain("shell");
  });

  it("observe is the floor and cannot be toggled off", () => {
    expect(toggleGrant(review, "observe")).toBe(review);
  });

  it("deny refuses everything and records what was asked", () => {
    const denied = denyRequest(review);
    expect(denied).toEqual({
      kind: "capability-denied",
      deviceLabel: "MacBook Pro",
      refused: ["observe", "control", "shell"],
    });
    expect(canRetry(denied)).toBe(true);
  });
});

describe("token hygiene", () => {
  it("the wire token never survives into the device record", () => {
    const device = deviceFromPairResult(WIRE_PAIR_RESULT_FIXTURE);
    expect(JSON.stringify(device)).not.toContain(WIRE_PAIR_RESULT_FIXTURE.token);
    expect(Object.keys(device)).not.toContain("token");
  });

  it("the granted phase serializes without the token", () => {
    const review = deviceRequested(
      issueCode(PAIRING_IDLE, "739 214", T0),
      PAIRING_REQUEST_FIXTURE,
    );
    const granted = approveGrant(review, WIRE_PAIR_RESULT_FIXTURE);
    expect(JSON.stringify(granted)).not.toContain(WIRE_PAIR_RESULT_FIXTURE.token);
  });
});

describe("security copy", () => {
  it("reachability-is-not-trust names the boundary and who decides", () => {
    expect(MEMBERSHIP_NOT_TRUST_COPY).toContain("reach");
    expect(MEMBERSHIP_NOT_TRUST_COPY).toContain("decided here, by you");
  });
});
