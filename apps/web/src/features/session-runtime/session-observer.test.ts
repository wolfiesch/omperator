// Observer UX contract: the strict `liveState.sessionControl` reader, the
// freshness precedence rule, the copy every surface renders, and the write
// gates (slash palette, composer controls). Absence must stay writable so
// hosts without `session.observer` keep working unchanged; any present but
// unproven shape must stay read-only with unknown-safe copy.
import { describe, expect, it } from "vite-plus/test";

import type { CatalogItem, SessionRef } from "@t4-code/protocol";

import { slashCommandsFromCatalog } from "../composer/slash.ts";
import type { ComposerControlsSnapshot } from "./session-controls.ts";
import {
  advanceRecordArrival,
  gateComposerControls,
  initialControlAnnouncerState,
  presentSessionControl,
  presentSessionControlKind,
  readSessionControl,
  recordArrivalBaseline,
  reduceControlAnnouncement,
  SESSION_CONTROL_RETURN_BLIP_MS,
  SESSION_CONTROL_RETURNED_ANNOUNCEMENT,
  SESSION_FORK_FEATURE,
  sessionControlDisplayKind,
  sessionControlForLink,
  sessionForkAction,
  type ControlAnnouncerState,
  type SessionControlState,
} from "./session-observer.ts";

function refWith(liveState: unknown): SessionRef {
  return { liveState } as unknown as SessionRef;
}

const OBSERVER_LIVE: SessionControlState = {
  mode: "observer",
  lockStatus: "live",
  transcript: "live",
};

describe("readSessionControl", () => {
  it("treats only a truly absent field as writable (backward compatibility)", () => {
    expect(readSessionControl(undefined)).toBeNull();
    expect(readSessionControl({} as unknown as SessionRef)).toBeNull();
    expect(readSessionControl(refWith({}))).toBeNull();
    expect(readSessionControl(refWith({ isStreaming: true }))).toBeNull();
  });

  it("parses every exact observer shape", () => {
    for (const lockStatus of ["live", "suspect", "malformed"] as const) {
      for (const transcript of ["live", "snapshot"] as const) {
        expect(
          readSessionControl(refWith({ sessionControl: { mode: "observer", lockStatus, transcript } })),
        ).toEqual({ mode: "observer", lockStatus, transcript });
      }
    }
  });

  it("parses both reconciling shapes", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      expect(
        readSessionControl(refWith({ sessionControl: { mode: "reconciling", transcript } })),
      ).toEqual({ mode: "reconciling", transcript });
    }
  });

  it("parses both unverified terminal-session shapes", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      expect(
        readSessionControl(refWith({ sessionControl: { mode: "unverified", transcript } })),
      ).toEqual({ mode: "unverified", transcript });
    }
  });

  it("reads extra keys on a known mode as unknown (exact shapes only)", () => {
    expect(
      readSessionControl(
        refWith({
          sessionControl: { mode: "observer", lockStatus: "live", transcript: "live", later: 1 },
        }),
      ),
    ).toEqual({ mode: "unknown" });
    expect(
      readSessionControl(
        refWith({ sessionControl: { mode: "reconciling", transcript: "live", extra: true } }),
      ),
    ).toEqual({ mode: "unknown" });
    expect(
      readSessionControl(
        refWith({ sessionControl: { mode: "unverified", transcript: "live", owner: "secret" } }),
      ),
    ).toEqual({ mode: "unknown" });
  });

  it("reads any present but unproven shape as unknown, never writable", () => {
    for (const liveState of [undefined, null, "invalid", 42, true, []]) {
      expect(readSessionControl(refWith(liveState))).toEqual({ mode: "unknown" });
    }
    const malformed: unknown[] = [
      null,
      "observer",
      42,
      true,
      [],
      { mode: "owner" },
      { mode: "observer" },
      { mode: "observer", lockStatus: "held", transcript: "live" },
      { mode: "observer", lockStatus: "live", transcript: "durable" },
      { mode: "reconciling" },
      { mode: "reconciling", transcript: "partial" },
      { mode: "unverified" },
      { mode: "unverified", transcript: "partial" },
    ];
    for (const sessionControl of malformed) {
      expect(readSessionControl(refWith({ sessionControl }))).toEqual({ mode: "unknown" });
    }
  });

  it("returns to writable the moment the field clears", () => {
    expect(readSessionControl(refWith({ sessionControl: { mode: "reconciling", transcript: "live" } }))).not.toBeNull();
    expect(readSessionControl(refWith({ isStreaming: false }))).toBeNull();
  });
});

