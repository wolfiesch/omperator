import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as React from "react";

import { ActionRegistryProvider } from "../src/actions/context.tsx";
import type { ActionRegistry } from "../src/actions/types.ts";
import { PaneContent } from "../src/features/panes/PaneContent.tsx";
import { SESSION_SURFACE_RENDERERS } from "../src/features/panes/PaneContent.tsx";
import { SESSION_SURFACES } from "../src/components/pane-families.tsx";
import { AgentsPane } from "../src/features/panes/AgentsPane.tsx";
import { ActivityPane } from "../src/features/panes/ActivityPane.tsx";
import { ReviewPane } from "../src/features/panes/ReviewPane.tsx";
import { createInspectorStore, type InspectorStoreApi } from "../src/features/panes/inspector-store.ts";

const TEST_ACTION_REGISTRY = {
  execute: () => ({ executed: false, availability: { status: "disabled", reason: "test" } }),
} as unknown as ActionRegistry;

function createEmptyMockStore(): InspectorStoreApi {
  return createInspectorStore({
    sampleMode: true,
    controller: () => ({
      kind: "fixture",
      performControl() {},
      performReview() {},
      loadDir() {},
      loadPreview() {},
    }),
    seed: {
      activity: [],
      agentMap: { order: [], agents: {} },
      review: {
        files: [],
        selectedPath: null,
        view: "unified",
        comments: [],
        wrap: false,
        viewedByPath: {},
        draftAnchor: null,
      },
      terminals: [],
    },
  });
}

describe("Pane empty state headers and close controls", () => {
  const mockTrailing = <button aria-label="Close pane">X</button>;

  it("keeps the registered surfaces and renderer map complete and immutable", () => {
    expect(SESSION_SURFACES.map((surface) => surface.id)).toEqual([
      "agents",
      "activity",
      "review",
      "files",
      "terminals",
    ]);
    expect(Object.keys(SESSION_SURFACE_RENDERERS)).toEqual(
      SESSION_SURFACES.map((surface) => surface.id),
    );
    expect(Object.isFrozen(SESSION_SURFACES)).toBe(true);
    expect(SESSION_SURFACES.every((surface) => Object.isFrozen(surface))).toBe(true);
  });

  it("renders an explicitly routed PaneContent with its header and close control", () => {
    const html = renderToStaticMarkup(
      <PaneContent sessionId="test-empty" surfaceId="agents" trailing={mockTrailing} />
    );
    expect(html).toContain("Agents");
    expect(html).toContain("aria-label=\"Close pane\"");
  });

  it("renders empty AgentsPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <AgentsPane api={store} sessionId="test" trailing={mockTrailing} />
    );
    expect(html).toContain("Agents");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("No agents running");
  });

  it("renders empty ActivityPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <ActivityPane api={store} trailing={mockTrailing} />
    );
    expect(html).toContain("Activity");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("Nothing recorded yet");
  });

  it("renders empty ReviewPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <ActionRegistryProvider registry={TEST_ACTION_REGISTRY}>
        <ReviewPane api={store} sessionId="test" trailing={mockTrailing} />
      </ActionRegistryProvider>
    );
    expect(html).toContain("Review");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("Nothing to review");
  });
});
