import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeServerFrame, entryId, hostId, parseBounded, projectId, sessionId } from "@t4-code/host-wire";
import {
	FileSessionDiscovery,
	projectMessageText,
	SessionEntryProjector,
	SessionTranscriptObserver,
} from "../src/discovery.ts";
import { SessionProjection } from "../src/projection.ts";
import type { FileSystem } from "../src/types.ts";

const stamp = "2026-07-11T00:00:00.000Z";
const host = hostId("discovery-test");

function fakeFs(files: Record<string, string>, directories: string[]): FileSystem {
	return {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		stat: async path => ({
			isFile: () => path in files,
			isDirectory: () => directories.includes(path),
			mode: 0o600,
			mtimeMs: 1,
			size: files[path]?.length ?? 0,
		}),
		readdir: async path =>
			[...Object.keys(files), ...directories].filter(
				child => child !== path && child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes("/"),
			),
		readFile: async path => files[path] ?? "",
	};
}

function line(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}
function transcript(entries: Record<string, unknown>[], title?: string): string {
	const prelude = title === undefined ? [] : [{ type: "title", v: 1, title, updatedAt: stamp, pad: "" }];
	return [
		...prelude,
		{ type: "session", version: 3, id: "session-1", cwd: "/home/tester/project", timestamp: stamp },
		...entries,
	]
		.map(line)
		.join("\n");
}

function sessionTranscript(id: string, cwd: string, title: string): string {
	return JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: stamp, title });
}

