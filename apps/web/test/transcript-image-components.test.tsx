import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  TranscriptImageSnapshot,
  TranscriptImageSource,
} from "../src/features/session-runtime/transcript-images.ts";
import { TranscriptImages } from "../src/features/transcript/TranscriptImages.tsx";
import type { TranscriptImageReference } from "../src/features/transcript/image-metadata.ts";

const IMAGE: TranscriptImageReference = {
  entryId: "animated-entry",
  sha256: "a".repeat(64),
  mimeType: "image/gif",
};

function source(snapshot: TranscriptImageSnapshot): TranscriptImageSource {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    retain: () => () => undefined,
    reportDecodeFailure: () => undefined,
    dispose: () => undefined,
  };
}

describe("transcript image presentation", () => {
  it("starts animated evidence paused when reduced motion is requested", () => {
    const markup = renderToStaticMarkup(
      <TranscriptImages
        images={[IMAGE]}
        issue={null}
        label="User message"
        motionPreference="reduce"
        source={source({
          status: "ready",
          url: "blob:animated",
          mimeType: "image/gif",
          size: 42,
          animated: true,
        })}
      />,
    );

    expect(markup).toContain("Animated image paused");
    expect(markup).toContain('aria-label="Play animation"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('src="blob:animated"');
  });

  it("does not add animation controls to still evidence", () => {
    const markup = renderToStaticMarkup(
      <TranscriptImages
        images={[{ ...IMAGE, mimeType: "image/png" }]}
        issue={null}
        label="Tool result"
        source={source({
          status: "ready",
          url: "blob:still",
          mimeType: "image/png",
          size: 42,
          animated: false,
        })}
      />,
    );

    expect(markup).toContain('src="blob:still"');
    expect(markup).not.toContain("animation");
  });
});
