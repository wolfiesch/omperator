import { createDesktopRuntimeController } from "@t4-code/client";
import {
  entryId,
  hostId,
  revision,
  sessionId,
  type DurableEntry,
  type SessionSnapshotFrame,
} from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import { createFixtureSessionRuntime } from "../src/features/session-runtime/controller.ts";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import {
  createTranscriptImageSource,
  decodeTranscriptImageChunk,
  disposeTranscriptImagesForSession,
  isAnimatedTranscriptImage,
  transcriptImageSourceForSession,
  TRANSCRIPT_IMAGE_CHUNK_BYTES,
  TRANSCRIPT_IMAGE_DECODE_ERROR,
  TRANSCRIPT_IMAGE_INTEGRITY_ERROR,
  TRANSCRIPT_IMAGE_MAX_CHUNKS,
  TRANSCRIPT_IMAGE_PAUSED_REASON,
  TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
  type TranscriptImageCommandResult,
  type TranscriptImageSnapshot,
  type TranscriptImageSource,
  type TranscriptMediaReference,
} from "../src/features/session-runtime/transcript-images.ts";
import {
  INVALID_TRANSCRIPT_IMAGE_METADATA,
  transcriptImagesFromEntry,
  type TranscriptImageMimeType,
  type TranscriptImageReference,
} from "../src/features/transcript/image-metadata.ts";
import type { TranscriptArtifactReference } from "../src/features/transcript/artifact-metadata.ts";
import { initialProjection, reduceTranscript } from "../src/features/transcript/projection.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";

const HOST = "image-host";
const SESSION = "image-session";

function pngBytes(size = 16, salt = 0): Uint8Array {
  const bytes = new Uint8Array(Math.max(8, size));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (index + salt) % 251;
  return bytes;
}

function gifBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x02]);
}

function animatedGifBytes(): Uint8Array {
  const header = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  ];
  const frame = [
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x02,
    0x02, 0x4c, 0x01,
    0x00,
  ];
  return new Uint8Array([...header, ...frame, ...frame, 0x3b]);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

async function reference(
  bytes: Uint8Array,
  options: { readonly entryId?: string; readonly mimeType?: TranscriptImageMimeType } = {},
): Promise<TranscriptImageReference> {
  return {
    entryId: options.entryId ?? "entry-image",
    sha256: await sha256(bytes),
    mimeType: options.mimeType ?? "image/png",
  };
}

function responseFor(
  bytes: Uint8Array,
  image: TranscriptImageReference,
  offset: number,
): TranscriptImageCommandResult {
  const nextOffset = Math.min(offset + TRANSCRIPT_IMAGE_CHUNK_BYTES, bytes.byteLength);
  return {
    accepted: true,
    result: {
      sha256: image.sha256,
      mimeType: image.mimeType,
      size: bytes.byteLength,
      offset,
      nextOffset,
      complete: nextOffset === bytes.byteLength,
      content: base64(bytes.subarray(offset, nextOffset)),
    },
  };
}

function artifactResponseFor(
  bytes: Uint8Array,
  artifact: TranscriptArtifactReference,
  offset: number,
): TranscriptImageCommandResult {
  const nextOffset = Math.min(offset + TRANSCRIPT_IMAGE_CHUNK_BYTES, bytes.byteLength);
  return {
    accepted: true,
    result: {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      size: bytes.byteLength,
      offset,
      nextOffset,
      complete: nextOffset === bytes.byteLength,
      content: base64(bytes.subarray(offset, nextOffset)),
    },
  };
}

