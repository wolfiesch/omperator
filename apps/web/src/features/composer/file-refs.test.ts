// File-reference contract: "@" opens only on a whitespace-delimited token,
// listings that never resolved never reach the picker, ranking is the shared
// tiered scorer with basename matches ahead of path matches, directory
// accepts keep the menu open with a trailing slash, and chips are parsed
// back out of the draft — never staged anywhere else.
import { describe, expect, it } from "vite-plus/test";

import type { FileChildren } from "../panes/inspector-store.ts";
import {
  activeFileRefQuery,
  buildFileRefInsert,
  fileRefTokensInDraft,
  flattenFileIndex,
  rankFileRefs,
  type FileRefEntry,
} from "./file-refs.ts";

function entry(path: string, isDir = false): FileRefEntry {
  const name = path.split("/").pop() ?? path;
  return { path, name, isDir };
}

describe("activeFileRefQuery", () => {
  it("opens on '@' at the start of the draft", () => {
    expect(activeFileRefQuery("@rea", 4)).toEqual({ query: "rea", start: 0 });
  });

  it("opens on '@' after whitespace", () => {
    expect(activeFileRefQuery("check @src/li", 13)).toEqual({ query: "src/li", start: 6 });
  });

  it("opens with an empty query right after the trigger", () => {
    expect(activeFileRefQuery("@", 1)).toEqual({ query: "", start: 0 });
  });

  it("stays closed when '@' is mid-word", () => {
    expect(activeFileRefQuery("name@host", 9)).toBeNull();
  });

  it("stays closed once the token ends with whitespace", () => {
    expect(activeFileRefQuery("@done next", 10)).toBeNull();
  });

  it("follows the caret into the middle of a token", () => {
    expect(activeFileRefQuery("@src/lib.ts", 4)).toEqual({ query: "src", start: 0 });
  });

  it("stays closed when the caret leaves the token", () => {
    expect(activeFileRefQuery("@src done", 3)).toEqual({ query: "sr", start: 0 });
    expect(activeFileRefQuery("text @src", 4)).toBeNull();
  });

  it("allows slashes but not exotic characters in the query", () => {
    expect(activeFileRefQuery("@a/b-c_d.ts", 11)).toEqual({ query: "a/b-c_d.ts", start: 0 });
    expect(activeFileRefQuery("@a(b)", 4)).toBeNull();
  });

  it("allows Unicode filenames", () => {
    const text = "@资料/🧪.ts";
    expect(activeFileRefQuery(text, text.length)).toEqual({ query: "资料/🧪.ts", start: 0 });
  });

  it("rejects paths that can leave the project", () => {
    expect(activeFileRefQuery("@../secret", 10)).toBeNull();
    expect(activeFileRefQuery("@src/../../secret", 17)).toBeNull();
    expect(activeFileRefQuery("@/etc/passwd", 12)).toBeNull();
  });
});

describe("flattenFileIndex", () => {
  it("walks parents before children and preserves listing order", () => {
    const childrenByPath: Record<string, FileChildren> = {
      src: [
        { path: "src/b.ts", name: "b.ts", kind: "file" },
        { path: "src/a.ts", name: "a.ts", kind: "file" },
      ],
      "": [
        { path: "README.md", name: "README.md", kind: "file" },
        { path: "src", name: "src", kind: "dir" },
      ],
      "src/lib": [{ path: "src/lib/c.ts", name: "c.ts", kind: "file" }],
    };
    expect(flattenFileIndex(childrenByPath)).toEqual([
      entry("README.md"),
      entry("src", true),
      entry("src/b.ts"),
      entry("src/a.ts"),
      entry("src/lib/c.ts"),
    ]);
  });

  it("skips listings that are loading or in error", () => {
    const childrenByPath: Record<string, FileChildren> = {
      "": [{ path: "src", name: "src", kind: "dir" }],
      src: "loading",
    };
    expect(flattenFileIndex(childrenByPath)).toEqual([entry("src", true)]);
  });
});

describe("rankFileRefs", () => {
  const entries = [
    entry("src", true),
    entry("src/app.ts"),
    entry("src/lib/app.test.ts"),
    entry("docs/app-guide.md"),
    entry("README.md"),
  ];

  it("keeps flatten order and honors the limit on an empty query", () => {
    expect(rankFileRefs(entries, "", 2)).toEqual([entry("src", true), entry("src/app.ts")]);
  });

  it("ranks a basename prefix ahead of a deeper path hit", () => {
    const ranked = rankFileRefs(entries, "app");
    expect(ranked[0]).toEqual(entry("src/app.ts"));
  });

  it("matches on the full path too", () => {
    const ranked = rankFileRefs(entries, "lib/app");
    expect(ranked[0]).toEqual(entry("src/lib/app.test.ts"));
  });

  it("drops entries that do not match at all", () => {
    expect(rankFileRefs(entries, "zzz")).toEqual([]);
  });

  it("breaks ties by path for a stable order", () => {
    const ranked = rankFileRefs([entry("b/x.ts"), entry("a/x.ts")], "x.ts");
    expect(ranked).toEqual([entry("a/x.ts"), entry("b/x.ts")]);
  });
});

describe("buildFileRefInsert", () => {
  it("replaces the query span with a file path and a closing space", () => {
    expect(buildFileRefInsert("use @ap please", 7, 4, entry("src/app.ts"))).toEqual({
      nextText: "use @src/app.ts please",
      nextCaret: 15,
    });
  });

  it("keeps a trailing slash for directories so the menu stays open", () => {
    expect(buildFileRefInsert("@sr", 3, 0, entry("src", true))).toEqual({
      nextText: "@src/",
      nextCaret: 5,
    });
  });
});

describe("fileRefTokensInDraft", () => {
  const known = new Set(["src/app.ts", "src", "README.md"]);

  it("finds known references with their spans", () => {
    expect(fileRefTokensInDraft("look at @src/app.ts and @README.md", known)).toEqual([
      { path: "src/app.ts", start: 8, end: 19 },
      { path: "README.md", start: 24, end: 34 },
    ]);
  });

  it("ignores tokens the index does not know", () => {
    expect(fileRefTokensInDraft("ping @ghost.ts or @src/app.t", known)).toEqual([]);
  });

  it("matches directory references too", () => {
    expect(fileRefTokensInDraft("everything under @src/ broke", known)).toEqual([
      { path: "src", start: 17, end: 22 },
    ]);
  });

  it("does not turn an email-like token into a file chip", () => {
    expect(fileRefTokensInDraft("send dev@src/app.ts a note", known)).toEqual([]);
  });

  it("finds a known Unicode filename", () => {
    expect(fileRefTokensInDraft("inspect @资料/🧪.ts", new Set(["资料/🧪.ts"]))).toEqual([
      { path: "资料/🧪.ts", start: 8, end: 17 },
    ]);
  });
});
