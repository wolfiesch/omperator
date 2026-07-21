import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WoodpeckerProvider, mapWoodpeckerPipeline } from "../src/woodpecker.ts";

const correlation = {
	sessionId: "session-one",
	repositoryId: "t4-code",
	ref: "refs/heads/agent/t4-cluster-operator",
	commit: "0123456789abcdef0123456789abcdef01234567",
};
const runCorrelation = { ...correlation, commandId: "command-one" };
const runKey = createHash("sha256").update(correlation.sessionId).update("\u0000").update(runCorrelation.commandId).digest("base64url");
const pipeline = {
	number: 42,
	status: "running",
	ref: correlation.ref,
	branch: "agent/t4-cluster-operator",
	commit: correlation.commit,
	created: 1_773_964_800,
	started: 1_773_964_810,
	finished: 0,
	variables: { T4_SESSION_ID: correlation.sessionId, T4_IDEMPOTENCY_KEY: runKey },
	stages: [
		{ name: "clone", status: "success" },
		{ name: "test", status: "running" },
	],
};

function provider(fetch: typeof globalThis.fetch) {
	return new WoodpeckerProvider({
		baseUrl: "https://ci.example.test",
		token: "secret-from-kubernetes",
		repositories: { "t4-code": { slug: "owner/t4-code" } },
		fetch,
	});
}

