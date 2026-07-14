import { describe, expect, it } from "vite-plus/test";

import {
  canonicalBase64,
  IMAGE_PROMPT_UNKNOWN_REASON,
  IMAGE_UPLOAD_CHUNK_BYTES,
  IMAGE_UPLOAD_PREPARATION_REASON,
  IMAGE_UPLOAD_PROTOCOL_REASON,
  runImagePromptUpload,
  sniffPromptImageMimeType,
  type ImagePromptUploadOptions,
  type ImageUploadCommand,
  type ImageUploadCommandResult,
} from "../src/features/session-runtime/image-upload.ts";
import type { PromptAttachment } from "../src/features/session-runtime/intents.ts";

const IMAGE_IDS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
] as const;

function pngBytes(size = 16): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 8));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = index % 251;
  return bytes;
}

function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
}

function attachment(
  id: string,
  bytes: Uint8Array,
  options: { readonly name?: string; readonly type?: string } = {},
): PromptAttachment {
  const file = new File([new Uint8Array(bytes)], options.name ?? `${id}.png`, {
    type: options.type ?? "image/png",
  });
  return {
    id,
    name: file.name,
    mediaType: file.type,
    sizeBytes: file.size,
    kind: "image",
    file,
  };
}

function byteLengthOfBase64(value: string): number {
  return atob(value).length;
}

interface UploadHarness {
  readonly events: string[];
  readonly chunks: string[];
  readonly command: ImagePromptUploadOptions["command"];
}

function successfulCommandHarness(ids: readonly string[] = IMAGE_IDS): UploadHarness {
  const events: string[] = [];
  const chunks: string[] = [];
  let beginIndex = 0;
  const sizes = new Map<string, number>();
  const received = new Map<string, number>();
  return {
    events,
    chunks,
    async command(command, args) {
      if (command === "session.image.begin") {
        const imageId = ids[beginIndex++];
        if (imageId === undefined) throw new Error("test image id exhausted");
        sizes.set(imageId, Number(args.size));
        received.set(imageId, 0);
        events.push(`begin:${imageId}:${String(args.mimeType)}`);
        return {
          accepted: true,
          result: { imageId, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES },
        };
      }
      const imageId = String(args.imageId);
      if (command === "session.image.discard") {
        events.push(`discard:${imageId}`);
        return { accepted: true, result: { discarded: true } };
      }
      const content = String(args.content);
      chunks.push(content);
      const next = (received.get(imageId) ?? 0) + byteLengthOfBase64(content);
      received.set(imageId, next);
      events.push(`chunk:${imageId}:${String(args.offset)}:${next}`);
      return {
        accepted: true,
        result: { imageId, received: next, complete: next === sizes.get(imageId) },
      };
    },
  };
}

function baseOptions(
  attachments: readonly PromptAttachment[],
  command: ImagePromptUploadOptions["command"],
  sendPrompt: ImagePromptUploadOptions["sendPrompt"],
  targetId = "local",
): ImagePromptUploadOptions {
  return {
    targetId,
    attachments,
    command,
    sendPrompt,
    rejectionReason: () => "host rejected image upload",
  };
}

