import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AttachmentChips, RunOptionsMenu } from "../src/features/composer/ComposerControls.tsx";
import {
  fastModeTooltip,
  RuntimeOptions,
} from "../src/features/composer/ComposerRuntimeOptions.tsx";
import { ContextMeter } from "../src/features/composer/ContextMeter.tsx";
import {
  thinkingValueLabel,
  type ComposerControlsSnapshot,
} from "../src/features/session-runtime/session-controls.ts";
import { CopyButton } from "../src/features/transcript/Markdown.tsx";

const CONTROLS: ComposerControlsSnapshot = {
  modelSupported: true,
  modelUnsupportedReason: null,
  modelLabel: "Fixture model",
  modelSelectedId: "model:fixture/model",
  modelChoices: [
    {
      id: "model:fixture/model",
      kind: "model",
      label: "Fixture model",
      detail: "fixture/model",
      selector: "fixture/model",
      role: null,
    },
  ],
  thinkingSupported: true,
  thinkingUnsupportedReason: null,
  thinking: "medium",
  thinkingEffective: "medium",
  thinkingResolved: null,
  thinkingOffFloored: false,
  thinkingLevels: ["medium", "high"],
  fastSupported: true,
  fastUnsupportedReason: null,
  fast: false,
  fastAvailable: true,
  fastActive: false,
  modeSupported: true,
  mode: "build",
  attachmentsSupported: true,
  attachmentsUnsupportedReason: null,
  pendingControl: null,
  controlError: null,
};

function buttonTags(markup: string): readonly string[] {
  return markup.match(/<button\b[^>]*>/g) ?? [];
}

