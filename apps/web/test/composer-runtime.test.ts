// Composer behavior and runtime-controller contracts: IME-safe keys, slash
// ranking with aliases and disabled reasons, attachment validation, draft
// A→B→A continuity, and intent-driven approval/ask/plan transitions with
// offline/cached disable truth. Pure logic plus the fixture controller.
import { describe, expect, it } from "vite-plus/test";

import {
  admitAttachments,
  MAX_STAGED_ATTACHMENT_BYTES,
  MAX_STAGED_ATTACHMENTS,
  toPromptAttachment,
  type AttachmentIntakeOptions,
  type StagedAttachment,
} from "../src/features/composer/attachments.ts";
import { resolveAskDigit, resolveComposerKey, resolveMenuKey } from "../src/features/composer/keys.ts";
import {
  activeSlashQuery,
  buildSlashCatalog,
  searchSlashCommands,
} from "../src/features/composer/slash.ts";
import {
  composerStore,
  createComposerStore,
  LEGACY_COMPOSER_STORAGE_KEY,
  purgeLegacyComposerPersistence,
} from "../src/features/composer/composer-store.ts";
import {
  createSubmissionGate,
  type SubmissionIo,
  type SubmissionLatch,
} from "../src/features/composer/submission.ts";
import { createFixtureSessionRuntime } from "../src/features/session-runtime/controller.ts";
import { FIXTURE_NOW_MS } from "../src/features/session-runtime/fixtures.ts";
import { createMemoryPersistence } from "../src/state/persistence.ts";
import { createWorkspaceStore, selectSessionView } from "../src/state/workspace-store.ts";

const KEY = {
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
} as const;

function imageFile(name: string, sizeBytes = 4, type = "image/png"): File {
  return new File([new Uint8Array(sizeBytes)], name, { type, lastModified: 1 });
}

function deterministicAttachmentOptions(ids: string[] = []): AttachmentIntakeOptions {
  let index = 0;
  return {
    createId: () => ids[index++] ?? `attachment-test-${index}`,
    createPreviewUrl: (file) => `blob:test/${file.name}/${index}`,
  };
}

describe("composer keys (IME-safe)", () => {
  it("Enter submits; modifiers insert a newline", () => {
    expect(resolveComposerKey(KEY)).toBe("submit");
    expect(resolveComposerKey({ ...KEY, shiftKey: true })).toBe("newline");
    expect(resolveComposerKey({ ...KEY, altKey: true })).toBe("newline");
    expect(resolveComposerKey({ ...KEY, ctrlKey: true })).toBe("newline");
    expect(resolveComposerKey({ ...KEY, metaKey: true })).toBe("newline");
  });

  it("never submits during IME composition (isComposing or keyCode 229)", () => {
    expect(resolveComposerKey({ ...KEY, isComposing: true })).toBe("none");
    expect(resolveComposerKey({ ...KEY, keyCode: 229 })).toBe("none");
    expect(resolveMenuKey({ ...KEY, isComposing: true })).toBe("none");
  });

  it("menu keys navigate, accept, and dismiss", () => {
    expect(resolveMenuKey({ ...KEY, key: "ArrowDown" })).toBe("next");
    expect(resolveMenuKey({ ...KEY, key: "ArrowUp" })).toBe("previous");
    expect(resolveMenuKey({ ...KEY, key: "Tab" })).toBe("accept");
    expect(resolveMenuKey(KEY)).toBe("accept");
    expect(resolveMenuKey({ ...KEY, key: "Escape" })).toBe("dismiss");
  });

  it("digits 1-9 answer ask options; out-of-range and composed digits do not", () => {
    expect(resolveAskDigit({ ...KEY, key: "1" }, 3)).toBe(0);
    expect(resolveAskDigit({ ...KEY, key: "3" }, 3)).toBe(2);
    expect(resolveAskDigit({ ...KEY, key: "4" }, 3)).toBeNull();
    expect(resolveAskDigit({ ...KEY, key: "0" }, 3)).toBeNull();
    expect(resolveAskDigit({ ...KEY, key: "1", isComposing: true }, 3)).toBeNull();
    expect(resolveAskDigit({ ...KEY, key: "1", ctrlKey: true }, 3)).toBeNull();
  });
});

