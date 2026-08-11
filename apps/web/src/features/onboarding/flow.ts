// First-run flow machine: three task-led stages — get the runtime running,
// add a host, choose how sessions open. Pure data + transitions; the
// component renders it and the tests hold the guards. Advancing is earned:
// every stage states exactly what is missing while its guard fails.
import { type HostRow, hostIsUsable } from "./hosts.ts";
import type { ServiceViewModel } from "./service.ts";

export type OnboardingStage = "runtime" | "hosts" | "defaults";

export const ONBOARDING_STAGES: readonly OnboardingStage[] = ["runtime", "hosts", "defaults"];

export interface StageInfo {
  readonly id: OnboardingStage;
  readonly title: string;
  readonly task: string;
}

export const STAGE_INFO: Readonly<Record<OnboardingStage, StageInfo>> = {
  runtime: {
    id: "runtime",
    title: "Get the runtime running",
    task: "The app talks to a local T4 host backed by OMP. Check for one, or install it as a service.",
  },
  hosts: {
    id: "hosts",
    title: "Add a host",
    task: "Sessions live on hosts. Use this computer, or pair another computer.",
  },
  defaults: {
    id: "defaults",
    title: "Choose how sessions open",
    task: "Pick what happens when the app starts. You can change any of this later in Settings.",
  },
};

export type ResumeBehavior = "resume-last" | "ask" | "start-fresh";

export interface SessionDefaults {
  /** Safe display label of the default project; null = pick per session. */
  readonly defaultProject: string | null;
  readonly resume: ResumeBehavior;
}

export interface OnboardingState {
  readonly stage: OnboardingStage;
  readonly service: ServiceViewModel;
  /** User explicitly chose to run without a local T4 host. */
  readonly remoteOnly: boolean;
  readonly hosts: readonly HostRow[];
  readonly defaults: SessionDefaults;
  /**
   * Element id that should hold focus after the last transition; the
   * component applies it, tests assert it. Null = leave focus alone.
   */
  readonly focusTarget: string | null;
}

export function createOnboarding(
  service: ServiceViewModel,
  hosts: readonly HostRow[] = [],
): OnboardingState {
  return {
    stage: "runtime",
    service,
    remoteOnly: false,
    hosts,
    defaults: { defaultProject: null, resume: "resume-last" },
    focusTarget: null,
  };
}

/**
 * Why Continue is disabled, or null when the stage guard passes. The copy
 * doubles as the inline hint next to the disabled button.
 */
export function blockedReason(state: OnboardingState): string | null {
  switch (state.stage) {
    case "runtime":
      if (state.service.status === "running" || state.remoteOnly) return null;
      return "Continue once the T4 host is running, or choose to use remote hosts only.";
    case "hosts":
      if (state.hosts.some((host) => hostIsUsable(host.state))) return null;
      if (state.hosts.length === 0) {
        return "Add at least one host first.";
      }
      return "None of your hosts is reachable yet. Fix one, or add another.";
    case "defaults":
      return null;
  }
}

/** Move forward when the guard passes; otherwise return the state as is. */
export function advance(state: OnboardingState): OnboardingState {
  if (blockedReason(state) !== null) return state;
  const index = ONBOARDING_STAGES.indexOf(state.stage);
  const next = ONBOARDING_STAGES[index + 1];
  if (next === undefined) return state;
  return { ...state, stage: next, focusTarget: `onboarding-stage-${next}` };
}

/** Going back is always allowed and never loses stage data. */
export function goBack(state: OnboardingState): OnboardingState {
  const index = ONBOARDING_STAGES.indexOf(state.stage);
  const previous = ONBOARDING_STAGES[index - 1];
  if (previous === undefined) return state;
  return { ...state, stage: previous, focusTarget: `onboarding-stage-${previous}` };
}

/** Final-stage guard: the whole flow is complete only from "defaults". */
export function canFinish(state: OnboardingState): boolean {
  return state.stage === "defaults" && blockedReason(state) === null;
}

export type StepperItemState = "done" | "current" | "upcoming";

/** Stepper projection: which of the three stages is done/current/upcoming. */
export function stepperItems(
  stage: OnboardingStage,
): readonly { readonly id: OnboardingStage; readonly state: StepperItemState }[] {
  const current = ONBOARDING_STAGES.indexOf(stage);
  return ONBOARDING_STAGES.map((id, index) => ({
    id,
    state: index < current ? "done" : index === current ? "current" : "upcoming",
  }));
}
