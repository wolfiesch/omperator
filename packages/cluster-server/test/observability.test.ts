import { describe, expect, it } from "vite-plus/test";
import {
	ClusterMetrics,
	ClusterServerHealth,
	JsonLogger,
	createAdminHandler,
	redactStructuredValue,
} from "../src/observability.ts";
import { isLoopbackAddress } from "../src/server.ts";

describe("cluster-server observability", () => {
	it("redacts credentials, prompt content, pairing data, and private paths recursively", () => {
		const redacted = redactStructuredValue({
			component: "cluster-server",
			session: "session-one",
			token: "top-secret",
			request: {
				deviceToken: "paired-secret",
				prompt: "private prompt",
				path: "/workspace/private/file",
				result: "success",
			},
		});
		expect(redacted).toEqual({
			component: "cluster-server",
			session: "session-one",
			token: "[REDACTED]",
			request: { deviceToken: "[REDACTED]", prompt: "[REDACTED]", path: "[REDACTED]", result: "success" },
		});
		const lines: string[] = [];
		new JsonLogger(line => lines.push(line), { component: "cluster-server", version: "test" }).info("ci lookup", {
			provider: "woodpecker",
			token: "secret",
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "info", message: "ci lookup", provider: "woodpecker", token: "[REDACTED]" });
	});

	it("serves separate health/readiness and bounded metrics without a remote drain route", async () => {
		const health = new ClusterServerHealth();
		const metrics = new ClusterMetrics({ component: "cluster-server", version: "test" });
		const handler = createAdminHandler({ health, metrics });
		expect((await handler(new Request("http://admin/healthz"))).status).toBe(200);
		expect((await handler(new Request("http://admin/readyz"))).status).toBe(503);
		health.markKubernetesSynced();
		health.markGatewayListening();
		expect(await (await handler(new Request("http://admin/readyz"))).json()).toEqual({ ready: true });

		metrics.increment("t4_cluster_gateway_commands_total", { result: "success", provider: "woodpecker" });
		metrics.set("t4_cluster_gateway_connections", 2);
		const metricResponse = await handler(new Request("http://admin/metrics"));
		expect(metricResponse.headers.get("content-type")).toContain("text/plain");
		const body = await metricResponse.text();
		expect(body).toContain('t4_cluster_gateway_commands_total{component="cluster-server",provider="woodpecker",result="success",version="test"} 1');
		expect(body).not.toContain("token");

		expect((await handler(new Request("http://admin/drainz", { method: "POST" }))).status).toBe(404);
		expect((await handler(new Request("http://admin/readyz"))).status).toBe(200);
	});

	it("recognizes only kernel loopback sources for the preStop drain route", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.42.0.7")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("10.42.0.7")).toBe(false);
		expect(isLoopbackAddress("fd7a:115c:a1e0::1")).toBe(false);
	});

	it("rejects unbounded or secret-like metric labels", () => {
		const metrics = new ClusterMetrics({ component: "cluster-server", version: "test" });
		expect(() => metrics.increment("bad-name", {})).toThrow("metric name");
		expect(() => metrics.increment("valid_metric", { token: "secret" })).toThrow("metric label");
		expect(() => metrics.increment("valid_metric", { result: "x".repeat(129) })).toThrow("metric label");
	});
});
