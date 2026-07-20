// Files pane contract: lazy directory loading through the controller seam,
// preview resolution races, and offline degradation.
import { describe, expect, it } from "vite-plus/test";

import {
  createInspectorStore,
  resolveDir,
  resolvePreview,
  resolveFileWriteOutcome,
  type InspectorStoreApi,
} from "../src/features/panes/inspector-store.ts";
import type { FileTreeNode } from "../src/features/panes/model.ts";

const ROOT: FileTreeNode[] = [
  { path: "src", name: "src", kind: "dir" },
  { path: "README.md", name: "README.md", kind: "file" },
];

function storeWithDirs(): {
  api: InspectorStoreApi;
  dirCalls: string[];
  previewCalls: string[];
  writeCalls: Array<{ path: string; content: string; baseRevision: string | null }>;
} {
  const dirCalls: string[] = [];
  const previewCalls: string[] = [];
  const writeCalls: Array<{ path: string; content: string; baseRevision: string | null }> = [];
  const api = createInspectorStore({
    sampleMode: true,
    controller: () => ({
      kind: "fixture",
      performControl: () => {},
      performReview: () => {},
      loadDir: (path) => dirCalls.push(path),
      loadPreview: (path) => previewCalls.push(path),
      writeFile: (path, content, baseRevision) => writeCalls.push({ path, content, baseRevision }),
    }),
  });
  return { api, dirCalls, previewCalls, writeCalls };
}

describe("lazy file tree", () => {
  it("expanding an unknown directory marks it loading and asks the controller once", () => {
    const { api, dirCalls } = storeWithDirs();
    api.getState().setFileExpanded("src", true);
    expect(api.getState().files.childrenByPath.src).toBe("loading");
    expect(dirCalls).toEqual(["src"]);
    // Collapse and re-expand: already known (loading), no duplicate fetch.
    api.getState().setFileExpanded("src", false);
    api.getState().setFileExpanded("src", true);
    expect(dirCalls).toEqual(["src"]);
    resolveDir(api, "src", ROOT);
    expect(api.getState().files.childrenByPath.src).toEqual(ROOT);
  });

  it("a failed listing degrades to an error marker, not a crash", () => {
    const { api } = storeWithDirs();
    api.getState().setFileExpanded("src", true);
    resolveDir(api, "src", "error");
    expect(api.getState().files.childrenByPath.src).toBe("error");
  });

  it("does not send parent-directory requests to the controller", () => {
    const { api, dirCalls } = storeWithDirs();
    api.getState().requestDir("../secret");
    api.getState().setFileExpanded("src/../../secret", true);
    expect(dirCalls).toEqual([]);
    expect(api.getState().files.childrenByPath["../secret"]).toBeUndefined();
  });

  it("preview resolution is ignored once selection moved on", () => {
    const { api, previewCalls } = storeWithDirs();
    api.getState().selectFile("a.ts");
    api.getState().selectFile("b.ts");
    expect(previewCalls).toEqual(["a.ts", "b.ts"]);
    // The stale a.ts answer lands after selection changed: dropped.
    resolvePreview(api, { kind: "code", path: "a.ts", text: "old", truncated: false });
    expect(api.getState().files.preview).toBe("loading");
    resolvePreview(api, { kind: "code", path: "b.ts", text: "new", truncated: false });
    expect(api.getState().files.preview).toEqual({
      kind: "code",
      path: "b.ts",
      text: "new",
      truncated: false,
    });
  });

  it("clearing selection clears the preview", () => {
    const { api } = storeWithDirs();
    api.getState().selectFile("a.ts");
    api.getState().selectFile(null);
    expect(api.getState().files.preview).toBeNull();
  });
});

