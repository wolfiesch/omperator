// Action state for the hosts screen. Runtime truth (targets, connection
// states, granted capabilities) always comes from the DesktopRuntimeController
// snapshot; this store owns only what the renderer legitimately owns — form
// drafts, pair-code drafts, per-target busy/error state, the remove
// confirmation, requested-capability records, and the serialized local
// service actions. Nothing here reports success it did not see.
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { redactedMessage } from "@t4-code/client";

import type {
  ConnectResult,
  DesktopTarget,
  DisconnectResult,
  LocalProfile,
  LocalProfileAddRequest,
  LocalProfileRemoveResult,
  LocalProfileUpdateRequest,
  PairResult,
  ServiceActionResult,
  ServiceInspection,
  TargetAddRequest,
  TargetRemoveResult,
} from "@t4-code/protocol/desktop-ipc";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";

import {
  EMPTY_TARGET_DRAFT,
  PAIR_CODE_ERROR,
  PAIR_CODE_PATTERN,
  type TargetDraft,
  type TargetDraftField,
  validateTargetDraft,
} from "./model.ts";

/** The controller surface this store drives. */
export interface TargetActionsPort {
  listTargets(): Promise<readonly DesktopTarget[]>;
  addTarget(request: TargetAddRequest): Promise<DesktopTarget>;
  removeTarget(targetId: string): Promise<TargetRemoveResult>;
  connect(targetId: string): Promise<ConnectResult>;
  disconnect(targetId: string): Promise<DisconnectResult>;
  pair(targetId: string, code: string): Promise<PairResult>;
}

/** The optional local-service surface from the desktop shell port. */
export interface ServicePort {
  readonly inspect?: () => Promise<ServiceInspection>;
  readonly install?: () => Promise<ServiceActionResult>;
  readonly start?: () => Promise<ServiceActionResult>;
  readonly stop?: () => Promise<ServiceActionResult>;
  readonly restart?: () => Promise<ServiceActionResult>;
}

/** Named-profile lifecycle exposed only by desktop builds that support it. */
export interface ProfilesPort {
  list(): Promise<readonly LocalProfile[]>;
  add(profile: LocalProfileAddRequest["profile"]): Promise<LocalProfile>;
  update(profileId: string, changes: LocalProfileUpdateRequest["changes"]): Promise<LocalProfile>;
  remove(profileId: string): Promise<LocalProfileRemoveResult>;
  status(profileId: string): Promise<LocalProfile>;
  start(profileId: string): Promise<LocalProfile>;
  stop(profileId: string): Promise<LocalProfile>;
  restart(profileId: string): Promise<LocalProfile>;
}

