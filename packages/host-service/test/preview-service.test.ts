import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validatePreviewUrl, previewUrlAllowed } from "../src/preview/url-policy.ts";
import { PreviewServiceError } from "../src/preview/types.ts";
import { PreviewService } from "../src/preview/preview-service.ts";
import { createPreviewChromiumResolver } from "../src/preview/chromium-resolver.ts";
import type { PreviewChromiumResolver } from "../src/preview/types.ts";
import type { SessionId } from "@t4-code/host-wire";

const SESSION_ID = "sess_test" as SessionId;

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

describe("preview URL policy", () => {
	describe("validatePreviewUrl", () => {
		it("accepts http localhost", () => {
			expect(validatePreviewUrl("http://localhost:3000").hostname).toBe("localhost");
		});

		it("accepts https localhost", () => {
			expect(validatePreviewUrl("https://localhost").hostname).toBe("localhost");
		});

		it("accepts 127.0.0.1", () => {
			expect(validatePreviewUrl("http://127.0.0.1:8080").hostname).toBe("127.0.0.1");
		});

		it("accepts [::1]", () => {
			expect(validatePreviewUrl("http://[::1]:9000").hostname).toBe("[::1]");
		});

		it("accepts .ts.net tailnet host", () => {
			expect(validatePreviewUrl("https://myhost.ts.net").hostname).toBe("myhost.ts.net");
		});

		it("accepts .tailnet host", () => {
			expect(validatePreviewUrl("https://dev.tailnet:443").hostname).toBe("dev.tailnet");
		});

		it("rejects non-http protocols", () => {
			expect(() => validatePreviewUrl("file:///etc/passwd")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("ftp://localhost")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("javascript:alert(1)")).toThrow(PreviewServiceError);
		});

		it("rejects credentials in URL", () => {
			expect(() => validatePreviewUrl("http://user:pass@localhost:3000")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("http://user@localhost:3000")).toThrow(PreviewServiceError);
		});

		it("rejects arbitrary internet hosts", () => {
			expect(() => validatePreviewUrl("https://example.com")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("http://10.0.0.1")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("http://192.168.1.1")).toThrow(PreviewServiceError);
		});

		it("rejects unparseable URLs", () => {
			expect(() => validatePreviewUrl("not a url")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("")).toThrow(PreviewServiceError);
			expect(() => validatePreviewUrl("://")).toThrow(PreviewServiceError);
		});

		it("rejects with correct error codes", () => {
			try {
				validatePreviewUrl("ftp://localhost");
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(PreviewServiceError);
				expect((e as PreviewServiceError).code).toBe("forbidden_url");
			}
			try {
				validatePreviewUrl("not a url");
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(PreviewServiceError);
				expect((e as PreviewServiceError).code).toBe("invalid_url");
			}
		});
	});

	describe("previewUrlAllowed", () => {
		it("returns true for allowed URLs", () => {
			expect(previewUrlAllowed("http://localhost:3000")).toBe(true);
			expect(previewUrlAllowed("https://myhost.ts.net")).toBe(true);
		});

		it("returns false for rejected URLs", () => {
			expect(previewUrlAllowed("https://example.com")).toBe(false);
			expect(previewUrlAllowed("ftp://localhost")).toBe(false);
			expect(previewUrlAllowed("")).toBe(false);
		});
	});
});

const fakeChromiumResolver: PreviewChromiumResolver = async () => ({
	path: "/fake/chrome",
	browserVersion: "0.0.0.0",
});

// ---------------------------------------------------------------------------
// PreviewService — validation and non-browser logic
// ---------------------------------------------------------------------------