describe("current OMP JSONL projection", () => {
	test("bounds multibyte plain-string prompt projections without splitting UTF-8", () => {
		const projected = projectMessageText("🙂".repeat(4_000), 8 * 1024);
		expect(new TextEncoder().encode(projected).byteLength).toBeLessThanOrEqual(8 * 1024);
		expect(projected).not.toContain("�");
		expect(projected.length).toBeLessThan("🙂".repeat(4_000).length);
	});

	test("preserves bounded IRC metadata for exact collaboration rendering", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-irc"), "batch");
		const [entry] = projector.project({
			type: "custom_message",
			id: "irc-message",
			parentId: null,
			timestamp: stamp,
			customType: "irc:incoming",
			content: "Incoming message from ReviewAgent",
			display: true,
			attribution: "agent",
			details: {
				id: "message-1",
				from: "ReviewAgent",
				message: "Found one issue.",
				replyTo: "message-0",
			},
		});

		expect(entry?.data).toEqual({
			role: "assistant",
			text: "Incoming message from ReviewAgent",
			customType: "irc:incoming",
			customDetails: {
				id: "message-1",
				from: "ReviewAgent",
				message: "Found one issue.",
				replyTo: "message-0",
			},
		});
	});

	test("preserves async-result job metadata without flattening it into prose", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-async-result"), "batch");
		const [entry] = projector.project({
			type: "custom_message",
			id: "async-result",
			parentId: null,
			timestamp: stamp,
			customType: "async-result",
			content: '<task-result agent="ReleaseReview" status="completed"><output>Ready.</output></task-result>',
			display: true,
			attribution: "agent",
			details: {
				jobs: [{ jobId: "ReleaseReview", type: "task", label: "Release review", durationMs: 91_000 }],
			},
		});

		expect(entry?.data.customType).toBe("async-result");
		expect(entry?.data.customDetails).toEqual({
			jobs: [{ jobId: "ReleaseReview", type: "task", label: "Release review", durationMs: 91_000 }],
		});
	});

	test("does not attach custom metadata to ordinary assistant messages", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-ordinary"), "batch");
		const [entry] = projector.project({
			type: "message",
			id: "ordinary-message",
			parentId: null,
			timestamp: stamp,
			customType: "irc:incoming",
			details: { from: "SpoofedAgent" },
			message: { role: "assistant", content: "Ordinary assistant prose" },
		});

		expect(entry?.data).toEqual({ role: "assistant", text: "Ordinary assistant prose" });
	});

	test("redacts sensitive custom details and omits oversized metadata", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-custom-details"), "batch");
		const [safeEntry] = projector.project({
			type: "custom_message",
			id: "sensitive-details",
			parentId: null,
			timestamp: stamp,
			customType: `  notice\u0000${"x".repeat(256)}  `,
			content: "Sanitized metadata",
			display: true,
			details: {
				from: "Worker",
				token: "top-secret-token",
				nested: { password: "top-secret-password", log: "opened /home/tester/private/report.txt" },
			},
		});
		const [oversizedEntry] = projector.project({
			type: "custom_message",
			id: "oversized-details",
			parentId: "sensitive-details",
			timestamp: stamp,
			customType: "async-result",
			content: "Oversized metadata",
			display: true,
			details: { jobs: ["a".repeat(64 * 1024), "b".repeat(64 * 1024), "c".repeat(64 * 1024)] },
		});

		const customType = safeEntry?.data.customType;
		expect(typeof customType).toBe("string");
		expect(new TextEncoder().encode(String(customType)).byteLength).toBeLessThanOrEqual(128);
		expect(String(customType)).not.toContain("\u0000");
		expect(safeEntry?.data.customDetails).toEqual({
			from: "Worker",
			nested: { log: "opened [path]" },
		});
		expect(JSON.stringify(safeEntry?.data)).not.toContain("top-secret");
		expect(oversizedEntry?.data.customDetails).toEqual({
			omitted: "Tool result details exceeded the app-wire display budget.",
		});
	});

	test("projects ordered transcript image metadata without image bytes or paths", () => {
		const first = "a".repeat(64);
		const second = "b".repeat(64);
		const projector = new SessionEntryProjector(host, sessionId("session-images"), "live");
		const projected = projector.project({
			type: "message",
			id: "image-message",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "image", mimeType: "image/png", data: `blob:sha256:${first}` },
					{ type: "text", text: "two images" },
					{ type: "image", mimeType: "image/webp", data: "", appImageSha256: second },
				],
			},
		});
		expect(projected).toHaveLength(1);
		expect(projected[0]?.data).toEqual({
			role: "assistant",
			text: "two images",
			images: [
				{ sha256: first, mimeType: "image/png" },
				{ sha256: second, mimeType: "image/webp" },
			],
		});
		const serialized = JSON.stringify(projected[0]);
		expect(serialized).not.toContain("blob:sha256:");
		expect(serialized).not.toContain("appImageSha256");
		expect(serialized).not.toContain("/home/");
		const [batchEntry] = new SessionEntryProjector(host, sessionId("batch-images"), "batch").project({
			type: "message",
			id: "spoofed-marker",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "untrusted persisted marker" },
					{ type: "image", mimeType: "image/webp", data: "", appImageSha256: second },
				],
			},
		});
		expect(batchEntry?.data).toEqual({ role: "assistant", text: "untrusted persisted marker" });

		const record = {
			sessionId: sessionId("session-images"),
			path: "/session.jsonl",
			cwd: "/project",
			projectId: projectId("project-images"),
			title: "Images",
			updatedAt: stamp,
			status: "idle" as const,
			entries: projected,
		};
		const projection = new SessionProjection(host, record, "epoch");
		expect(projection.transcriptImage(entryId("image-message"), first)).toEqual({
			sha256: first,
			mimeType: "image/png",
		});
		expect(projection.transcriptImage(entryId("image-message"), "c".repeat(64))).toBeUndefined();
		expect(projection.transcriptImage(entryId("other-entry"), first)).toBeUndefined();
	});

	test("preserves structured read, edit, and task results without exposing image payloads", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-tool-details"), "live");
		projector.project({
			type: "message",
			id: "tool-calls",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/app.ts" } },
					{ type: "toolCall", id: "edit-call", name: "edit", arguments: { input: "[src/app.ts]\nreplace" } },
					{
						type: "toolCall",
						id: "task-call",
						name: "task",
						arguments: {
							agent: "worker",
							preview: `iVBORw0KGgo${"Q".repeat(4_096)}`,
							image: { mimeType: "image/png", data: `iVBORw0KGgo${"R".repeat(4_096)}` },
						},
					},
				],
			},
		});

		const imageSha = "e".repeat(64);
		const embeddedImage = `iVBORw0KGgo${"A".repeat(4096)}`;
		const [readEntry] = projector.project({
			type: "message",
			id: "read-result",
			parentId: "tool-calls",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "read-call",
				toolName: "read",
				content: [
					{ type: "text", text: "first line\n" },
					{ type: "image", mimeType: "image/png", data: embeddedImage, appImageSha256: imageSha },
					{ type: "text", text: "second line" },
				],
				details: {
					resolvedPath: "/home/tester/project/src/app.ts",
					summary: { lines: 2, elidedSpans: 0 },
					note: "token=read-secret",
					authorization: "Bearer should-not-survive",
					detachedPreview: embeddedImage,
					thumbnail: { type: "image", mimeType: "image/png", data: embeddedImage },
				},
				isError: false,
			},
		});
		const [editEntry] = projector.project({
			type: "message",
			id: "edit-result",
			parentId: "read-result",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "edit-call",
				toolName: "edit",
				content: [{ type: "text", text: "Patch did not apply" }],
				details: {
					diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new",
					perFileResults: [{ path: "src/app.ts", isError: true, displayErrorText: "match failed" }],
				},
				isError: true,
			},
		});
		const [taskEntry] = projector.project({
			type: "message",
			id: "task-result",
			parentId: "edit-result",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "task-call",
				toolName: "task",
				content: [{ type: "text", text: "worker finished" }],
				details: {
					results: [{ id: "worker", output: "done", exitCode: 0, patchPath: "/tmp/private/worker.patch" }],
					totalDurationMs: 1250,
				},
				isError: false,
			},
		});

		expect(readEntry?.data).toMatchObject({
			tool: "read",
			ok: true,
			result: {
				output: "first line\nsecond line",
				content: [
					{ type: "text", text: "first line\n" },
					{ type: "text", text: "second line" },
				],
				details: {
					resolvedPath: "[path]",
					summary: { lines: 2, elidedSpans: 0 },
					note: "token=[redacted]",
					detachedPreview: "[image omitted]",
					thumbnail: { type: "image", mimeType: "image/png" },
				},
				isError: false,
			},
			images: [{ sha256: imageSha, mimeType: "image/png" }],
		});
		expect(editEntry?.data).toMatchObject({
			tool: "edit",
			ok: false,
			result: {
				content: [{ type: "text", text: "Patch did not apply" }],
				details: {
					diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new",
					perFileResults: [{ path: "src/app.ts", isError: true, displayErrorText: "match failed" }],
				},
				isError: true,
			},
		});
		expect(taskEntry?.data).toMatchObject({
			tool: "task",
			args: { agent: "worker", preview: "[image omitted]", image: { mimeType: "image/png" } },
			ok: true,
			result: {
				content: [{ type: "text", text: "worker finished" }],
				details: {
					results: [{ id: "worker", output: "done", exitCode: 0, patchPath: "[path]" }],
					totalDurationMs: 1250,
				},
				isError: false,
			},
		});
		const serializedResult = JSON.stringify(readEntry?.data.result);
		expect(serializedResult).not.toContain(embeddedImage);
		expect(serializedResult).not.toContain("authorization");
		expect(serializedResult).not.toContain("/home/tester");
		const serializedTask = JSON.stringify(taskEntry);
		expect(serializedTask).not.toContain("QQQQ");
		expect(serializedTask).not.toContain("RRRR");
	});

	test("deduplicates managed tool images from content and details without retaining renderer payloads", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-tool-detail-images"), "live");
		projector.project({
			type: "message",
			id: "image-call",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "generate-call", name: "generate_image", arguments: {} }],
			},
		});
		const contentSha = "a".repeat(64);
		const detailOnlySha = "b".repeat(64);
		const contentBytes = `iVBORw0KGgo${"C".repeat(4_096)}`;
		const detailBytes = `blob:sha256:${detailOnlySha}`;
		const [entry] = projector.project({
			type: "message",
			id: "image-result",
			parentId: "image-call",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "generate-call",
				toolName: "generate_image",
				content: [
					{ type: "text", text: "generated image" },
					{ type: "image", mimeType: "image/png", data: contentBytes, appImageSha256: contentSha },
				],
				details: {
					images: [
						{ type: "image", mimeType: "image/png", data: contentBytes, appImageSha256: contentSha },
						{ mimeType: "image/png", data: detailBytes },
					],
					sourcePath: "/home/tester/private/generated.png",
					note: "ready",
				},
				isError: false,
			},
		});

		expect(entry?.data).toMatchObject({
			tool: "generate_image",
			result: {
				content: [{ type: "text", text: "generated image" }],
				details: { sourcePath: "[path]", note: "ready" },
				isError: false,
			},
			images: [
				{ sha256: contentSha, mimeType: "image/png" },
				{ sha256: detailOnlySha, mimeType: "image/png" },
			],
		});
		const result = entry?.data.result as Record<string, unknown> | undefined;
		const details = result?.details as Record<string, unknown> | undefined;
		expect(details).not.toHaveProperty("images");
		const serialized = JSON.stringify(entry);
		expect(serialized).not.toContain(contentBytes);
		expect(serialized).not.toContain(detailBytes);
		expect(serialized).not.toContain("appImageSha256");
		expect(serialized).not.toContain("/home/tester");
	});

	test("unwraps a matching v17 xdev result into a semantic durable tool entry", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-xdev-image"), "live");
		const imageSha = "c".repeat(64);
		projector.project({
			type: "message",
			id: "xdev-result",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "xdev-call",
				content: [{ type: "text", text: "generated image" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						args: { prompt: "a geometric fox", output_format: "png" },
						inner: {
							provider: "test-provider",
							sourcePath: "/home/tester/private/generated.png",
							images: [
								{
									mimeType: "image/png",
									data: "",
									appImageSha256: imageSha,
								},
							],
						},
					},
				},
				isError: false,
			},
		});
		const [entry] = projector.project({
			type: "message",
			id: "xdev-call-message",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "xdev-call",
						name: "write",
						arguments: {
							path: "xd://generate_image",
							content: JSON.stringify({ prompt: "a geometric fox", output_format: "png" }),
						},
					},
				],
			},
		});

		expect(entry?.data).toMatchObject({
			toolCallId: "xdev-call",
			tool: "generate_image",
			title: "generate_image",
			args: { prompt: "a geometric fox", output_format: "png" },
			ok: true,
			result: {
				output: "generated image",
				content: [{ type: "text", text: "generated image" }],
				details: {
					provider: "test-provider",
					sourcePath: "[path]",
				},
				isError: false,
			},
			images: [{ sha256: imageSha, mimeType: "image/png" }],
		});
		const serialized = JSON.stringify(entry);
		expect(serialized).not.toContain("appImageSha256");
		expect(serialized).not.toContain('"xdev"');
		expect(serialized).not.toContain("/home/tester");
	});

	test("keeps mismatched or malformed xdev envelopes on the outer write path", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-xdev-mismatch"), "live");
		projector.project({
			type: "message",
			id: "xdev-call-message",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "xdev-mismatch",
						name: "write",
						arguments: { path: "xd://generate_image", content: JSON.stringify({ prompt: "fox" }) },
					},
					{
						type: "toolCall",
						id: "xdev-malformed",
						name: "write",
						arguments: { path: "xd://hub", content: "not-json" },
					},
					{
						type: "toolCall",
						id: "xdev-same-tool-mismatch",
						name: "write",
						arguments: { path: "xd://resolve", content: "Apply A" },
					},
					{
						type: "toolCall",
						id: "xdev-json-argument-mismatch",
						name: "write",
						arguments: {
							path: "xd://hub",
							content: JSON.stringify({ op: "send", to: "reviewer" }),
						},
					},
				],
			},
		});
		const [mismatch] = projector.project({
			type: "message",
			id: "xdev-mismatch-result",
			parentId: "xdev-call-message",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "xdev-mismatch",
				content: [{ type: "text", text: "unexpected" }],
				details: {
					xdev: {
						tool: "hub",
						mode: "execute",
						args: { op: "list" },
						inner: { note: "do not promote" },
					},
				},
			},
		});
		const [malformed] = projector.project({
			type: "message",
			id: "xdev-malformed-result",
			parentId: "xdev-mismatch-result",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "xdev-malformed",
				content: [{ type: "text", text: "invalid arguments" }],
				isError: true,
			},
		});
		const [sameToolMismatch] = projector.project({
			type: "message",
			id: "xdev-same-tool-mismatch-result",
			parentId: "xdev-malformed-result",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "xdev-same-tool-mismatch",
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
		});
		const [jsonArgumentMismatch] = projector.project({
			type: "message",
			id: "xdev-json-argument-mismatch-result",
			parentId: "xdev-same-tool-mismatch-result",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "xdev-json-argument-mismatch",
				content: [{ type: "text", text: "unexpected" }],
				details: {
					xdev: {
						tool: "hub",
						mode: "execute",
						args: { op: "delete", to: "victim" },
						inner: { action: "delete" },
					},
				},
			},
		});

		expect(mismatch?.data).toMatchObject({
			tool: "write",
			args: { path: "xd://generate_image", content: '{"prompt":"fox"}' },
			result: { details: { xdev: { tool: "hub", mode: "execute" } } },
		});
		expect(malformed?.data).toMatchObject({
			tool: "write",
			args: { path: "xd://hub", content: "not-json" },
			ok: false,
		});
		expect(sameToolMismatch?.data).toMatchObject({
			tool: "write",
			args: { path: "xd://resolve", content: "Apply A" },
			result: { details: { xdev: { tool: "resolve", args: { reason: "Apply B" } } } },
		});
		expect(jsonArgumentMismatch?.data).toMatchObject({
			tool: "write",
			args: { path: "xd://hub", content: '{"op":"send","to":"reviewer"}' },
			result: { details: { xdev: { tool: "hub", args: { op: "delete", to: "victim" } } } },
		});
	});

	test("bounds aggregate tool result content and details", () => {
		const projector = new SessionEntryProjector(host, sessionId("session-tool-result-bounds"), "batch");
		projector.project({
			type: "message",
			id: "tool-call",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "edit", arguments: {} }],
			},
		});
		const [entry] = projector.project({
			type: "message",
			id: "tool-result",
			parentId: "tool-call",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "edit",
				content: [
					{ type: "text", text: "界".repeat(30_000) },
					{ type: "text", text: "this block is beyond the result budget" },
				],
				details: {
					first: "a".repeat(70_000),
					second: "b".repeat(70_000),
					third: "c".repeat(70_000),
				},
				isError: false,
			},
		});
		const result = entry?.data.result as Record<string, unknown> | undefined;
		const content = result?.content as Array<{ type: string; text: string }> | undefined;
		const text = content?.map(block => block.text).join("") ?? "";
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(64 * 1024);
		expect(result?.output).toBe(text);
		expect(result?.details).toEqual({
			omitted: "Tool result details exceeded the app-wire display budget.",
		});
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(132 * 1024);
	});

	test("normalizes nested messages, tools, hidden entries, and runtime settings", async () => {
		const hugeArgs = Array.from({ length: 1000 }, () => "x".repeat(900));
		const toolImage = "d".repeat(64);
		const entries: Record<string, unknown>[] = [
			{
				type: "session_init",
				id: "init",
				parentId: null,
				timestamp: stamp,
				systemPrompt: "do not leak /home/tester/secret",
				task: "task",
				tools: ["read"],
			},
			{ type: "model_change", id: "model", parentId: "init", timestamp: stamp, model: "openai/gpt-5.6" },
			{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: stamp, thinkingLevel: "high" },
			{
				type: "message",
				id: "u1",
				parentId: "thinking",
				timestamp: stamp,
				message: { role: "user", content: "Please inspect the project" },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: stamp,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should inspect safely." },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "/home/tester/project/src/app.ts", values: hugeArgs },
						},
					],
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: stamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{ type: "text", text: "file contents" },
						{ type: "image", mimeType: "image/jpeg", data: `blob:sha256:${toolImage}` },
					],
					isError: false,
				},
			},
			{
				type: "custom_message",
				id: "hidden",
				parentId: "r1",
				timestamp: stamp,
				customType: "secret",
				content: "hidden",
				display: false,
			},
			{
				type: "custom_message",
				id: "shown",
				parentId: "hidden",
				timestamp: stamp,
				customType: "notice",
				content: "Visible note",
				display: true,
				attribution: "agent",
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries, "  Fixed\nTitle  ") }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Fixed Title");
		expect(session?.projectName).toBe("project");
		expect(session?.cwd).toBe("/home/tester/project");
		expect(session?.model).toBe("openai/gpt-5.6");
		expect(session?.thinking).toBe("high");
		expect(session?.entries.map(entry => entry.kind)).toEqual(["message", "message", "tool-use", "message"]);
		const message = session?.entries[0];
		expect(message?.data).toEqual({ role: "user", text: "Please inspect the project" });
		const tool = session?.entries[2];
		expect(tool?.data).toMatchObject({
			tool: "read",
			title: "read",
			ok: true,
			result: { output: "file contents" },
			images: [{ sha256: toolImage, mimeType: "image/jpeg" }],
		});
		const toolArgs = tool?.data.args && typeof tool.data.args === "object" ? JSON.stringify(tool.data.args) : "";
		expect(new TextEncoder().encode(toolArgs).byteLength).toBeLessThan(128 * 1024);
		expect(JSON.stringify(session?.entries)).not.toContain("systemPrompt");
		expect(JSON.stringify(session?.entries)).not.toContain("/home/tester");
		expect(session?.entries[1]?.data).toEqual({ role: "assistant", text: "", reasoning: "I should inspect safely." });
	});

	test("rebinds discovered entry identities to the snapshot envelope", async () => {
		const entries = [
			{
				type: "message",
				id: "mismatch",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "hello" },
			},
		];
		const sessionDiscovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			hostId("discovery-other"),
		);
		const [session] = await sessionDiscovery.list();
		if (!session) throw new Error("session not discovered");
		const frame = new SessionProjection(host, session, "epoch-test").snapshot();
		const decoded = decodeServerFrame(frame);
		expect(decoded.type).toBe("snapshot");
		if (decoded.type === "snapshot") {
			expect(
				decoded.entries.every(entry => entry.hostId === decoded.hostId && entry.sessionId === decoded.sessionId),
			).toBe(true);
		}
	});

	test("bounds non-ASCII titles and falls back to the first visible user text", async () => {
		const title = `${"界".repeat(400)}\n  `;
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "First visible request" },
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("First visible request");
		const titledDiscovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript([], title) }, ["/root"]),
			host,
		);
		const [titled] = await titledDiscovery.list();
		expect(titled?.title).toBeDefined();
		expect(new TextEncoder().encode(titled?.title ?? "").byteLength).toBeLessThanOrEqual(512);
	});

	test("uses the first substantive Change line for a bounded fallback title", async () => {
		const wrapped = `Complete the assignment below, thoroughly:\n\n# Target\nIgnore this heading\n\n# Change\n1. Build a durable projector with a deliberately long description ${"x".repeat(200)}`;
		const entries = [
			{ type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: wrapped } },
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title?.startsWith("Build a durable projector")).toBe(true);
		expect(new TextEncoder().encode(session?.title ?? "").byteLength).toBeLessThanOrEqual(120);
	});

	test("skips a wrapper line when Change is absent", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: {
					role: "user",
					content: "Complete the assignment below, thoroughly:\n\n# Target\nFallback title",
				},
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Fallback title");
	});

	test("keeps direct-message fallback on its first substantive line", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "Please inspect this project\n# Change\n1. Do not use this as a title" },
			},
		];
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.title).toBe("Please inspect this project");
	});

	test("keeps valid session history around a malformed middle entry", async () => {
		const header = sessionTranscript("session-malformed-middle", "/tmp/project", "Recovered session");
		const before = line({
			type: "message",
			id: "before",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "before malformed entry" },
		});
		const after = line({
			type: "message",
			id: "after",
			parentId: "before",
			timestamp: stamp,
			message: { role: "assistant", content: "after malformed entry" },
		});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": [header, before, '{"type":', after].join("\n") }, ["/root"]),
			host,
		);

		const [session] = await discovery.list();
		expect(String(session?.sessionId)).toBe("session-malformed-middle");
		expect(session?.entries.map(entry => entry.data.text)).toEqual([
			"before malformed entry",
			"after malformed entry",
		]);
	});

	test("keeps valid session history when the final JSONL write is crash-truncated", async () => {
		const header = sessionTranscript("session-truncated-tail", "/tmp/project", "Recovered tail");
		const complete = line({
			type: "message",
			id: "complete",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "complete entry" },
		});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": `${header}\n${complete}\n{"type":"message","id":"partial"` }, ["/root"]),
			host,
		);

		const [session] = await discovery.list();
		expect(String(session?.sessionId)).toBe("session-truncated-tail");
		expect(session?.entries.map(entry => entry.data.text)).toEqual(["complete entry"]);
	});

	test("rejects malformed headers while dropping an oversized non-header entry", async () => {
		const validHeader = sessionTranscript("oversized-entry", "/tmp/project", "Oversized entry");
		const files = {
			"/root/malformed-header.jsonl": '{"type":"session"',
			"/root/missing-header.jsonl": line({
				type: "message",
				id: "message-only",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "no header" },
			}),
			"/root/oversized-entry.jsonl": `${validHeader}\n${"x".repeat(1024 * 1024 + 1)}`,
		};
		const discovery = new FileSessionDiscovery("/root", fakeFs(files, ["/root"]), host);

		const sessions = await discovery.list();
		expect(sessions.map(session => session.sessionId)).toEqual([sessionId("oversized-entry")]);
		expect(sessions[0]?.entries).toEqual([]);
	});

	test("limits snapshots to 1000 entries with an omission notice", async () => {
		const entries: Record<string, unknown>[] = [];
		for (let i = 0; i < 1001; i++)
			entries.push({
				type: "message",
				id: `m-${i}`,
				parentId: i === 0 ? null : `m-${i - 1}`,
				timestamp: stamp,
				message: { role: "user", content: `${"x".repeat(8192)} ${i}` },
			});
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(session?.entries.length).toBeLessThanOrEqual(1000);
		expect(session?.entries[0]?.kind).toBe("compaction");
		expect(session?.entries[0]?.data.summary).toContain("Older transcript entries were omitted");
		expect(new Set(session?.entries.map(entry => entry.id)).size).toBe(session?.entries.length);
		expect(
			session?.entries.every(
				entry => entry.parentId === null || session?.entries.some(parent => parent.id === entry.parentId),
			),
		).toBe(true);
		if (!session) throw new Error("session not discovered");
		const initialOmitted = Number(session.entries[0]?.data.omitted);
		const projection = new SessionProjection(host, session, "epoch-test");
		for (let i = 0; i < 100; i++)
			projection.appendEntry({
				id: entryId(`live-after-discovery-${i}`),
				parentId: null,
				hostId: host,
				sessionId: session.sessionId,
				kind: "message",
				timestamp: stamp,
				data: { role: "assistant", text: `${"y".repeat(8192)} ${i}` },
			});
		const snapshot = projection.snapshot();
		const snapshotText = JSON.stringify(snapshot);
		expect(new TextEncoder().encode(snapshotText).byteLength).toBeLessThan(1_048_576);
		expect(() => parseBounded(snapshotText)).not.toThrow();
		if (snapshot.type !== "snapshot") throw new Error("expected snapshot");
		const notices = snapshot.entries.filter(entry => entry.data.snapshotOmission === true);
		expect(notices).toHaveLength(1);
		const projectedEntries = projection.value.entries.filter(entry => entry.data.snapshotOmission !== true).length;
		const retainedEntries = snapshot.entries.filter(entry => entry.data.snapshotOmission !== true).length;
		expect(Number(notices[0]?.data.omitted)).toBe(initialOmitted + projectedEntries - retainedEntries);
	});
});

