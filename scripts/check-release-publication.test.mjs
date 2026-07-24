import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyStableReleasePublication,
  writePublicationState,
} from "./check-release-publication.mjs";

const publishedRelease = {
  tag_name: "v0.1.17",
  html_url: "https://github.com/wolfiesch/omperator/releases/tag/v0.1.17",
  draft: false,
  prerelease: false,
  published_at: "2026-07-15T00:00:00Z",
  assets: [],
};

function response(status, body = publishedRelease) {
  return new Response(JSON.stringify(body), { status });
}

function unboundedStreamingResponse({ contentLength, chunkBytes }) {
  let canceled = false;
  const chunk = new Uint8Array(chunkBytes);
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return {
    response: { status: 200, headers, body },
    wasCanceled: () => canceled,
  };
}

test("classifies only an exact GitHub 404 as not yet published", async () => {
  assert.deepEqual(
    await classifyStableReleasePublication({
      version: "0.1.17",
      fetchImpl: async () => response(404, { message: "Not Found" }),
    }),
    { state: "not-published", tag: "v0.1.17" },
  );
});

test("accepts an exact published stable release", async () => {
  let request;
  const result = await classifyStableReleasePublication({
    version: "0.1.17",
    token: "test-token",
    fetchImpl: async (...args) => {
      request = args;
      return response(200);
    },
  });

  assert.deepEqual(result, {
    state: "published",
    tag: "v0.1.17",
    releaseUrl: publishedRelease.html_url,
  });
  assert.equal(
    request[0],
    "https://api.github.com/repos/wolfiesch/omperator/releases/tags/v0.1.17",
  );
  assert.equal(request[1].headers.Authorization, "Bearer test-token");
});

test("fails closed on authentication, network, and malformed release responses", async () => {
  const cases = [
    [async () => response(401), /HTTP 401/],
    [async () => { throw new Error("offline"); }, /Could not query GitHub/],
    [async () => response(200, { ...publishedRelease, draft: true }), /published stable release/],
    [async () => response(200, { ...publishedRelease, prerelease: true }), /published stable release/],
    [async () => response(200, { ...publishedRelease, tag_name: "v9.9.9" }), /published stable release/],
    [async () => response(200, { ...publishedRelease, html_url: "https://example.com" }), /published stable release/],
  ];
  for (const [fetchImpl, expected] of cases) {
    await assert.rejects(
      classifyStableReleasePublication({ version: "0.1.17", fetchImpl }),
      expected,
    );
  }
});

test("bounds and cancels an oversized GitHub response without Content-Length", async () => {
  const streamed = unboundedStreamingResponse({ chunkBytes: 600 * 1024 });
  await assert.rejects(
    classifyStableReleasePublication({
      version: "0.1.17",
      fetchImpl: async () => streamed.response,
    }),
    /GitHub release response exceeded 1048576 bytes/u,
  );
  assert.equal(streamed.wasCanceled(), true);
});

test("bounds and cancels an oversized GitHub response with a lying Content-Length", async () => {
  const streamed = unboundedStreamingResponse({ contentLength: "1", chunkBytes: 600 * 1024 });
  await assert.rejects(
    classifyStableReleasePublication({
      version: "0.1.17",
      fetchImpl: async () => streamed.response,
    }),
    /GitHub release response exceeded 1048576 bytes/u,
  );
  assert.equal(streamed.wasCanceled(), true);
});

test("writes a constrained publication state to the GitHub Actions output file", () => {
  const directory = mkdtempSync(join(tmpdir(), "t4-release-state-"));
  try {
    const outputPath = join(directory, "github-output");
    writePublicationState(outputPath, { state: "not-published" });
    writePublicationState(outputPath, { state: "published" });
    assert.equal(readFileSync(outputPath, "utf8"), "state=not-published\nstate=published\n");
    assert.throws(() => writePublicationState(outputPath, { state: "unknown" }), /publication state/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