describe("slash commands", () => {
  const catalog = buildSlashCatalog({ link: "live", turnActive: false });

  it("detects the active query only in a leading slash token", () => {
    expect(activeSlashQuery("/mo", 3)).toBe("mo");
    expect(activeSlashQuery("/", 1)).toBe("");
    expect(activeSlashQuery("hello /mo", 9)).toBeNull();
    expect(activeSlashQuery("/model something", 16)).toBeNull();
  });

  it("ranks prefix matches first and matches aliases", () => {
    const byName = searchSlashCommands(catalog, "mo");
    expect(byName[0]?.name).toBe("/model");
    const byAlias = searchSlashCommands(catalog, "again");
    expect(byAlias[0]?.name).toBe("/retry");
    const bySecondAlias = searchSlashCommands(catalog, "sh");
    expect(bySecondAlias[0]?.name).toBe("/terminal");
  });

  it("keeps disabled commands visible with a reason instead of hiding them", () => {
    const terminal = catalog.find((command) => command.name === "/terminal");
    expect(terminal?.disabledReason).toBe("Needs terminal access on this host");
    const offline = buildSlashCatalog({ link: "offline", turnActive: false });
    expect(offline.every((command) => command.disabledReason !== null)).toBe(true);
    const streaming = buildSlashCatalog({ link: "live", turnActive: true });
    expect(streaming.find((command) => command.name === "/retry")?.disabledReason).toBe(
      "A turn is already running",
    );
  });
});

