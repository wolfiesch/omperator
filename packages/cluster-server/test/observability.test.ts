import { describe, expect, it } from "vite-plus/test";
import {
	ClusterMetrics,
	ClusterServerHealth,
	JsonLogger,
	OMperatorMetricDefinitions,
	createAdminHandler,
	redactStructuredValue,
	sanitizeTraceAttributes,
} from "../src/observability.ts";
import { isLoopbackAddress } from "../src/server.ts";

describe("cluster-server observability", () => {
	it("redacts credentials and every content-bearing field recursively while retaining correlation", () => {
		const redacted = redactStructuredValue({
			component: "cluster-server",
			request_id: "request-one",
			runtime_ref: "runtime-one",
			runtime_generation: "generation-one",
			token: "top-secret",
			request: {
				deviceToken: "paired-secret",
				prompt: "private prompt",
				path: "/workspace/private/file",
				body: "private body",
				transcript: "private transcript",
				result: "success",
			},
		});
		expect(redacted).toEqual({
			component: "cluster-server",
			request_id: "request-one",
			runtime_ref: "runtime-one",
			runtime_generation: "generation-one",
			token: "[REDACTED]",
			request: {
				deviceToken: "[REDACTED]",
				prompt: "[REDACTED]",
				path: "[REDACTED]",
				body: "[REDACTED]",
				transcript: "[REDACTED]",
				result: "success",
			},
		});
		const lines: string[] = [];
		new JsonLogger(line => lines.push(line), { component: "cluster-server" }).info("connection opened", {
			request_id: "request-one",
			runtime_ref: "runtime-one",
			runtime_generation: "generation-one",
			prompt: "private",
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ request_id: "request-one", runtime_ref: "runtime-one", runtime_generation: "generation-one", prompt: "[REDACTED]" });
	});

	it("allows only content-free bounded trace correlation attributes", () => {
		expect(sanitizeTraceAttributes({
			component: "cluster-server",
			operation: "open",
			result: "success",
			request_id: "request-one",
			runtime_ref: "runtime-one",
			runtime_generation: "generation-one",
			prompt: "private prompt",
			transcript: "private transcript",
			path: "/private/path",
			body: "private body",
		})).toEqual({
			component: "cluster-server",
			operation: "open",
			result: "success",
			request_id: "request-one",
			runtime_ref: "runtime-one",
			runtime_generation: "generation-one",
		});
	});

	it("serves separate health/readiness and the exact omperator metric surface", async () => {
		const health = new ClusterServerHealth();
		const metrics = new ClusterMetrics({ component: "cluster-server" });
		const handler = createAdminHandler({ health, metrics });
		expect((await handler(new Request("http://admin/healthz"))).status).toBe(200);
		expect((await handler(new Request("http://admin/readyz"))).status).toBe(503);
		health.markKubernetesSynced();
		health.markGatewayListening();
		expect(await (await handler(new Request("http://admin/readyz"))).json()).toEqual({ ready: true });

		metrics.increment("omperator_gateway_requests_total", { transport: "rest", operation: "request", result: "success" });
		metrics.observe("omperator_gateway_request_duration_seconds", 0.25, { transport: "rest", operation: "request", result: "success" });
		metrics.set("omperator_gateway_ready", 1);
		const metricResponse = await handler(new Request("http://admin/metrics"));
		expect(metricResponse.headers.get("content-type")).toContain("text/plain");
		const body = await metricResponse.text();
		for (const name of Object.keys(OMperatorMetricDefinitions)) expect(body).toContain(`# TYPE ${name} `);
		expect(body).toContain('omperator_gateway_requests_total{component="cluster-server",operation="request",result="success",transport="rest"} 1');
		expect(body).toContain('omperator_gateway_request_duration_seconds_count{component="cluster-server",operation="request",result="success",transport="rest"} 1');
		expect(body).toContain('omperator_gateway_ready{component="cluster-server"} 1');
		expect(body).not.toMatch(/workspace=|session=|scope=|token=|prompt=|path=|body=/u);

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

	it("rejects unknown metrics, label keys, and dynamic label values", () => {
		const metrics = new ClusterMetrics({ component: "cluster-server" });
		expect(() => metrics.increment("bad-name" as never, {})).toThrow("metric name");
		expect(() => metrics.increment("omperator_gateway_requests_total", { transport: "rest", operation: "request", result: "private-scope-id" })).toThrow("metric label");
		expect(() => metrics.increment("omperator_gateway_requests_total", { transport: "rest", operation: "request", result: "success", workspace: "workspace-one" } as never)).toThrow("metric label set");
		expect(() => metrics.observe("omperator_gateway_request_duration_seconds", -1, { transport: "rest", operation: "request", result: "success" })).toThrow("metric observation");
		expect(() => new ClusterMetrics({ component: "cluster-server", namespace: "private-team" })).toThrow("base labels");
	});
});