test("lists only root and encoded-project main sessions, not child-area subagents", async () => {
	const files = {
		"/root/root-main.jsonl": sessionTranscript("root-main", "/tmp/root", "Root main"),
		"/root/root-main/root-subagent.jsonl": sessionTranscript("root-subagent", "/tmp/root", "Root subagent"),
		"/root/-tmp-project/project-main.jsonl": sessionTranscript("project-main", "/tmp/project", "Project main"),
		"/root/-tmp-project/project-main/project-subagent.jsonl": sessionTranscript(
			"project-subagent",
			"/tmp/project",
			"Project subagent",
		),
		"/root/-tmp-project/project-main/task/nested-task.jsonl": sessionTranscript(
			"nested-task",
			"/tmp/project",
			"Nested task",
		),
	};
	const directories = [
		"/root",
		"/root/root-main",
		"/root/-tmp-project",
		"/root/-tmp-project/project-main",
		"/root/-tmp-project/project-main/task",
	];
	const discovery = new FileSessionDiscovery("/root", fakeFs(files, directories), host);
	const sessions = await discovery.list();
	expect(sessions.map(session => String(session.sessionId)).sort()).toEqual(["project-main", "root-main"]);
});

test("lists oversized main metadata with a bounded prefix read", async () => {
	const path = "/root/oversized.jsonl";
	const header = `${sessionTranscript("oversized", "/tmp/oversized", "Oversized main")}\n`;
	let fullReads = 0;
	let prefixReads = 0;
	const fs: FileSystem & {
		readFileSlice(path: string, maxBytes: number): Promise<string>;
	} = {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		readdir: async directory => (directory === "/root" ? [path] : []),
		stat: async value => ({
			isFile: () => value === path,
			isDirectory: () => value === "/root",
			mode: 0o600,
			mtimeMs: 2,
			size: value === path ? 70 * 1024 * 1024 : 0,
		}),
		readFile: async () => {
			fullReads++;
			throw new Error("unbounded read");
		},
		readFileSlice: async (_value, maxBytes) => {
			prefixReads++;
			expect(maxBytes).toBeLessThanOrEqual(128 * 1024);
			return header;
		},
	};
	const discovery = new FileSessionDiscovery("/root", fs, host);
	const [session] = await discovery.list();
	expect(String(session?.sessionId)).toBe("oversized");
	expect(session?.title).toBe("Oversized main");
	expect(session?.entries).toEqual([]);
	expect(prefixReads).toBe(1);
	expect(fullReads).toBe(0);
});