describe("image preparation", () => {
  it("magic-sniffs all supported image types and rejects arbitrary bytes", () => {
    expect(sniffPromptImageMimeType(pngBytes())).toBe("image/png");
    expect(sniffPromptImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(sniffPromptImageMimeType(new TextEncoder().encode("GIF87a"))).toBe("image/gif");
    expect(sniffPromptImageMimeType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffPromptImageMimeType(webpBytes())).toBe("image/webp");
    expect(sniffPromptImageMimeType(new TextEncoder().encode("not an image"))).toBeNull();
  });

  it("produces canonical base64 across the safe conversion-batch boundary", () => {
    const bytes = pngBytes(70_001);
    const encoded = canonicalBase64(bytes);
    const binary = atob(encoded);
    expect(binary).toHaveLength(bytes.byteLength);
    expect(Uint8Array.from(binary, (character) => character.charCodeAt(0))).toEqual(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/u);
  });
});

describe("image prompt upload", () => {
  it("reads image bytes through FileReader when File.arrayBuffer is unavailable", async () => {
    const bytes = pngBytes();
    const legacyAttachment = attachment("legacy-webview", bytes);
    Object.defineProperty(legacyAttachment.file, "arrayBuffer", {
      configurable: true,
      value: undefined,
    });

    const originalFileReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    class LegacyFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsArrayBuffer(): void {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        this.result = buffer;
        queueMicrotask(() => this.onload?.());
      }
    }
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: LegacyFileReader,
    });

    const harness = successfulCommandHarness();
    try {
      await expect(
        runImagePromptUpload(
          baseOptions([legacyAttachment], harness.command, async () => ({ kind: "accepted" })),
        ),
      ).resolves.toEqual({ kind: "accepted" });
    } finally {
      if (originalFileReader === undefined) Reflect.deleteProperty(globalThis, "FileReader");
      else Object.defineProperty(globalThis, "FileReader", originalFileReader);
    }

    expect(harness.events).toEqual([
      `begin:${IMAGE_IDS[0]}:image/png`,
      `chunk:${IMAGE_IDS[0]}:0:${bytes.byteLength}`,
      `discard:${IMAGE_IDS[0]}`,
    ]);
  });

  it("hashes and uploads whole files sequentially, normalizes MIME by magic, and prompts with refs only", async () => {
    const large = pngBytes(IMAGE_UPLOAD_CHUNK_BYTES + 7);
    const mismatched = attachment("webp", webpBytes(), {
      name: "provider.png",
      type: "image/png",
    });
    const first = attachment("large", large);
    const harness = successfulCommandHarness();
    let promptCalls = 0;
    let promptRefs: readonly Readonly<{ imageId: string }>[] = [];

    const outcome = await runImagePromptUpload(
      baseOptions([first, mismatched], harness.command, async (images) => {
        promptCalls += 1;
        promptRefs = images;
        harness.events.push("prompt");
        return { kind: "accepted" };
      }),
    );

    expect(outcome).toEqual({ kind: "accepted" });
    expect(promptCalls).toBe(1);
    expect(promptRefs).toEqual([{ imageId: IMAGE_IDS[0] }, { imageId: IMAGE_IDS[1] }]);
    expect(harness.events).toEqual([
      `begin:${IMAGE_IDS[0]}:image/png`,
      `chunk:${IMAGE_IDS[0]}:0:${IMAGE_UPLOAD_CHUNK_BYTES}`,
      `chunk:${IMAGE_IDS[0]}:${IMAGE_UPLOAD_CHUNK_BYTES}:${large.byteLength}`,
      `begin:${IMAGE_IDS[1]}:image/webp`,
      `chunk:${IMAGE_IDS[1]}:0:${webpBytes().byteLength}`,
      "prompt",
      `discard:${IMAGE_IDS[0]}`,
      `discard:${IMAGE_IDS[1]}`,
    ]);
    expect(harness.chunks[0]).toBe(canonicalBase64(large.subarray(0, IMAGE_UPLOAD_CHUNK_BYTES)));
    expect(harness.chunks[1]).toBe(canonicalBase64(large.subarray(IMAGE_UPLOAD_CHUNK_BYTES)));
  });

  it("discards every begun image when a later chunk is rejected and never sends the prompt", async () => {
    const harness = successfulCommandHarness();
    let chunks = 0;
    const command = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      if (commandName === "session.image.chunk") {
        chunks += 1;
        if (chunks === 2) {
          harness.events.push(`rejected:${String(args.imageId)}`);
          return {
            accepted: false,
            error: { code: "image_invalid", message: "test rejection" },
          };
        }
      }
      return harness.command(commandName, args);
    };
    let promptCalls = 0;

    const outcome = await runImagePromptUpload(
      baseOptions(
        [attachment("first", pngBytes()), attachment("second", pngBytes())],
        command,
        async () => {
          promptCalls += 1;
          return { kind: "accepted" };
        },
      ),
    );

    expect(outcome).toEqual({ kind: "rejected", reason: "host rejected image upload" });
    expect(promptCalls).toBe(0);
    expect(harness.events.slice(-3)).toEqual([
      `rejected:${IMAGE_IDS[1]}`,
      `discard:${IMAGE_IDS[0]}`,
      `discard:${IMAGE_IDS[1]}`,
    ]);
  });

  it("rejects unreadable image bytes before begin and preserves the prompt boundary", async () => {
    const harness = successfulCommandHarness();
    let promptCalls = 0;
    const invalid = attachment("invalid", new TextEncoder().encode("plain text"));

    const outcome = await runImagePromptUpload(
      baseOptions([invalid], harness.command, async () => {
        promptCalls += 1;
        return { kind: "accepted" };
      }),
    );

    expect(outcome).toEqual({ kind: "rejected", reason: IMAGE_UPLOAD_PREPARATION_REASON });
    expect(harness.events).toEqual([]);
    expect(promptCalls).toBe(0);
  });

  it("treats malformed progress as a protocol failure and cleans its begun spool", async () => {
    const harness = successfulCommandHarness();
    const command = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      if (commandName === "session.image.chunk") {
        return {
          accepted: true,
          result: { imageId: args.imageId, received: 1, complete: true },
        };
      }
      return harness.command(commandName, args);
    };

    const outcome = await runImagePromptUpload(
      baseOptions([attachment("proof", pngBytes())], command, async () => ({ kind: "accepted" })),
    );

    expect(outcome).toEqual({ kind: "rejected", reason: IMAGE_UPLOAD_PROTOCOL_REASON });
    expect(harness.events.at(-1)).toBe(`discard:${IMAGE_IDS[0]}`);
  });

  it("does not retry an uncertain prompt and still performs best-effort cleanup", async () => {
    const harness = successfulCommandHarness();
    let promptCalls = 0;
    const outcome = await runImagePromptUpload(
      baseOptions([attachment("proof", pngBytes())], harness.command, async () => {
        promptCalls += 1;
        throw new Error("connection closed after send");
      }),
    );

    expect(outcome).toEqual({ kind: "unknown", reason: IMAGE_PROMPT_UNKNOWN_REASON });
    expect(promptCalls).toBe(1);
    expect(harness.events.at(-1)).toBe(`discard:${IMAGE_IDS[0]}`);
  });

  it("keeps an accepted prompt accepted when post-prompt spool cleanup fails", async () => {
    const harness = successfulCommandHarness();
    let discardAttempts = 0;
    const command = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      if (commandName === "session.image.discard") {
        discardAttempts += 1;
        throw new Error("cleanup transport unavailable");
      }
      return harness.command(commandName, args);
    };

    const outcome = await runImagePromptUpload(
      baseOptions([attachment("proof", pngBytes())], command, async () => ({ kind: "accepted" })),
    );

    expect(outcome).toEqual({ kind: "accepted" });
    expect(discardAttempts).toBe(1);
  });

  it("serializes hash/upload/prompt per target", async () => {
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const firstHarness = successfulCommandHarness([IMAGE_IDS[0]]);
    const secondHarness = successfulCommandHarness([IMAGE_IDS[1]]);
    let held = false;
    const firstCommand = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      if (commandName === "session.image.begin" && !held) {
        held = true;
        events.push("A:begin-held");
        await gate.promise;
      }
      events.push(`A:${commandName}`);
      return firstHarness.command(commandName, args);
    };
    const secondCommand = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      events.push(`B:${commandName}`);
      return secondHarness.command(commandName, args);
    };

    const first = runImagePromptUpload(
      baseOptions([attachment("A", pngBytes())], firstCommand, async () => {
        events.push("A:prompt");
        return { kind: "accepted" };
      }),
    );
    const second = runImagePromptUpload(
      baseOptions([attachment("B", pngBytes())], secondCommand, async () => {
        events.push("B:prompt");
        return { kind: "accepted" };
      }),
    );
    await expect.poll(() => events).toEqual(["A:begin-held"]);

    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "accepted" },
      { kind: "accepted" },
    ]);
    expect(events).toEqual([
      "A:begin-held",
      "A:session.image.begin",
      "A:session.image.chunk",
      "A:prompt",
      "A:session.image.discard",
      "B:session.image.begin",
      "B:session.image.chunk",
      "B:prompt",
      "B:session.image.discard",
    ]);
  });

  it("settles the prompt and advances the target pipeline while post-prompt discards are pending", async () => {
    const cleanupGate = Promise.withResolvers<void>();
    const harness = successfulCommandHarness();
    const discardAttempts: string[] = [];
    const command = async (
      commandName: ImageUploadCommand,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ImageUploadCommandResult> => {
      if (commandName === "session.image.discard") {
        discardAttempts.push(String(args.imageId));
        await cleanupGate.promise;
        return { accepted: true, result: { discarded: true } };
      }
      return harness.command(commandName, args);
    };
    const promptEvents: string[] = [];

    const first = runImagePromptUpload(
      baseOptions(
        [attachment("first-a", pngBytes()), attachment("first-b", pngBytes())],
        command,
        async () => {
          promptEvents.push("first");
          return { kind: "accepted" };
        },
      ),
    );
    const second = runImagePromptUpload(
      baseOptions([attachment("second", pngBytes())], command, async () => {
        promptEvents.push("second");
        return { kind: "accepted" };
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "accepted" },
      { kind: "accepted" },
    ]);
    expect(promptEvents).toEqual(["first", "second"]);
    expect(discardAttempts).toEqual([...IMAGE_IDS]);

    cleanupGate.resolve();
  });
});
