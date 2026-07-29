import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PreviewServiceError } from "./types.ts";

// Preview URLs are restricted to http(s) served from localhost or a tailnet
// host. Anything else fails closed — a remote client cannot drive the host
// browser toward an arbitrary origin on the open internet or an internal
// address outside the developer's tailnet.

const TAILNET_SUFFIXES = [".ts.net", ".tailnet"] as const;

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function isTailnet(hostname: string): boolean {
	return TAILNET_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

function isLoopbackAddress(address: string): boolean {
	const normalized = address.toLowerCase();
	return (
		normalized === "::1" ||
		normalized.startsWith("::ffff:127.") ||
		/^127(?:\.\d{1,3}){3}$/u.test(normalized)
	);
}

function isTailnetAddress(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized.startsWith("fd7a:115c:a1e0:")) return true;
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
	if (!match) return false;
	const octets = match.slice(1).map(Number);
	return octets.every(value => value >= 0 && value <= 255) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

export interface ResolvedPreviewUrl {
	readonly url: URL;
	readonly origin: string;
	readonly hostname: string;
	readonly addresses: readonly string[];
}

/**
 * Validates that a URL is http(s) pointing at localhost or a tailnet host.
 * Throws PreviewServiceError with code "forbidden_url" when the policy rejects
 * the URL, or "invalid_url" when the URL cannot be parsed.
 */
export function validatePreviewUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new PreviewServiceError("invalid_url", "preview URL is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new PreviewServiceError("forbidden_url", "preview URL must be http or https");
	if (parsed.username !== "" || parsed.password !== "")
		throw new PreviewServiceError("forbidden_url", "preview URL must not carry credentials");
	const hostname = parsed.hostname.toLowerCase();
	if (!isLoopback(hostname) && !isTailnet(hostname) && !isTailnetAddress(hostname))
		throw new PreviewServiceError(
			"forbidden_url",
			"preview URL must target localhost or a tailnet host",
		);
	return parsed;
}

/**
 * Resolves the host before Chromium sees it and verifies every resulting
 * address. Callers pin the returned address set for the preview lifetime and
 * re-run this check for every request, so a later DNS answer cannot silently
 * move an allowed hostname onto another network.
 */
export async function resolvePreviewUrl(
	raw: string,
	expected?: Pick<ResolvedPreviewUrl, "origin" | "hostname" | "addresses">,
): Promise<ResolvedPreviewUrl> {
	const parsed = validatePreviewUrl(raw);
	const rawHostname = parsed.hostname.toLowerCase();
	const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
		? rawHostname.slice(1, -1)
		: rawHostname;
	if (expected && (parsed.origin !== expected.origin || hostname !== expected.hostname))
		throw new PreviewServiceError("forbidden_url", "preview request must remain on the launched origin");
	let addresses: string[];
	if (isIP(hostname) !== 0) addresses = [hostname];
	else {
		try {
			addresses = [...new Set((await lookup(hostname, { all: true, verbatim: true })).map(result => result.address.toLowerCase()))];
		} catch {
			throw new PreviewServiceError("forbidden_url", "preview host could not be resolved safely");
		}
	}
	if (
		addresses.length === 0 ||
		addresses.some(address =>
			isLoopback(hostname) ? !isLoopbackAddress(address) : !isTailnetAddress(address),
		)
	)
		throw new PreviewServiceError("forbidden_url", "preview host resolved outside the allowed network");
	if (expected) {
		const pinned = new Set(expected.addresses);
		if (addresses.some(address => !pinned.has(address)))
			throw new PreviewServiceError("forbidden_url", "preview host DNS answer changed");
	}
	return { url: parsed, origin: parsed.origin, hostname, addresses };
}

/** Returns true when the URL passes the preview URL policy. */
export function previewUrlAllowed(raw: string): boolean {
	try {
		validatePreviewUrl(raw);
		return true;
	} catch {
		return false;
	}
}
