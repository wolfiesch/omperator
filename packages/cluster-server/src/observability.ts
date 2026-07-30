const REDACTED = "[REDACTED]";
const SECRET_MARKERS = ["password", "passwd", "secret", "token", "credential", "apikey", "privatekey", "cookie", "auth", "pairing", "prompt", "transcript", "path", "body", "content"];
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

type ValueTable = Readonly<Record<string, true>>;
const VALUES = {
	component: { "cluster-server": true, "cluster-operator": true, "ssh-gateway": true, "model-gateway": true, runtime: true },
	transport: { rest: true, "omp-app": true, cmux: true, sse: true, ssh: true, internal: true },
	operation: { request: true, open: true, close: true, issue: true, consume: true, revoke: true, reconcile: true, read: true, write: true, remount: true, probe: true, create: true, update: true, delete: true, snapshot: true },
	result: { success: true, error: true, denied: true, retry: true, timeout: true, unavailable: true, fenced: true },
	error_class: { authentication: true, authorization: true, validation: true, backend: true, timeout: true, conflict: true, capacity: true, internal: true },
	resource: { clusterhost: true, workspace: true, runtime: true, session: true, ticket: true, storage: true },
} as const satisfies Readonly<Record<string, ValueTable>>;

type BoundedLabel = keyof typeof VALUES;
interface MetricDefinition { readonly type: "counter" | "gauge" | "histogram"; readonly help: string; readonly labels: readonly BoundedLabel[]; }
export const OMperatorMetricDefinitions = Object.freeze({
	omperator_reconcile_duration_seconds: { type: "histogram", help: "Controller reconciliation duration by bounded resource kind and result.", labels: ["component", "resource", "result"] },
	omperator_reconcile_errors_total: { type: "counter", help: "Controller reconciliation failures by bounded resource kind and error class.", labels: ["component", "resource", "error_class"] },
	omperator_runtime_start_duration_seconds: { type: "histogram", help: "Runtime start duration by bounded result.", labels: ["component", "result"] },
	omperator_runtime_fence_duration_seconds: { type: "histogram", help: "Runtime positive-fence duration by bounded result.", labels: ["component", "result"] },
	omperator_gateway_requests_total: { type: "counter", help: "Gateway requests by bounded transport, operation, and result.", labels: ["component", "transport", "operation", "result"] },
	omperator_gateway_request_duration_seconds: { type: "histogram", help: "Gateway request duration by bounded transport, operation, and result.", labels: ["component", "transport", "operation", "result"] },
	omperator_provider_ticket_total: { type: "counter", help: "Provider ticket operations by bounded operation and result.", labels: ["component", "operation", "result"] },
	omperator_provider_snapshot_duration_seconds: { type: "histogram", help: "Provider snapshot duration by bounded result.", labels: ["component", "result"] },
	omperator_storage_operation_duration_seconds: { type: "histogram", help: "Storage operation duration by bounded operation and result.", labels: ["component", "operation", "result"] },
	omperator_runtime_ready: { type: "gauge", help: "Number of currently ready runtimes.", labels: ["component"] },
	omperator_gateway_ready: { type: "gauge", help: "Whether this gateway replica is ready.", labels: ["component"] },
	omperator_cmux_protocol_mismatch_total: { type: "counter", help: "Rejected cmux protocol mismatches.", labels: ["component"] },
	omperator_omp_bridge_mismatch_total: { type: "counter", help: "Rejected OMP bridge protocol mismatches.", labels: ["component"] },
	omperator_browser_stream_dropped_frames_total: { type: "counter", help: "Browser stream frames dropped by bounded backpressure handling.", labels: ["component"] },
	omperator_wake_total: { type: "counter", help: "Runtime wake outcomes by bounded result.", labels: ["component", "result"] },
	omperator_drain_total: { type: "counter", help: "Gateway and runtime drain outcomes by bounded result.", labels: ["component", "result"] },
} satisfies Readonly<Record<string, MetricDefinition>>);

type MetricName = keyof typeof OMperatorMetricDefinitions;

