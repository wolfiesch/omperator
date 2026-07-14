// Docs navigation invariants: unique anchors, hash resolution, and complete
// topic coverage per the public-docs contract.
import { describe, expect, it } from "vite-plus/test";
import {
  ANCHOR_INDEX,
  DEFAULT_TOPIC_ID,
  DOC_GROUPS,
  DOC_TOPICS,
  resolveTopicForHash,
} from "../src/docs/content.ts";

describe("docs structure", () => {
  it("covers all twelve contracted topics", () => {
    expect(DOC_TOPICS.map((t) => t.id).sort()).toEqual(
      [
        "agents",
        "build-from-source",
        "first-run",
        "install",
        "keyboard-shortcuts",
        "local-sessions",
        "remote-pairing",
        "security",
        "session-controls",
        "settings-model-roles",
        "terminals-files-review",
        "troubleshooting",
      ].sort(),
    );
  });

  it("places every topic in exactly one group", () => {
    const grouped = DOC_GROUPS.flatMap((g) => g.topics.map((t) => t.id));
    expect(grouped.sort()).toEqual(DOC_TOPICS.map((t) => t.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("has globally unique anchor ids across topics and headings", () => {
    const ids: string[] = [];
    for (const topic of DOC_TOPICS) {
      ids.push(topic.id);
      for (const block of topic.blocks) {
        if (block.kind === "h2" || block.kind === "h3") ids.push(block.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to the install topic", () => {
    expect(DEFAULT_TOPIC_ID).toBe("install");
  });
});

describe("resolveTopicForHash", () => {
  it("resolves a topic id, with or without the leading #", () => {
    expect(resolveTopicForHash("#agents")?.id).toBe("agents");
    expect(resolveTopicForHash("agents")?.id).toBe("agents");
  });

  it("resolves a heading id to its owning topic", () => {
    expect(resolveTopicForHash("#install-android")?.id).toBe("install");
    expect(resolveTopicForHash("#install-ios")?.id).toBe("install");
    expect(resolveTopicForHash("#install-gatekeeper")?.id).toBe("install");
    expect(resolveTopicForHash("#shortcuts-composer")?.id).toBe("keyboard-shortcuts");
  });

  it("returns undefined for empty or unknown hashes", () => {
    expect(resolveTopicForHash("")).toBeUndefined();
    expect(resolveTopicForHash("#")).toBeUndefined();
    expect(resolveTopicForHash("#no-such-page")).toBeUndefined();
  });

  it("resolves every anchor the index knows", () => {
    for (const id of ANCHOR_INDEX.keys()) {
      expect(resolveTopicForHash(`#${id}`)).toBeDefined();
    }
  });
});

describe("internal links", () => {
  it("only links to anchors that exist", () => {
    const linkTargets: string[] = [];
    for (const topic of DOC_TOPICS) {
      const texts: string[] = [topic.lede];
      for (const block of topic.blocks) {
        if (block.kind === "p" || block.kind === "note") texts.push(block.text);
        if (block.kind === "ul" || block.kind === "ol") texts.push(...block.items);
      }
      for (const text of texts) {
        for (const match of text.matchAll(/\]\(#([^)]+)\)/g)) {
          linkTargets.push(match[1]!);
        }
      }
    }
    expect(linkTargets.length).toBeGreaterThan(0);
    for (const target of linkTargets) {
      expect(ANCHOR_INDEX.has(target), `broken anchor #${target}`).toBe(true);
    }
  });
});
