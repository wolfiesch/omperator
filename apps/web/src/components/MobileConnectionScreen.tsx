import { BrandLockup, Button, Spinner } from "@t4-code/ui";
import { Cable, LockKeyhole, Network } from "lucide-react";
import { useState } from "react";

import {
  parseTailnetBackend,
  probeMobileBackend,
  writeStoredMobileBackend,
} from "../platform/native-mobile.ts";

export function MobileConnectionScreen({ startupMessage }: { readonly startupMessage?: string }) {
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(startupMessage ?? null);
  const [checking, setChecking] = useState(false);

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center border-border border-b px-4 pt-[env(safe-area-inset-top)]">
        <BrandLockup />
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-10">
        <div className="mb-8 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Cable aria-hidden="true" className="size-5" />
        </div>
        <h1 className="text-balance font-heading font-semibold text-2xl">Connect to your T4 host</h1>
        <p className="mt-2 max-w-[62ch] text-pretty text-muted-foreground text-sm leading-relaxed">
          T4 Code runs the interface on this phone. OMP and your projects stay on your computer.
        </p>

        <form
          className="mt-8 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (checking) return;
            setMessage(null);
            let backend;
            try {
              backend = parseTailnetBackend(address);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : "Enter a valid Tailnet address.");
              return;
            }
            setChecking(true);
            void probeMobileBackend(backend)
              .then(() => {
                writeStoredMobileBackend(backend);
                window.location.reload();
              })
              .catch((error: unknown) => {
                setMessage(error instanceof Error ? error.message : "T4 Code could not reach that host.");
                setChecking(false);
              });
          }}
        >
          <label className="font-medium text-sm" htmlFor="mobile-tailnet-address">
            Tailnet address
          </label>
          <input
            aria-describedby="mobile-tailnet-help mobile-tailnet-status"
            aria-invalid={message !== null}
            autoCapitalize="none"
            autoComplete="url"
            autoCorrect="off"
            className="h-12 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none transition-shadow duration-(--motion-duration-fast) placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            disabled={checking}
            id="mobile-tailnet-address"
            inputMode="url"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://your-computer.your-tailnet.ts.net:8445"
            spellCheck={false}
            type="url"
            value={address}
          />
          <p className="text-muted-foreground text-xs leading-relaxed" id="mobile-tailnet-help">
            Use the full HTTPS address shown by the T4 gateway on your computer.
          </p>
          <p
            aria-live="polite"
            className="min-h-5 text-destructive-foreground text-sm"
            id="mobile-tailnet-status"
            role={message === null ? undefined : "alert"}
          >
            {message}
          </p>
          <Button className="mt-1 h-12 w-full text-base" disabled={checking} size="lg" type="submit">
            {checking && <Spinner />}
            {checking ? "Checking host…" : "Connect"}
          </Button>
        </form>

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