function redactKey(key: string): boolean {
	const normalized = key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "");
	return SECRET_MARKERS.some(marker => normalized.includes(marker));
}
export function redactStructuredValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) return value.slice(0, 1_000).map(item => redactStructuredValue(item, seen));
	if (!value || typeof value !== "object") return typeof value === "string" && value.length > 2_048 ? `${value.slice(0, 2_048)}…` : value;
	if (seen.has(value)) return "[CYCLE]";
	seen.add(value);
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 128))
		output[key] = redactKey(key) ? REDACTED : redactStructuredValue(child, seen);
	return output;
}

export class JsonLogger {
	constructor(
		private readonly write: (line: string) => void = line => process.stdout.write(`${line}\n`),
		private readonly base: Readonly<Record<string, unknown>> = {},
	) {}
	info(message: string, fields: Readonly<Record<string, unknown>> = {}): void { this.#log("info", message, fields); }
	warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void { this.#log("warn", message, fields); }
	error(message: string, fields: Readonly<Record<string, unknown>> = {}): void { this.#log("error", message, fields); }
	#log(level: "info" | "warn" | "error", message: string, fields: Readonly<Record<string, unknown>>): void {
		const value = redactStructuredValue({ timestamp: new Date().toISOString(), level, message: message.slice(0, 512), ...this.base, ...fields });
		this.write(JSON.stringify(value));
	}
}

const TRACE_FIELDS: Readonly<Record<string, true>> = { component: true, operation: true, result: true, request_id: true, runtime_ref: true, runtime_generation: true };
export function sanitizeTraceAttributes(attributes: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!TRACE_FIELDS[key] || redactKey(key) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) continue;
		const rendered = String(value);
		if (rendered.length > 256) continue;
		output[key] = rendered;
	}
	return Object.freeze(output);
}

interface MetricValue { value: number; labels: Readonly<Record<string, string>>; }
interface HistogramValue extends MetricValue { count: number; buckets: number[]; }
const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;
function labelsKey(labels: Readonly<Record<string, string>>): string {
	return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\u0000");
}
function escaped(value: string): string { return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"'); }
function renderedLabels(labels: Readonly<Record<string, string>>, extra?: readonly [string, string]): string {
	const entries = Object.entries(labels);
	if (extra) entries.push([extra[0], extra[1]]);
	return entries.sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => `${label}="${escaped(value)}"`).join(",");
}