test("incrementally indexes a large corpus and evicts only deleted or changed files", async () => {
	const files: Record<string, string> = {};
	const mtimes = new Map<string, number>();
	for (let index = 0; index < 5000; index++) {
		const path = `/root/session-${index}.jsonl`;
		files[path] = JSON.stringify({
			type: "session",
			version: 3,
			id: `session-${index}`,
			cwd: "/tmp/project",
			timestamp: stamp,
		});
		mtimes.set(path, index);
	}
	let reads = 0;
	const fs: FileSystem = {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		stat: async path => ({
			isFile: () => path in files,
			isDirectory: () => path === "/root",
			mode: 0o600,
			mtimeMs: mtimes.get(path) ?? 0,
			size: files[path]?.length ?? 0,
		}),
		readdir: async path => (path === "/root" ? Object.keys(files) : []),
		readFile: async path => {
			reads++;
			return files[path] ?? "";
		},
	};
	const discovery = new FileSessionDiscovery("/root", fs, host);
	const cold = await discovery.list();
	expect(cold).toHaveLength(5000);
	expect(reads).toBe(5000);
	expect(cold.slice(0, 3).map(value => String(value.sessionId))).toEqual([
		"session-4999",
		"session-4998",
		"session-4997",
	]);
	reads = 0;
	const warm = await discovery.list();
	expect(warm).toHaveLength(5000);
	expect(reads).toBe(0);
	const changedPath = "/root/session-2500.jsonl";
	files[changedPath] = JSON.stringify({
		type: "session",
		version: 3,
		id: "session-2500",
		cwd: "/tmp/changed",
		timestamp: stamp,
	});
	mtimes.set(changedPath, 10_000);
	const changed = await discovery.list();
	expect(reads).toBe(1);
	expect(changed.find(value => String(value.sessionId) === "session-2500")?.cwd).toBe("/tmp/changed");
	delete files["/root/session-10.jsonl"];
	mtimes.delete("/root/session-10.jsonl");
	reads = 0;
	const firstMiss = await discovery.list();
	expect(firstMiss).toHaveLength(5000);
	expect(firstMiss.some(value => String(value.sessionId) === "session-10")).toBe(true);
	expect(reads).toBe(0);
	const deleted = await discovery.list();
	expect(deleted).toHaveLength(4999);
	expect(deleted.some(value => String(value.sessionId) === "session-10")).toBe(false);
	expect(reads).toBe(0);
});