describe("file drafts", () => {
  it("edits locally, saves through the controller, and promotes confirmed text", () => {
    const { api, writeCalls } = storeWithDirs();
    api.getState().selectFile("src/app.ts");
    resolvePreview(
      api,
      {
        kind: "code",
        path: "src/app.ts",
        text: "const value = 1;\n",
        truncated: false,
      },
      "rev-1",
    );
    api.getState().startFileEdit("src/app.ts");
    expect(api.getState().files.draftsByPath["src/app.ts"]).toMatchObject({
      status: "clean",
      originalText: "const value = 1;\n",
      baseRevision: "rev-1",
      text: "const value = 1;\n",
    });
    api.getState().updateFileDraft("src/app.ts", "const value = 2;\n");
    api.getState().saveFile("src/app.ts");

    expect(writeCalls).toEqual([
      { path: "src/app.ts", content: "const value = 2;\n", baseRevision: "rev-1" },
    ]);
    expect(api.getState().files.draftsByPath["src/app.ts"]?.status).toBe("saving");

    resolveFileWriteOutcome(api, "src/app.ts", "saved");
    expect(api.getState().files.draftsByPath["src/app.ts"]).toBeUndefined();
    expect(api.getState().files.preview).toBe("loading");
    api.getState().startFileEdit("src/app.ts");
    expect(api.getState().files.draftsByPath["src/app.ts"]).toBeUndefined();

    resolvePreview(
      api,
      {
        kind: "code",
        path: "src/app.ts",
        text: "const value = 2;\n",
        truncated: false,
      },
      "rev-2",
    );
    api.getState().startFileEdit("src/app.ts");
    expect(api.getState().files.draftsByPath["src/app.ts"]).toMatchObject({
      baseRevision: "rev-2",
      originalText: "const value = 2;\n",
    });
  });

  it("keeps a dirty draft and marks a later host version as a conflict", () => {
    const { api } = storeWithDirs();
    api.getState().selectFile("src/app.ts");
    resolvePreview(api, {
      kind: "code",
      path: "src/app.ts",
      text: "before\n",
      truncated: false,
    });
    api.getState().startFileEdit("src/app.ts");
    api.getState().updateFileDraft("src/app.ts", "mine\n");

    resolvePreview(api, {
      kind: "code",
      path: "src/app.ts",
      text: "theirs\n",
      truncated: false,
    });

    expect(api.getState().files.draftsByPath["src/app.ts"]).toMatchObject({
      originalText: "before\n",
      text: "mine\n",
      status: "conflict",
    });
    expect(api.getState().files.preview).toMatchObject({ text: "theirs\n" });
  });

  it("blocks a dirty draft when a reload cannot confirm editable text", () => {
    const { api } = storeWithDirs();
    api.getState().selectFile("src/app.ts");
    resolvePreview(api, {
      kind: "code",
      path: "src/app.ts",
      text: "before\n",
      truncated: false,
    });
    api.getState().startFileEdit("src/app.ts");
    api.getState().updateFileDraft("src/app.ts", "mine\n");

    resolvePreview(api, {
      kind: "diagnostic",
      path: "src/app.ts",
      message: "The host could not read this file.",
    });

    expect(api.getState().files.draftsByPath["src/app.ts"]).toMatchObject({
      text: "mine\n",
      status: "conflict",
    });
    expect(api.getState().files.preview).toMatchObject({ kind: "diagnostic" });
  });

  it("never starts an editable draft from a truncated preview", () => {
    const { api } = storeWithDirs();
    api.getState().selectFile("large.ts");
    resolvePreview(api, {
      kind: "code",
      path: "large.ts",
      text: "partial",
      truncated: true,
    });
    api.getState().startFileEdit("large.ts");
    expect(api.getState().files.draftsByPath["large.ts"]).toBeUndefined();
  });
  it("uses generic safety copy when the host cannot confirm the draft's base revision", () => {
    const { api } = storeWithDirs();
    api.getState().selectFile("src/app.ts");
    resolvePreview(
      api,
      { kind: "code", path: "src/app.ts", text: "before\n", truncated: false },
      "rev-1",
    );
    api.getState().startFileEdit("src/app.ts");
    api.getState().updateFileDraft("src/app.ts", "mine\n");

    resolveFileWriteOutcome(api, "src/app.ts", "conflict");

    expect(api.getState().files.draftsByPath["src/app.ts"]?.message).toBe(
      "The host could not confirm this draft's base revision. Your draft is safe; discard it only when you are ready to reload.",
    );
  });

});