export interface ProfileDraft {
  readonly profileId: string;
  readonly label: string;
  readonly autoStart: boolean;
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = Object.freeze({
  profileId: "",
  label: "",
  autoStart: false,
});

export type ProfileActionId = "status" | "start" | "stop" | "restart" | "update" | "remove";

export type ServiceActionId = "install" | "start" | "stop" | "restart";

export interface ServiceState {
  /** Last real inspection; null until the first one lands. */
  readonly inspection: ServiceInspection | null;
  /** Action in flight; actions are serialized, one at a time. */
  readonly pending: ServiceActionId | "inspect" | null;
  readonly error: string | null;
}

export type TargetBusyAction = "connect" | "disconnect" | "pair" | "remove";

export interface TargetsState {
  readonly draft: TargetDraft;
  readonly draftErrors: Partial<Record<TargetDraftField, string>>;
  /** Submit failure from the desktop, already free of paths and tokens. */
  readonly addError: string | null;
  readonly adding: boolean;
  /** Capabilities this window requested per target, for the grant diff. */
  readonly requestedCapabilities: Readonly<Record<string, readonly string[]>>;
  readonly pairCodes: Readonly<Record<string, string>>;
  readonly pairErrors: Readonly<Record<string, string>>;
  readonly busy: Readonly<Record<string, TargetBusyAction>>;
  readonly targetErrors: Readonly<Record<string, string>>;
  /** Target waiting on the remove confirmation dialog. */
  readonly removing: string | null;
  readonly service: ServiceState;
  /** Desktop-owned native OMP profiles; empty until the first real list lands. */
  readonly profiles: readonly LocalProfile[];
  readonly profilesPending: boolean;
  readonly profilesError: string | null;
  readonly profileDraft: ProfileDraft;
  readonly profileDraftErrors: Readonly<Partial<Record<"profileId" | "label", string>>>;
  readonly profileAdding: boolean;
  readonly profileBusy: Readonly<Record<string, ProfileActionId>>;
  readonly profileErrors: Readonly<Record<string, string>>;
  readonly removingProfile: string | null;
  readonly announcement: string;
}

export interface TargetsActions {
  setDraft(draft: TargetDraft): void;
  submitAdd(): Promise<void>;
  resetDraft(): void;
  connect(targetId: string): Promise<void>;
  disconnect(targetId: string): Promise<void>;
  setPairCode(targetId: string, code: string): void;
  submitPair(targetId: string): Promise<void>;
  askRemove(targetId: string): void;
  cancelRemove(): void;
  confirmRemove(): Promise<void>;
  inspectService(): Promise<void>;
  runServiceAction(action: ServiceActionId): Promise<void>;
  loadProfiles(): Promise<void>;
  setProfileDraft(draft: ProfileDraft): void;
  resetProfileDraft(): void;
  submitProfile(): Promise<void>;
  setProfileAutoStart(profileId: string, autoStart: boolean): Promise<void>;
  runProfileAction(
    profileId: string,
    action: Exclude<ProfileActionId, "update" | "remove">,
  ): Promise<void>;
  askRemoveProfile(profileId: string): void;
  cancelRemoveProfile(): void;
  confirmRemoveProfile(): Promise<void>;
}

export type TargetsStoreApi = StoreApi<TargetsState & TargetsActions>;

function sanitizedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0) return fallback;
  return redactedMessage(message).slice(0, 300).trim();
}

function sortProfiles(profiles: readonly LocalProfile[]): readonly LocalProfile[] {
  return Object.freeze(
    [...profiles].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.label.localeCompare(right.label) || left.profileId.localeCompare(right.profileId);
    }),
  );
}

function validateProfileDraft(
  draft: ProfileDraft,
  existing: readonly LocalProfile[],
): Readonly<Partial<Record<"profileId" | "label", string>>> {
  const errors: Partial<Record<"profileId" | "label", string>> = {};
  try {
    const profileId = decodeLocalProfileId(draft.profileId.trim());
    if (profileId === "default") errors.profileId = "The default profile is already managed.";
    else if (existing.some((profile) => profile.profileId === profileId))
      errors.profileId = "That profile is already listed.";
  } catch {
    errors.profileId = "Use lowercase letters, numbers, dots, dashes, or underscores.";
  }
  if (draft.label.trim().length > 128) errors.label = "Keep the name under 129 characters.";
  return errors;
}