test("rebinds a canonical cached transcript when its live symlink alias changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-discovery-alias-"));
	const target = join(root, "session-target.jsonl");
	const firstAlias = join(root, "alias-a.jsonl");
	const secondAlias = join(root, "alias-b.jsonl");
	const contents = JSON.stringify({
		type: "session",
		version: 3,
		id: "alias-session",
		cwd: "/tmp/project",
		timestamp: stamp,
	});
	try {
		await writeFile(target, contents);
		await symlink(target, firstAlias);
		const discovery = new FileSessionDiscovery(root, undefined, host);
		const first = await discovery.list();
		expect(first[0]?.path).toBe(firstAlias);
		await rm(firstAlias);
		await symlink(target, secondAlias);
		const warmAlias = await discovery.list();
		expect(warmAlias[0]?.path).toBe(secondAlias);
		await expect(stat(warmAlias[0]!.path)).resolves.toBeDefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lazy discovery reads a bounded preview and hydrates only the selected transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-discovery-lazy-"));
	const path = join(root, "lazy.jsonl");
	const body = `${JSON.stringify({ type: "session", id: "lazy-session", cwd: "/tmp/lazy", timestamp: stamp })}\n${JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: stamp, message: { role: "user", content: "Lazy title" } })}\n`;
	try {
		await writeFile(path, body);
		const discovery = new FileSessionDiscovery(root, undefined, host, true);
		const [preview] = await discovery.list();
		expect(preview).toMatchObject({ title: "Lazy title", entriesLoaded: false, entries: [] });
		if (!preview) throw new Error("missing lazy transcript preview");
		const loaded = await discovery.load(preview);
		expect(loaded.entriesLoaded).not.toBe(false);
		expect(loaded.entries.map(entry => entry.kind)).toEqual(["message"]);
		const [cached] = await discovery.list();
		expect(cached?.entries.map(entry => entry.kind)).toEqual(["message"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function observerFsState(content: Uint8Array, identity = 1) {
	let bytes = content;
	let ino = identity;
	let failReads = 0;
	return {
		fs: {
			mkdir: async () => undefined,
			chmod: async () => undefined,
			unlink: async () => undefined,
			stat: async () => ({
				isFile: () => true,
				isDirectory: () => false,
				mode: 0o600,
				mtimeMs: 1,
				size: bytes.byteLength,
				dev: 1,
				ino,
			}),
			readdir: async () => [],
			readFile: async () => bytes,
			readFileRange: async (_path: string, offset: number, maxBytes: number) => {
				if (failReads > 0) {
					failReads -= 1;
					throw new Error("read failed");
				}
				return bytes.slice(offset, offset + maxBytes);
			},
		},
		setContent(next: Uint8Array, nextIdentity = ino) {
			bytes = next;
			ino = nextIdentity;
		},
		failNextReads(count = 1) {
			failReads = count;
		},
	};
}

test("observer keeps partial final lines live until newline then needs one unchanged EOF sample", async () => {
	const header = `${sessionTranscript("observer-partial", "/tmp/partial", "Partial")}\n`;
	const entry = JSON.stringify({
		type: "message",
		id: "partial-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "unfinished" },
	});
	const state = observerFsState(new TextEncoder().encode(header + entry));
	const observer = new SessionTranscriptObserver("/tmp/partial.jsonl", host, state.fs);
	expect((await observer.poll()).stable).toBe(false);
	expect((await observer.poll()).stable).toBe(false);
	state.setContent(new TextEncoder().encode(`${header + entry}\n`));
	expect((await observer.poll()).stable).toBe(false);
	expect((await observer.poll()).stable).toBe(true);
});

test("live projector resolves a result that arrives before its tool call", () => {
	const projector = new SessionEntryProjector(host, sessionId("pending-before-call"), "live");
	projector.project({
		type: "message",
		id: "result-entry",
		parentId: null,
		timestamp: stamp,
		message: {
			role: "toolResult",
			toolCallId: "call-before",
			content: [{ type: "text", text: "done" }],
		},
	});
	expect(projector.unresolvedPendingCount).toBe(1);
	const projected = projector.project({
		type: "message",
		id: "call-entry",
		parentId: null,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-before", name: "read", arguments: { path: "file" } }],
		},
	});
	expect(projected).toHaveLength(1);
	expect(projected[0]?.kind).toBe("tool-use");
	expect(projected[0]?.data).toMatchObject({ toolCallId: "call-before", tool: "read", ok: true });
	expect(projector.unresolvedPendingCount).toBe(0);
});

test("live projector keeps an unmatched call pending, then settles it exactly once", () => {
	const projector = new SessionEntryProjector(host, sessionId("pending-after-call"), "live");
	projector.project({
		type: "message",
		id: "call-entry",
		parentId: null,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-after", name: "read", arguments: { path: "file" } }],
		},
	});
	expect(projector.unresolvedPendingCount).toBe(1);
	const result = {
		type: "message",
		id: "result-entry",
		parentId: null,
		timestamp: stamp,
		message: {
			role: "toolResult",
			toolCallId: "call-after",
			content: [{ type: "text", text: "done" }],
		},
	};
	expect(projector.project(result)).toHaveLength(1);
	expect(projector.unresolvedPendingCount).toBe(0);
	expect(projector.project({ ...result, id: "duplicate-result" })).toEqual([]);
	expect(projector.entries.filter(entry => entry.kind === "tool-use")).toHaveLength(1);
});

test("observer skips a control-character raw ID and recovers on a repaired transcript", async () => {
	const header = `${sessionTranscript("observer-invalid-id", "/tmp/invalid-id", "Invalid ID")}\n`;
	const invalid = `${header}${line({
		type: "message",
		id: "bad\nid",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "unsafe" },
	})}\n`;
	const valid = `${header}${line({
		type: "message",
		id: "recovered-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "recovered" },
	})}\n`;
	const state = mutableObserverFsState(new TextEncoder().encode(invalid));
	const observer = new SessionTranscriptObserver("/tmp/invalid-id.jsonl", host, state.fs);
	const failed = await observer.poll();
	expect(failed.watermark).toEqual({ entryCount: 0, lastEntryId: null });
	expect(failed.record?.entries).toEqual([]);
	state.setContent(new TextEncoder().encode(valid), { touch: true });
	const recovered = await observer.poll();
	expect(recovered.reset).toBe(true);
	expect(recovered.watermark).toEqual({ entryCount: 1, lastEntryId: "recovered-entry" });
	expect(recovered.record?.entries.map(entry => entry.data.text)).toEqual(["recovered"]);
});

test("observer raw watermark follows duplicate-key JSON while projection stays bounded", async () => {
	const header = `${sessionTranscript("observer-duplicates", "/tmp/duplicates", "Duplicates")}\n`;
	const duplicate = `{"type":"message","id":"first","id":"last","parentId":null,"timestamp":"${stamp}","message":{"role":"user","content":"safe"}}\n`;
	const state = observerFsState(new TextEncoder().encode(header + duplicate));
	const observer = new SessionTranscriptObserver("/tmp/duplicates.jsonl", host, state.fs);
	const poll = await observer.poll();
	expect(poll.watermark).toEqual({ entryCount: 1, lastEntryId: "last" });
	expect(poll.record?.entries.map(entry => entry.id)).toEqual([entryId("last")]);
	expect(poll.record?.entries[0]?.data.text).toBe("safe");
});

test("observer rejects inode replacement during read and replays the replacement from byte zero", async () => {
	const oldTranscript = `${sessionTranscript("observer-old", "/tmp/old", "Old")}\n`;
	const newTranscript = `${sessionTranscript("observer-new", "/tmp/new", "New")}\n${JSON.stringify({
		type: "message",
		id: "new-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "replacement" },
	})}\n`;
	const state = observerFsState(new TextEncoder().encode(oldTranscript), 1);
	const originalRange = state.fs.readFileRange;
	let swapped = false;
	state.fs.readFileRange = async (path, offset, maxBytes) => {
		const result = await originalRange(path, offset, maxBytes);
		if (!swapped) {
			swapped = true;
			state.setContent(new TextEncoder().encode(newTranscript), 2);
		}
		return result;
	};
	const observer = new SessionTranscriptObserver("/tmp/replaced.jsonl", host, state.fs);
	const failed = await observer.poll();
	expect(failed.transcript).toBe("snapshot");
	const recovered = await observer.poll();
	expect(recovered.reset).toBe(true);
	expect(String(recovered.record?.sessionId)).toBe("observer-new");
	expect(recovered.record?.entries.map(entry => entry.data.text)).toEqual(["replacement"]);
});

test("observer reports a read failure as a snapshot and recovers from byte zero", async () => {
	const content = new TextEncoder().encode(
		`${sessionTranscript("observer-recover", "/tmp/recover", "Recover")}\n${JSON.stringify({
			type: "message",
			id: "recovered-entry",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "recovered" },
		})}\n`,
	);
	const state = observerFsState(content);
	state.failNextReads();
	const observer = new SessionTranscriptObserver("/tmp/recover.jsonl", host, state.fs);
	const failed = await observer.poll();
	expect(failed.transcript).toBe("snapshot");
	const recovered = await observer.poll();
	expect(recovered.reset).toBe(true);
	expect(recovered.watermark).toEqual({ entryCount: 1, lastEntryId: "recovered-entry" });
});

test("discovery retains a cached record for one read miss and removes it on the second", async () => {
	const path = "/root/transient.jsonl";
	const files: Record<string, string> = { [path]: sessionTranscript("transient", "/tmp/transient", "Transient") };
	let failures = 0;
	let mtime = 1;
	const fs: FileSystem = {
		mkdir: async () => undefined,
		chmod: async () => undefined,
		unlink: async () => undefined,
		stat: async value => ({
			isFile: () => value === path,
			isDirectory: () => value === "/root",
			mode: 0o600,
			mtimeMs: mtime,
			size: files[value]?.length ?? 0,
			dev: 1,
			ino: 1,
		}),
		readdir: async () => [path],
		readFile: async value => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("transient read");
			}
			return files[value] ?? "";
		},
	};
	const discovery = new FileSessionDiscovery("/root", fs, host);
	expect(await discovery.list()).toHaveLength(1);
	failures = 2;
	mtime = 2;
	expect(await discovery.list()).toHaveLength(1);
	mtime = 3;
	expect(await discovery.list()).toHaveLength(0);
});

