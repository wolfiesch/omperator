// Pairing panel, host side: mint a short-lived code, review what the remote
// device asked for, edit the grant, approve or refuse. Security stays
// explicit on every screen — tailnet reachability is not trust, and the
// bearer credential is never shown (it does not even reach this component's
// props). Standalone: phase in, intents out.
import { Badge, Button, cn } from "@t4-code/ui";
import { useEffect, useRef } from "react";

import {
  CAPABILITIES,
  DEVICE_PLATFORM_LABELS,
  type CapabilityId,
  type PeerIdentity,
  capabilityLabels,
} from "./model.ts";
import {
  canRetry,
  codeSecondsLeft,
  MEMBERSHIP_NOT_TRUST_COPY,
  PAIRING_MAX_ATTEMPTS,
  type PairingPhase,
} from "./pairing.ts";

export interface PairingPanelProps {
  readonly phase: PairingPhase;
  /** Deterministic clock for the countdown; the parent ticks it. */
  readonly nowMs: number;
  /** Safe display name of the host minting the code. */
  readonly hostName: string;
  readonly onIssueCode: () => void;
  readonly onToggleCapability: (capability: CapabilityId) => void;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly onDone: () => void;
}

function IdentityFacts({ identity }: { readonly identity: PeerIdentity }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="font-mono">{identity.account}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Device name</dt>
        <dd className="font-mono">{identity.node}</dd>
      </div>
    </dl>
  );
}

/** Heading that receives focus whenever the pairing phase changes. */
function PhaseHeading({ children }: { readonly children: string }) {
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h3 className="font-medium text-sm outline-none" ref={ref} tabIndex={-1}>
      {children}
    </h3>
  );
}

