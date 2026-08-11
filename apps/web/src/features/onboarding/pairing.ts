// Pairing state machine, host side. The host mints a short-lived code, the
// remote device types it, the host reviews and edits the requested
// capabilities, then approves or denies. Security posture is explicit
// everywhere: network reachability is not trust, the grant is the trust
// decision, and the bearer token never enters this model — `granted`
// carries a token-free `PairedDevice` only.
import {
  type CapabilityId,
  type DevicePlatform,
  deviceFromPairResult,
  type PairedDevice,
  type PeerIdentity,
  type WirePairResult,
} from "./model.ts";

/** Pairing codes live this long; mirrors `omp appserver pair`. */
export const PAIRING_CODE_TTL_MS = 2 * 60_000;

/** Attempts per source per hour before the host locks pairing out. */
export const PAIRING_MAX_ATTEMPTS = 5;

/**
 * The one sentence every pairing surface must carry. Reachability is a
 * network fact; trust is the grant the user approves here.
 */
export const MEMBERSHIP_NOT_TRUST_COPY =
  "Being able to reach this host is not trust. What a device can do is decided here, by you.";

/** What the remote device asked for, as reported by the host. */
export interface PairingRequest {
  readonly deviceLabel: string;
  readonly platform: DevicePlatform;
  readonly identity: PeerIdentity;
  readonly requested: readonly CapabilityId[];
}

export type PairingPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "code-issued";
      readonly code: string;
      readonly issuedAtMs: number;
      readonly expiresAtMs: number;
      readonly attemptsLeft: number;
    }
  | {
      readonly kind: "capability-review";
      readonly request: PairingRequest;
      /** The editable grant; starts as the requested set. */
      readonly grant: readonly CapabilityId[];
      readonly attemptsLeft: number;
    }
  | { readonly kind: "granted"; readonly device: PairedDevice }
  | { readonly kind: "expired"; readonly attemptsLeft: number }
  | {
      readonly kind: "identity-mismatch";
      readonly pinned: PeerIdentity;
      readonly presented: PeerIdentity;
    }
  | {
      readonly kind: "capability-denied";
      readonly deviceLabel: string;
      /** What was asked and refused, for the closing summary. */
      readonly refused: readonly CapabilityId[];
    }
  | { readonly kind: "revoked"; readonly deviceLabel: string };

export const PAIRING_IDLE: PairingPhase = { kind: "idle" };

/**
 * Mint a code. The caller supplies the code string and clock so fixtures and
 * tests stay deterministic; the real adapter passes the server-minted code.
 */
export function issueCode(
  phase: PairingPhase,
  code: string,
  nowMs: number,
): PairingPhase {
  const attemptsLeft =
    phase.kind === "expired" || phase.kind === "code-issued"
      ? phase.attemptsLeft
      : PAIRING_MAX_ATTEMPTS;
  if (attemptsLeft <= 0) return phase;
  return {
    kind: "code-issued",
    code,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + PAIRING_CODE_TTL_MS,
    attemptsLeft: attemptsLeft - 1,
  };
}

/** Advance the clock; an outstanding code past its expiry becomes expired. */
export function tick(phase: PairingPhase, nowMs: number): PairingPhase {
  if (phase.kind === "code-issued" && nowMs >= phase.expiresAtMs) {
    return { kind: "expired", attemptsLeft: phase.attemptsLeft };
  }
  return phase;
}

/** Whole seconds left on the code; 0 once expired. */
export function codeSecondsLeft(phase: PairingPhase, nowMs: number): number {
  if (phase.kind !== "code-issued") return 0;
  return Math.max(0, Math.ceil((phase.expiresAtMs - nowMs) / 1000));
}

/** A device presented the code; move to the editable capability review. */
export function deviceRequested(phase: PairingPhase, request: PairingRequest): PairingPhase {
  if (phase.kind !== "code-issued") return phase;
  return {
    kind: "capability-review",
    request,
    grant: request.requested,
    attemptsLeft: phase.attemptsLeft,
  };
}

/**
 * Toggle one capability in the grant. `observe` is the floor and cannot be
 * toggled off — removing everything is what "Deny" is for.
 */
export function toggleGrant(phase: PairingPhase, capability: CapabilityId): PairingPhase {
  if (phase.kind !== "capability-review") return phase;
  if (capability === "observe") return phase;
  const grant = phase.grant.includes(capability)
    ? phase.grant.filter((entry) => entry !== capability)
    : [...phase.grant, capability];
  return { ...phase, grant };
}

/**
 * Approve the edited grant. The wire result (with its token) is consumed
 * here and only the token-free device record survives.
 */
export function approveGrant(phase: PairingPhase, result: WirePairResult): PairingPhase {
  if (phase.kind !== "capability-review") return phase;
  return { kind: "granted", device: deviceFromPairResult(result) };
}

/** Refuse the request outright. */
export function denyRequest(phase: PairingPhase): PairingPhase {
  if (phase.kind !== "capability-review") return phase;
  return {
    kind: "capability-denied",
    deviceLabel: phase.request.deviceLabel,
    refused: phase.request.requested,
  };
}

/** The host reported the peer's verified identity differs from the pinned one. */
export function identityMismatch(
  pinned: PeerIdentity,
  presented: PeerIdentity,
): PairingPhase {
  return { kind: "identity-mismatch", pinned, presented };
}

/** Restart from a terminal phase. Refused when attempts ran out. */
export function canRetry(phase: PairingPhase): boolean {
  if (phase.kind === "expired") return phase.attemptsLeft > 0;
  return (
    phase.kind === "capability-denied" ||
    phase.kind === "identity-mismatch" ||
    phase.kind === "revoked"
  );
}
