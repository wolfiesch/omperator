import { BrandLockup, Button, Spinner } from "@t4-code/ui";
import { Cable, LockKeyhole, Network } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  parseTailnetBackend,
  probeMobileBackend,
  replaceStoredMobileBackend,
  type StoredMobileBackend,
} from "../platform/native-mobile.ts";

/**
 * Shared Tailnet address form: parse, probe, then persist-and-reload. Used by
 * the first-run screen and the host manager's Add view so address validation
 * and probing never fork. Nothing is written until the probe succeeds, so a
 * cancelled or failed attempt leaves every saved host untouched. `save`
 * decides what a success writes: startup repair replaces broken state, the
 * host manager upserts alongside existing hosts.
 */
type MobileBackendProbe = (
  backend: StoredMobileBackend,
  options: { readonly signal?: AbortSignal },
) => Promise<void>;

/**
 * Probe before persistence, and re-check cancellation after the async boundary.
 * This keeps a closed or backed-out Add view from saving a late probe result.
 */
export async function probeAndSaveMobileBackend(
  backend: StoredMobileBackend,
  io: {
    readonly signal: AbortSignal;
    readonly probe?: MobileBackendProbe;
    readonly save: (backend: StoredMobileBackend) => void;
    readonly reload: () => void;
  },
): Promise<"cancelled" | "saved"> {
  const probe = io.probe ?? probeMobileBackend;
  try {
    await probe(backend, { signal: io.signal });
  } catch (error) {
    if (io.signal.aborted) return "cancelled";
    throw error;
  }
  if (io.signal.aborted) return "cancelled";
  io.save(backend);
  io.reload();
  return "saved";
}

export function TailnetAddressForm({
  cancelSignal,
  initialMessage,
  save,
  submitLabel = "Connect",
}: {
  readonly cancelSignal?: AbortSignal;
  readonly initialMessage?: string;
  readonly save: (backend: StoredMobileBackend) => void;
  readonly submitLabel?: string;
}) {
  const id = useId();
  const [address, setAddress] = useState("");
  const [profileId, setProfileId] = useState("");
  const [clusterOperatorEnabled, setClusterOperatorEnabled] = useState(false);
  const [message, setMessage] = useState<string | null>(initialMessage ?? null);
  const [checking, setChecking] = useState(false);
  const activeProbe = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeProbe.current?.abort();
    },
    [],
  );
  const addressId = `${id}-address`;
  const profileIdId = `${id}-profile`;
  const clusterOperatorId = `${id}-cluster-operator`;
  const helpId = `${id}-help`;
  const statusId = `${id}-status`;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (checking) return;
        setMessage(null);
        let backend;
        try {
          backend = parseTailnetBackend(address, profileId, clusterOperatorEnabled);
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Enter a valid Tailnet address.");
          return;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        cancelSignal?.addEventListener("abort", cancel, { once: true });
        if (cancelSignal?.aborted === true) controller.abort();
        activeProbe.current = controller;
        setChecking(true);
        void probeAndSaveMobileBackend(backend, {
          signal: controller.signal,
          save,
          reload: () => window.location.reload(),
        })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setMessage(error instanceof Error ? error.message : "T4 Code could not reach that host.");
          })
          .finally(() => {
            cancelSignal?.removeEventListener("abort", cancel);
            if (activeProbe.current !== controller) return;
            activeProbe.current = null;
            if (!controller.signal.aborted) setChecking(false);
          });
      }}
    >
      <label className="font-medium text-sm" htmlFor={addressId}>
        Tailnet address
      </label>
      <input
        aria-describedby={`${helpId} ${statusId}`}
        aria-invalid={message !== null}
        autoCapitalize="none"
        autoComplete="url"
        autoCorrect="off"
        className="h-12 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none transition-shadow duration-(--motion-duration-fast) placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        disabled={checking}
        id={addressId}
        inputMode="url"
        onChange={(event) => setAddress(event.target.value)}
        placeholder="https://host.tailnet.ts.net:8445"
        spellCheck={false}
        type="url"
        value={address}
      />
      <label className="font-medium text-sm" htmlFor={profileIdId}>
        Profile ID <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        aria-describedby={helpId}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        className="h-12 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none transition-shadow duration-(--motion-duration-fast) placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        disabled={checking || clusterOperatorEnabled}
        id={profileIdId}
        onChange={(event) => setProfileId(event.target.value)}
        placeholder="default route"
        spellCheck={false}
        value={profileId}
      />
      <label
        className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5"
        htmlFor={clusterOperatorId}
      >
        <input
          checked={clusterOperatorEnabled}
          className="mt-0.5 size-4 accent-primary"
          disabled={checking}
          id={clusterOperatorId}
          onChange={(event) => {
            setClusterOperatorEnabled(event.target.checked);
            if (event.target.checked) setProfileId("");
          }}
          type="checkbox"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-sm">Cluster operator endpoint</span>
          <span className="text-muted-foreground text-xs">
            Request cluster workspaces only from this secure WSS host.
          </span>
        </span>
      </label>
      <p className="text-muted-foreground text-xs leading-relaxed" id={helpId}>
        Use the full HTTPS address shown by the T4 gateway on your computer.
      </p>
      <p
        aria-live="polite"
        className="min-h-5 text-destructive-foreground text-sm"
        id={statusId}
        role={message === null ? undefined : "alert"}
      >
        {message}
      </p>
      <Button className="mt-1 h-12 w-full text-base" disabled={checking} size="lg" type="submit">
        {checking && <Spinner />}
        {checking ? "Checking host…" : submitLabel}
      </Button>
    </form>
  );
}

export function MobileConnectionScreen({ startupMessage }: { readonly startupMessage?: string }) {
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center border-border border-b px-4 pt-(--app-safe-area-top)">
        <BrandLockup />
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center pt-10 pr-[max(1.25rem,var(--app-safe-area-right))] pb-[calc(2.5rem+var(--app-safe-area-bottom))] pl-[max(1.25rem,var(--app-safe-area-left))]">
        <div className="mb-8 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Cable aria-hidden="true" className="size-5" />
        </div>
        <h1 className="text-balance font-heading font-semibold text-2xl">Connect to your T4 host</h1>
        <p className="mt-2 max-w-[62ch] text-pretty text-muted-foreground text-sm leading-relaxed">
          T4 Code runs the interface on this phone. OMP and your projects stay on your computer.
        </p>

        <div className="mt-8">
          <TailnetAddressForm
            save={replaceStoredMobileBackend}
            {...(startupMessage === undefined ? {} : { initialMessage: startupMessage })}
          />
        </div>

        <div className="mt-9 divide-y divide-border border-border border-y">
          <div className="flex gap-3 py-3.5">
            <Network aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed">
              Open Tailscale on this phone and connect to the same tailnet as your computer.
            </p>
          </div>
          <div className="flex gap-3 py-3.5">
            <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed">
              If the host asks to pair, T4 Code will show the exact command and six-digit code flow.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
