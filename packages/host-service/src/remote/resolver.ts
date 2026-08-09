import { isIP } from "node:net";
import { parseBounded, utf8ByteLength } from "@t4-code/host-wire";
import type { ProcessRunner, RemotePeerIdentity } from "./types.ts";

const MAX_WHOIS_OUTPUT = 256 * 1024;
function normalizeIp(value: string): string | undefined {
	const v = value.startsWith("::ffff:") ? value.slice(7) : value;
	return acceptedIp(v) ? v : undefined;
}
function acceptedIp(value: string): boolean {
	return isIP(value) === 4 || isIP(value) === 6;
}
function parseAddressEntry(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const parts = value.split("/");
	if (parts.length === 1) return normalizeIp(parts[0]);
	if (parts.length !== 2) return undefined;
	const ip = normalizeIp(parts[0]);
	if (!ip || !/^\d+$/.test(parts[1])) return undefined;
	const prefix = Number(parts[1]);
	return (isIP(ip) === 4 && prefix === 32) || (isIP(ip) === 6 && prefix === 128) ? ip : undefined;
}
function text(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= max ? value : undefined;
}
function tailnetUserId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && /^\d{1,15}$/u.test(value)) return value;
	return undefined;
}
export class TailscaleWhoisResolver {
	constructor(
		private readonly runner: ProcessRunner,
		private readonly timeoutMs = 2_000,
		private readonly maxOutputBytes = MAX_WHOIS_OUTPUT,
	) {}
	async resolve(address: string): Promise<RemotePeerIdentity> {
		if (!acceptedIp(address)) throw new Error("whois address must be an IP literal");
		const result = await this.runner.run(["tailscale", "whois", "--json", address], {
			timeoutMs: this.timeoutMs,
			maxOutputBytes: this.maxOutputBytes,
		});
		if (result.exitCode !== 0) throw new Error("tailscale whois failed");
		const bytes = typeof result.stdout === "string" ? utf8ByteLength(result.stdout) : result.stdout.byteLength;
		if (bytes > this.maxOutputBytes) throw new Error("tailscale whois output exceeds limit");
		const value = parseBounded(result.stdout);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("tailscale whois returned invalid JSON");
		const root = value as Record<string, unknown>;
		const node =
			root.Node && typeof root.Node === "object" && !Array.isArray(root.Node)
				? (root.Node as Record<string, unknown>)
				: undefined;
		const profile =
			root.UserProfile && typeof root.UserProfile === "object" && !Array.isArray(root.UserProfile)
				? (root.UserProfile as Record<string, unknown>)
				: undefined;
		const nodeId = text(node?.StableID);
		if (!nodeId || !node) throw new Error("tailscale whois response omitted stable node identity");
		const rawAddresses = node.Addresses;
		if (!Array.isArray(rawAddresses)) throw new Error("tailscale whois response omitted addresses");
		const requested = normalizeIp(address);
		if (!requested) throw new Error("whois address must be an IP literal");
		const addresses = rawAddresses.map(parseAddressEntry);
		if (addresses.some((entry): entry is undefined => entry === undefined))
			throw new Error("tailscale whois response contained malformed address");
		const normalized = addresses as string[];
		if (new Set(normalized).size !== normalized.length)
			throw new Error("tailscale whois response contained duplicate address");
		if (!normalized.includes(requested)) throw new Error("tailscale whois address mismatch");
		return {
			nodeId,
			hostname: text(node.ComputedName) ?? text(node.Name),
			user: text(profile?.LoginName),
			userId: tailnetUserId(node.User) ?? tailnetUserId(profile?.ID),
			addresses: normalized,
			source: "tailscale",
		};
	}
}