function mutableObserverFsState(content: Uint8Array, identity = 1) {
	let bytes = content;
	let ino = identity;
	let mtimeMs = 1;
	let ctimeMs = 1;
	let swapIdentityOnOpen = false;
	const state = {
		fs: {
			mkdir: async () => undefined,
			chmod: async () => undefined,
			unlink: async () => undefined,
			stat: async () => ({
				isFile: () => true,
				isDirectory: () => false,
				mode: 0o600,
				mtimeMs,
				ctimeMs,
				size: bytes.byteLength,
				dev: 1,
				ino,
			}),
			readdir: async () => [],
			readFile: async () => bytes,
			readFileRange: async (_path: string, offset: number, maxBytes: number, expectedIdentity?: string) => {
				if (swapIdentityOnOpen) {
					swapIdentityOnOpen = false;
					ino += 1;
				}
				if (expectedIdentity !== undefined && expectedIdentity !== `1:${ino}`)
					throw new Error("transcript inode changed while opening range");
				return bytes.slice(offset, offset + maxBytes);
			},
		},
		setContent(next: Uint8Array, options: { identity?: number; touch?: boolean } = {}) {
			bytes = next;
			if (options.identity !== undefined) ino = options.identity;
			if (options.touch) {
				mtimeMs += 1;
				ctimeMs += 1;
			}
		},
		swapNextOpen() {
			swapIdentityOnOpen = true;
		},
	};
	return state;
}

