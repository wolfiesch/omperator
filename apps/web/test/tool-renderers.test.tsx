import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { decodeServerFrame } from "@t4-code/protocol";

import {
  adaptToolRender,
  type ToolRenderInput,
} from "../src/features/transcript/tool-render/adapter.ts";
import { resolveToolRenderer } from "../src/features/transcript/tool-render/registry.ts";
import {
  boundToolTextForDisplay,
  DiffBlock,
  MAX_TOOL_TEXT_RENDER_CHARS,
  MAX_TOOL_TEXT_RENDER_LINES,
  Output,
  ResultImages,
} from "../src/features/transcript/tool-render/parts.tsx";
import type { ToolRenderProps } from "../src/features/transcript/tool-render/types.ts";
import { initialProjection, reduceTranscript } from "../src/features/transcript/projection.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";

function renderTool(
  input: Omit<ToolRenderInput, "state"> & { readonly state?: ToolRenderInput["state"] },
) {
  const view = adaptToolRender({ ...input, state: input.state ?? "ok" });
  const renderer = resolveToolRenderer(view.name);
  const props: ToolRenderProps = {
    name: view.name,
    args: view.args,
    result: view.result,
    running: input.state === "running",
  };
  const Summary = renderer.Summary;
  const Body = renderer.Body;
  return {
    view,
    summary: renderToStaticMarkup(<Summary {...props} />),
    body: Body === undefined ? "" : renderToStaticMarkup(<Body {...props} />),
  };
}