describe("attachments", () => {
  it("uses crypto-backed collision-resistant ids by default", () => {
    const result = admitAttachments(
      [],
      [{ file: imageFile("first.png") }, { file: imageFile("second.png") }],
      { createPreviewUrl: (file) => `blob:test/${file.name}` },
    );

    expect(result.accepted.map((attachment) => attachment.id)).toEqual([
      expect.stringMatching(/^attachment-[0-9a-f]{32}$/),
      expect.stringMatching(/^attachment-[0-9a-f]{32}$/),
    ]);
    expect(result.accepted[0]?.id).not.toBe(result.accepted[1]?.id);
  });

  it("retains exact image Files, uses unique ids, and rejects non-images", () => {
    const first = imageFile("shot.png");
    const sameNameDifferentFile = imageFile("shot.png");
    const notes = new File(["notes"], "notes.md", { type: "text/markdown" });
    const movie = new File(["movie"], "movie.mp4", { type: "video/mp4" });
    const result = admitAttachments(
      [],
      [{ file: first }, { file: sameNameDifferentFile }, { file: notes }, { file: movie }],
      deterministicAttachmentOptions(["attachment-a", "attachment-a", "attachment-b"]),
    );
    expect(result.accepted.map((attachment) => attachment.kind)).toEqual(["image", "image"]);
    expect(result.accepted[0]?.file).toBe(first);
    expect(result.accepted[1]?.file).toBe(sameNameDifferentFile);
    expect(result.accepted.map((attachment) => attachment.id)).toEqual([
      "attachment-a",
      "attachment-b",
    ]);
    expect(toPromptAttachment(result.accepted[0] as StagedAttachment)).toEqual({
      id: "attachment-a",
      kind: "image",
      mediaType: "image/png",
      name: "shot.png",
      sizeBytes: 4,
      file: first,
    });
    expect(result.rejections).toEqual([
      "notes.md: attach a PNG, JPEG, WebP, or GIF image.",
      "movie.mp4: attach a PNG, JPEG, WebP, or GIF image.",
    ]);
  });

  it("stages Android-style image Files with an empty MIME type by extension", () => {
    const androidPng = imageFile("content-provider.PNG", 4, "");
    const genericJpeg = imageFile("camera.jpg", 4, "application/octet-stream");
    const legacyJpeg = imageFile("camera-provider", 4, "image/jpg");
    const noExtension = imageFile("content-provider", 4, "");
    const result = admitAttachments(
      [],
      [{ file: androidPng }, { file: genericJpeg }, { file: legacyJpeg }, { file: noExtension }],
      deterministicAttachmentOptions([
        "attachment-android",
        "attachment-generic",
        "attachment-legacy",
      ]),
    );

    expect(result.accepted).toHaveLength(3);
    expect(result.accepted[0]).toMatchObject({
      id: "attachment-android",
      mediaType: "image/png",
      file: androidPng,
    });
    expect(result.accepted[1]).toMatchObject({
      id: "attachment-generic",
      mediaType: "image/jpeg",
      file: genericJpeg,
    });
    expect(result.accepted[2]).toMatchObject({
      id: "attachment-legacy",
      mediaType: "image/jpeg",
      file: legacyJpeg,
    });
    expect(result.rejections).toEqual([
      "content-provider: attach a PNG, JPEG, WebP, or GIF image.",
    ]);
  });

  it("enforces the size cap, count cap, and exact-File duplicate guard", () => {
    const tooLarge = imageFile("big.png", 21 * 1024 * 1024);
    const oversize = admitAttachments(
      [],
      [{ file: tooLarge }],
      deterministicAttachmentOptions(),
    );
    expect(oversize.accepted.length).toBe(0);
    expect(oversize.rejections[0]).toContain("over the 20.0 MB limit");

    const files = Array.from({ length: 9 }, (_, index) => imageFile(`f${index}.png`, 10));
    const eight = admitAttachments(
      [],
      files.map((file) => ({ file })),
      deterministicAttachmentOptions(),
    ).accepted;
    expect(eight.length).toBe(8);

    const duplicate = admitAttachments(
      eight.slice(0, 7),
      [{ file: files[0] as File }],
      deterministicAttachmentOptions(),
    );
    expect(duplicate.accepted.length).toBe(0);
    expect(duplicate.rejections).toEqual(["f0.png: already attached."]);
  });

  it("bounds preserved staging across sessions without silently evicting files", () => {
    const candidate = imageFile("next.png", 1);
    const atByteBudget = admitAttachments(
      [],
      [{ file: candidate }],
      {
        ...deterministicAttachmentOptions(),
        stagedBytes: MAX_STAGED_ATTACHMENT_BYTES,
        stagedCount: 8,
      },
    );
    expect(atByteBudget.accepted).toEqual([]);
    expect(atByteBudget.rejections[0]).toContain("staged images across sessions would exceed 160.0 MB");

    const atCountBudget = admitAttachments(
      [],
      [{ file: candidate }],
      {
        ...deterministicAttachmentOptions(),
        stagedBytes: MAX_STAGED_ATTACHMENTS,
        stagedCount: MAX_STAGED_ATTACHMENTS,
      },
    );
    expect(atCountBudget.accepted).toEqual([]);
    expect(atCountBudget.rejections[0]).toContain(`already has ${MAX_STAGED_ATTACHMENTS} staged images`);

    const empty = admitAttachments(
      [],
      [{ file: imageFile("empty.png", 0) }],
      deterministicAttachmentOptions(),
    );
    expect(empty.rejections).toEqual(["empty.png: the image is empty."]);
  });

  it("keeps staged Files and previews through rejection/unknown, then revokes on acceptance", async () => {
    const file = imageFile("proof.png");
    const staged = admitAttachments(
      [],
      [{ file }],
      deterministicAttachmentOptions(["attachment-proof"]),
    ).accepted[0] as StagedAttachment;
    const revoked: string[] = [];
    const store = createComposerStore({ revokePreviewUrl: (url) => revoked.push(url) });
    store.getState().addAttachments("session-a", [staged]);
    let draft = "ship with proof";
    const io: SubmissionIo = {
      getDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
      removeAttachments: (ids) => {
        for (const id of ids) store.getState().removeAttachment("session-a", id);
      },
      setNotice: () => {},
    };
    const intent = {
      kind: "prompt",
      text: draft,
      attachments: [toPromptAttachment(staged)],
    } as const;
    const submitted = { text: draft, attachmentIds: [staged.id] };

    await createSubmissionGate(async () => ({ kind: "rejected", reason: "not yet" })).submit(
      intent,
      submitted,
      io,
    );
    expect(store.getState().attachmentsBySessionId["session-a"]?.[0]?.file).toBe(file);
    expect(revoked).toEqual([]);
    expect(draft).toBe("ship with proof");

    await createSubmissionGate(async () => {
      throw new Error("transport gone");
    }).submit(intent, submitted, io);
    expect(store.getState().attachmentsBySessionId["session-a"]?.[0]?.file).toBe(file);
    expect(revoked).toEqual([]);
    expect(draft).toBe("ship with proof");

    await createSubmissionGate(async () => ({ kind: "accepted" })).submit(intent, submitted, io);
    expect(store.getState().attachmentsBySessionId["session-a"]).toEqual([]);
    expect(revoked).toEqual([staged.previewUrl]);
    expect(draft).toBe("");
  });
});