async function waitForStatus(
  source: TranscriptImageSource,
  image: TranscriptMediaReference,
  status: TranscriptImageSnapshot["status"],
): Promise<TranscriptImageSnapshot> {
  const initial = source.getSnapshot(image);
  if (initial.status === status) return initial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for transcript image ${status}`));
    }, 2_000);
    const check = () => {
      const snapshot = source.getSnapshot(image);
      if (snapshot.status !== status) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = source.subscribe(image, check);
    check();
  });
}

function durableEntry(
  id: string,
  kind: string,
  data: Record<string, unknown>,
): DurableEntry {
  return {
    id: entryId(id),
    parentId: null,
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    kind,
    timestamp: "2026-07-14T12:00:00.000Z",
    data,
  };
}

describe("transcript image metadata", () => {
  it("preserves exact ordered metadata for message and tool-result rows", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const message = durableEntry("message-images", "message", {
      role: "user",
      text: "look",
      images: [
        { sha256: first, mimeType: "image/png" },
        { sha256: second, mimeType: "image/webp" },
      ],
    });
    const tool = durableEntry("tool-images", "tool-result", {
      tool: "read",
      title: "read image",
      result: {},
      images: [{ sha256: second, mimeType: "image/webp" }],
    });
    const frame: SessionSnapshotFrame = {
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "images", seq: 1 },
      revision: revision("images-revision"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [message, tool],
    };
    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), frame));
    const messageRow = rows.find((row) => row.kind === "message");
    const toolRow = rows.find((row) => row.kind === "tool-group");

    expect(messageRow?.kind === "message" && messageRow.images).toEqual([
      { entryId: "message-images", sha256: first, mimeType: "image/png" },
      { entryId: "message-images", sha256: second, mimeType: "image/webp" },
    ]);
    expect(toolRow?.kind === "tool-group" && toolRow.calls[0]?.images).toEqual([
      { entryId: "tool-images", sha256: second, mimeType: "image/webp" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("content");
  });

  it("rejects the whole metadata list when any item is malformed", () => {
    for (const images of [
      "not-an-array",
      [{ sha256: "A".repeat(64), mimeType: "image/png" }],
      [{ sha256: "a".repeat(64), mimeType: "image/svg+xml" }],
      [{ sha256: "a".repeat(64), mimeType: "image/png", content: "AQ==" }],
      Array.from({ length: 65 }, () => ({ sha256: "a".repeat(64), mimeType: "image/png" })),
    ]) {
      expect(transcriptImagesFromEntry(durableEntry("bad", "message", { images }))).toEqual({
        images: [],
        issue: INVALID_TRANSCRIPT_IMAGE_METADATA,
      });
    }
  });
});

describe("transcript image result decoding", () => {
  it("accepts one exact bounded result and rejects structural or sequencing drift", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const valid = responseFor(bytes, image, 0).result as Record<string, unknown>;
    expect(decodeTranscriptImageChunk(valid, image, 0)).toMatchObject({
      size: bytes.byteLength,
      offset: 0,
      nextOffset: bytes.byteLength,
      complete: true,
    });
    expect(
      decodeTranscriptImageChunk(
        {
          ...valid,
          nextOffset: 8,
          complete: false,
          content: base64(bytes.subarray(0, 8)),
        },
        image,
        0,
      ),
    ).toMatchObject({ offset: 0, nextOffset: 8, complete: false });

    for (const invalid of [
      { ...valid, sha256: "f".repeat(64) },
      { ...valid, mimeType: "image/webp" },
      { ...valid, size: 0 },
      { ...valid, offset: 1 },
      { ...valid, nextOffset: bytes.byteLength - 1 },
      { ...valid, complete: false },
      { ...valid, content: "AQJ=" },
      { ...valid, path: "/tmp/image" },
    ]) {
      expect(() => decodeTranscriptImageChunk(invalid, image, 0)).toThrow(
        TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
      );
    }
  });

  it("detects browser-decodable animated formats before autoplay", () => {
    expect(isAnimatedTranscriptImage(animatedGifBytes(), "image/gif")).toBe(true);
    expect(
      isAnimatedTranscriptImage(
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x00, 0x61, 0x63, 0x54, 0x4c,
          0x00, 0x00, 0x00, 0x00,
        ]),
        "image/png",
      ),
    ).toBe(true);
    expect(
      isAnimatedTranscriptImage(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
          0x57, 0x45, 0x42, 0x50,
          0x41, 0x4e, 0x49, 0x4d, 0x00, 0x00, 0x00, 0x00,
        ]),
        "image/webp",
      ),
    ).toBe(true);
    expect(isAnimatedTranscriptImage(pngBytes(), "image/png")).toBe(false);
  });
});

describe("bounded transcript image source", () => {
  it("exposes only the newest registered source and restores the prior source on disposal", () => {
    const first = createTranscriptImageSource({
      hostId: "registry-host",
      sessionId: "registry-session",
      readChunk: async () => ({ accepted: false }),
    });
    const second = createTranscriptImageSource({
      hostId: "registry-host",
      sessionId: "registry-session",
      readChunk: async () => ({ accepted: false }),
    });

    expect(transcriptImageSourceForSession("registry-host", "registry-session")).toBe(second);
    second.dispose();
    expect(transcriptImageSourceForSession("registry-host", "registry-session")).toBe(first);
    first.dispose();
    expect(transcriptImageSourceForSession("registry-host", "registry-session")).toBeNull();
  });

  it("deduplicates duplicate references, reconstructs sequentially, and revokes on dispose", async () => {
    const bytes = pngBytes(TRANSCRIPT_IMAGE_CHUNK_BYTES + 17);
    const image = await reference(bytes);
    const offsets: number[] = [];
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => {
        offsets.push(offset);
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: (blob) => {
        blobs.push(blob);
        return "blob:verified";
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const releaseFirst = source.retain(image);
    const releaseSecond = source.retain({ ...image });
    const ready = await waitForStatus(source, image, "ready");

    expect(ready).toEqual({
      status: "ready",
      url: "blob:verified",
      mimeType: "image/png",
      size: bytes.byteLength,
      animated: false,
    });
    expect(offsets).toEqual([0, TRANSCRIPT_IMAGE_CHUNK_BYTES]);
    expect(blobs).toHaveLength(1);
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(bytes);
    releaseFirst();
    releaseSecond();
    source.dispose();
    expect(revoked).toEqual(["blob:verified"]);
  });

  it("reversibly evicts ready bytes on pause while retains and listeners remain active", async () => {
    const bytes = pngBytes(32, 41);
    const image = await reference(bytes, { entryId: "pause-ready" });
    const revoked: string[] = [];
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => {
        reads += 1;
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => `blob:pause-ready-${reads}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });
    let notifications = 0;
    const unsubscribe = source.subscribe(image, () => {
      notifications += 1;
    });
    const release = source.retain(image);
    const first = await waitForStatus(source, image, "ready");

    expect(first).toMatchObject({ status: "ready", url: "blob:pause-ready-1" });
    expect((source as unknown as { readonly residentBytes: number }).residentBytes).toBe(
      bytes.byteLength,
    );

    source.pause();
    source.pause();

    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: TRANSCRIPT_IMAGE_PAUSED_REASON,
    });
    expect(revoked).toEqual(["blob:pause-ready-1"]);
    expect((source as unknown as { readonly residentBytes: number }).residentBytes).toBe(0);
    const pausedNotifications = notifications;

    source.resume();
    source.resume();

    expect(await waitForStatus(source, image, "ready")).toMatchObject({
      status: "ready",
      url: "blob:pause-ready-2",
    });
    expect(reads).toBe(2);
    expect(notifications).toBeGreaterThan(pausedNotifications);

    release();
    unsubscribe();
    source.dispose();
    expect(revoked).toEqual(["blob:pause-ready-1", "blob:pause-ready-2"]);
  });

  it("cancels a non-abortable paused load and never commits its stale response after resume", async () => {
    const bytes = pngBytes(32, 42);
    const image = await reference(bytes, { entryId: "pause-race" });
    const firstResult = deferred<TranscriptImageCommandResult>();
    const created: string[] = [];
    const revoked: string[] = [];
    let reads = 0;
    let firstCancelled = false;
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxConcurrentLoads: 1,
      readChunk: async (nextImage, offset, signal) => {
        reads += 1;
        if (reads === 1) {
          signal.onCancel(() => {
            firstCancelled = true;
          });
          // Match the desktop command path: cancellation cannot abort the
          // already-issued RPC, so its eventual response must be discarded.
          return firstResult.promise;
        }
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => {
        const url = `blob:pause-race-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const release = source.retain(image);
    expect(reads).toBe(1);

    source.pause();
    source.resume();
    expect(firstCancelled).toBe(true);
    expect(created).toEqual([]);

    firstResult.resolve(responseFor(bytes, image, 0));
    expect(await waitForStatus(source, image, "ready")).toMatchObject({
      status: "ready",
      url: "blob:pause-race-1",
    });
    expect(reads).toBe(2);
    expect(created).toEqual(["blob:pause-race-1"]);

    source.pause();
    source.dispose();
    release();
    expect(revoked).toEqual(["blob:pause-race-1"]);
    expect((source as unknown as { readonly entries: Map<unknown, unknown> }).entries.size).toBe(0);
    expect((source as unknown as { readonly residentBytes: number }).residentBytes).toBe(0);
    expect((source as unknown as { readonly reservedBytes: number }).reservedBytes).toBe(0);
  });

  it("drops accumulated segments immediately across eight paused runtimes with stalled RPCs", async () => {
    const runtimeCount = 8;
    const loadsPerRuntime = 4;
    const declaredSize = 16 * 1024 * 1024;
    const firstChunk = pngBytes(TRANSCRIPT_IMAGE_CHUNK_BYTES, 44);
    const encodedFirstChunk = base64(firstChunk);
    const gates = new Map<string, ReturnType<typeof deferred<TranscriptImageCommandResult>>>();
    const stalled = new Set<string>();
    let urlsCreated = 0;
    const sources = Array.from({ length: runtimeCount }, (_, runtimeIndex) =>
      createTranscriptImageSource({
        availability: { available: true },
        maxConcurrentLoads: loadsPerRuntime,
        readChunk: (image, offset) => {
          if (offset === 0) {
            return Promise.resolve({
              accepted: true,
              result: {
                sha256: image.sha256,
                mimeType: image.mimeType,
                size: declaredSize,
                offset: 0,
                nextOffset: TRANSCRIPT_IMAGE_CHUNK_BYTES,
                complete: false,
                content: encodedFirstChunk,
              },
            });
          }
          stalled.add(image.entryId);
          const gate = deferred<TranscriptImageCommandResult>();
          gates.set(image.entryId, gate);
          return gate.promise;
        },
        createObjectUrl: () => {
          urlsCreated += 1;
          return `blob:stalled-${runtimeIndex}-${urlsCreated}`;
        },
      }),
    );
    const references = sources.map((_, runtimeIndex) =>
      Array.from({ length: loadsPerRuntime }, (_, loadIndex): TranscriptImageReference => ({
        entryId: `stalled-${runtimeIndex}-${loadIndex}`,
        sha256: `${runtimeIndex.toString(16)}${loadIndex.toString(16)}`.padEnd(64, "a"),
        mimeType: "image/png",
      })),
    );
    const releases = sources.map((source, runtimeIndex) =>
      references[runtimeIndex]!.map((image) => source.retain(image)),
    );
    type DebugSource = {
      readonly activeLoads: number;
      readonly bufferedBytes: number;
      readonly materializedBytes: number;
      readonly reservedBytes: number;
      readonly entries: Map<string, { readonly accumulator: unknown }>;
    };
    const debug = (source: (typeof sources)[number]) => source as unknown as DebugSource;
    const sum = (
      field: "activeLoads" | "bufferedBytes" | "materializedBytes" | "reservedBytes",
    ) =>
      sources.reduce((total, source) => total + debug(source)[field], 0);

    await vi.waitFor(() => expect(stalled.size).toBe(runtimeCount * loadsPerRuntime));

    // The old implementation had already allocated all 512 MiB represented
    // by these reservations. Segment accumulation holds only the 8 MiB that
    // actually arrived before the host calls stalled.
    expect(sum("reservedBytes")).toBe(runtimeCount * loadsPerRuntime * declaredSize);
    expect(sum("bufferedBytes")).toBe(
      runtimeCount * loadsPerRuntime * TRANSCRIPT_IMAGE_CHUNK_BYTES,
    );
    expect(sum("materializedBytes")).toBe(0);
    expect(sum("activeLoads")).toBe(runtimeCount * loadsPerRuntime);

    for (const source of sources) source.pause();

    // The host Promises are deliberately still unresolved. Pausing must drop
    // actual Uint8Array references and reservation authority synchronously.
    expect(gates.size).toBe(runtimeCount * loadsPerRuntime);
    expect(sum("activeLoads")).toBe(runtimeCount * loadsPerRuntime);
    expect(sum("bufferedBytes")).toBe(0);
    expect(sum("materializedBytes")).toBe(0);
    expect(sum("reservedBytes")).toBe(0);
    for (const source of sources) {
      for (const entry of debug(source).entries.values()) {
        expect(entry.accumulator).toBeNull();
      }
    }
    expect(urlsCreated).toBe(0);

    for (const gate of gates.values()) gate.resolve({ accepted: false });
    await vi.waitFor(() => expect(sum("activeLoads")).toBe(0));
    for (const runtimeReleases of releases) {
      for (const release of runtimeReleases) release();
    }
    for (const source of sources) source.dispose();
    expect(urlsCreated).toBe(0);
  });

  it("globally serializes materialization and cancels paused finalizer waiters", async () => {
    const runtimeCount = 8;
    const bytes = pngBytes(TRANSCRIPT_IMAGE_CHUNK_BYTES + 32, 45);
    const image = await reference(bytes, { entryId: "deferred-digest" });
    const digestGate = deferred<string>();
    let digestCalls = 0;
    const digestSizes: number[] = [];
    let urlsCreated = 0;
    const sources = Array.from({ length: runtimeCount }, (_, runtimeIndex) =>
      createTranscriptImageSource({
        availability: { available: true },
        readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
        digest: (input) => {
          digestCalls += 1;
          digestSizes.push(input.byteLength);
          return digestGate.promise;
        },
        createObjectUrl: () => {
          urlsCreated += 1;
          return `blob:deferred-digest-${runtimeIndex}-${urlsCreated}`;
        },
      }),
    );
    const releases = sources.map((source) => source.retain(image));
    type DebugSource = {
      readonly activeLoads: number;
      readonly bufferedBytes: number;
      readonly materializedBytes: number;
      readonly reservedBytes: number;
    };
    const debug = (source: (typeof sources)[number]) => source as unknown as DebugSource;
    const sum = (
      field: "activeLoads" | "bufferedBytes" | "materializedBytes" | "reservedBytes",
    ) => sources.reduce((total, source) => total + debug(source)[field], 0);
    let digestReleased = false;
    try {
      await vi.waitFor(() => {
        expect(digestCalls).toBe(1);
        expect(sum("materializedBytes")).toBe(bytes.byteLength);
        expect(sum("bufferedBytes")).toBe((runtimeCount - 1) * bytes.byteLength);
      });

      // Seven completed downloads wait as clearable segments. Only the global
      // finalizer owner has a contiguous buffer captured by the stalled digest.
      expect(digestSizes).toEqual([bytes.byteLength]);
      expect(sum("reservedBytes")).toBe(runtimeCount * bytes.byteLength);
      expect(sum("activeLoads")).toBe(runtimeCount);
      expect(urlsCreated).toBe(0);

      for (const source of sources) source.pause();

      // Paused queue members never materialize. The sole in-flight digest keeps
      // exactly one authoritative reservation until its Promise unwinds.
      expect(digestCalls).toBe(1);
      expect(sum("bufferedBytes")).toBe(0);
      expect(sum("materializedBytes")).toBe(bytes.byteLength);
      expect(sum("reservedBytes")).toBe(bytes.byteLength);
      expect(urlsCreated).toBe(0);

      digestReleased = true;
      digestGate.resolve(image.sha256);
      await vi.waitFor(() => expect(sum("activeLoads")).toBe(0));
      expect(sum("bufferedBytes")).toBe(0);
      expect(sum("materializedBytes")).toBe(0);
      expect(sum("reservedBytes")).toBe(0);
      expect(digestCalls).toBe(1);
      expect(urlsCreated).toBe(0);
    } finally {
      for (const source of sources) source.pause();
      if (!digestReleased) digestGate.resolve(image.sha256);
      for (const release of releases) release();
      await vi.waitFor(() => expect(sum("activeLoads")).toBe(0));
      for (const source of sources) source.dispose();
    }
  });

  it("refuses digest and MIME magic mismatches before creating a URL", async () => {
    const valid = pngBytes(16, 1);
    const different = pngBytes(16, 2);
    const digestMismatch = await reference(different, { entryId: "digest-mismatch" });
    const gif = gifBytes();
    const mimeMismatch = await reference(gif, {
      entryId: "mime-mismatch",
      mimeType: "image/png",
    });
    let created = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (image, offset) =>
        responseFor(image.entryId === "digest-mismatch" ? valid : gif, image, offset),
      createObjectUrl: () => {
        created += 1;
        return `blob:${created}`;
      },
    });

    const releaseDigest = source.retain(digestMismatch);
    const digestError = await waitForStatus(source, digestMismatch, "error");
    const releaseMime = source.retain(mimeMismatch);
    const mimeError = await waitForStatus(source, mimeMismatch, "error");

    expect(digestError).toEqual({ status: "error", reason: TRANSCRIPT_IMAGE_INTEGRITY_ERROR });
    expect(mimeError).toEqual({ status: "error", reason: TRANSCRIPT_IMAGE_INTEGRITY_ERROR });
    expect(created).toBe(0);
    releaseDigest();
    releaseMime();
    source.dispose();
  });

  it("keeps retained URLs alive and evicts the least-recent unused URL", async () => {
    const firstBytes = pngBytes(16, 1);
    const secondBytes = pngBytes(16, 2);
    const first = await reference(firstBytes, { entryId: "first" });
    const second = await reference(secondBytes, { entryId: "second" });
    const revoked: string[] = [];
    let objectUrlSerial = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxCacheBytes: 32,
      maxCacheEntries: 1,
      readChunk: async (image, offset) =>
        responseFor(image.entryId === "first" ? firstBytes : secondBytes, image, offset),
      createObjectUrl: (blob) => {
        objectUrlSerial += 1;
        return `blob:${blob.size}:${objectUrlSerial}`;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const unsubscribeFirst = source.subscribe(first, () => undefined);
    const releaseFirst = source.retain(first);
    const firstReady = await waitForStatus(source, first, "ready");
    const releaseSecond = source.retain(second);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.getSnapshot(second)).toEqual({ status: "loading" });
    expect(revoked).toEqual([]);

    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(source.getSnapshot(second)).toEqual({ status: "loading" });
    expect(revoked).toEqual([]);
    unsubscribeFirst();
    const secondReady = await waitForStatus(source, second, "ready");
    expect(secondReady.status).toBe("ready");
    expect(revoked).toEqual([firstReady.status === "ready" ? firstReady.url : ""]);
    releaseSecond();
    source.dispose();
  });

  it("bounds concurrent reads and drains queued images in order", async () => {
    const images = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const bytes = pngBytes(16, index + 1);
        return { bytes, image: await reference(bytes, { entryId: `queued-${index}` }) };
      }),
    );
    const gates = new Map<string, ReturnType<typeof deferred<TranscriptImageCommandResult>>>();
    for (const { image } of images) gates.set(image.entryId, deferred<TranscriptImageCommandResult>());
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxConcurrentLoads: 2,
      readChunk: async (image) => {
        started.push(image.entryId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gates.get(image.entryId)!.promise;
        } finally {
          active -= 1;
        }
      },
      createObjectUrl: (blob) => `blob:queued-${blob.size}-${started.length}`,
    });
    const releases = images.map(({ image }) => source.retain(image));

    expect(started).toEqual(["queued-0", "queued-1"]);
    for (let index = 0; index < images.length; index += 1) {
      const item = images[index]!;
      gates.get(item.image.entryId)!.resolve(responseFor(item.bytes, item.image, 0));
      expect((await waitForStatus(source, item.image, "ready")).status).toBe("ready");
      await Promise.resolve();
    }
    expect(started).toEqual(images.map(({ image }) => image.entryId));
    expect(maximumActive).toBe(2);
    for (const release of releases) release();
    source.dispose();
  });

  it("aborts an unretained read and wakes the next queued image", async () => {
    const firstBytes = pngBytes(16, 11);
    const secondBytes = pngBytes(16, 12);
    const first = await reference(firstBytes, { entryId: "abort-first" });
    const second = await reference(secondBytes, { entryId: "abort-second" });
    const firstStarted = deferred<void>();
    let aborted = false;
    let secondReads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxConcurrentLoads: 1,
      readChunk: (image, offset, signal) => {
        if (image.entryId === first.entryId) {
          firstStarted.resolve(undefined);
          return new Promise((_, reject) => {
            signal.onCancel(() => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        }
        secondReads += 1;
        return Promise.resolve(responseFor(secondBytes, image, offset));
      },
      createObjectUrl: () => "blob:after-abort",
    });

    const releaseFirst = source.retain(first);
    const releaseSecond = source.retain(second);
    await firstStarted.promise;
    expect(secondReads).toBe(0);
    releaseFirst();

    expect((await waitForStatus(source, second, "ready")).status).toBe("ready");
    expect(aborted).toBe(true);
    expect(secondReads).toBe(1);
    releaseSecond();
    source.dispose();
  });

  it("removes cancelled queue entries while a non-abortable host read is still live", async () => {
    const firstBytes = pngBytes(16, 21);
    const first = await reference(firstBytes, { entryId: "non-abortable-first" });
    const firstResult = deferred<TranscriptImageCommandResult>();
    const churn = await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        const bytes = pngBytes(16, index + 22);
        return { bytes, image: await reference(bytes, { entryId: `cancelled-${index}` }) };
      }),
    );
    const finalBytes = pngBytes(16, 99);
    const final = await reference(finalBytes, { entryId: "queue-survivor" });
    const reads: string[] = [];
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxConcurrentLoads: 1,
      readChunk: async (image, offset) => {
        reads.push(image.entryId);
        if (image.entryId === first.entryId) {
          // Deliberately ignore the cancellation signal, matching the live
          // controller command that can only settle when the host responds.
          return firstResult.promise;
        }
        return responseFor(finalBytes, image, offset);
      },
      createObjectUrl: (blob) => `blob:non-abortable-${blob.size}-${reads.length}`,
    });
    const pendingCount = () =>
      (source as unknown as { readonly pendingLoads: readonly unknown[] }).pendingLoads.length;

    const releaseFirst = source.retain(first);
    expect(reads).toEqual([first.entryId]);
    for (const { image } of churn) {
      const release = source.retain(image);
      expect(pendingCount()).toBe(1);
      release();
      expect(pendingCount()).toBe(0);
    }

    const releaseFinal = source.retain(final);
    expect(pendingCount()).toBe(1);
    firstResult.resolve(responseFor(firstBytes, first, 0));
    expect((await waitForStatus(source, first, "ready")).status).toBe("ready");
    expect((await waitForStatus(source, final, "ready")).status).toBe("ready");
    expect(reads).toEqual([first.entryId, final.entryId]);

    releaseFinal();
    releaseFirst();
    source.dispose();
  });

  it("does not read while unavailable and resumes retained reads when access arrives", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: false, reason: "Waiting for the host." },
      readChunk: async (nextImage, offset) => {
        reads += 1;
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => "blob:connected",
    });
    const release = source.retain(image);
    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Waiting for the host.",
    });
    expect(source.getSnapshot(image)).toBe(source.getSnapshot(image));
    expect(reads).toBe(0);

    source.setAvailability({ available: true });
    expect((await waitForStatus(source, image, "ready")).status).toBe("ready");
    expect(reads).toBe(1);
    release();
    source.dispose();
  });

  it("hides cached legacy images and artifacts when their capability is revoked", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes, { entryId: "revoked-image" });
    const artifact: TranscriptArtifactReference = {
      artifactId: "revoked-artifact",
      kind: "image",
      mediaType: "image/png",
      disposition: "inline",
      retention: "session",
      source: "artifact",
    };
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextReference, offset) =>
        "artifactId" in nextReference
          ? artifactResponseFor(bytes, artifact, offset)
          : responseFor(bytes, image, offset),
      createObjectUrl: (blob) => `blob:revoked-${blob.size}`,
    });
    const releaseImage = source.retain(image);
    const releaseArtifact = source.retain(artifact);
    expect((await waitForStatus(source, image, "ready")).status).toBe("ready");
    expect((await waitForStatus(source, artifact, "ready")).status).toBe("ready");

    source.setAvailability((nextReference) => ({
      available: false,
      reason: "artifactId" in nextReference ? "Artifact access revoked." : "Image access revoked.",
    }));
    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Image access revoked.",
    });
    expect(source.getSnapshot(artifact)).toEqual({
      status: "unavailable",
      reason: "Artifact access revoked.",
    });
    releaseArtifact();
    releaseImage();
    source.dispose();
  });

  it("clears transient failure state so a later retain can retry cleanly", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => {
        reads += 1;
        return reads === 1
          ? { accepted: false, error: { code: "connection_closed", message: "gone" } }
          : responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => "blob:retry",
    });

    const releaseFailed = source.retain(image);
    expect((await waitForStatus(source, image, "error")).status).toBe("error");
    releaseFailed();
    const releaseReady = source.retain(image);
    expect(await waitForStatus(source, image, "ready")).toMatchObject({
      status: "ready",
      url: "blob:retry",
    });
    expect(reads).toBe(2);
    releaseReady();
    source.dispose();
  });

  it("bounds pathological tiny-chunk responses", async () => {
    const bytes = pngBytes(TRANSCRIPT_IMAGE_MAX_CHUNKS + 1);
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (_nextImage, offset) => {
        reads += 1;
        const nextOffset = offset + 1;
        return {
          accepted: true,
          result: {
            sha256: image.sha256,
            mimeType: image.mimeType,
            size: bytes.byteLength,
            offset,
            nextOffset,
            complete: nextOffset === bytes.byteLength,
            content: base64(bytes.subarray(offset, nextOffset)),
          },
        };
      },
    });
    const release = source.retain(image);

    expect(await waitForStatus(source, image, "error")).toEqual({
      status: "error",
      reason: TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
    });
    expect(reads).toBe(TRANSCRIPT_IMAGE_MAX_CHUNKS);
    release();
    source.dispose();
  });

  it("revokes a just-created URL when disposal wins the final integrity race", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    let source!: ReturnType<typeof createTranscriptImageSource>;
    source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => {
        source.dispose("Closed during image finalization.");
        return "blob:finalization-race";
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const release = source.retain(image);
    expect(await waitForStatus(source, image, "unavailable")).toEqual({
      status: "unavailable",
      reason: "Closed during image finalization.",
    });
    expect(revoked).toEqual(["blob:finalization-race"]);
    expect(source.getSnapshot(image)).toBe(source.getSnapshot(image));
    release();
    source.dispose();
    expect(revoked).toEqual(["blob:finalization-race"]);
  });

  it("revokes and removes a cached URL when the browser rejects its bytes", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => "blob:decode-failure",
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const release = source.retain(image);
    await waitForStatus(source, image, "ready");

    source.reportDecodeFailure(image);

    expect(source.getSnapshot(image)).toEqual({
      status: "error",
      reason: TRANSCRIPT_IMAGE_DECODE_ERROR,
    });
    expect(revoked).toEqual(["blob:decode-failure"]);
    release();
    source.dispose();
    expect(revoked).toEqual(["blob:decode-failure"]);
  });

  it("revokes registered URLs on authoritative session deletion", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      hostId: HOST,
      sessionId: SESSION,
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => "blob:authoritative",
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const release = source.retain(image);
    await waitForStatus(source, image, "ready");

    disposeTranscriptImagesForSession(HOST, SESSION);

    expect(revoked).toEqual(["blob:authoritative"]);
    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "This session was removed from the host.",
    });
    release();
  });
});

describe("runtime capability gating", () => {
  function snapshot(): SessionSnapshotFrame {
    return {
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "runtime-images", seq: 1 },
      revision: revision("runtime-images-revision"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [],
    };
  }

  it("keeps fixture/browser transcript images honestly unavailable", async () => {
    const image = await reference(pngBytes());
    const runtime = createFixtureSessionRuntime({ sessionKey: "fixture", variant: "default" });
    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Transcript images are available only from a connected OMP host.",
    });
    runtime.dispose();
  });

  it("requires sessions.read and transcript.images before issuing a read", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.read"], []) });
    shell.emitFrame({ targetId: "local", frame: snapshot() });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    const release = runtime.transcriptImages.retain(image);

    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "This OMP host does not offer transcript image reads.",
    });
    expect(shell.commandCount("session.image.read")).toBe(0);
    release();
    runtime.dispose();
    await controller.stop();
  });

  it("reads through the live runtime only after the attach acknowledgement", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const shell = new FakeShell();
    const attachGate = deferred<void>();
    shell.command = async (request: CommandRequest): Promise<CommandResult> => {
      shell.commands.push(request);
      if (request.intent.command === "session.attach") await attachGate.promise;
      const result =
        request.intent.command === "session.image.read"
          ? responseFor(bytes, image, Number(request.intent.args?.offset)).result
          : { accepted: true };
      return {
        targetId: request.targetId,
        requestId: `runtime-image-${shell.commands.length}`,
        commandId: `runtime-image-command-${shell.commands.length}`,
        accepted: true,
        result,
      };
    };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"], ["transcript.images"]),
    });
    shell.emitFrame({ targetId: "local", frame: snapshot() });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    const release = runtime.transcriptImages.retain(image);
    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Waiting for this session to finish connecting.",
    });
    expect(shell.commandCount("session.image.read")).toBe(0);
    attachGate.resolve(undefined);
    expect((await waitForStatus(runtime.transcriptImages, image, "ready")).status).toBe("ready");
    expect(
      shell.commands.map((request) => request.intent.command).filter((command) =>
        command.startsWith("session.image"),
      ),
    ).toEqual(["session.image.read"]);
    expect(shell.commands.find((request) => request.intent.command === "session.image.read")?.intent.args)
      .toEqual({ entryId: image.entryId, sha256: image.sha256, offset: 0 });

    release();
    runtime.dispose();
    await controller.stop();
  });

  it("gates mixed legacy images and generic artifacts by their own feature", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes, { entryId: "legacy-image" });
    const artifact: TranscriptArtifactReference = {
      artifactId: "generic-image",
      kind: "image",
      mediaType: "image/png",
      disposition: "inline",
      retention: "session",
      source: "artifact",
    };

    const run = async (
      features: readonly string[],
      available: TranscriptMediaReference,
      unavailable: TranscriptMediaReference,
      expectedCommand: "session.image.read" | "artifact.read",
    ) => {
      const shell = new FakeShell();
      shell.command = async (request: CommandRequest): Promise<CommandResult> => {
        shell.commands.push(request);
        const result =
          request.intent.command === "session.image.read"
            ? responseFor(bytes, image, Number(request.intent.args?.offset)).result
            : request.intent.command === "artifact.read"
              ? artifactResponseFor(bytes, artifact, Number(request.intent.args?.offset)).result
              : { accepted: true };
        return {
          targetId: request.targetId,
          requestId: `mixed-media-${shell.commands.length}`,
          commandId: `mixed-media-command-${shell.commands.length}`,
          accepted: true,
          result,
        };
      };
      const controller = createDesktopRuntimeController({ shell });
      await controller.start();
      try {
        shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.read"], features) });
        shell.emitFrame({ targetId: "local", frame: snapshot() });
        const runtime = createLiveSessionRuntime({
          controller,
          targetId: "local",
          hostId: HOST,
          sessionId: SESSION,
        });
        try {
          const releaseAvailable = runtime.transcriptImages.retain(available);
          const releaseUnavailable = runtime.transcriptImages.retain(unavailable);
          try {
            expect(await waitForStatus(runtime.transcriptImages, available, "ready")).toMatchObject({
              status: "ready",
            });
            await vi.waitFor(() =>
              expect(runtime.transcriptImages.getSnapshot(unavailable)).toMatchObject({
                status: "unavailable",
              }),
            );
            expect(
              shell.commands
                .map((request) => request.intent.command)
                .filter(
                  (command) => command === "session.image.read" || command === "artifact.read",
                ),
            ).toEqual([expectedCommand]);
          } finally {
            releaseUnavailable();
            releaseAvailable();
          }
        } finally {
          runtime.dispose();
        }
      } finally {
        await controller.stop();
      }
    };

    await run(["transcript.images"], image, artifact, "session.image.read");
    await run(["artifacts.read"], artifact, image, "artifact.read");
  });

  it("routes runtime pause and resume through reversible transcript-image eviction", async () => {
    const bytes = pngBytes(32, 43);
    const image = await reference(bytes, { entryId: "runtime-pause" });
    const shell = new FakeShell();
    shell.command = async (request: CommandRequest): Promise<CommandResult> => {
      shell.commands.push(request);

      const result =
        request.intent.command === "session.image.read"
          ? responseFor(bytes, image, Number(request.intent.args?.offset)).result
          : { accepted: true };
      return {
        targetId: request.targetId,
        requestId: `runtime-pause-${shell.commands.length}`,
        commandId: `runtime-pause-command-${shell.commands.length}`,
        accepted: true,
        result,
      };
    };
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:runtime-pause-${created.length + 1}`;
      created.push(url);
      return url;
    });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    const controller = createDesktopRuntimeController({ shell });
    try {
      await controller.start();
      shell.emitFrame({
        targetId: "local",
        frame: makeWelcome(HOST, ["sessions.read"], ["transcript.images"]),
      });
      shell.emitFrame({ targetId: "local", frame: snapshot() });
      const runtime = createLiveSessionRuntime({
        controller,
        targetId: "local",
        hostId: HOST,
        sessionId: SESSION,
      });
      const release = runtime.transcriptImages.retain(image);
      expect(await waitForStatus(runtime.transcriptImages, image, "ready")).toMatchObject({
        status: "ready",
        url: "blob:runtime-pause-1",
      });

      runtime.pause();
      runtime.pause();
      expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
        status: "unavailable",
        reason: TRANSCRIPT_IMAGE_PAUSED_REASON,
      });
      expect(revoked).toEqual(["blob:runtime-pause-1"]);

      runtime.resume();
      runtime.resume();
      expect(await waitForStatus(runtime.transcriptImages, image, "ready")).toMatchObject({
        status: "ready",
        url: "blob:runtime-pause-2",
      });
      expect(shell.commandCount("session.image.read")).toBe(2);

      release();
      runtime.dispose();
      expect(revoked).toEqual(["blob:runtime-pause-1", "blob:runtime-pause-2"]);
    } finally {
      await controller.stop();
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });
});