export function createTargetsStore(
  port: TargetActionsPort,
  service: ServicePort,
  profilesPort?: ProfilesPort,
): TargetsStoreApi {
  // Local service actions run strictly one after another.
  let serviceQueue: Promise<void> = Promise.resolve();
  // A list request may finish after a profile action. Do not let its older
  // snapshot overwrite the newer action result already returned by desktop.
  let profileMutationGeneration = 0;

  return createStore<TargetsState & TargetsActions>()((set, get) => {
    function setBusy(targetId: string, action: TargetBusyAction | null): void {
      const busy = { ...get().busy };
      if (action === null) delete busy[targetId];
      else busy[targetId] = action;
      set({ busy });
    }

    function setTargetError(targetId: string, message: string | null): void {
      const targetErrors = { ...get().targetErrors };
      if (message === null) delete targetErrors[targetId];
      else targetErrors[targetId] = message;
      set({ targetErrors });
    }

    function setProfileBusy(profileId: string, action: ProfileActionId | null): void {
      const profileBusy = { ...get().profileBusy };
      if (action === null) delete profileBusy[profileId];
      else profileBusy[profileId] = action;
      set({ profileBusy });
    }

    function setProfileError(profileId: string, message: string | null): void {
      const profileErrors = { ...get().profileErrors };
      if (message === null) delete profileErrors[profileId];
      else profileErrors[profileId] = message;
      set({ profileErrors });
    }

    function upsertProfile(profile: LocalProfile): void {
      profileMutationGeneration += 1;
      set({
        profiles: sortProfiles([
          ...get().profiles.filter((current) => current.profileId !== profile.profileId),
          profile,
        ]),
      });
    }

    async function inspectNow(): Promise<void> {
      if (service.inspect === undefined) return;
      try {
        const inspection = await service.inspect();
        // Only the inspection updates; an action failure recorded just
        // before stays visible next to the real status.
        set({ service: { ...get().service, inspection } });
      } catch (error) {
        set({
          service: {
            ...get().service,
            error: sanitizedError(error, "Could not check the local service."),
          },
        });
      }
    }

    return {
      draft: EMPTY_TARGET_DRAFT,
      draftErrors: {},
      addError: null,
      adding: false,
      requestedCapabilities: {},
      pairCodes: {},
      pairErrors: {},
      busy: {},
      targetErrors: {},
      removing: null,
      service: { inspection: null, pending: null, error: null },
      profiles: [],
      profilesPending: false,
      profilesError: null,
      profileDraft: EMPTY_PROFILE_DRAFT,
      profileDraftErrors: {},
      profileAdding: false,
      profileBusy: {},
      profileErrors: {},
      removingProfile: null,
      announcement: "",

      setDraft(draft) {
        set({ draft, draftErrors: {}, addError: null });
      },
      resetDraft() {
        set({ draft: EMPTY_TARGET_DRAFT, draftErrors: {}, addError: null });
      },
      async submitAdd() {
        const { draft, adding } = get();
        if (adding) return;
        const existing = new Set(Object.keys(get().requestedCapabilities));
        const targets = await port.listTargets().catch(() => [] as readonly DesktopTarget[]);
        for (const target of targets) existing.add(target.targetId);
        const result = validateTargetDraft(draft, existing);
        if (!result.ok) {
          set({ draftErrors: result.errors, addError: null });
          return;
        }
        set({ adding: true, addError: null, draftErrors: {} });
        try {
          const added = await port.addTarget({ target: result.target });
          set({
            adding: false,
            draft: EMPTY_TARGET_DRAFT,
            requestedCapabilities: {
              ...get().requestedCapabilities,
              [added.targetId]: result.target.requestedCapabilities,
            },
            announcement: `Added ${added.label}.`,
          });
          await get().connect(added.targetId);
        } catch (error) {
          set({
            adding: false,
            addError: sanitizedError(error, "The desktop could not add this host."),
          });
        }
      },

      async connect(targetId) {
        if (get().busy[targetId] !== undefined) return;
        setBusy(targetId, "connect");
        setTargetError(targetId, null);
        try {
          await port.connect(targetId);
        } catch (error) {
          setTargetError(targetId, sanitizedError(error, "Could not start the connection."));
        } finally {
          setBusy(targetId, null);
        }
      },
      async disconnect(targetId) {
        if (get().busy[targetId] !== undefined) return;
        setBusy(targetId, "disconnect");
        try {
          await port.disconnect(targetId);
          setTargetError(targetId, null);
        } catch (error) {
          setTargetError(targetId, sanitizedError(error, "Could not disconnect."));
        } finally {
          setBusy(targetId, null);
        }
      },

      setPairCode(targetId, code) {
        // Free-typing stays digits-only and bounded; validation is on submit.
        const cleaned = code.replace(/\D+/gu, "").slice(0, 6);
        const pairErrors = { ...get().pairErrors };
        delete pairErrors[targetId];
        set({ pairCodes: { ...get().pairCodes, [targetId]: cleaned }, pairErrors });
      },
      async submitPair(targetId) {
        const code = get().pairCodes[targetId] ?? "";
        if (!PAIR_CODE_PATTERN.test(code)) {
          set({ pairErrors: { ...get().pairErrors, [targetId]: PAIR_CODE_ERROR } });
          return;
        }
        if (get().busy[targetId] !== undefined) return;
        setBusy(targetId, "pair");
        try {
          const result = await port.pair(targetId, code);
          if (result.paired) {
            const pairCodes = { ...get().pairCodes };
            const pairErrors = { ...get().pairErrors };
            delete pairCodes[targetId];
            delete pairErrors[targetId];
            set({ pairCodes, pairErrors, announcement: "Paired. Reconnecting…" });
          } else {
            // The host answered but did not pair; the code stays for retry.
            set({
              pairErrors: {
                ...get().pairErrors,
                [targetId]: "The host turned this code down. Check it and try again.",
              },
            });
          }
        } catch (error) {
          set({
            pairErrors: {
              ...get().pairErrors,
              [targetId]: sanitizedError(
                error,
                "Pairing failed. The code stays here so you can retry.",
              ),
            },
          });
        } finally {
          setBusy(targetId, null);
        }
      },

      askRemove(targetId) {
        set({ removing: targetId });
      },
      cancelRemove() {
        set({ removing: null });
      },
      async confirmRemove() {
        const targetId = get().removing;
        if (targetId === null || get().busy[targetId] !== undefined) return;
        setBusy(targetId, "remove");
        try {
          const result = await port.removeTarget(targetId);
          if (result.removed) {
            const requestedCapabilities = { ...get().requestedCapabilities };
            delete requestedCapabilities[targetId];
            set({
              removing: null,
              requestedCapabilities,
              announcement: "Host removed. The credential stored on this computer is gone.",
            });
          } else {
            set({ removing: null });
            setTargetError(targetId, "The desktop kept this host; nothing was removed.");
          }
        } catch (error) {
          set({ removing: null });
          setTargetError(targetId, sanitizedError(error, "Could not remove this host."));
        } finally {
          setBusy(targetId, null);
        }
      },

      async inspectService() {
        if (get().service.pending !== null) return;
        set({ service: { ...get().service, pending: "inspect", error: null } });
        const task = serviceQueue.then(inspectNow, inspectNow);
        serviceQueue = task;
        await task;
        set({ service: { ...get().service, pending: null } });
      },
      async runServiceAction(action) {
        const run = service[action];
        if (run === undefined) {
          set({
            service: { ...get().service, error: "This build cannot manage the local service." },
          });
          return;
        }
        if (get().service.pending !== null) return;
        set({ service: { ...get().service, pending: action, error: null } });
        const work = async (): Promise<void> => {
          try {
            await run();
          } catch (error) {
            set({
              service: {
                ...get().service,
                error: sanitizedError(error, `Could not ${action} the local service.`),
              },
            });
          }
          // Status comes only from a fresh inspection — never from the
          // action having merely resolved.
          await inspectNow();
        };
        const task = serviceQueue.then(work, work);
        serviceQueue = task;
        await task;
        set({ service: { ...get().service, pending: null } });
      },

      async loadProfiles() {
        if (profilesPort === undefined || get().profilesPending) return;
        const startedAtMutation = profileMutationGeneration;
        set({ profilesPending: true, profilesError: null });
        try {
          const profiles = await profilesPort.list();
          if (startedAtMutation === profileMutationGeneration) {
            set({ profiles: sortProfiles(profiles) });
          }
        } catch (error) {
          set({
            profilesError: sanitizedError(error, "Could not load local OMP profiles."),
          });
        } finally {
          set({ profilesPending: false });
        }
      },
      setProfileDraft(profileDraft) {
        set({ profileDraft, profileDraftErrors: {}, profilesError: null });
      },
      resetProfileDraft() {
        set({ profileDraft: EMPTY_PROFILE_DRAFT, profileDraftErrors: {}, profilesError: null });
      },
      async submitProfile() {
        if (profilesPort === undefined || get().profileAdding) return;
        const draft = get().profileDraft;
        const profileDraftErrors = validateProfileDraft(draft, get().profiles);
        if (Object.keys(profileDraftErrors).length > 0) {
          set({ profileDraftErrors });
          return;
        }
        set({ profileAdding: true, profileDraftErrors: {}, profilesError: null });
        try {
          const profile = await profilesPort.add({
            profileId: draft.profileId.trim(),
            ...(draft.label.trim().length === 0 ? {} : { label: draft.label.trim() }),
            autoStart: draft.autoStart,
          });
          upsertProfile(profile);
          set({
            profileDraft: EMPTY_PROFILE_DRAFT,
            announcement: `Added ${profile.label}.`,
          });
        } catch (error) {
          set({
            profilesError: sanitizedError(error, "Could not add that local OMP profile."),
          });
        } finally {
          set({ profileAdding: false });
        }
      },
      async setProfileAutoStart(profileId, autoStart) {
        if (profilesPort === undefined || get().profileBusy[profileId] !== undefined) return;
        setProfileBusy(profileId, "update");
        setProfileError(profileId, null);
        try {
          const profile = await profilesPort.update(profileId, { autoStart });
          upsertProfile(profile);
          set({
            announcement: `${profile.label} will ${autoStart ? "start" : "stay stopped"} when T4 Code opens.`,
          });
        } catch (error) {
          setProfileError(profileId, sanitizedError(error, "Could not change automatic startup."));
        } finally {
          setProfileBusy(profileId, null);
        }
      },
      async runProfileAction(profileId, action) {
        if (profilesPort === undefined || get().profileBusy[profileId] !== undefined) return;
        setProfileBusy(profileId, action);
        setProfileError(profileId, null);
        try {
          const profile = await profilesPort[action](profileId);
          upsertProfile(profile);
          const verb =
            action === "status"
              ? "Checked"
              : action === "stop"
                ? "Stopped"
                : action === "restart"
                  ? "Restarted"
                  : "Started";
          set({ announcement: `${verb} ${profile.label}.` });
        } catch (error) {
          setProfileError(profileId, sanitizedError(error, `Could not ${action} that profile.`));
        } finally {
          setProfileBusy(profileId, null);
        }
      },
      askRemoveProfile(profileId) {
        const profile = get().profiles.find((candidate) => candidate.profileId === profileId);
        if (profile === undefined || profile.isDefault) return;
        set({ removingProfile: profileId });
      },
      cancelRemoveProfile() {
        set({ removingProfile: null });
      },
      async confirmRemoveProfile() {
        if (profilesPort === undefined) return;
        const profileId = get().removingProfile;
        if (profileId === null || get().profileBusy[profileId] !== undefined) return;
        const label =
          get().profiles.find((profile) => profile.profileId === profileId)?.label ?? profileId;
        setProfileBusy(profileId, "remove");
        setProfileError(profileId, null);
        try {
          const result = await profilesPort.remove(profileId);
          if (!result.removed) throw new Error("The desktop kept this profile registration.");
          profileMutationGeneration += 1;
          set({
            profiles: get().profiles.filter((profile) => profile.profileId !== profileId),
            removingProfile: null,
            announcement: `Removed ${label} from T4 Code. Its OMP profile data was left in place.`,
          });
        } catch (error) {
          set({ removingProfile: null });
          setProfileError(profileId, sanitizedError(error, "Could not remove that profile."));
        } finally {
          setProfileBusy(profileId, null);
        }
      },
    };
  });
}

export function useTargets<T>(
  api: TargetsStoreApi,
  selector: (state: TargetsState & TargetsActions) => T,
): T {
  return useStore(api, selector);
}