test("follower keeps a partial final JSONL record out of projection until newline", async () => {
	const header = `${sessionTranscript("observer-final", "/tmp/final", "Final")}\n`;
	const entry = line({
		type: "message",
		id: "final-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "durable after newline" },
	});
	const state = observerFsState(new TextEncoder().encode(header + entry));
	const observer = new SessionTranscriptObserver("/tmp/final.jsonl", host, state.fs);
	const partial = await observer.poll();
	expect(partial.watermark).toEqual({ entryCount: 0, lastEntryId: null });
	expect(partial.entries).toEqual([]);
	state.setContent(new TextEncoder().encode(`${header + entry}\n`));
	const complete = await observer.poll();
	expect(complete.watermark).toEqual({ entryCount: 1, lastEntryId: "final-entry" });
	expect(complete.entries.map(value => value.data.text)).toEqual(["durable after newline"]);
});

test("follower carries a partial UTF-8 code point across reads without replacement text", async () => {
	const header = `${sessionTranscript("observer-utf8", "/tmp/utf8", "UTF-8")}\n`;
	const entry = line({
		type: "message",
		id: "utf8-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "prefix 🙂 suffix" },
	});
	const encoder = new TextEncoder();
	const full = encoder.encode(`${header + entry}\n`);
	const emojiOffset = encoder.encode(`${header}${entry.slice(0, entry.indexOf("🙂"))}`).byteLength;
	const state = observerFsState(full.slice(0, emojiOffset + 1));
	const observer = new SessionTranscriptObserver("/tmp/utf8.jsonl", host, state.fs);
	expect((await observer.poll()).entries).toEqual([]);
	state.setContent(full);
	const recovered = await observer.poll();
	expect(recovered.entries.map(value => value.data.text)).toEqual(["prefix 🙂 suffix"]);
	expect(JSON.stringify(recovered.entries)).not.toContain("�");
});

test("follower skips an oversized line across bounded reads and resumes at the next record", async () => {
	const header = `${sessionTranscript("observer-oversized", "/tmp/oversized", "Oversized")}\n`;
	const message = (id: string, content: string) =>
		line({
			type: "message",
			id,
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content },
		});
	const prefix = message("prefix-entry", "p".repeat(600_000));
	const oversized = line({
		type: "compaction",
		id: "oversized-entry",
		parentId: "prefix-entry",
		timestamp: stamp,
		summary: "x".repeat(1_980_000),
	});
	const suffix = message("suffix-entry", "s".repeat(600_000));
	const final = message("final-entry", "current tail");
	const state = observerFsState(
		new TextEncoder().encode(`${header}${prefix}\n${oversized}\n${suffix}\n${final}\n`),
	);
	const observer = new SessionTranscriptObserver("/tmp/oversized.jsonl", host, state.fs);

	const first = await observer.poll();
	expect(first.entries.map(entry => entry.id)).toEqual([entryId("prefix-entry")]);
	const second = await observer.poll();
	expect(second.reset).toBe(false);
	expect(second.transcript).toBe("live");
	expect(second.entries.map(entry => entry.id)).toEqual([
		entryId("oversized-transcript-record-1"),
		entryId("suffix-entry"),
		entryId("final-entry"),
	]);
	expect(second.entries[0]?.data).toEqual({
		summary: "One transcript record was omitted because it exceeded the 1 MiB safety limit.",
		oversizedRecordOmission: true,
	});
	expect(second.entries.at(-1)?.data.text).toBe("current tail");
	expect(second.watermark).toEqual({ entryCount: 3, lastEntryId: "final-entry" });
	expect((await observer.poll()).stable).toBe(true);
});