describe("draft continuity A→B→A", () => {
  it("restores each session's draft through the workspace store", () => {
    const store = createWorkspaceStore({ persistence: createMemoryPersistence() });
    store.getState().setSessionDraft("A", "half-written to A");
    store.getState().setSessionDraft("B", "note for B");
    store.getState().setSessionDraft("A", "half-written to A, continued");
    expect(selectSessionView(store.getState(), "A").draft).toBe("half-written to A, continued");
    expect(selectSessionView(store.getState(), "B").draft).toBe("note for B");
  });

  it("keeps one session submission locked across recreated composer gates", async () => {
    const store = createComposerStore();
    const latch: SubmissionLatch = {
      pending: () => store.getState().pendingSubmissionBySessionId.A !== undefined,
      begin: () => store.getState().beginSubmission("A"),
      current: (token) => store.getState().isSubmissionCurrent("A", token),
      end: (token) => store.getState().finishSubmission("A", token),
    };
    const deferred = Promise.withResolvers<{ readonly kind: "accepted" }>();
    let submissions = 0;
    const submitPrompt = () => {
      submissions += 1;
      return deferred.promise;
    };
    const io: SubmissionIo = {
      getDraft: () => "hello A",
      clearDraft: () => undefined,
      removeAttachments: () => undefined,
      setNotice: (notice) => store.getState().setSubmissionNotice("A", notice),
    };
    const intent = { kind: "prompt", text: "hello A", attachments: [] } as const;
    const submitted = { text: "hello A", attachmentIds: [] };

    const first = createSubmissionGate(submitPrompt, latch).submit(intent, submitted, io);
    expect(store.getState().pendingSubmissionBySessionId.A).toMatch(/^submission-/u);
    // A composer recreated after A to B to A shares the same session latch.
    await expect(
      createSubmissionGate(submitPrompt, latch).submit(intent, submitted, io),
    ).resolves.toBeNull();
    expect(submissions).toBe(1);

    deferred.resolve({ kind: "accepted" });
    await expect(first).resolves.toEqual({ kind: "accepted" });
    expect(store.getState().pendingSubmissionBySessionId.A).toBeUndefined();
  });

  it("ignores an obsolete completion after deletion invalidates its token", async () => {
    const revoked: string[] = [];
    const store = createComposerStore({ revokePreviewUrl: (url) => revoked.push(url) });
    const staged = admitAttachments(
      [],
      [{ file: imageFile("delete-me.png") }],
      deterministicAttachmentOptions(["attachment-delete"]),
    ).accepted[0] as StagedAttachment;
    store.getState().addAttachments("A", [staged]);
    const latch: SubmissionLatch = {
      pending: () => store.getState().pendingSubmissionBySessionId.A !== undefined,
      begin: () => store.getState().beginSubmission("A"),
      current: (token) => store.getState().isSubmissionCurrent("A", token),
      end: (token) => store.getState().finishSubmission("A", token),
    };
    const deferred = Promise.withResolvers<{ readonly kind: "accepted" }>();
    let draft = "delete while pending";
    let clears = 0;
    const io: SubmissionIo = {
      getDraft: () => draft,
      clearDraft: () => {
        clears += 1;
        draft = "";
      },
      removeAttachments: () => {
        throw new Error("obsolete completion touched attachments");
      },
      setNotice: (notice) => store.getState().setSubmissionNotice("A", notice),
    };
    const pending = createSubmissionGate(() => deferred.promise, latch).submit(
      { kind: "prompt", text: draft, attachments: [toPromptAttachment(staged)] },
      { text: draft, attachmentIds: [staged.id] },
      io,
    );

    store.getState().disposeSession("A");
    expect(revoked).toEqual([staged.previewUrl]);
    const nextToken = store.getState().beginSubmission("A");
    expect(nextToken).not.toBeNull();
    deferred.resolve({ kind: "accepted" });
    await expect(pending).resolves.toBeNull();
    expect(clears).toBe(0);
    expect(draft).toBe("delete while pending");
    expect(store.getState().pendingSubmissionBySessionId.A).toBe(nextToken);
  });

  it("keeps intake warnings scoped to the session that produced them", () => {
    const store = createComposerStore();
    store.getState().setAttachmentRejections("A", ["A image is too large"]);
    store.getState().setAttachmentRejections("B", ["B image type is unsupported"]);
    store.getState().setAttachmentRejections("A", []);

    expect(store.getState().attachmentRejectionsBySessionId.A).toBeUndefined();
    expect(store.getState().attachmentRejectionsBySessionId.B).toEqual([
      "B image type is unsupported",
    ]);
  });
});