export class ClusterMetrics {
	readonly #base: Readonly<Record<string, string>>;
	readonly #metrics = new Map<string, MetricValue>();
	readonly #histograms = new Map<string, HistogramValue>();
	constructor(base: Readonly<Record<string, string>>) {
		if (Object.keys(base).length !== 1 || base.component === undefined || !(VALUES.component as ValueTable)[base.component]) throw new Error("metric base labels are invalid");
		this.#base = Object.freeze({ component: base.component });
	}
	increment(name: MetricName, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
		const definition = this.#definition(name);
		if (definition.type !== "counter") throw new Error("metric type is invalid");
		if (!Number.isFinite(amount) || amount < 0) throw new Error("metric increment is invalid");
		const merged = this.#labels(name, { ...this.#base, ...labels });
		const key = `${name}\u0000${labelsKey(merged)}`;
		const current = this.#metrics.get(key);
		this.#metrics.set(key, { labels: merged, value: (current?.value ?? 0) + amount });
	}
	set(name: MetricName, value: number, labels: Readonly<Record<string, string>> = {}): void {
		const definition = this.#definition(name);
		if (definition.type !== "gauge") throw new Error("metric type is invalid");
		if (!Number.isFinite(value)) throw new Error("metric value is invalid");
		const merged = this.#labels(name, { ...this.#base, ...labels });
		this.#metrics.set(`${name}\u0000${labelsKey(merged)}`, { labels: merged, value });
	}
	observe(name: MetricName, value: number, labels: Readonly<Record<string, string>> = {}): void {
		const definition = this.#definition(name);
		if (definition.type !== "histogram") throw new Error("metric type is invalid");
		if (!Number.isFinite(value) || value < 0) throw new Error("metric observation is invalid");
		const merged = this.#labels(name, { ...this.#base, ...labels });
		const key = `${name}\u0000${labelsKey(merged)}`;
		const current = this.#histograms.get(key) ?? { labels: merged, value: 0, count: 0, buckets: HISTOGRAM_BUCKETS.map(() => 0) };
		current.value += value;
		current.count++;
		for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) if (value <= HISTOGRAM_BUCKETS[index]!) current.buckets[index]!++;
		this.#histograms.set(key, current);
	}
	render(): string {
		const lines: string[] = [];
		for (const [name, definition] of Object.entries(OMperatorMetricDefinitions).sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} ${definition.type}`);
			if (definition.type === "histogram") {
				for (const [, metric] of [...this.#histograms.entries()].filter(([key]) => key.startsWith(`${name}\u0000`)).sort(([a], [b]) => a.localeCompare(b))) {
					for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) lines.push(`${name}_bucket{${renderedLabels(metric.labels, ["le", String(HISTOGRAM_BUCKETS[index]!)])}} ${metric.buckets[index]}`);
					lines.push(`${name}_bucket{${renderedLabels(metric.labels, ["le", "+Inf"])}} ${metric.count}`);
					lines.push(`${name}_sum{${renderedLabels(metric.labels)}} ${metric.value}`);
					lines.push(`${name}_count{${renderedLabels(metric.labels)}} ${metric.count}`);
				}
				continue;
			}
			for (const [, metric] of [...this.#metrics.entries()].filter(([key]) => key.startsWith(`${name}\u0000`)).sort(([a], [b]) => a.localeCompare(b))) lines.push(`${name}{${renderedLabels(metric.labels)}} ${metric.value}`);
		}
		return `${lines.join("\n")}\n`;
	}
	#definition(name: string): MetricDefinition {
		if (!METRIC_NAME.test(name) || !(name in OMperatorMetricDefinitions)) throw new Error("metric name is invalid");
		return OMperatorMetricDefinitions[name as MetricName];
	}
	#labels(name: MetricName, labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
		const expected = OMperatorMetricDefinitions[name].labels;
		if (Object.keys(labels).length !== expected.length) throw new Error("metric label set is invalid");
		const output: Record<string, string> = {};
		for (const key of expected) {
			const value = labels[key];
			if (!LABEL_NAME.test(key) || value === undefined || !(VALUES[key] as ValueTable)[value]) throw new Error("metric label is invalid");
			output[key] = value;
		}
		return Object.freeze(output);
	}
}

export class ClusterServerHealth {
	#kubernetesSynced = false;
	#gatewayListening = false;
	#draining = false;
	markKubernetesSynced(): void { this.#kubernetesSynced = true; }
	markKubernetesUnavailable(): void { this.#kubernetesSynced = false; }
	markGatewayListening(): void { this.#gatewayListening = true; }
	markGatewayStopped(): void { this.#gatewayListening = false; }
	beginDrain(): void { this.#draining = true; }
	get healthy(): boolean { return true; }
	get ready(): boolean { return this.#kubernetesSynced && this.#gatewayListening && !this.#draining; }
	get draining(): boolean { return this.#draining; }
}

export interface AdminHandlerOptions { readonly health: ClusterServerHealth; readonly metrics: ClusterMetrics; }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
export function createAdminHandler(options: AdminHandlerOptions): (request: Request) => Promise<Response> {
	return async request => {
		const path = new URL(request.url).pathname;
		if (path === "/healthz") return request.method === "GET" ? json({ healthy: options.health.healthy }) : new Response(null, { status: 405 });
		if (path === "/readyz") return request.method === "GET" ? json({ ready: options.health.ready }, options.health.ready ? 200 : 503) : new Response(null, { status: 405 });
		if (path === "/metrics") return request.method === "GET" ? new Response(options.metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } }) : new Response(null, { status: 405 });
		return new Response("not found", { status: 404 });
	};
}