describe("sessionControlForLink", () => {
  it("keeps observer state only on a live link (cached/offline copy wins)", () => {
    expect(sessionControlForLink("live", OBSERVER_LIVE)).toEqual(OBSERVER_LIVE);
    expect(sessionControlForLink("cached", OBSERVER_LIVE)).toBeNull();
    expect(sessionControlForLink("offline", OBSERVER_LIVE)).toBeNull();
    expect(sessionControlForLink("live", null)).toBeNull();
  });
});

const EVERY_STATE: readonly SessionControlState[] = [
  { mode: "observer", lockStatus: "live", transcript: "live" },
  { mode: "observer", lockStatus: "live", transcript: "snapshot" },
  { mode: "observer", lockStatus: "suspect", transcript: "live" },
  { mode: "observer", lockStatus: "suspect", transcript: "snapshot" },
  { mode: "observer", lockStatus: "malformed", transcript: "live" },
  { mode: "observer", lockStatus: "malformed", transcript: "snapshot" },
  { mode: "reconciling", transcript: "live" },
  { mode: "reconciling", transcript: "snapshot" },
  { mode: "unverified", transcript: "live" },
  { mode: "unverified", transcript: "snapshot" },
  { mode: "unknown" },
];

describe("presentSessionControl", () => {
  it("renders complete copy for every state — no holes, no 'undefined'", () => {
    for (const state of EVERY_STATE) {
      const presentation = presentSessionControl(state);
      for (const [key, value] of Object.entries(presentation)) {
        if (key === "bannerBusy" || key === "forkAction") continue;
        expect(typeof value, `${JSON.stringify(state)}.${key}`).toBe("string");
        expect(value, `${JSON.stringify(state)}.${key}`).not.toBe("");
        expect(value, `${JSON.stringify(state)}.${key}`).not.toMatch(/\bundefined\b|\bnull\b/);
      }
    }
    expect(SESSION_CONTROL_RETURNED_ANNOUNCEMENT).toBe(
      "Session is now available in Omperator. Input is back.",
    );
  });

  it("uses the Active elsewhere rail label only for a confirmed live lock", () => {
    for (const state of EVERY_STATE) {
      const presentation = presentSessionControl(state);
      expect(presentation.railLabel === "Active elsewhere", JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
      if (state.mode !== "unverified") {
        expect(presentation.bannerDetail).not.toMatch(/TUI|terminal|CLI|lock|watermark|promot/i);
      }
    }
  });

  it("renders byte-identical observer copy for transcript live and snapshot", () => {
    for (const lockStatus of ["live", "suspect", "malformed"] as const) {
      const live = presentSessionControl({ mode: "observer", lockStatus, transcript: "live" });
      const snapshot = presentSessionControl({
        mode: "observer",
        lockStatus,
        transcript: "snapshot",
      });
      // The transcript field is a read-path detail, not an ownership state:
      // every rendered string and the busy flag must match byte for byte.
      expect(snapshot, lockStatus).toEqual(live);
      expect(live.bannerBusy, lockStatus).toBe(false);
    }
    const live = presentSessionControl({ mode: "observer", lockStatus: "live", transcript: "live" });
    expect(live.bannerDetail).toBe(
      "Following saved output, not a token-by-token stream. Finished steps appear here as the other app saves them. To continue here, run /continue-in-t4 in the other app — or just exit it.",
    );
  });

  it("stays word-stable while transcript freshness churns at 250ms for 20 seconds", () => {
    // Simulates the packaged-proof failure: the follower alternated
    // live/snapshot every poll while the owner's app kept saving. Every
    // visible and accessible string must be identical on every tick.
    const baseline = presentSessionControl({
      mode: "observer",
      lockStatus: "live",
      transcript: "live",
    });
    for (let tick = 0; tick * 250 < 20_000; tick += 1) {
      const transcript = tick % 2 === 0 ? ("live" as const) : ("snapshot" as const);
      const presentation = presentSessionControl({ mode: "observer", lockStatus: "live", transcript });
      expect(presentation, `tick ${tick} (${transcript})`).toEqual(baseline);
      // Read-only gates never blink open: every reason stays present.
      expect(presentation.composerReason).not.toBe("");
      expect(presentation.cancelReason).not.toBe("");
      expect(presentation.slashReason).not.toBe("");
      expect(presentation.managementReason).not.toBe("");
    }
  });

  it("names /continue-in-t4 as the explicit transfer path while the owner is live", () => {
    const presentation = presentSessionControl(OBSERVER_LIVE);
    expect(presentation.bannerDetail).toContain("/continue-in-t4");
    expect(presentation.composerReason).toContain("/continue-in-t4");
  });

  it("distinguishes lock states without naming internals", () => {
    const live = presentSessionControl(OBSERVER_LIVE);
    const suspect = presentSessionControl({
      mode: "observer",
      lockStatus: "suspect",
      transcript: "live",
    });
    const malformed = presentSessionControl({
      mode: "observer",
      lockStatus: "malformed",
      transcript: "live",
    });
    // Suspect: the other app went quiet; Omperator waits before taking over.
    expect(suspect.bannerDetail).toContain("gone quiet");
    expect(suspect.bannerDetail).toContain("waits");
    expect(suspect.bannerDetail).not.toContain("/continue-in-t4");
    // Malformed: ownership is unclear; Omperator stays read-only until safe.
    expect(malformed.bannerDetail.toLowerCase()).toContain("ownership");
    expect(malformed.bannerDetail.toLowerCase()).toContain("unclear");
    expect(malformed.bannerDetail.toLowerCase()).toContain("read-only");
    expect(malformed.bannerDetail).not.toContain("/continue-in-t4");
    // All three read differently.
    expect(new Set([live.bannerDetail, suspect.bannerDetail, malformed.bannerDetail]).size).toBe(3);
  });

  it("marks reconciling as busy with return-of-input copy", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      const presentation = presentSessionControl({ mode: "reconciling", transcript });
      expect(presentation.bannerBusy).toBe(true);
      expect(presentation.railLabel).toBe("Taking over");
      expect(presentation.composerReason.toLowerCase()).toContain("input returns");
    }
  });

  it("keeps unverified sessions calmly read-only and points future work to t4-omp", () => {
    const presentation = presentSessionControl({ mode: "unverified", transcript: "live" });
    expect(presentation.bannerBusy).toBe(false);
    expect(presentation.railLabel).toContain("Read-only");
    expect(presentation.bannerDetail).toContain("t4-omp");
    expect(presentation.bannerDetail).not.toContain("Taking over");
  });

  it("offers Continue in a copy exactly for the read-only dead ends", () => {
    for (const state of EVERY_STATE) {
      const fork = presentSessionControl(state).forkAction;
      // Observer (any lock status) and unverified are dead ends without a
      // coordinated handoff; reconciling resolves on its own and unknown has
      // no ownership truth to copy from.
      const deadEnd = state.mode === "observer" || state.mode === "unverified";
      expect(fork !== null, JSON.stringify(state)).toBe(deadEnd);
      if (fork === null) continue;
      expect(fork.label).toBe("Continue in a copy");
      expect(fork.explanation).toBe(
        "Starts a new session with this history. The original stays where it is and is never modified.",
      );
      // The copy promises a fork, nothing more: no takeover, no claims about
      // the other writer, no engine internals.
      for (const text of [fork.label, fork.explanation]) {
        expect(text, JSON.stringify(state)).not.toMatch(
          /TUI|terminal|CLI|lock|watermark|promot|take ?over|verif|pid/i,
        );
      }
    }
  });

  it("gates the fork affordance on the negotiated session.fork feature", () => {
    expect(SESSION_FORK_FEATURE).toBe("session.fork");
    for (const state of EVERY_STATE) {
      const granted = sessionForkAction(state, ["sessions.manage", SESSION_FORK_FEATURE]);
      const withheld = sessionForkAction(state, ["sessions.manage"]);
      expect(granted, JSON.stringify(state)).toEqual(presentSessionControl(state).forkAction);
      // Without the feature the affordance vanishes for every state, so the
      // UI renders exactly as it did before forking existed.
      expect(withheld, JSON.stringify(state)).toBeNull();
    }
    expect(sessionForkAction(null, [SESSION_FORK_FEATURE])).toBeNull();
  });
});

