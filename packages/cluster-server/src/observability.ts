const REDACTED = "[REDACTED]";
const SECRET_MARKERS = ["password", "passwd", "secret", "token", "credential", "apikey", "privatekey", "cookie", "auth", "pairing", "prompt", "transcript", "path"];
const METRIC_LABELS = new Set(["component", "version", "namespace", "workspace", "session", "condition", "provider", "result"]);
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

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

interface MetricValue { value: number; labels: Readonly<Record<string, string>>; }
function labelsKey(labels: Readonly<Record<string, string>>): string {
	return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\u0000");
}
function escaped(value: string): string { return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"'); }

export class ClusterMetrics {
	readonly #base: Readonly<Record<string, string>>;
	readonly #metrics = new Map<string, MetricValue>();
	constructor(base: Readonly<Record<string, string>>) {
		this.#base = this.#labels(base);
	}
	increment(name: string, labels: Readonly<Record<string, string>>, amount = 1): void {
		this.#name(name);
		if (!Number.isFinite(amount) || amount < 0) throw new Error("metric increment is invalid");
		const merged = this.#labels({ ...this.#base, ...labels });
		const key = `${name}\u0000${labelsKey(merged)}`;
		const current = this.#metrics.get(key);
		this.#metrics.set(key, { labels: merged, value: (current?.value ?? 0) + amount });
	}
	set(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
		this.#name(name);
		if (!Number.isFinite(value)) throw new Error("metric value is invalid");
		const merged = this.#labels({ ...this.#base, ...labels });
		this.#metrics.set(`${name}\u0000${labelsKey(merged)}`, { labels: merged, value });
	}
	render(): string {
		return [...this.#metrics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, metric]) => {
			const name = key.slice(0, key.indexOf("\u0000"));
			const labels = Object.entries(metric.labels).sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => `${label}="${escaped(value)}"`).join(",");
			return `${name}${labels ? `{${labels}}` : ""} ${metric.value}`;
		}).join("\n") + "\n";
	}
	#name(name: string): void { if (!METRIC_NAME.test(name)) throw new Error("metric name is invalid"); }
	#labels(labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
		if (Object.keys(labels).length > 8) throw new Error("metric label limit exceeded");
		const output: Record<string, string> = {};
		for (const [key, value] of Object.entries(labels)) {
			if (!LABEL_NAME.test(key) || !METRIC_LABELS.has(key) || redactKey(key) || typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 128)
				throw new Error("metric label is invalid");
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

export interface AdminHandlerOptions {
	readonly health: ClusterServerHealth;
	readonly metrics: ClusterMetrics;
}
function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
export function createAdminHandler(options: AdminHandlerOptions): (request: Request) => Promise<Response> {
	return async request => {
		const path = new URL(request.url).pathname;
		if (path === "/healthz") return request.method === "GET" ? json({ healthy: options.health.healthy }) : new Response(null, { status: 405 });
		if (path === "/readyz") return request.method === "GET" ? json({ ready: options.health.ready }, options.health.ready ? 200 : 503) : new Response(null, { status: 405 });
		if (path === "/metrics") return request.method === "GET" ? new Response(options.metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } }) : new Response(null, { status: 405 });
		return new Response("not found", { status: 404 });
	};
}
