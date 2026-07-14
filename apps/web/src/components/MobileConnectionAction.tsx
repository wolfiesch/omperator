import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  IconButton,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { Cable } from "lucide-react";
import { useState } from "react";

import {
  clearNativeMobileConnection,
  nativeMobilePlatform,
  readStoredMobileBackend,
} from "../platform/native-mobile.ts";

export function MobileConnectionAction() {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  if (nativeMobilePlatform() === null) return null;

  let origin = "Saved Tailnet host";
  try {
    origin = readStoredMobileBackend()?.origin ?? origin;
  } catch {
    // The setup screen will repair invalid storage on the next launch.
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="Mobile connection"
              className="size-11 sm:size-7"
              onClick={() => setOpen(true)}
              size="icon-sm"
            >
              <Cable />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">Mobile connection</TooltipPopup>
      </Tooltip>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Mobile connection</DialogTitle>
          <DialogDescription>
            This phone connects directly to the T4 gateway below. Changing it also removes the paired device credential from this phone.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-md bg-secondary px-3 py-2 font-mono text-sm">{origin}</p>
        <DialogFooter>
          <DialogClose render={<Button disabled={clearing} size="sm" variant="ghost" />}>
            Keep this host
          </DialogClose>
          <Button
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              void clearNativeMobileConnection()
                .then(() => window.location.reload())
                .catch(() => setClearing(false));
            }}
            size="sm"
            variant="outline"
          >
            {clearing ? "Clearing…" : "Change host"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