describe("sessionControlDisplayKind", () => {
  it("reserves the observer kind for a confirmed live lock", () => {
    for (const state of EVERY_STATE) {
      expect(sessionControlDisplayKind(state) === "observer", JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
    }
  });

  it("maps every state to its honest compact kind", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      expect(
        sessionControlDisplayKind({ mode: "observer", lockStatus: "suspect", transcript }),
      ).toBe("suspect");
      expect(
        sessionControlDisplayKind({ mode: "observer", lockStatus: "malformed", transcript }),
      ).toBe("unclear");
      expect(sessionControlDisplayKind({ mode: "reconciling", transcript })).toBe("reconciling");
      expect(sessionControlDisplayKind({ mode: "unverified", transcript })).toBe("unverified");
    }
    expect(sessionControlDisplayKind({ mode: "unknown" })).toBe("unclear");
  });
});

describe("presentSessionControlKind", () => {
  it("says another app is active only for the observer kind", () => {
    const kinds = ["observer", "suspect", "reconciling", "unverified", "unclear"] as const;
    for (const kind of kinds) {
      const presentation = presentSessionControlKind(kind);
      expect(presentation.railLabel === "Active elsewhere", kind).toBe(kind === "observer");
      expect(presentation.composerReason.includes("active in another app"), kind).toBe(
        kind === "observer",
      );
    }
  });

  it("matches presentSessionControl copy for each state's kind", () => {
    for (const state of EVERY_STATE) {
      const viaKind = presentSessionControlKind(sessionControlDisplayKind(state));
      const direct = presentSessionControl(state);
      // Compact surfaces render only transcript-independent fields.
      expect(viaKind.railLabel, JSON.stringify(state)).toBe(direct.railLabel);
      expect(viaKind.composerReason, JSON.stringify(state)).toBe(direct.composerReason);
      expect(viaKind.managementReason, JSON.stringify(state)).toBe(direct.managementReason);
    }
  });

  it("keeps suspect and unclear copy calm and owner-free", () => {
    const suspect = presentSessionControlKind("suspect");
    expect(suspect.railLabel).toBe("Waiting to take over");
    expect(suspect.composerReason).toContain("gone quiet");
    const unclear = presentSessionControlKind("unclear");
    expect(unclear.railLabel).toBe("Read-only");
    expect(unclear.composerReason.toLowerCase()).toContain("unclear");
    expect(unclear.composerReason.toLowerCase()).not.toContain("another app is");
  });
});