describe("OMP semantic tool renderers", () => {
  it("renders apply-patch input as a file summary and diff instead of an args dump", () => {
    const rendered = renderTool({
      tool: "edit",
      args: {
        input:
          "*** Begin Patch\n*** Update File: src/alpha.ts\n@@\n-oldValue\n+newValue\n*** End Patch",
      },
      result: {
        additions: 1,
        deletions: 1,
        diff: "@@ -1 +1 @@\n-oldValue\n+newValue",
      },
    });

    expect(rendered.view.known).toBe(true);
    expect(rendered.summary).toContain("src/alpha.ts");
    expect(rendered.summary).toContain("+1");
    expect(rendered.body).toContain("tv-diff-row--del");
    expect(rendered.body).toContain("tv-diff-row--add");
    expect(rendered.body.indexOf("tv-diff")).toBeLessThan(rendered.body.indexOf("input"));
    expect(rendered.summary).not.toContain("&quot;input&quot;");
  });

  it("renders a phased todo board with task statuses", () => {
    const rendered = renderTool({
      tool: "todo",
      args: {
        op: "write",
        list: [{ name: "Build", items: ["Wire renderer", "Verify"] }],
      },
      result: {
        content: [],
        details: {
          phases: [
            {
              name: "Build",
              tasks: [
                { content: "Wire renderer", status: "in_progress" },
                { content: "Verify", status: "pending" },
              ],
            },
          ],
        },
      },
    });

    expect(rendered.summary).toContain("write");
    expect(rendered.body).toContain("I. Build");
    expect(rendered.body).toContain("tv-task--in_progress");
    expect(rendered.body).toContain('aria-hidden="true"');
    expect(rendered.body).toContain('class="sr-only">In progress:');
    expect(rendered.body).toContain("tv-task-content");
    expect(rendered.body).toContain("Wire renderer");
    expect(rendered.body).toContain("→");
  });

  it("renders task assignments and agent results with status and output", () => {
    const rendered = renderTool({
      tool: "task",
      args: {
        agent: "reviewer",
        tasks: [
          {
            id: "ui.audit",
            description: "Audit renderer fidelity",
            assignment: "Inspect the tool events and report gaps.",
          },
        ],
      },
      result: {
        content: [],
        details: {
          results: [
            {
              id: "ui.audit",
              description: "Audit renderer fidelity",
              exitCode: 0,
              output: "All requested event families are covered.",
              durationMs: 1250,
            },
          ],
        },
      },
    });

    expect(rendered.summary).toContain("reviewer");
    expect(rendered.body).toContain("ui&gt;audit");
    expect(rendered.body).toContain("assignment");
    expect(rendered.body).toContain("done");
    expect(rendered.body).toContain("All requested event families are covered.");
    expect(rendered.body).toContain("1 succeeded");
  });

  it("renders read selectors, resolved metadata, and full live content", () => {
    const rendered = renderTool({
      tool: "read",
      args: { path: "src/session.ts", range: "20-30" },
      result: {
        content: [{ type: "text", text: "export const session = true;" }],
        details: { resolvedPath: "/workspace/src/session.ts" },
      },
    });

    expect(rendered.summary).toContain("src/session.ts");
    expect(rendered.summary).toContain("20-30");
    expect(rendered.body).toContain("resolved");
    expect(rendered.body).toContain("export const session = true;");
  });

  it("renders shell, search, and fetch payloads semantically", () => {
    const shell = renderTool({
      tool: "bash",
      args: { command: "pnpm test", cwd: "/workspace" },
      result: { output: "3 tests passed", exitCode: 0 },
    });
    expect(shell.summary).toContain("pnpm test");
    expect(shell.body).toContain("tv-cmd-prompt");
    expect(shell.body).toContain("3 tests passed");

    const search = renderTool({
      tool: "search",
      args: { pattern: "ToolCallRow", path: "apps/web" },
      result: { matches: 2, files: ["apps/web/a.tsx", "apps/web/b.tsx"] },
    });
    expect(search.summary).toContain("/ToolCallRow/");
    expect(search.body).toContain("2 matches");
    expect(search.body).toContain("2 files");
    expect(search.body).toContain("apps/web/a.tsx");

    const fetch = renderTool({
      tool: "fetch",
      args: { url: "https://example.test/page" },
      result: {
        output: "# Page title",
        url: "https://example.test/page",
        finalUrl: "https://example.test/final",
        contentType: "text/markdown",
      },
    });
    expect(fetch.summary).toContain("https://example.test/page");
    expect(fetch.body).toContain("final url");
    expect(fetch.body).toContain("https://example.test/final");
    expect(fetch.body).toContain("# Page title");
  });

  it("adapts both structured live results and old durable output records", () => {
    const live = renderTool({
      tool: "bash",
      args: { command: "pwd" },
      result: {
        content: [{ type: "text", text: "/workspace" }],
        details: { exitCode: 0, wallTimeMs: 12 },
      },
    });
    expect(live.body).toContain("/workspace");
    expect(live.body).toContain("wall 12ms");

    const durable = renderTool({
      tool: "bash",
      args: { command: "echo durable" },
      result: { output: "durable output", exitCode: 0 },
    });
    expect(durable.body).toContain("durable output");
    expect(durable.view.result?.details).toMatchObject({ exitCode: 0 });
    expect(durable.view.result?.details).not.toHaveProperty("output");
  });

  it("unwraps appserver-1 v17 xdev frames and accepts appserver-2 semantic frames", () => {
    const wrapped = renderTool({
      tool: "write",
      args: {
        path: "xd://generate_image",
        content: JSON.stringify({ subject: "A geometric fox", aspect_ratio: "16:9" }),
      },
      result: {
        content: [{ type: "text", text: "generated" }],
        details: {
          xdev: {
            tool: "generate_image",
            mode: "execute",
            args: { subject: "A geometric fox", aspect_ratio: "16:9" },
            inner: { provider: "test-provider", model: "image-model" },
          },
        },
      },
    });

    expect(wrapped.view).toMatchObject({
      name: "generate_image",
      args: { subject: "A geometric fox", aspect_ratio: "16:9" },
      known: true,
      result: { details: { provider: "test-provider", model: "image-model" } },
    });
    expect(wrapped.view.result?.details).not.toHaveProperty("xdev");
    expect(wrapped.summary).toContain("A geometric fox");
    expect(wrapped.body).toContain("test-provider");

    const ownedImage = adaptToolRender({
      tool: "write",
      args: {
        path: "xd://generate_image",
        content: JSON.stringify({ subject: "A geometric fox" }),
      },
      result: {
        content: [{ type: "text", text: "generated" }],
        details: {
          xdev: {
            tool: "generate_image",
            mode: "execute",
            args: { subject: "A geometric fox" },
            inner: {
              provider: "test-provider",
              images: [{ type: "image", mimeType: "image/png", data: "legacy-inline-bytes" }],
            },
          },
        },
      },
      state: "ok",
      omitInlineImages: true,
    });
    expect(ownedImage.result?.details).toEqual({ provider: "test-provider" });
    expect(JSON.stringify(ownedImage)).not.toContain("legacy-inline-bytes");

    const normalized = renderTool({
      tool: "hub",
      args: { op: "send", to: "ReviewAgent", message: "Please verify the fix." },
      result: {
        content: [{ type: "text", text: "delivered" }],
        details: { op: "send", receipts: [{ to: "ReviewAgent", outcome: "woken" }] },
      },
    });
    expect(normalized.view.known).toBe(true);
    expect(normalized.summary).toContain("send");
    expect(normalized.summary).toContain("ReviewAgent");
    expect(normalized.body).toContain("woken");
  });

  it("consumes an appserver-2 xdev image entry with separate managed metadata", () => {
    const frame = decodeServerFrame({
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "epoch", seq: 0 },
      revision: "r-appserver-2-xdev-fixture",
      hostId: "host",
      sessionId: "session",
      entries: [
        {
          id: "xdev-image-tool",
          parentId: null,
          hostId: "host",
          sessionId: "session",
          kind: "tool-use",
          timestamp: "2026-07-15T20:03:00Z",
          data: {
            toolCallId: "xdev-call",
            tool: "generate_image",
            title: "generate_image",
            args: { subject: "A geometric fox", aspect_ratio: "16:9" },
            ok: true,
            result: {
              output: "generated image",
              content: [{ type: "text", text: "generated image" }],
              details: { provider: "test-provider", model: "image-model" },
              isError: false,
            },
            images: [{ sha256: "c".repeat(64), mimeType: "image/png" }],
          },
        },
      ],
    });
    if (frame.type !== "snapshot") throw new Error("expected appserver snapshot fixture");
    const [row] = deriveTranscriptRows(reduceTranscript(initialProjection(), frame));
    if (row?.kind !== "tool-group") throw new Error("expected appserver tool group");
    const [call] = row.calls;
    if (!call) throw new Error("expected appserver tool call");

    expect(call.images).toEqual([
      {
        entryId: "xdev-image-tool",
        sha256: "c".repeat(64),
        mimeType: "image/png",
      },
    ]);
    const view = adaptToolRender({
      tool: call.tool,
      args: call.args,
      result: call.result,
      state: call.state,
      omitInlineImages: call.images.length > 0,
    });
    expect(view).toMatchObject({
      name: "generate_image",
      args: { subject: "A geometric fox", aspect_ratio: "16:9" },
      known: true,
      result: { details: { provider: "test-provider", model: "image-model" } },
    });
    expect(JSON.stringify(view)).not.toContain('"xdev"');
  });

  it("uses call-only xdev semantics while running but rejects settled mismatches", () => {
    const running = adaptToolRender({
      tool: "write",
      args: { path: "xd://hub", content: JSON.stringify({ op: "list" }) },
      result: null,
      state: "running",
    });
    expect(running).toMatchObject({ name: "hub", args: { op: "list" }, known: true });

    const mismatch = adaptToolRender({
      tool: "write",
      args: { path: "xd://hub", content: JSON.stringify({ op: "list" }) },
      result: {
        content: [{ type: "text", text: "unexpected" }],
        details: {
          xdev: {
            tool: "generate_image",
            mode: "execute",
            args: { subject: "spoof" },
            inner: {},
          },
        },
      },
      state: "ok",
    });
    expect(mismatch.name).toBe("write");
    expect(mismatch.args).toMatchObject({ path: "xd://hub" });
    expect(mismatch.result?.details).toHaveProperty("xdev");

    const oversizedMultibyte = adaptToolRender({
      tool: "write",
      args: {
        path: "xd://hub",
        content: JSON.stringify({ op: "send", message: "🦊".repeat(40_000) }),
      },
      result: null,
      state: "running",
    });
    expect(oversizedMultibyte.name).toBe("write");
  });

  it("renders v17 plain-text xdev devices as bounded semantic cards", () => {
    const resolve = renderTool({
      tool: "write",
      args: { path: "xd://resolve", content: " Apply the preview. " },
      result: null,
      state: "running",
    });
    expect(resolve.view).toMatchObject({
      name: "resolve",
      args: { reason: "Apply the preview." },
      known: true,
    });
    expect(resolve.summary).toContain("apply");
    expect(resolve.summary).toContain("Apply the preview.");

    const reject = renderTool({
      tool: "write",
      args: { path: "xd://reject", content: " Discard this change. " },
      result: {
        content: [{ type: "text", text: "rejected" }],
        details: {
          xdev: {
            tool: "reject",
            mode: "execute",
            args: { reason: "Discard this change." },
            inner: { action: "discard" },
          },
        },
      },
    });
    expect(reject.view).toMatchObject({
      name: "reject",
      args: { reason: "Discard this change." },
      known: true,
    });
    expect(reject.summary).toContain("discard");
    expect(reject.body).toContain("proposed → rejected");
    expect(reject.body).toContain("Discard this change.");

    const propose = renderTool({
      tool: "write",
      args: { path: "xd://propose", content: " session-lifecycle-plan " },
      result: null,
      state: "running",
    });
    expect(propose.view).toMatchObject({
      name: "propose",
      args: { title: "session-lifecycle-plan" },
      known: true,
    });
    expect(propose.summary).toContain("plan");
    expect(propose.summary).toContain("session-lifecycle-plan");

    const reportIssue = renderTool({
      tool: "write",
      args: { path: "xd://report_issue", content: " write lost the final line " },
      result: null,
      state: "running",
    });
    expect(reportIssue.view).toMatchObject({
      name: "report_issue",
      args: { report: "write lost the final line" },
      known: true,
    });
    expect(reportIssue.summary).toContain("write lost the final line");
    expect(reportIssue.body).toContain("write lost the final line");
  });

  it("keeps plain-text xdev normalization exact and correlation-safe", () => {
    const mismatch = adaptToolRender({
      tool: "write",
      args: { path: "xd://resolve", content: "Apply the preview." },
      result: {
        content: [{ type: "text", text: "unexpected" }],
        details: {
          xdev: {
            tool: "reject",
            mode: "execute",
            args: { reason: "Discard this change." },
            inner: {},
          },
        },
      },
      state: "ok",
    });
    expect(mismatch.name).toBe("write");
    expect(mismatch.result?.details).toHaveProperty("xdev");

    const sameToolMismatch = adaptToolRender({
      tool: "write",
      args: { path: "xd://resolve", content: "Apply A" },
      result: {
        content: [{ type: "text", text: "unexpected" }],
        details: {
          xdev: {
            tool: "resolve",
            mode: "execute",
            args: { reason: "Apply B" },
            inner: { action: "apply" },
          },
        },
      },
      state: "ok",
    });
    expect(sameToolMismatch.name).toBe("write");
    expect(sameToolMismatch.args).toMatchObject({ path: "xd://resolve", content: "Apply A" });
    expect(sameToolMismatch.result?.details).toHaveProperty("xdev");

    const strictJsonDevice = adaptToolRender({
      tool: "write",
      args: { path: "xd://hub", content: "not-json" },
      result: null,
      state: "running",
    });
    expect(strictJsonDevice.name).toBe("write");

    const oversizedPlainText = adaptToolRender({
      tool: "write",
      args: { path: "xd://resolve", content: "🦊".repeat(40_000) },
      result: null,
      state: "running",
    });
    expect(oversizedPlainText.name).toBe("write");
  });

  it("routes hub job and process modes to bounded semantic cards", () => {
    const jobs = renderTool({
      tool: "hub",
      args: { op: "jobs" },
      result: {
        content: [],
        details: {
          op: "jobs",
          jobs: [
            {
              id: "review",
              type: "task",
              status: "completed",
              label: "Compatibility review",
              durationMs: 1250,
              resultText: "No blockers.",
            },
          ],
        },
      },
    });
    expect(jobs.summary).toContain("list");
    expect(jobs.body).toContain("Compatibility review");
    expect(jobs.body).toContain("completed");

    const process = renderTool({
      tool: "hub",
      args: { op: "start", name: "web", application: "pnpm", args: ["dev"] },
      result: {
        content: [{ type: "text", text: "started web" }],
        details: { op: "start", daemon: { name: "web", state: "running", pid: 4242 } },
      },
    });
    expect(process.summary).toContain("start");
    expect(process.summary).toContain("web");
    expect(process.body).toContain("pnpm dev");
    expect(process.body).toContain("running");
  });

  it("disambiguates both settled outcomes of a bare hub wait", () => {
    const message = renderTool({
      tool: "hub",
      args: { op: "wait" },
      result: {
        content: [{ type: "text", text: "message received" }],
        details: {
          op: "wait",
          waited: { from: "ReviewAgent", body: "The compatibility check is clean." },
        },
      },
    });
    expect(message.summary).toContain("ReviewAgent");
    expect(message.summary).toContain("compatibility check is clean");
    expect(message.body).toContain("The compatibility check is clean.");

    const job = renderTool({
      tool: "hub",
      args: { op: "wait" },
      result: {
        content: [],
        details: {
          op: "wait",
          jobs: [
            {
              id: "review",
              type: "task",
              status: "completed",
              label: "Compatibility review",
              durationMs: 1250,
              resultText: "No blockers.",
            },
          ],
        },
      },
    });
    expect(job.summary).toContain("all running jobs");
    expect(job.body).toContain("Compatibility review");
    expect(job.body).toContain("completed");
  });

  it("keeps malformed known tools semantic and reserves raw JSON for unknown tools", () => {
    const malformed = renderTool({
      tool: "bash",
      args: { command: 42 },
      result: { output: "bad command" },
      state: "error",
    });
    expect(malformed.view.known).toBe(true);
    expect(malformed.summary).toContain("[invalid command]");
    expect(malformed.body).toContain("[invalid command]");
    expect(malformed.body).not.toContain("&quot;command&quot;");

    const unknown = renderTool({
      tool: "future_quantum_tool",
      args: { mode: "entangle", count: 3 },
      result: { output: "complete" },
    });
    expect(unknown.view.known).toBe(false);
    expect(unknown.body).toContain("args");
    expect(unknown.body).toContain("&quot;mode&quot;");
    expect(unknown.body).toContain("entangle");
    expect(unknown.body).toContain("complete");
  });

  it("strips internal intent for clean display and avoids duplicate inline images", () => {
    const kept = adaptToolRender({
      tool: "read",
      args: { i: "Inspect the generated diagram", path: "diagram.png" },
      result: {
        content: [
          { type: "text", text: "generated" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      state: "ok",
    });
    expect(kept.intent).toBe("Inspect the generated diagram");
    expect(kept.args).not.toHaveProperty("i");
    expect(kept.result?.content).toHaveLength(2);

    const omitted = adaptToolRender({
      tool: "read",
      args: { path: "diagram.png" },
      result: {
        content: [
          { type: "text", text: "generated" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      state: "ok",
      omitInlineImages: true,
    });
    expect(omitted.result?.content).toEqual([{ type: "text", text: "generated" }]);
  });

  it("exposes expandable blocks and inline result images to assistive technology", () => {
    const output = renderToStaticMarkup(<Output maxLines={1} text={"first\nsecond\nthird"} />);
    const diff = renderToStaticMarkup(<DiffBlock diff={"+first\n+second\n+third"} maxLines={1} />);
    const images = renderToStaticMarkup(
      <ResultImages
        result={{
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
            },
          ],
        }}
      />,
    );

    for (const markup of [output, diff]) {
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain("aria-controls=");
    }
    expect(images).toContain('class="tv-image-button"');
    expect(images).toContain('aria-label="Open tool result image 1"');
    expect(images).toContain('<img alt="" class="tv-img" decoding="async" loading="lazy"');
  });

  it("keeps huge command and diff previews to a bounded head and tail window", () => {
    const huge = [
      "HEAD_SENTINEL",
      ...Array.from({ length: 99_998 }, (_, index) =>
        index === 50_000 ? "MIDDLE_SENTINEL" : `test output ${index}`,
      ),
      "TAIL_SENTINEL",
    ].join("\n");
    const bounded = boundToolTextForDisplay(huge);

    expect(bounded.truncated).toBe(true);
    expect(bounded.totalLines).toBe(100_000);
    expect(bounded.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_RENDER_CHARS);
    expect(bounded.text.split("\n")).toHaveLength(MAX_TOOL_TEXT_RENDER_LINES);
    expect(bounded.text).toContain("HEAD_SENTINEL");
    expect(bounded.text).toContain("TAIL_SENTINEL");
    expect(bounded.text).toContain("output capped");
    expect(bounded.text).not.toContain("MIDDLE_SENTINEL");

    const output = renderToStaticMarkup(<Output maxLines={12} text={huge} />);
    const diff = renderToStaticMarkup(<DiffBlock diff={huge} maxLines={40} />);
    for (const markup of [output, diff]) {
      expect(markup).toContain("100,000 lines · bounded preview");
      expect(markup).not.toContain("MIDDLE_SENTINEL");
    }
  });

  it("renders web-search sources as identifiable external links", () => {
    const rendered = renderTool({
      tool: "web_search",
      args: { query: "T4 Code" },
      result: {
        content: [],
        details: {
          response: {
            sources: [{ title: "T4 Code docs", url: "https://example.test/docs" }],
          },
        },
      },
    });

    expect(rendered.body).toContain('class="tv-link"');
    expect(rendered.body).toContain('aria-label="T4 Code docs (opens in a new tab)"');
    expect(rendered.body).toContain('rel="noreferrer"');
  });

  it("keeps active URL schemes and executable inline image payloads inert", () => {
    const search = renderTool({
      tool: "web_search",
      args: { query: "unsafe source" },
      result: {
        content: [],
        details: {
          response: {
            sources: [
              { title: "Script source", url: "javascript:alert(document.domain)" },
              { title: "Data source", url: "data:text/html,<script>alert(1)</script>" },
            ],
          },
        },
      },
    });
    expect(search.body).toContain("Script source");
    expect(search.body).toContain("Data source");
    expect(search.body).not.toContain("href=");
    expect(search.body).not.toContain("javascript:");
    expect(search.body).not.toContain("data:text/html");

    const images = renderToStaticMarkup(
      <ResultImages
        result={{
          content: [
            {
              type: "image",
              mimeType: "image/svg+xml",
              data: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
            },
            {
              type: "image",
              mimeType: "text/html",
              data: btoa("<script>alert(document.domain)</script>"),
            },
            {
              type: "image",
              mimeType: "image/png",
              data: btoa("<script>alert(document.domain)</script>"),
            },
          ],
        }}
      />,
    );
    expect(images).toBe("");
  });
  it("offers the live session preview without changing export renderers", () => {
    const renderer = resolveToolRenderer("browser");
    const Body = renderer.Body;
    expect(Body).toBeDefined();
    let openCount = 0;
    const props: ToolRenderProps = {
      name: "browser",
      args: { action: "open", url: "https://example.test/" },
      host: {
        openPreview: () => {
          openCount += 1;
        },
      },
    };
    const live = Body === undefined ? "" : renderToStaticMarkup(<Body {...props} />);
    expect(live).toContain("Open Preview");
    expect(live).toContain('aria-label="Open browser preview for this session"');
    expect(openCount).toBe(0);
    const exported =
      Body === undefined ? "" : renderToStaticMarkup(<Body {...props} host={undefined} />);
    expect(exported).not.toContain("Open Preview");
  });
});
