import { Badge, Button, Spinner } from "@t4-code/ui";
import { Download, RefreshCw, RotateCw } from "lucide-react";

import {
  actionForUpdate,
  defaultUpdateMessage,
  formatUpdateTimestamp,
  type AppUpdateState,
  updateStatusLabel,
} from "./update-model.ts";
import { appUpdateController } from "./update-store.ts";

export function UpdateSettingsPanel({ state }: { readonly state: AppUpdateState }) {
  const action = actionForUpdate(state);
  const checked = formatUpdateTimestamp(state.checkedAt);
  const progress = state.phase === "downloading" ? (state.progressPercent ?? null) : null;
  const runAction = () => {
    if (action.kind === "download") void appUpdateController.download();
    else if (action.kind === "restart") void appUpdateController.restart();
    else void appUpdateController.check();
  };

  return (
    <section aria-labelledby="section-t4-updates">
      <div className="mb-2 flex flex-col gap-0.5">
        <h2 className="font-heading font-semibold text-foreground text-sm" id="section-t4-updates" tabIndex={-1}>
          Updates
        </h2>
        <p className="max-w-[70ch] text-muted-foreground text-xs">
          Keep T4 Code current on your schedule. Checks are quiet; downloads, installs, and restarts stay in your control.
        </p>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="font-medium text-foreground text-sm">T4 Code</h3>
              <Badge variant={state.phase === "error" ? "error" : state.phase === "current" ? "success" : "outline"}>
                {updateStatusLabel(state)}
              </Badge>
            </div>
            <p aria-live="polite" className="mt-1 max-w-[70ch] text-muted-foreground text-xs leading-relaxed" role="status">
              {defaultUpdateMessage(state)}
            </p>
            {checked !== null && (
              <p className="mt-1 text-muted-foreground text-xs">Last checked {checked}</p>
            )}
          </div>

          <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-3 gap-y-1 text-xs sm:min-w-44">
            <dt className="text-muted-foreground">Installed</dt>
            <dd className="text-end font-mono text-foreground">v{state.currentVersion}</dd>
            {state.availableVersion !== undefined && (
              <>
                <dt className="text-muted-foreground">Available</dt>
                <dd className="text-end font-mono text-foreground">v{state.availableVersion}</dd>
              </>
            )}
          </dl>
        </div>

        {progress !== null && (
          <div className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-4 text-xs">
              <span className="text-muted-foreground">Downloading update for verification</span>
              <span className="font-mono text-foreground">{Math.round(progress)}%</span>
            </div>
            <div
              aria-label="Update download progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(progress)}
              className="h-1.5 overflow-hidden rounded-full bg-secondary"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-(--motion-duration-slow) motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {state.releaseNotes !== undefined && state.availableVersion !== undefined && (
          <div className="px-4 py-3">
            <h3 className="font-medium text-foreground text-xs">What’s new in v{state.availableVersion}</h3>
            <p className="mt-1 max-w-[70ch] whitespace-pre-line text-muted-foreground text-xs leading-relaxed">
              {state.releaseNotes}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-[62ch] text-muted-foreground text-xs">
            {state.delivery === "android"
              ? "T4 Code keeps the APK private, verifies its bytes, identity, version, and signer, then Android asks before replacing this installation."
              : state.delivery === "web"
                ? "No package is installed in a browser; the deployment provides the application."
                : "T4 Code selects the release package that matches this installation."}
          </p>
          <Button
            className="min-h-11 w-full shrink-0 sm:min-h-8 sm:w-auto"
            disabled={action.busy}
            onClick={runAction}
            size="sm"
            variant={state.phase === "available" || state.phase === "manual" || state.phase === "ready" ? "default" : "outline"}
          >
            {action.busy ? (
              <Spinner />
            ) : action.kind === "restart" ? (
              <RotateCw />
            ) : action.kind === "download" ? (
              <Download />
            ) : (
              <RefreshCw />
            )}
            {action.label}
          </Button>
        </div>
      </div>
    </section>
  );
}