test("same-size in-place rewrite resets the follower and replays from byte zero", async () => {
	const header = `${sessionTranscript("observer-rewrite", "/tmp/rewrite", "Rewrite")}\n`;
	const makeEntry = (id: string, text: string) =>
		line({
			type: "message",
			id,
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: text },
		});
	const oldBytes = new TextEncoder().encode(`${header + makeEntry("old-entry", "old")}\n`);
	const newBytes = new TextEncoder().encode(`${header + makeEntry("new-entry", "new")}\n`);
	expect(newBytes.byteLength).toBe(oldBytes.byteLength);
	const state = mutableObserverFsState(oldBytes);
	const observer = new SessionTranscriptObserver("/tmp/rewrite.jsonl", host, state.fs);
	expect((await observer.poll()).entries.map(value => value.data.text)).toEqual(["old"]);
	state.setContent(newBytes, { touch: true });
	const rewritten = await observer.poll();
	expect(rewritten.reset).toBe(true);
	expect(rewritten.entries.map(value => value.data.text)).toEqual(["new"]);
	expect(rewritten.watermark).toEqual({ entryCount: 1, lastEntryId: "new-entry" });
});

test("shrink resets the follower and drops entries no longer present", async () => {
	const header = `${sessionTranscript("observer-shrink", "/tmp/shrink", "Shrink")}\n`;
	const entry = (id: string) =>
		line({
			type: "message",
			id,
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: id },
		});
	const state = mutableObserverFsState(new TextEncoder().encode(`${header + entry("first")}\n${entry("second")}\n`));
	const observer = new SessionTranscriptObserver("/tmp/shrink.jsonl", host, state.fs);
	expect((await observer.poll()).watermark.entryCount).toBe(2);
	state.setContent(new TextEncoder().encode(header), { touch: true });
	const shrunk = await observer.poll();
	expect(shrunk.reset).toBe(true);
	expect(shrunk.record?.entries).toEqual([]);
	expect(shrunk.watermark).toEqual({ entryCount: 0, lastEntryId: null });
});

test("stat/open identity changes fail closed and recover from the replacement generation", async () => {
	const content = new TextEncoder().encode(
		`${sessionTranscript("observer-open-identity", "/tmp/open-identity", "Open identity")}\n${line({
			type: "message",
			id: "open-entry",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "replacement generation" },
		})}\n`,
	);
	const state = mutableObserverFsState(content);
	state.swapNextOpen();
	const observer = new SessionTranscriptObserver("/tmp/open-identity.jsonl", host, state.fs);
	const failed = await observer.poll();
	expect(failed.transcript).toBe("snapshot");
	const recovered = await observer.poll();
	expect(recovered.reset).toBe(true);
	expect(recovered.record?.sessionId).toBe(sessionId("observer-open-identity"));
	expect(recovered.entries.map(value => value.data.text)).toEqual(["replacement generation"]);
});

test("transient UTF-8 decode failure recovers by replaying a valid generation", async () => {
	const header = `${sessionTranscript("observer-decode", "/tmp/decode", "Decode")}\n`;
	const invalid = new Uint8Array([...new TextEncoder().encode(header), 0xff]);
	const valid = new TextEncoder().encode(
		`${
			header +
			line({
				type: "message",
				id: "decoded-entry",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: "decoded" },
			})
		}\n`,
	);
	const state = mutableObserverFsState(invalid);
	const observer = new SessionTranscriptObserver("/tmp/decode.jsonl", host, state.fs);
	expect((await observer.poll()).transcript).toBe("snapshot");
	state.setContent(valid);
	const recovered = await observer.poll();
	expect(recovered.reset).toBe(true);
	expect(recovered.entries.map(value => value.data.text)).toEqual(["decoded"]);
});

test("fixed-title prelude remains authoritative after streamed title changes", async () => {
	const prelude = line({ type: "title", v: 1, title: "Pinned title", updatedAt: stamp });
	const header = sessionTranscript("observer-fixed-title", "/tmp/fixed-title", "Header title");
	const titleChange = line({
		type: "title_change",
		id: "title-change",
		parentId: null,
		timestamp: stamp,
		title: "Later title",
	});
	const state = observerFsState(new TextEncoder().encode(`${prelude}\n${header}\n${titleChange}\n`));
	const observer = new SessionTranscriptObserver("/tmp/fixed-title.jsonl", host, state.fs);
	const poll = await observer.poll();
	expect(poll.record?.title).toBe("Pinned title");
});

test("raw duplicate-key records use loader semantics while projected cursor stays separate", async () => {
	const header = `${sessionTranscript("observer-watermark", "/tmp/watermark", "Watermark")}\n`;
	const duplicate = `{"type":"message","id":"first","id":"last","parentId":null,"timestamp":"${stamp}","message":{"role":"user","content":"safe"}}\n`;
	const state = observerFsState(new TextEncoder().encode(header + duplicate));
	const observer = new SessionTranscriptObserver("/tmp/watermark.jsonl", host, state.fs);
	const poll = await observer.poll();
	expect(poll.watermark).toEqual({ entryCount: 1, lastEntryId: "last" });
	expect(poll.record?.entries.map(entry => entry.id)).toEqual([entryId("last")]);
	const projection = new SessionProjection(host, poll.record!, "epoch-watermark");
	expect(projection.value.cursor).toEqual({ epoch: "epoch-watermark", seq: 0 });
});

test("follower requires a valid session header before accepting a matching record", async () => {
	const invalidHeader = line({
		type: "session",
		version: 3,
		id: "invalid-header",
		cwd: "/tmp/invalid-header",
		timestamp: "not-a-timestamp",
	});
	const validHeader = sessionTranscript("valid-header", "/tmp/valid-header", "Valid header");
	const entry = line({
		type: "message",
		id: "valid-entry",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: "only after valid header" },
	});
	const state = observerFsState(new TextEncoder().encode(`${invalidHeader}\n${validHeader}\n${entry}\n`));
	const observer = new SessionTranscriptObserver("/tmp/header.jsonl", host, state.fs);
	const poll = await observer.poll();
	expect(poll.record?.sessionId).toBe(sessionId("valid-header"));
	expect(poll.entries.map(value => value.data.text)).toEqual(["only after valid header"]);
});

test("same-epoch gap-plus-snapshot replay is monotonic and accepts gap.to as the new cursor", () => {
	const first = new SessionProjection(
		host,
		{
			sessionId: sessionId("replay-gap"),
			path: "/tmp/replay-gap.jsonl",
			cwd: "/tmp/replay-gap",
			projectId: projectId("/tmp/replay-gap"),
			title: "Replay gap",
			updatedAt: stamp,
			status: "idle",
			entries: [],
		},
		"epoch-replay",
		1,
	);
	first.appendEvent({ type: "one" });
	first.appendEvent({ type: "two" });
	const replay = first.replay({ epoch: "epoch-replay", seq: 0 });
	expect(replay.map(frame => frame.type)).toEqual(["gap", "snapshot"]);
	const gap = replay[0];
	const snapshot = replay[1];
	if (gap?.type !== "gap" || snapshot?.type !== "snapshot") throw new Error("expected gap and snapshot");
	expect(gap.from.epoch).toBe("epoch-replay");
	expect(gap.to.epoch).toBe("epoch-replay");
	expect(gap.from.seq).toBeLessThanOrEqual(gap.to.seq);
	expect(snapshot.cursor).toEqual(gap.to);
	expect(first.replay(gap.to)).toEqual([]);
});
