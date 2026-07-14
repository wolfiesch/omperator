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
import type { ComposerControlsSnapshot } from "../src/features/session-runtime/session-controls.ts";
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
  thinkingLevels: ["medium", "high"],
  fastSupported: true,
  fastUnsupportedReason: null,
  fast: false,
  modeSupported: true,
  mode: "build",
  attachmentsSupported: true,
  pendingControl: null,
  controlError: null,
};

function buttonTags(markup: string): readonly string[] {
  return markup.match(/<button\b[^>]*>/g) ?? [];
}

describe("phone touch targets", () => {
  it("describes fast mode as provider priority without changing reasoning effort", () => {
    expect(fastModeTooltip(false)).toBe(
      "Request provider priority processing when supported; reasoning effort is unchanged",
    );
    expect(fastModeTooltip(true)).toBe(
      "Fast mode requests provider priority processing; reasoning effort is unchanged",
    );
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
    const rail = readFileSync(join(import.meta.dirname, "../src/components/Rail.tsx"), "utf8");
    const css = readFileSync(join(import.meta.dirname, "../src/app.css"), "utf8");

    expect(controls).toContain("flex min-h-11 w-full cursor-pointer items-center");
    expect(controls).toContain("flex max-h-[min(24rem,var(--available-height))]");
    expect(controls).toContain("min-h-0 overflow-y-auto overscroll-contain");
    expect(titlebar.match(/className="size-11 sm:size-7"/g)).toHaveLength(4);
    const hostedAppAction = readFileSync(
      join(import.meta.dirname, "../src/components/HostedAppAction.tsx"),
      "utf8",
    );
    expect(hostedAppAction).toContain('className="size-11 lg:size-7"');
    expect(session).toContain('aria-label="Session panels"');
    expect(session).toContain("flex size-11 shrink-0 cursor-pointer");
    expect(session).toContain("flex min-h-11 w-full cursor-pointer items-center");
    expect(rail).toContain("flex min-h-11 min-w-0 flex-1 items-center");
    expect(rail).toContain('"size-11 shrink-0 sm:size-6"');
    expect(css).toContain('[data-slot="sheet-popup"]');
    expect(css).toContain('input:not([type="checkbox"]):not([type="radio"])');
    expect(css).toContain("min-height: 2.75rem");
  });
});