describe("bounded Woodpecker provider", () => {
	it("maps only allowlisted categorical pipeline state and canonical HTTPS links", () => {
		expect(mapWoodpeckerPipeline(pipeline, correlation, "https://ci.example.test/repos/owner/t4-code/pipeline/42")).toEqual({
			provider: "woodpecker",
			correlation: "exact",
			repositoryId: "t4-code",
			ref: correlation.ref,
			branch: "agent/t4-cluster-operator",
			commit: correlation.commit,
			pipelineNumber: 42,
			status: "running",
			currentStage: "test",
			createdAt: "2026-03-20T00:00:00.000Z",
			startedAt: "2026-03-20T00:00:10.000Z",
			link: "https://ci.example.test/repos/owner/t4-code/pipeline/42",
		});
		for (const [raw, mapped] of [
			["pending", "queued"], ["queued", "queued"], ["running", "running"], ["success", "success"],
			["failure", "failure"], ["error", "failure"], ["killed", "killed"], ["blocked", "unknown"],
		] as const) expect(mapWoodpeckerPipeline({ ...pipeline, status: raw }, correlation).status).toBe(mapped);
	});

	it("queries exact repository/ref/commit/session correlation and deduplicates before trigger", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return Response.json([pipeline]);
		}) as typeof globalThis.fetch;
		const result = await provider(fetch).run(runCorrelation);
		expect(result).toMatchObject({ triggered: false, pipelineNumber: 42, status: "running" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://ci.example.test/api/repos/owner%2Ft4-code/pipelines?ref=refs%2Fheads%2Fagent%2Ft4-cluster-operator&commit=0123456789abcdef0123456789abcdef01234567&limit=100");
		expect(requests[0]?.init?.headers).toMatchObject({ Authorization: "Bearer secret-from-kubernetes" });
		expect(JSON.stringify(result)).not.toContain("secret-from-kubernetes");
	});

	it("ignores approximate matches, triggers once with server-resolved URL, and re-queries before retry", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		let query = 0;
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			if (!init?.method || init.method === "GET") {
				query++;
				return Response.json(query === 1 ? [{ ...pipeline, variables: { T4_SESSION_ID: "another-session" } }] : [pipeline]);
			}
			return Response.json({ ...pipeline, idempotencyKey: runKey }, { status: 201 });
		}) as typeof globalThis.fetch;
		const woodpecker = provider(fetch);
		const first = await woodpecker.run(runCorrelation);
		expect(first.triggered).toBe(true);
		const post = requests.find(request => request.init?.method === "POST");
		expect(post?.url).toBe("https://ci.example.test/api/repos/owner%2Ft4-code/pipelines");
		const posted = JSON.parse(String(post?.init?.body));
		expect(posted).toMatchObject({
			ref: correlation.ref,
			commit: correlation.commit,
			event: "manual",
			variables: { T4_SESSION_ID: correlation.sessionId },
		});
		expect(posted.variables.T4_IDEMPOTENCY_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(new Headers(post?.init?.headers).get("idempotency-key")).toBe(`t4-${posted.variables.T4_IDEMPOTENCY_KEY}`);
		const second = await woodpecker.run(runCorrelation);
		expect(second).toMatchObject({ triggered: false, pipelineNumber: 42 });
		expect(requests.filter(request => request.init?.method === "POST")).toHaveLength(1);
	});

	it("requires an adapter idempotency receipt before reporting a trigger", async () => {
		let posts = 0;
		const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			if (!init?.method || init.method === "GET") return Response.json([]);
			posts++;
			return Response.json(pipeline, { status: 201 });
		}) as typeof globalThis.fetch;
		await expect(provider(fetch).run(runCorrelation)).rejects.toThrow("provider-side idempotency");
		expect(posts).toBe(1);
	});

	it("uses a distinct provider idempotency key for each intentional command", async () => {
		const keys: string[] = [];
		const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			if (!init?.method || init.method === "GET") return Response.json([]);
			const body = JSON.parse(String(init.body)) as { variables: { T4_IDEMPOTENCY_KEY: string } };
			keys.push(body.variables.T4_IDEMPOTENCY_KEY);
			return Response.json({ ...pipeline, idempotencyKey: body.variables.T4_IDEMPOTENCY_KEY }, { status: 201 });
		}) as typeof globalThis.fetch;
		const woodpecker = provider(fetch);
		await woodpecker.run(runCorrelation);
		await woodpecker.run({ ...runCorrelation, commandId: "command-two" });
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
	});

	it("re-reads a bounded projected credential for every provider request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-woodpecker-token-"));
		try {
			const tokenFile = join(directory, "token");
			const seen: string[] = [];
			const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				seen.push(new Headers(init?.headers).get("authorization") ?? "");
				return Response.json([]);
			}) as typeof globalThis.fetch;
			await writeFile(`${tokenFile}.next`, "a".repeat(40), { mode: 0o400 });
			await rename(`${tokenFile}.next`, tokenFile);
			const woodpecker = new WoodpeckerProvider({
				baseUrl: "https://ci.example.test",
				tokenFile,
				repositories: { "t4-code": { slug: "owner/t4-code" } },
				fetch,
			});
			await woodpecker.query(correlation);
			await writeFile(`${tokenFile}.next`, "b".repeat(40), { mode: 0o400 });
			await rename(`${tokenFile}.next`, tokenFile);
			await woodpecker.query(correlation);
			expect(seen).toEqual([`Bearer ${"a".repeat(40)}`, `Bearer ${"b".repeat(40)}`]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("permits only an exact in-cluster HTTP adapter while keeping deep links on HTTPS", async () => {
		const woodpecker = new WoodpeckerProvider({
			baseUrl: "http://woodpecker-ci-trigger.linkedin-ci.svc.cluster.local:8080",
			webBaseUrl: "https://woodpecker-ci-dev.tail.example.test",
			token: "server-side-token",
			repositories: { "t4-code": { slug: "owner/t4-code" } },
			fetch: (async () => Response.json([pipeline])) as unknown as typeof globalThis.fetch,
		});
		expect((await woodpecker.query(correlation)).link).toBe("https://woodpecker-ci-dev.tail.example.test/repos/owner/t4-code/pipeline/42");
		expect(() => new WoodpeckerProvider({
			baseUrl: "http://ci.example.test",
			webBaseUrl: "https://ci.example.test",
			token: "token",
			repositories: {},
		})).toThrow("in-cluster");
	});

	it("fails closed for unconfigured repositories, insecure provider URLs, oversized replies, and unknown correlation", async () => {
		expect(() => new WoodpeckerProvider({ baseUrl: "http://ci.example.test", token: "secret", repositories: {} })).toThrow("HTTPS");
		expect(() => new WoodpeckerProvider({ baseUrl: "https://ci.example.test", token: "secret", tokenFile: "/run/token", repositories: {} })).toThrow("exactly one");
		const fetch = (async () => Response.json(Array.from({ length: 101 }, () => pipeline))) as unknown as typeof globalThis.fetch;
		await expect(provider(fetch).query(correlation)).rejects.toThrow("pipeline response limit");
		await expect(provider(fetch).query({ ...correlation, repositoryId: "not-allowed" })).rejects.toThrow("not allowlisted");
		const unknown = await provider((async () => Response.json([])) as unknown as typeof globalThis.fetch).query(correlation);
		expect(unknown).toEqual({
			provider: "woodpecker",
			correlation: "unknown",
			repositoryId: "t4-code",
			ref: correlation.ref,
			commit: correlation.commit,
		});
	});
});
