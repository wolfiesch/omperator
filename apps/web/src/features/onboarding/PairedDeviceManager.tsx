// Paired devices: what each device is, which account it belongs to, when it
// was last seen, and exactly what it may do — with revoke one click away
// behind a confirmation that names the impact. Focus returns to a sensible
// row after the dialog closes, however it closes.
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@t4-code/ui";
import { useState } from "react";

import { GroupLabel } from "./bits.tsx";
import {
  buildRevokeConfirmation,
  focusAfterRevoke,
  type RevokeConfirmation,
} from "./devices.ts";
import {
  CAPABILITY_BY_ID,
  DEVICE_PLATFORM_LABELS,
  formatLastSeen,
  type PairedDevice,
} from "./model.ts";

export interface PairedDeviceManagerProps {
  readonly devices: readonly PairedDevice[];
  /** Safe display name of the host these devices are paired with. */
  readonly hostName: string;
  /** Deterministic clock for "last seen" labels. */
  readonly nowMs: number;
  readonly onRevoke: (deviceId: string) => void;
}

function DeviceRow({
  device,
  nowMs,
  onRequestRevoke,
}: {
  readonly device: PairedDevice;
  readonly nowMs: number;
  readonly onRequestRevoke: (device: PairedDevice, buttonId: string) => void;
}) {
  const revokeButtonId = `revoke-device-${device.id}`;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{device.label}</span>
        <Badge size="sm" variant="outline">
          {DEVICE_PLATFORM_LABELS[device.platform]}
        </Badge>
        <span className="shrink-0 text-muted-foreground text-xs">
          {device.connected ? "Connected" : formatLastSeen(device.lastSeenAt, nowMs)}
        </span>
      </div>
      <p className="truncate font-mono text-muted-foreground text-xs">
        {device.identity.account} · {device.identity.node}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {device.capabilities.map((capability) => (
          <Badge key={capability} size="sm" variant="secondary">
            {CAPABILITY_BY_ID[capability].label}
          </Badge>
        ))}
        <span className="flex-1" />
        <Button
          id={revokeButtonId}
          onClick={() => onRequestRevoke(device, revokeButtonId)}
          size="xs"
          variant="destructive-outline"
        >
          Revoke
        </Button>
      </div>
    </li>
  );
}

export function PairedDeviceManager({
  devices,
  hostName,
  nowMs,
  onRevoke,
}: PairedDeviceManagerProps) {
  const [pending, setPending] = useState<RevokeConfirmation | null>(null);

  const closeDialog = (confirmed: boolean) => {
    if (pending === null) return;
    const focusId = confirmed
      ? focusAfterRevoke(devices, pending.deviceId)
      : pending.returnFocusId;
    if (confirmed) onRevoke(pending.deviceId);
    setPending(null);
    // The opener row may be gone after a revoke; fall back per the model.
    requestAnimationFrame(() => {
      (document.getElementById(focusId) ?? document.getElementById("paired-device-list"))?.focus();
    });
  };

  return (
    <section aria-labelledby="paired-devices-heading" className="flex min-w-0 flex-col gap-1.5">
      <GroupLabel id="paired-devices-heading">{`Paired with ${hostName}`}</GroupLabel>
      {devices.length === 0 ? (
        <p className="rounded-lg border border-border border-dashed px-3 py-4 text-center text-muted-foreground text-sm">
          Nothing is paired with this host. Pairing starts with a code you create here, so nothing
          can add itself.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 outline-none" id="paired-device-list" tabIndex={-1}>
          {devices.map((device) => (
            <DeviceRow
              device={device}
              key={device.id}
              nowMs={nowMs}
              onRequestRevoke={(target, buttonId) =>
                setPending(buildRevokeConfirmation(target, hostName, buttonId))
              }
            />
          ))}
        </ul>
      )}
      {pending !== null && (
        <Dialog onOpenChange={(open) => (open ? undefined : closeDialog(false))} open>
          <DialogPopup aria-label={pending.title} className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base">{pending.title}</DialogTitle>
              <DialogDescription>{pending.body}</DialogDescription>
            </DialogHeader>
            <DialogFooter variant="bare">
              <Button onClick={() => closeDialog(false)} size="sm" variant="ghost">
                Keep it paired
              </Button>
              <Button onClick={() => closeDialog(true)} size="sm" variant="destructive">
                {pending.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </section>
  );
}
