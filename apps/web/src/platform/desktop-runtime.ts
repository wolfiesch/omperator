// One DesktopRuntimeController per window. The slot lives on globalThis so
// StrictMode double-invocation and Vite HMR module swaps reuse the same
// controller and its listeners instead of stacking duplicates. Browser-direct
// mode uses the same controller with a browser shell port; no-config browser
// mode has no shell and keeps the fixture path.
import {
  createDesktopRuntimeController,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
  type DesktopShellPort,
} from "@t4-code/client";
import { useSyncExternalStore } from "react";

import { bindAuthoritativeComposerCleanup } from "../features/composer/authoritative-cleanup.ts";
import { rendererPlatform } from "../state/store-instance.ts";

const RUNTIME_SLOT = Symbol.for("t4-code.web.desktop-runtime");

interface RuntimeSlot {
  controller: DesktopRuntimeController;
  disposeComposerCleanup: () => void;
  started: boolean;
}

/** Anything that can carry the window's runtime slot (globalThis in prod). */
export type RuntimeSlotHolder = object & { [RUNTIME_SLOT]?: RuntimeSlot };

/**
 * The holder's controller, created on first acquisition and reused for
 * every later call — including StrictMode's doubled render pass and HMR
 * module swaps, which see the same slot on the same holder.
 */
export function acquireRuntimeController(
  shell: DesktopShellPort,
  holder: RuntimeSlotHolder,
): DesktopRuntimeController {
  let slot = holder[RUNTIME_SLOT];
  if (slot === undefined) {
    const controller = createDesktopRuntimeController({ shell });
    slot = {
      controller,
      disposeComposerCleanup: bindAuthoritativeComposerCleanup(controller),
      started: false,
    };
    holder[RUNTIME_SLOT] = slot;
  }
  return slot.controller;
}

/**
 * Start the holder's controller exactly once. Safe to call from a
 * StrictMode-doubled effect: the slot flag (and the controller's own start
 * memoization) make every call after the first a no-op. Start failures are
 * not thrown — they are already recorded in the runtime snapshot the shell
 * renders.
 */
export function startRuntimeController(shell: DesktopShellPort, holder: RuntimeSlotHolder): void {
  const controller = acquireRuntimeController(shell, holder);
  const slot = holder[RUNTIME_SLOT];
  if (slot === undefined || slot.started) return;
  slot.started = true;
  void controller.start().catch(() => {
    // Recorded in snapshot.runtimeErrors / startState by the controller.
  });
  if (typeof window !== "undefined") {
    window.addEventListener(
      "pagehide",
      () => {
        slot.disposeComposerCleanup();
        void controller.stop();
        delete holder[RUNTIME_SLOT];
      },
      { once: true },
    );
  }
}

/** The window's runtime controller; null outside the desktop shell. */
export function desktopRuntime(): DesktopRuntimeController | null {
  const shell = rendererPlatform.shell;
  if (shell === null) return null;
  return acquireRuntimeController(shell, globalThis as RuntimeSlotHolder);
}

/** Start the window's runtime once; no-op in the browser. */
export function startDesktopRuntime(): void {
  const shell = rendererPlatform.shell;
  if (shell === null) return;
  startRuntimeController(shell, globalThis as RuntimeSlotHolder);
}

const subscribeNoop = () => () => undefined;
const getNull = () => null;

// Stable per-controller store bindings so useSyncExternalStore never
// resubscribes on re-render (a fresh closure per render would).
interface StoreBinding {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => DesktopRuntimeSnapshot;
}
const bindings = new WeakMap<DesktopRuntimeController, StoreBinding>();

/** Live runtime snapshot, or null in the browser. */
export function useDesktopRuntimeSnapshot(): DesktopRuntimeSnapshot | null {
  const controller = desktopRuntime();
  let binding: StoreBinding | undefined;
  if (controller !== null) {
    binding = bindings.get(controller);
    if (binding === undefined) {
      binding = {
        subscribe: (onChange) => controller.subscribe(onChange),
        getSnapshot: () => controller.getSnapshot(),
      };
      bindings.set(controller, binding);
    }
  }
  return useSyncExternalStore(
    binding?.subscribe ?? subscribeNoop,
    binding?.getSnapshot ?? getNull,
  );
}
