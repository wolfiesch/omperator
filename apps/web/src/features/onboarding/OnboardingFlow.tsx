// First-run flow: three task-led stages rendered from the pure machine in
// flow.ts. The component owns nothing but presentation — every service and
// pairing side effect flows out through intent props, and success states
// render only when the view model says so. Focus follows stage changes via
// the machine's focusTarget.
import { Button, cn, OmpMark } from "@t4-code/ui";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ToneBadge } from "./bits.tsx";
import {
  advance,
  blockedReason,
  canFinish,
  goBack,
  ONBOARDING_STAGES,
  type OnboardingStage,
  type OnboardingState,
  type ResumeBehavior,
  STAGE_INFO,
  stepperItems,
} from "./flow.ts";
import { HostConnectionMenu } from "./HostConnectionMenu.tsx";
import type { HostActionId } from "./hosts.ts";
import type { CapabilityId } from "./model.ts";
import type { PairingPhase } from "./pairing.ts";
import { PairingPanel } from "./PairingPanel.tsx";
import { SERVICE_STATUS_META, type ServiceViewModel } from "./service.ts";

export interface OnboardingFlowProps {
  readonly state: OnboardingState;
  readonly onStateChange: (state: OnboardingState) => void;
  /** Called with the completed defaults when the last stage finishes. */
  readonly onFinish: (state: OnboardingState) => void;
  /** Service intents; the desktop backend owns the real work. */
  readonly onInstallService: () => void;
  readonly onStartService: () => void;
  readonly onRecheckService: () => void;
  /** Hand the safe diagnostic evidence to the diagnostics surface. */
  readonly onOpenDiagnostics: (lines: readonly string[]) => void;
  /** Host menu intents. */
  readonly onOpenHost: (hostId: string) => void;
  readonly onHostAction: (hostId: string, action: HostActionId) => void;
  readonly onAddHost: () => void;
  /** Pairing surface state and intents (stage 2 inline panel). */
  readonly pairing: PairingPhase;
  readonly nowMs: number;
  readonly onIssueCode: () => void;
  readonly onTogglePairingCapability: (capability: CapabilityId) => void;
  readonly onApprovePairing: () => void;
  readonly onDenyPairing: () => void;
  readonly onPairingDone: () => void;
  /** Project labels offered on the defaults stage. */
  readonly projectChoices: readonly string[];
}

function Stepper({ stage }: { readonly stage: OnboardingStage }) {
  return (
    <ol aria-label="Setup progress" className="flex flex-col gap-0.5">
      {stepperItems(stage).map((item, index) => (
        <li
          aria-current={item.state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
            item.state === "current" && "bg-secondary font-medium",
            item.state === "upcoming" && "text-muted-foreground",
          )}
          key={item.id}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
              item.state === "done" && "border-transparent bg-primary text-primary-foreground",
              item.state === "current" && "border-primary text-foreground",
              item.state === "upcoming" && "border-border",
            )}
          >
            {item.state === "done" ? <CheckIcon className="size-3" /> : index + 1}
          </span>
          <span className="min-w-0">{STAGE_INFO[item.id].title}</span>
          {item.state === "done" && <span className="sr-only">(done)</span>}
        </li>
      ))}
    </ol>
  );
}