const WRITABLE_CONTROLS: ComposerControlsSnapshot = {
  modelSupported: true,
  modelUnsupportedReason: null,
  modelLabel: "anthropic/claude",
  modelSelectedId: "model:anthropic/claude",
  modelChoices: [],
  thinkingSupported: true,
  thinkingUnsupportedReason: null,
  thinking: "medium",
  thinkingEffective: "medium",
  thinkingResolved: null,
  thinkingLevels: ["off", "auto", "medium"],
  thinkingOffFloored: false,
  fastSupported: true,
  fastUnsupportedReason: null,
  fastAvailable: true,
  fast: false,
  fastActive: false,
  modeSupported: false,
  mode: null,
  attachmentsSupported: true,
  attachmentsUnsupportedReason: null,
  pendingControl: null,
  controlError: null,
};

describe("gateComposerControls", () => {
  it("gates model/thinking/fast/attachments while values keep host truth", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).controlReason;
    const gated = gateComposerControls(WRITABLE_CONTROLS, reason);
    expect(gated.modelSupported).toBe(false);
    expect(gated.modelUnsupportedReason).toBe(reason);
    expect(gated.thinkingSupported).toBe(false);
    expect(gated.thinkingUnsupportedReason).toBe(reason);
    expect(gated.fastSupported).toBe(false);
    expect(gated.fastUnsupportedReason).toBe(reason);
    expect(gated.modeSupported).toBe(false);
    expect(gated.attachmentsSupported).toBe(false);
    // Labels and current values still show what the host reports.
    expect(gated.modelLabel).toBe(WRITABLE_CONTROLS.modelLabel);
    expect(gated.thinking).toBe(WRITABLE_CONTROLS.thinking);
    expect(gated.fast).toBe(WRITABLE_CONTROLS.fast);
  });
});

