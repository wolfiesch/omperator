// One DesktopRuntimeController per window. The slot lives on globalThis so
// StrictMode double-invocation and Vite HMR module swaps reuse the same
// controller and its listeners instead of stacking duplicates. Browser-direct
// mode uses the same controller with a browser shell port; no-config browser
// mode has no shell and keeps the fixture path.
import {
  createDesktopRuntimeController,
  createProjectionStore,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
  type DesktopShellPort,
  type ProjectionCacheStore,
} from "@t4-code/client";
import { useSyncExternalStore } from "react";

import { bindAuthoritativeComposerCleanup } from "../features/composer/authoritative-cleanup.ts";
import { rendererPlatform } from "../state/store-instance.ts";

const RUNTIME_SLOT = Symbol.for("t4-code.web.desktop-runtime");

interface RuntimeSlot {
  controller: DesktopRuntimeController;
  disposeComposerCleanup: () => void;
  disposePageLifecycle?: () => void;
  started: boolean;
}

export interface RuntimePageLifecycleTarget {
  addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
}

/** Anything that can carry the window's runtime slot (globalThis in prod). */
export type RuntimeSlotHolder = object & { [RUNTIME_SLOT]?: RuntimeSlot };

function projectionCacheStore(shell: DesktopShellPort): ProjectionCacheStore | undefined {
  const load = shell.loadProjectionCache?.bind(shell);
  const save = shell.saveProjectionCache?.bind(shell);
  if (load === undefined || save === undefined) return undefined;
  let cacheAvailable: boolean | undefined;
  return {
    load: async () => {
      const result = await load();
      cacheAvailable = result.available;
      return result.available ? result.value : null;
    },
    save: async (value) => {
      if (cacheAvailable === false) return;
      const result = await save({ value });
      if (!result.saved) throw new Error("projection cache save failed");
    },
  };
}

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
    const cacheStore = projectionCacheStore(shell);
    const controller = createDesktopRuntimeController({
      shell,
      clusterOperatorEnabled: shell.clusterOperatorEnabled === true,
      ...(cacheStore === undefined
        ? {}
        : { projection: createProjectionStore({ cacheStore }) }),
    });
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
export function startRuntimeController(
  shell: DesktopShellPort,
  holder: RuntimeSlotHolder,
  pageTarget: RuntimePageLifecycleTarget | null =
    typeof window === "undefined" ? null : window,
): void {
  const controller = acquireRuntimeController(shell, holder);
  const slot = holder[RUNTIME_SLOT];
  if (slot === undefined || slot.started) return;
  slot.started = true;
  void controller.start().catch(() => {
    // Recorded in snapshot.runtimeErrors / startState by the controller.
  });
  if (pageTarget !== null && slot.disposePageLifecycle === undefined) {
    const onPageHide: EventListener = (event) => {
      // A persisted page is entering the back/forward cache. Its controller,
      // shell, subscriptions, and cursor state must survive until pageshow.
      if (Reflect.get(event, "persisted") === true) return;
      slot.disposePageLifecycle?.();
      slot.disposeComposerCleanup();
      void controller.stop();
      if (holder[RUNTIME_SLOT] === slot) delete holder[RUNTIME_SLOT];
    };
    const onPageShow: EventListener = () => {
      // Browser-direct connection wake-up is owned by browser-shell-port.
      // Keeping this listener paired with pagehide documents that persisted
      // restores intentionally retain the same runtime slot.
    };
    slot.disposePageLifecycle = () => {
      pageTarget.removeEventListener("pagehide", onPageHide);
      pageTarget.removeEventListener("pageshow", onPageShow);
      delete slot.disposePageLifecycle;
    };
    pageTarget.addEventListener("pagehide", onPageHide);
    pageTarget.addEventListener("pageshow", onPageShow);
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
