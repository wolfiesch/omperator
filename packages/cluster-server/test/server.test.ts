import { describe, expect, it } from "vite-plus/test";
import { RequestIdentityResolver, TailscaleIdentityAdapter } from "../src/identity.ts";
import { ClusterMetrics } from "../src/observability.ts";
import { gatewayIdentity, observeClusterRestResponse, recordBrowserStreamDrop, recordCmuxProtocolMismatch } from "../src/server.ts";

const resolver = new RequestIdentityResolver([
	new TailscaleIdentityAdapter({ id: "tailnet", type: "tailscale", policyRevision: "1" }),
]);
const trustedSource = (address: string): boolean => address === "100.64.0.7";
function request(headers: Readonly<Record<string, string>>): Request {
	return new Request("https://cluster.example/v1/ws", { headers });
}

describe("cluster gateway provider-neutral identity", () => {
	it("accepts an opaque Tailscale identity only across the explicit trusted HTTPS proxy boundary", async () => {
		const identity = await gatewayIdentity(request({
			"x-forwarded-proto": "https",
			"tailscale-user-login": "operator@example.com",
			"tailscale-user-name": "Operator",
		}), "100.64.0.7", trustedSource, resolver);
		expect(identity).toMatchObject({ adapter: { id: "tailnet", type: "tailscale" }, policyRevision: "1" });
		expect(identity?.principalId).toMatch(/^id_[A-Za-z0-9_-]{43}$/u);
	});

	it("rejects identity headers from untrusted sources, non-HTTPS forwarding, or incomplete identity", async () => {
		const headers = { "x-forwarded-proto": "https", "tailscale-user-login": "attacker@example.com" };
		expect(await gatewayIdentity(request(headers), "198.51.100.4", trustedSource, resolver)).toBeUndefined();
		expect(await gatewayIdentity(request({ ...headers, "x-forwarded-proto": "http" }), "100.64.0.7", trustedSource, resolver)).toBeUndefined();
		expect(await gatewayIdentity(request({ "tailscale-user-name": "Spoofed User", "x-forwarded-proto": "https" }), "100.64.0.7", trustedSource, resolver)).toBeUndefined();
	});

	it("does not expose adapter validation details or input values on rejection", async () => {
		const oversized = "x".repeat(257);
		const result = await gatewayIdentity(request({ "x-forwarded-proto": "https", "tailscale-user-login": oversized }), "100.64.0.7", trustedSource, resolver);
		expect(result).toBeUndefined();
	});
});

describe("cluster server metric producers", () => {
	it("records thrown REST requests in both exact request families", async () => {
		const metrics = new ClusterMetrics({ component: "cluster-server" });
		await expect(observeClusterRestResponse(
			metrics,
			async () => { throw new Error("backend unavailable"); },
			new Request("https://cluster.example/v1/runtimes"),
		)).rejects.toThrow("backend unavailable");
		const rendered = metrics.render();
		expect(rendered).toContain('omperator_gateway_requests_total{component="cluster-server",operation="request",result="error",transport="rest"} 1');
		expect(rendered).toContain('omperator_gateway_request_duration_seconds_count{component="cluster-server",operation="request",result="error",transport="rest"} 1');
	});

	it("records malformed cmux and only dropped browser preview frames", () => {
		const metrics = new ClusterMetrics({ component: "cluster-server" });
		recordCmuxProtocolMismatch(metrics);
		recordBrowserStreamDrop(metrics, { type: "preview.frame" }, true);
		recordBrowserStreamDrop(metrics, { type: "sessions" }, true);
		recordBrowserStreamDrop(metrics, { type: "preview.frame" }, false);
		const rendered = metrics.render();
		expect(rendered).toContain('omperator_cmux_protocol_mismatch_total{component="cluster-server"} 1');
		expect(rendered).toContain('omperator_browser_stream_dropped_frames_total{component="cluster-server"} 1');
	});
});