describe("slash gating", () => {
  const items = [
    {
      kind: "command",
      name: "retry",
      description: "Retry the last turn",
      metadata: { slashCommand: true },
    },
    {
      kind: "command",
      name: "compact",
      description: "Compact context",
      metadata: { slashCommand: true },
    },
  ] as unknown as readonly CatalogItem[];

  it("gates every command with the observer reason on a live link", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).slashReason;
    const commands = slashCommandsFromCatalog(
      items,
      { link: "live", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(commands.length).toBe(2);
    for (const command of commands) expect(command.disabledReason).toBe(reason);
  });

  it("lets cached/offline reasons win over the observer reason", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).slashReason;
    const [cached] = slashCommandsFromCatalog(
      items,
      { link: "cached", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(cached?.disabledReason).toBe("Unavailable on a cached copy");
    const [offline] = slashCommandsFromCatalog(
      items,
      { link: "offline", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(offline?.disabledReason).toBe("Unavailable while the host is unreachable");
  });

  it("stays unchanged when no read-only policy applies", () => {
    const commands = slashCommandsFromCatalog(
      items,
      { link: "live", turnActive: false },
      ["sessions.prompt"],
    );
    for (const command of commands) expect(command.disabledReason).toBeNull();
  });
});

describe("ownership-unclear honesty", () => {
  const UNCLEAR_STATES: readonly SessionControlState[] = [
    { mode: "observer", lockStatus: "malformed", transcript: "live" },
    { mode: "observer", lockStatus: "malformed", transcript: "snapshot" },
    { mode: "unknown" },
  ];

  it("never claims another app controls a malformed or unknown shape", () => {
    for (const state of UNCLEAR_STATES) {
      const presentation = presentSessionControl(state);
      for (const [key, value] of Object.entries(presentation)) {
        if (typeof value !== "string") continue;
        expect(value, `${JSON.stringify(state)}.${key}`).not.toMatch(
          /active in another app|another app controls|app running this session/i,
        );
      }
      expect(presentation.composerReason.toLowerCase()).toContain("unclear");
      expect(presentation.managementReason.toLowerCase()).toContain("unclear");
      expect(presentation.announcement.toLowerCase()).toContain("unclear");
      expect(presentation.bannerDetail.toLowerCase()).toContain("read-only");
    }
  });

  it("says active in another app only while the lock is proven live", () => {
    for (const state of EVERY_STATE) {
      const claims = Object.values(presentSessionControl(state)).some(
        (value) => typeof value === "string" && /active in another app/i.test(value),
      );
      expect(claims, JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
    }
  });
});

describe("attachment gating", () => {
  it("gives attachments the observer-specific rejection reason", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).controlReason;
    const gated = gateComposerControls(WRITABLE_CONTROLS, reason);
    expect(gated.attachmentsSupported).toBe(false);
    expect(gated.attachmentsUnsupportedReason).toBe(reason);
    expect(WRITABLE_CONTROLS.attachmentsUnsupportedReason).toBeNull();
  });
});

describe("reduceControlAnnouncement", () => {
  const RECONCILING: SessionControlState = { mode: "reconciling", transcript: "live" };
  const step = (
    state: ControlAnnouncerState,
    control: SessionControlState | null,
    nowMs: number,
    link: "live" | "cached" | "offline" = "live",
    writable = control === null,
  ) => reduceControlAnnouncement(state, { control, link, writable, nowMs });

  it("announces entering a state once, then again only when the copy changes", () => {
    let state = initialControlAnnouncerState(null, 0);
    const entered = step(state, OBSERVER_LIVE, 0);
    expect(entered.announcement).toBe(presentSessionControl(OBSERVER_LIVE).announcement);
    state = entered.state;
    expect(step(state, OBSERVER_LIVE, 250).announcement).toBeNull();
    const reconciling = step(state, RECONCILING, 500);
    expect(reconciling.announcement).toBe(presentSessionControl(RECONCILING).announcement);
  });

  it("stays silent while transcript freshness churns within one observer episode", () => {
    let state = initialControlAnnouncerState(null, 0);
    state = step(state, OBSERVER_LIVE, 0).state;
    for (let tick = 1; tick * 250 < 20_000; tick += 1) {
      const transcript = tick % 2 === 0 ? ("live" as const) : ("snapshot" as const);
      const next = step(
        state,
        { mode: "observer", lockStatus: "live", transcript },
        tick * 250,
        "live",
        false,
      );
      expect(next.announcement, `tick ${tick}`).toBeNull();
      state = next.state;
    }
    // The whole churn was one episode: its start time never moved.
    expect(state.observedAtMs).toBe(0);
  });

  it("announces input back only on a confirmed live+writable return", () => {
    let state = initialControlAnnouncerState(OBSERVER_LIVE, 0);
    // Live but not yet writable (grants pending): keep holding.
    const notWritable = reduceControlAnnouncement(state, {
      control: null,
      link: "live",
      writable: false,
      nowMs: 5_000,
    });
    expect(notWritable.announcement).toBeNull();
    expect(notWritable.state.pendingReturn).toBe(true);
    state = notWritable.state;
    const returned = step(state, null, 6_000);
    expect(returned.announcement).toBe(SESSION_CONTROL_RETURNED_ANNOUNCEMENT);
    // The transition is one-shot.
    expect(step(returned.state, null, 7_000).announcement).toBeNull();
  });

  it("suppresses the return for a sub-reading-speed control blip", () => {
    let state = initialControlAnnouncerState(null, 0);
    state = step(state, OBSERVER_LIVE, 10_000).state;
    const returned = step(state, null, 10_000 + SESSION_CONTROL_RETURN_BLIP_MS - 1);
    // "" clears the live region silently — never null, so a later identical
    // entering announcement re-fires; gates were never delayed by this.
    expect(returned.announcement).toBe("");
    expect(returned.state.pendingReturn).toBe(false);
    expect(returned.state.lastAnnouncement).toBe("");
    // Re-entering the same state after a suppressed blip announces again.
    const reentered = step(returned.state, OBSERVER_LIVE, 20_000);
    expect(reentered.announcement).toBe(presentSessionControl(OBSERVER_LIVE).announcement);
  });

  it("announces the return once the episode outlives the blip window", () => {
    let state = initialControlAnnouncerState(null, 0);
    state = step(state, OBSERVER_LIVE, 10_000).state;
    const returned = step(state, null, 10_000 + SESSION_CONTROL_RETURN_BLIP_MS);
    expect(returned.announcement).toBe(SESSION_CONTROL_RETURNED_ANNOUNCEMENT);
  });

  it("retains the pending transition across cached/offline without announcing", () => {
    let state = initialControlAnnouncerState(OBSERVER_LIVE, 0);
    for (const link of ["cached", "offline"] as const) {
      const held = reduceControlAnnouncement(state, {
        control: null,
        link,
        writable: false,
        nowMs: 5_000,
      });
      expect(held.announcement).toBeNull();
      expect(held.state.pendingReturn).toBe(true);
      state = held.state;
    }
    // Reconnecting straight into a writable live session announces exactly once.
    const returned = step(state, null, 6_000);
    expect(returned.announcement).toBe(SESSION_CONTROL_RETURNED_ANNOUNCEMENT);
  });

  it("never announces a return for a session that was never observed", () => {
    let state = initialControlAnnouncerState(null, 0);
    for (const link of ["offline", "cached", "live"] as const) {
      const next = reduceControlAnnouncement(state, {
        control: null,
        link,
        writable: true,
        nowMs: 9_000,
      });
      expect(next.announcement).toBeNull();
      state = next.state;
    }
  });
});

describe("record-arrival pulse signal", () => {
  const entries = (...ids: string[]) => ids.map((id) => ({ id }));

  it("fires only when a new durable entry lands", () => {
    let baseline = recordArrivalBaseline(entries("a", "b"));
    // Growth is arrival.
    const grew = advanceRecordArrival(baseline, entries("a", "b", "c"));
    expect(grew.arrived).toBe(true);
    baseline = grew.baseline;
    // Rotation under the retention cap (same length, new tail) is arrival.
    const rotated = advanceRecordArrival(baseline, entries("b", "c", "d"));
    expect(rotated.arrived).toBe(true);
    baseline = rotated.baseline;
    // Identical entries are not.
    expect(advanceRecordArrival(baseline, entries("b", "c", "d")).arrived).toBe(false);
    // Shrink (snapshot reinstall dropping history) is not.
    expect(advanceRecordArrival(baseline, entries("b", "c")).arrived).toBe(false);
  });

  it("never fires across 20 seconds of freshness churn with no new entries", () => {
    // The signal takes only durable entries: poll-derived transcript
    // live/snapshot churn cannot reach it. Simulate the churn anyway with
    // fresh (referentially distinct) arrays each tick, as a re-render would.
    let baseline = recordArrivalBaseline(entries("a", "b", "c"));
    for (let tick = 0; tick * 250 < 20_000; tick += 1) {
      const step = advanceRecordArrival(baseline, entries("a", "b", "c"));
      expect(step.arrived, `tick ${tick}`).toBe(false);
      baseline = step.baseline;
    }
    // One durable arrival after the churn is still detected.
    expect(advanceRecordArrival(baseline, entries("a", "b", "c", "d")).arrived).toBe(true);
  });

  it("does not fire on an empty transcript", () => {
    const baseline = recordArrivalBaseline([]);
    expect(advanceRecordArrival(baseline, []).arrived).toBe(false);
  });
});
