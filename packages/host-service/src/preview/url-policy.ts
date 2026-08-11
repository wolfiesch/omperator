import { PreviewServiceError } from "./types.ts";

// Preview URLs are restricted to http(s) served from localhost. Anything else
// fails closed — a remote client cannot drive the host browser toward an
// arbitrary origin on the open internet or an internal address.

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		hostname === "0.0.0.0"
	);
}

/**
 * Validates that a URL is http(s) pointing at localhost.
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
	if (!isLoopback(hostname))
		throw new PreviewServiceError("forbidden_url", "preview URL must target localhost");
	return parsed;
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