export function PairingPanel({
  phase,
  nowMs,
  hostName,
  onIssueCode,
  onToggleCapability,
  onApprove,
  onDeny,
  onDone,
}: PairingPanelProps) {
  return (
    <section
      aria-label={`Pair a device with ${hostName}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4"
      data-pairing-phase={phase.kind}
    >
      <div aria-live="polite" className="flex min-w-0 flex-col gap-3">
        {phase.kind === "idle" && (
          <>
            <PhaseHeading key="idle">Pair a device with this host</PhaseHeading>
            <p className="text-muted-foreground text-sm">
              A pairing code proves the other device is yours. The code works once, expires in two
              minutes, and grants nothing by itself — you approve what the device may do in the
              next step.
            </p>
            <div>
              <Button onClick={onIssueCode} size="sm">
                Create pairing code
              </Button>
            </div>
          </>
        )}

        {phase.kind === "code-issued" && (
          <>
            <PhaseHeading key="code">Enter this code on the other device</PhaseHeading>
            <div className="flex flex-col items-start gap-1 rounded-lg bg-secondary px-4 py-3">
              <span className="font-mono text-2xl tabular-nums tracking-[0.2em]">{phase.code}</span>
              <span className="text-muted-foreground text-xs tabular-nums">
                Single use · expires in {codeSecondsLeft(phase, nowMs)}s
              </span>
            </div>
            <p className="text-muted-foreground text-sm">
              On the other device, open T4 Code, choose “Pair with a host”, and type
              this code when it asks for one.
            </p>
          </>
        )}

        {phase.kind === "capability-review" && (
          <>
            <PhaseHeading key="review">
              {`${phase.request.deviceLabel} wants access to ${hostName}`}
            </PhaseHeading>
            <div className="flex flex-col gap-1.5 rounded-lg bg-secondary px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{phase.request.deviceLabel}</span>
                <Badge size="sm" variant="outline">
                  {DEVICE_PLATFORM_LABELS[phase.request.platform]}
                </Badge>
              </div>
              <IdentityFacts identity={phase.request.identity} />
              <p className="text-muted-foreground text-xs">
                Identity checked by this host against your tailnet. If this is not your device,
                refuse it.
              </p>
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                It asked for
              </legend>
              {CAPABILITIES.filter((capability) =>
                phase.request.requested.includes(capability.id),
              ).map((capability) => {
                const granted = phase.grant.includes(capability.id);
                const locked = capability.id === "observe";
                return (
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-(--motion-duration-fast) hover:bg-secondary/60",
                      locked && "cursor-default",
                    )}
                    key={capability.id}
                  >
                    <input
                      checked={granted}
                      className="mt-0.5 size-4 accent-primary"
                      disabled={locked}
                      onChange={() => onToggleCapability(capability.id)}
                      type="checkbox"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium text-sm">
                        {capability.label}
                        {locked && (
                          <span className="ps-1.5 font-normal text-muted-foreground text-xs">
                            always included
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground text-xs">{capability.impact}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="flex items-center gap-2">
              <Button onClick={onApprove} size="sm">
                {`Allow ${phase.grant.length} of ${phase.request.requested.length}`}
              </Button>
              <Button onClick={onDeny} size="sm" variant="destructive-outline">
                Refuse this device
              </Button>
            </div>
          </>
        )}

        {phase.kind === "granted" && (
          <>
            <PhaseHeading key="granted">{`${phase.device.label} is paired`}</PhaseHeading>
            <p className="text-sm">
              It can now {capabilityLabels(phase.device.capabilities)} on {hostName}.
            </p>
            <p className="text-muted-foreground text-xs">
              Its credential was handed over once, during pairing, and lives in that device’s
              own keychain. This app never shows it. Revoke the device any time from Paired
              devices.
            </p>
            <div>
              <Button onClick={onDone} size="sm" variant="outline">
                Done
              </Button>
            </div>
          </>
        )}

        {phase.kind === "expired" && (
          <>
            <PhaseHeading key="expired">The pairing code expired</PhaseHeading>
            <p className="text-muted-foreground text-sm">
              {phase.attemptsLeft > 0
                ? "Nothing was granted. Codes last two minutes; create a new one when the other device is ready."
                : `Nothing was granted. ${PAIRING_MAX_ATTEMPTS} codes within an hour is the limit — wait for the hour to pass, then try again.`}
            </p>
            {phase.attemptsLeft > 0 ? (
              <div>
                <Button onClick={onIssueCode} size="sm" variant="outline">
                  Create a new code
                </Button>
              </div>
            ) : (
              <div>
                <Button onClick={onDone} size="sm" variant="ghost">
                  Close
                </Button>
              </div>
            )}
          </>
        )}

        {phase.kind === "identity-mismatch" && (
          <>
            <PhaseHeading key="mismatch">This is not the device you paired</PhaseHeading>
            <div className="flex flex-col gap-2 rounded-lg bg-destructive/8 px-3 py-2.5 dark:bg-destructive/16">
              <p className="text-destructive-foreground text-sm">
                The connection was refused and nothing changed. Someone reachable on your tailnet
                presented a valid credential from a different identity.
              </p>
              <div className="flex flex-col gap-1 text-xs">
                <span>
                  <span className="text-muted-foreground">Pinned at pairing: </span>
                  <span className="font-mono">
                    {phase.pinned.account} · {phase.pinned.node}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground">Presented now: </span>
                  <span className="font-mono">
                    {phase.presented.account} · {phase.presented.node}
                  </span>
                </span>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              If you renamed or reinstalled the device, revoke it and pair again. If not, treat
              the credential as leaked and revoke it now.
            </p>
            <div>
              <Button onClick={onDone} size="sm" variant="outline">
                Review paired devices
              </Button>
            </div>
          </>
        )}

        {phase.kind === "capability-denied" && (
          <>
            <PhaseHeading key="denied">{`${phase.deviceLabel} was refused`}</PhaseHeading>
            <p className="text-muted-foreground text-sm">
              It asked to {capabilityLabels(phase.refused)} and received nothing. It stays
              unpaired and cannot see this host’s sessions.
            </p>
            {canRetry(phase) && (
              <div>
                <Button onClick={onIssueCode} size="sm" variant="outline">
                  Start over with a new code
                </Button>
              </div>
            )}
          </>
        )}

        {phase.kind === "revoked" && (
          <>
            <PhaseHeading key="revoked">{`${phase.deviceLabel} was revoked`}</PhaseHeading>
            <p className="text-muted-foreground text-sm">
              Its credential no longer works and any open connection was closed. Pairing it again
              starts from a fresh code.
            </p>
            <div>
              <Button onClick={onDone} size="sm" variant="outline">
                Done
              </Button>
            </div>
          </>
        )}
      </div>

      <p className="border-border border-t pt-3 text-muted-foreground text-xs">
        {MEMBERSHIP_NOT_TRUST_COPY}
      </p>
    </section>
  );
}