describe("PreviewService non-browser logic", () => {
	describe("policyCheck", () => {
			it("allows all PREVIEW_ACTIONS for localhost URLs", () => {
				const svc = new PreviewService({
					chromiumResolver: fakeChromiumResolver,
				});
			const result = svc.policyCheck({ action: "navigate", url: "http://localhost:3000" });
			expect(result.allowed).toBe(true);
		});

			it("rejects forbidden URLs", () => {
				const svc = new PreviewService({
					chromiumResolver: fakeChromiumResolver,
				});
			const result = svc.policyCheck({ action: "navigate", url: "https://example.com" });
			expect(result.allowed).toBe(false);
		});

			it("rejects unknown actions", () => {
				const svc = new PreviewService({
					chromiumResolver: fakeChromiumResolver,
				});
			const result = svc.policyCheck({ action: "unknown" as never, url: "http://localhost:3000" });
			expect(result.allowed).toBe(false);
		});
	});

	describe("lease management", () => {
		it("leaseAcquire returns a lease with ttl", () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			// Without a real preview, leaseAcquire should throw not_found
			expect(() =>
				svc.leaseAcquire({ sessionId: SESSION_ID, previewId: "pv_missing" as never }),
			).toThrow(PreviewServiceError);
		});

		it("leaseRenew throws for missing preview", () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			expect(() =>
				svc.leaseRenew({
					sessionId: SESSION_ID,
					previewId: "pv_missing" as never,
					leaseId: "lease_x" as never,
				}),
			).toThrow(PreviewServiceError);
		});

		it("leaseRelease throws for missing preview", () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			expect(() =>
				svc.leaseRelease({
					sessionId: SESSION_ID,
					previewId: "pv_missing" as never,
					leaseId: "lease_x" as never,
				}),
			).toThrow(PreviewServiceError);
		});
	});

	describe("state", () => {
		it("returns empty previews for unknown session", async () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			const result = await svc.state({ sessionId: SESSION_ID });
			expect(result.previews).toEqual([]);
		});

		it("throws not_found for unknown previewId", async () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			expect(async () =>
				svc.state({ sessionId: SESSION_ID, previewId: "pv_missing" as never }),
			).toThrow();
		});
	});

	describe("stop", () => {
		it("marks service as stopped", async () => {
			const svc = new PreviewService({
				chromiumResolver: fakeChromiumResolver,
			});
			await svc.stop();
			// After stop, launch should throw
			await expect(
				svc.launch({ sessionId: SESSION_ID, url: "http://localhost:3000" }),
			).rejects.toThrow(PreviewServiceError);
		});
	});
});

// ---------------------------------------------------------------------------
const STAGED_MANIFEST = join(import.meta.dirname, "../../..", ".artifacts", "preview-chromium", "manifest.json");

describe("PreviewService real chromium smoke", () => {
	it.skipIf(!existsSync(STAGED_MANIFEST))(
		"launches a real browser, navigates, and captures state",
		async () => {
			// Start a tiny HTTP server on an ephemeral localhost port.
			const server = Bun.serve({
				port: 0,
				hostname: "localhost",
				fetch: () => new Response("<html><head><title>Smoke</title></head><body>ok</body></html>", {
					headers: { "content-type": "text/html" },
				}),
			});
			const url = `http://localhost:${server.port}`;
			const svc = new PreviewService({
				chromiumResolver: createPreviewChromiumResolver(),
				actionTimeoutMs: 15_000,
			});
			try {
				const snapshot = await svc.launch({ sessionId: SESSION_ID, url });
				expect(snapshot.previewId).toBeDefined();
				expect(snapshot.state).toBe("ready");
				expect(snapshot.url).toBe(`${url}/`);
				expect(snapshot.title).toBe("Smoke");
				const stateResult = await svc.state({ sessionId: SESSION_ID });
				expect(stateResult.previews.length).toBe(1);
				expect(stateResult.previews[0]!.previewId).toBe(snapshot.previewId);
				const captured = await svc.capture({
					sessionId: SESSION_ID,
					previewId: snapshot.previewId,
				});
				expect(captured.capture).toBeDefined();
				const capture = captured.capture!;
				const chunks: Uint8Array[] = [];
				let offset = 0;
				let complete = false;
				while (!complete) {
					const read = svc.captureRead({
						sessionId: SESSION_ID,
						previewId: snapshot.previewId,
						captureId: capture.captureId,
						offset,
					});
					chunks.push(Buffer.from(read.content, "base64"));
					offset = read.nextOffset;
					complete = read.complete;
				}
				expect(chunks.reduce((size, chunk) => size + chunk.length, 0)).toBe(capture.size);
			} finally {
				await svc.stop();
				server.stop(true);
			}
		},
	);
});