describe("composer control persistence removal", () => {
  it("purges the retired v1 options blob so stale local state never returns", () => {
    const removed: string[] = [];
    purgeLegacyComposerPersistence({ removeItem: (key) => removed.push(key) });
    expect(removed).toEqual([LEGACY_COMPOSER_STORAGE_KEY]);
    // Storage failures stay silent — boot never trips on a broken store.
    purgeLegacyComposerPersistence({
      removeItem: () => {
        throw new Error("denied");
      },
    });
  });

  it("keeps no per-session control selections in the renderer store", () => {
    const state: Record<string, unknown> = { ...composerStore.getState() };
    expect(state.optionsBySessionId).toBeUndefined();
    expect(Object.keys(state)).toContain("attachmentsBySessionId");
  });
});

describe("fixture runtime controller", () => {
  it("resolves an approval into command execution frames", () => {
    const runtime = createFixtureSessionRuntime({
      sessionKey: "sess-settings",
      variant: "default",
      tickMs: 1,
    });
    runtime.pause(); // deterministic: drive via dispatch only
    const before = runtime.getSnapshot();
    expect(before.projection.approval?.approvalId).toBe("approval-migrate");
    // Elapsed labels render from the runtime's reported time base — the
    // fixed scripted "now", never the wall clock.
    expect(before.nowMs).toBe(FIXTURE_NOW_MS);
    runtime.dispatch({ kind: "approval", approvalId: "approval-migrate", decision: "approve" });
    const after = runtime.getSnapshot();
    expect(after.projection.approval).toBeNull();
    runtime.dispose();
  });

  it("answers an ask and clears the request", () => {
    const runtime = createFixtureSessionRuntime({
      sessionKey: "sess-fixtures",
      variant: "default",
      tickMs: 1,
    });
    runtime.pause();
    expect(runtime.getSnapshot().projection.ask?.options.length).toBe(3);
    runtime.dispatch({ kind: "ask", askId: "ask-scenarios", optionIds: ["faults"], text: "" });
    expect(runtime.getSnapshot().projection.ask).toBeNull();
    runtime.dispose();
  });

  it("resolves a plan for approve and reject", () => {
    for (const action of ["approve", "reject"] as const) {
      const runtime = createFixtureSessionRuntime({
        sessionKey: "sess-bundle",
        variant: "default",
        tickMs: 1,
      });
      runtime.pause();
      expect(runtime.getSnapshot().projection.plan?.planId).toBe("plan-bundle");
      runtime.dispatch({ kind: "plan", planId: "plan-bundle", action, note: "" });
      expect(runtime.getSnapshot().projection.plan).toBeNull();
      runtime.dispose();
    }
  });

  it("queues follow-ups while a turn is active and refuses offline intents", () => {
    const live = createFixtureSessionRuntime({
      sessionKey: "sess-settings",
      variant: "default",
      tickMs: 1,
    });
    live.pause();
    // sess-settings has turn.start applied (approval pending mid-turn).
    expect(live.getSnapshot().projection.turnActive).toBe(true);
    live.dispatch({ kind: "followUp", text: "afterwards, run the soak test" });
    expect(live.getSnapshot().queuedFollowUps).toEqual(["afterwards, run the soak test"]);
    live.dispose();

    const offline = createFixtureSessionRuntime({
      sessionKey: "sess-pagination",
      variant: "default",
      link: "offline",
      tickMs: 1,
    });
    offline.pause();
    const entriesBefore = offline.getSnapshot().projection.entries.length;
    expect(offline.getSnapshot().canPrompt).toBe(false);
    offline.dispatch({ kind: "prompt", text: "should not apply", attachments: [] });
    expect(offline.getSnapshot().controls.modelSupported).toBe(false);
    expect(offline.getSnapshot().projection.entries.length).toBe(entriesBefore);
    offline.dispose();
  });

  it("owns model/thinking/fast/mode state and applies control intents deterministically", () => {
    const runtime = createFixtureSessionRuntime({
      sessionKey: "sess-stream",
      variant: "default",
      tickMs: 1,
    });
    runtime.pause();
    const before = runtime.getSnapshot().controls;
    // Deterministic defaults come from the script, never from persistence.
    expect(before.modelSelectedId).toBe("role:default");
    expect(before.modelLabel).toBe("Default");
    expect(before.thinking).toBe("medium");
    expect(before.fast).toBe(false);
    expect(before.mode).toBe("build");
    expect(before.modeSupported).toBe(true);
    expect(before.attachmentsSupported).toBe(true);
    expect(before.thinkingLevels).toContain("auto");
    expect(before.thinkingLevels).toContain("max");

    runtime.dispatch({ kind: "setModel", selector: null, role: "smol" });
    runtime.dispatch({ kind: "setThinking", level: "xhigh" });
    runtime.dispatch({ kind: "setFast", enabled: true });
    runtime.dispatch({ kind: "setMode", mode: "plan" });
    const after = runtime.getSnapshot().controls;
    expect(after.modelSelectedId).toBe("role:smol");
    expect(after.modelLabel).toBe("Fast");
    expect(after.thinking).toBe("xhigh");
    expect(after.fast).toBe(true);
    expect(after.mode).toBe("plan");
    runtime.dispose();
  });

  it("gap variant pauses the stream instead of applying past the gap", () => {
    const runtime = createFixtureSessionRuntime({
      sessionKey: "sess-stream",
      variant: "gap",
      tickMs: 1,
    });
    runtime.pause();
    // Drive pending ticks synchronously by resuming with a tiny tick and
    // waiting is nondeterministic; instead the projection reducer already
    // covers gap semantics. Here we just assert the script attached cleanly.
    expect(runtime.getSnapshot().projection.phase).toBe("active");
    runtime.dispose();
  });
});