function ServiceCard({
  service,
  remoteOnly,
  onRemoteOnlyChange,
  onInstallService,
  onStartService,
  onRecheckService,
  onOpenDiagnostics,
}: {
  readonly service: ServiceViewModel;
  readonly remoteOnly: boolean;
  readonly onRemoteOnlyChange: (remoteOnly: boolean) => void;
  readonly onInstallService: () => void;
  readonly onStartService: () => void;
  readonly onRecheckService: () => void;
  readonly onOpenDiagnostics: (lines: readonly string[]) => void;
}) {
  const meta = SERVICE_STATUS_META[service.status];
  const failed = service.status === "install-failed" || service.status === "start-failed";
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5"
        data-service-status={service.status}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">Local T4 host</span>
          <ToneBadge label={meta.label} live={meta.live} tone={meta.tone} />
        </div>
        <p className={cn("text-xs", failed ? "text-destructive-foreground" : "text-muted-foreground")}>
          {service.detail}
        </p>
        {failed && service.diagnostics.length > 0 && (
          <ul className="flex flex-col gap-0.5 rounded-md bg-secondary px-2.5 py-2 font-mono text-muted-foreground text-xs">
            {service.diagnostics.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {service.status === "not-installed" && (
            <Button onClick={onInstallService} size="xs">
              Install the service
            </Button>
          )}
          {service.status === "stopped" && (
            <Button onClick={onStartService} size="xs">
              Start it
            </Button>
          )}
          {failed && (
            <>
              <Button
                onClick={service.status === "install-failed" ? onInstallService : onStartService}
                size="xs"
                variant="outline"
              >
                Try again
              </Button>
              <Button
                onClick={() => onOpenDiagnostics(service.diagnostics)}
                size="xs"
                variant="ghost"
              >
                Open diagnostics
              </Button>
            </>
          )}
          {(service.status === "running" || service.status === "stopped") && (
            <Button onClick={onRecheckService} size="xs" variant="ghost">
              Check again
            </Button>
          )}
        </div>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 px-1">
        <input
          checked={remoteOnly}
          className="mt-0.5 size-4 accent-primary"
          onChange={(event) => onRemoteOnlyChange(event.target.checked)}
          type="checkbox"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-sm">Skip the local runtime</span>
          <span className="text-muted-foreground text-xs">
            Use only hosts you pair over Tailscale. Nothing runs on this computer until you come
            back to this in Settings.
          </span>
        </span>
      </label>
    </div>
  );
}

function DefaultsStage({
  state,
  projectChoices,
  onStateChange,
}: {
  readonly state: OnboardingState;
  readonly projectChoices: readonly string[];
  readonly onStateChange: (state: OnboardingState) => void;
}) {
  const resumeOptions: readonly { readonly id: ResumeBehavior; readonly label: string; readonly detail: string }[] = [
    {
      id: "resume-last",
      label: "Reopen my last session",
      detail: "Land back where you left off, scroll position included.",
    },
    {
      id: "ask",
      label: "Show the session list",
      detail: "Start at the overview and pick a session yourself.",
    },
    {
      id: "start-fresh",
      label: "Start a new session",
      detail: "Open a fresh session in the default project every time.",
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Default project
        </legend>
        {[...projectChoices, null].map((choice) => (
          <label
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-(--motion-duration-fast) hover:bg-secondary/60"
            key={choice ?? "__ask"}
          >
            <input
              checked={state.defaults.defaultProject === choice}
              className="size-4 accent-primary"
              name="default-project"
              onChange={() =>
                onStateChange({
                  ...state,
                  defaults: { ...state.defaults, defaultProject: choice },
                })
              }
              type="radio"
            />
            <span className={cn("text-sm", choice !== null && "font-mono")}>
              {choice ?? "Ask each time"}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          When the app opens
        </legend>
        {resumeOptions.map((option) => (
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-(--motion-duration-fast) hover:bg-secondary/60"
            key={option.id}
          >
            <input
              checked={state.defaults.resume === option.id}
              className="mt-0.5 size-4 accent-primary"
              name="resume-behavior"
              onChange={() =>
                onStateChange({ ...state, defaults: { ...state.defaults, resume: option.id } })
              }
              type="radio"
            />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-sm">{option.label}</span>
              <span className="text-muted-foreground text-xs">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

export function OnboardingFlow({
  state,
  onStateChange,
  onFinish,
  onInstallService,
  onStartService,
  onRecheckService,
  onOpenDiagnostics,
  onOpenHost,
  onHostAction,
  onAddHost,
  pairing,
  nowMs,
  onIssueCode,
  onTogglePairingCapability,
  onApprovePairing,
  onDenyPairing,
  onPairingDone,
  projectChoices,
}: OnboardingFlowProps) {
  const [pairingOpen, setPairingOpen] = useState(false);
  const info = STAGE_INFO[state.stage];
  const blocked = blockedReason(state);
  const isLast = state.stage === ONBOARDING_STAGES[ONBOARDING_STAGES.length - 1];
  const isFirst = state.stage === ONBOARDING_STAGES[0];

  // The machine names the element that should hold focus after a stage
  // change; apply it exactly once per target.
  useEffect(() => {
    if (state.focusTarget !== null) document.getElementById(state.focusTarget)?.focus();
  }, [state.focusTarget]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 justify-center overflow-y-auto">
      <div className="flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <OmpMark className="h-6 w-auto shrink-0" title={null} />
            <h1 className="font-heading font-semibold text-xl">Set up T4 Code</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Powered by Oh My Pi. Three things and you are in a session. Everything here can change
            later in Settings.
          </p>
        </header>

        <div className="flex flex-col gap-6 md:flex-row">
          <nav aria-label="Setup stages" className="shrink-0 md:w-60">
            <Stepper stage={state.stage} />
          </nav>

          <section aria-labelledby={`onboarding-stage-${state.stage}`} className="min-w-0 flex-1">
            <div className="flex flex-col gap-1 pb-4">
              <h2
                className="font-medium text-base outline-none"
                id={`onboarding-stage-${state.stage}`}
                tabIndex={-1}
              >
                {info.title}
              </h2>
              <p className="text-muted-foreground text-sm">{info.task}</p>
            </div>

            {state.stage === "runtime" && (
              <ServiceCard
                onInstallService={onInstallService}
                onOpenDiagnostics={onOpenDiagnostics}
                onRecheckService={onRecheckService}
                onRemoteOnlyChange={(remoteOnly) => onStateChange({ ...state, remoteOnly })}
                onStartService={onStartService}
                remoteOnly={state.remoteOnly}
                service={state.service}
              />
            )}

            {state.stage === "hosts" && (
              <div className="flex flex-col gap-4">
                <HostConnectionMenu
                  hosts={state.hosts}
                  onAddHost={onAddHost}
                  onHostAction={onHostAction}
                  onOpenHost={onOpenHost}
                />
                <div className="flex flex-col gap-2">
                  {!pairingOpen ? (
                    <button
                      className="self-start text-muted-foreground text-xs underline-offset-4 transition-colors duration-(--motion-duration-fast) hover:text-foreground hover:underline"
                      onClick={() => setPairingOpen(true)}
                      type="button"
                    >
                      Also want your phone or laptop to reach this computer? Pair it now.
                    </button>
                  ) : (
                    <PairingPanel
                      hostName="This computer"
                      nowMs={nowMs}
                      onApprove={onApprovePairing}
                      onDeny={onDenyPairing}
                      onDone={onPairingDone}
                      onIssueCode={onIssueCode}
                      onToggleCapability={onTogglePairingCapability}
                      phase={pairing}
                    />
                  )}
                </div>
              </div>
            )}

            {state.stage === "defaults" && (
              <DefaultsStage
                onStateChange={onStateChange}
                projectChoices={projectChoices}
                state={state}
              />
            )}

            <footer className="flex items-center gap-2 pt-6">
              {!isFirst && (
                <Button onClick={() => onStateChange(goBack(state))} size="sm" variant="ghost">
                  Back
                </Button>
              )}
              <span className="flex-1" />
              {blocked !== null && (
                <span className="text-muted-foreground text-xs" role="status">
                  {blocked}
                </span>
              )}
              {isLast ? (
                <Button disabled={!canFinish(state)} onClick={() => onFinish(state)} size="sm">
                  Finish setup
                </Button>
              ) : (
                <Button
                  disabled={blocked !== null}
                  onClick={() => onStateChange(advance(state))}
                  size="sm"
                >
                  Continue
                </Button>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