describe("phone touch targets", () => {
  it("describes fast mode as provider priority without changing reasoning effort", () => {
    expect(fastModeTooltip({ available: true, enabled: false, active: false })).toBe(
      "Enable provider priority processing for this model; reasoning effort is unchanged",
    );
    expect(fastModeTooltip({ available: true, enabled: true, active: true })).toBe(
      "Provider priority is active for this model; reasoning effort is unchanged",
    );
  });

  it("does not invent an effective thinking level for older fixtures", () => {
    expect(thinkingValueLabel({ thinking: "medium" })).toBe("Medium");
    expect(thinkingValueLabel({ thinking: "auto" })).toBe("Auto");
  });

  it("renders every always-visible composer control at 44 CSS pixels", () => {
    const runOptions = renderToStaticMarkup(
      <RunOptionsMenu summary="Fixture model · Medium">
        <span>Options</span>
      </RunOptionsMenu>,
    );
    const context = renderToStaticMarkup(<ContextMeter usedTokens={25} windowTokens={100} />);
    const attachments = renderToStaticMarkup(
      <AttachmentChips
        attachments={[
          {
            id: "attachment-1",
            kind: "image",
            mediaType: "image/png",
            name: "proof.png",
            sizeBytes: 12,
            file: new File(["proof"], "proof.png", { type: "image/png" }),
            previewUrl: "blob:test/proof.png",
          },
        ]}
        onRemove={() => {}}
      />,
    );

    expect(buttonTags(runOptions)[0]).toContain("min-h-11");
    expect(buttonTags(context)[0]).toContain("h-11");
    expect(buttonTags(attachments)[0]).toContain("size-11");
    expect(attachments).toContain('<img alt="" class="size-4 shrink-0 rounded-sm object-cover"');
  });

  it("keeps all compact runtime triggers at 44 CSS pixels", () => {
    const markup = renderToStaticMarkup(
      <RuntimeOptions compact controls={CONTROLS} disabled={false} onIntent={() => {}} />,
    );
    const buttons = buttonTags(markup);

    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button).toContain("h-11");
  });

  it("makes transcript copy a visible 44px phone action", () => {
    const markup = renderToStaticMarkup(<CopyButton label="Copy response" text="Hello" />);
    expect(buttonTags(markup)[0]).toContain("size-11");

    const rows = readFileSync(
      join(import.meta.dirname, "../src/features/transcript/TranscriptRows.tsx"),
      "utf8",
    );
    expect(rows).toContain("h-11 items-center gap-1 opacity-100");
    expect(rows).toContain("mt-1 flex justify-end opacity-100");
  });

  it("keeps popup, titlebar, rail, and pane actions truly touch-sized", () => {
    const controls = readFileSync(
      join(import.meta.dirname, "../src/features/composer/ComposerControls.tsx"),
      "utf8",
    );
    const titlebar = readFileSync(
      join(import.meta.dirname, "../src/components/Titlebar.tsx"),
      "utf8",
    );
    const session = readFileSync(
      join(import.meta.dirname, "../src/components/SessionScreen.tsx"),
      "utf8",
    );
    const rail = [
      "../src/components/Rail.tsx",
      "../src/components/rail/SessionRowItem.tsx",
      "../src/components/rail/ProjectHeaderRow.tsx",
      "../src/components/rail/RailOptionsMenu.tsx",
    ]
      .map((path) => readFileSync(join(import.meta.dirname, path), "utf8"))
      .join("\n");
    const css = readFileSync(join(import.meta.dirname, "../src/app.css"), "utf8");

    expect(controls).toContain("flex min-h-11 w-full cursor-pointer items-center");
    expect(controls).toContain("flex max-h-[min(24rem,var(--available-height))]");
    expect(controls).toContain("min-h-0 overflow-y-auto overscroll-contain");
    expect(titlebar.match(/className="size-11 sm:size-7"/g)).toHaveLength(4);
    expect(titlebar).toContain('className="hidden size-11 sm:inline-flex sm:size-7"');
    expect(titlebar).toContain('aria-label="Exit focus mode"');
    expect(titlebar).toContain("Focus mode</span>");
    const hostedAppAction = readFileSync(
      join(import.meta.dirname, "../src/components/HostedAppAction.tsx"),
      "utf8",
    );
    expect(hostedAppAction).toContain('className="size-11 lg:size-7"');
    expect(session).toContain('aria-label="Workspace tools"');
    expect(session).toContain("flex size-11 shrink-0 cursor-pointer");
    expect(session).toContain("Session context:");
    expect(session).toContain("View host health");
    expect(session).toContain("flex min-h-11 w-full cursor-pointer items-center");
    expect(session).toContain("Agent terminals");
    expect(session).toContain("⌘J");
    expect(session).toContain("Enter focus mode");
    expect(session).toContain("⌘⇧F");
    expect(rail).toContain("flex min-h-11 min-w-0 flex-1 items-center");
    // Folder names and session titles are the rail's visible hierarchy and
    // wrap up to two lines. Host and model identifiers stay available in hover
    // tooltips instead of competing for the narrow row width; a non-default
    // host icon stays inline so touch surfaces (where tooltips never fire)
    // keep the host differentiator. The model lives tooltip-only.
    expect(rail).toContain(
      "min-w-0 flex-1 line-clamp-2 break-words font-medium text-foreground text-xs",
    );
    expect(rail).toContain("line-clamp-2 break-words text-foreground text-sm leading-5");
    expect(rail).not.toContain("modelMonogram");
    expect(rail).toContain('group.host.kind === "remote" && (');
    expect(rail).toContain(
      'Cable aria-hidden="true" className="size-3 shrink-0 text-muted-foreground"',
    );
    expect(rail).toContain("collisionPadding={8}");
    expect(rail).toContain("aria-label={`${group.displayName}, ${group.sessions.length}");
    expect(rail).toContain('Remote host" : "Host profile"');
    expect(rail).toContain("break-words font-mono text-muted-foreground");
    expect(rail).not.toContain('truncate font-mono text-[11px]">{session.model}');
    // Project-row create actions are labeled `New`, stay 44px on touch, and
    // announce that the chosen OMP profile owns the session.
    expect(rail.match(/flex h-11 shrink-0 [^"]*sm:h-6/g)).toHaveLength(2);
    expect(rail).toContain("choose the OMP profile that will own it");
    expect(rail).toContain("The OMP profile you choose will own this session.");
    expect(rail).toContain("aria-label={`New session in ${group.displayName}`}");
    expect(rail).toContain("Actions for ${group.displayName}");
    expect(rail).toContain("Only changes this T4 Code client.");
    expect(rail).toContain("flex size-11 shrink-0 cursor-pointer");
    expect(css).toContain('[data-slot="sheet-popup"]');
    expect(css).toContain('input:not([type="checkbox"]):not([type="radio"])');
    expect(css).toContain("min-height: 2.75rem");
  });

  it("keeps tool events and agent-tree rows usable at phone widths", () => {
    const agents = readFileSync(
      join(import.meta.dirname, "../src/features/panes/AgentsPane.tsx"),
      "utf8",
    );
    const toolCss = readFileSync(
      join(import.meta.dirname, "../src/features/transcript/tool-render/tool-render.css"),
      "utf8",
    );

    expect(agents).toContain("flex min-h-11 cursor-pointer flex-col justify-center");
    expect(agents).toContain("sm:min-h-0");
    expect(toolCss).toContain("@media (max-width: 39.999rem)");
    expect(toolCss).toContain(".tv-render .tv-agent-link,");
    expect(toolCss).toContain(".tv-render .tv-image-button,");
    expect(toolCss).toContain("min-height: 2.75rem");
  });
});
