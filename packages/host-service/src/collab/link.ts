//  collab/link.ts
//  Parse an OMP collab link into a relay WebSocket URL plus the AES-256-GCM
//  room key and optional write token, matching the host side's link grammar
//  (see @oh-my-pi/pi-coding-agent/src/collab/protocol.ts).

export interface CollabLink {
	readonly wsUrl: string; // wss://host[:port]/r/<roomId>
	readonly roomId: string;
	readonly key: Uint8Array; // 32 bytes
	readonly writeToken?: Uint8Array; // 16 bytes, absent on view links
}

export const ROOM_ID_BYTES = 16;
export const ROOM_KEY_BYTES = 32;
export const WRITE_TOKEN_BYTES = 16;

const DEFAULT_RELAY_URL = "wss://my.omp.sh";
const ROOM_PATH_RE = /\/r\/([A-Za-z0-9_-]{10,64})/u;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]+)$/u;

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url decode (no padding). Throws on invalid input. */
export function base64UrlDecode(input: string): Uint8Array {
	const cleaned = input.replace(/=/g, "");
	const bytes = new Uint8Array(Math.floor((cleaned.length * 6) / 8));
	let buffer = 0;
	let bits = 0;
	let index = 0;
	for (const char of cleaned) {
		const value = B64URL_ALPHABET.indexOf(char);
		if (value < 0) throw new Error(`invalid base64url character: ${char}`);
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[index++] = (buffer >> bits) & 0xff;
		}
	}
	return bytes.subarray(0, index);
}

function isWsAllowed(scheme: string, host: string): boolean {
	if (scheme === "wss") return true;
	// Plain ws only for loopback relays.
	if (scheme !== "ws") return false;
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve a collab link to a concrete relay URL + key. Accepts bare
 * `<roomId>.<key>`, scheme-less `host[:port]/r/<roomId>.<key>`, full ws/wss
 * URLs, and web deep links (`https://…/#<roomId>.<key>`) by recursing into the
 * fragment. `%23` is normalized to `#` first.
 */
export function parseCollabLink(input: string): CollabLink {
	let text = input.trim();
	text = text.replace(/%23/gu, "#");

	const trySecret = (candidate: string): Uint8Array | undefined => {
		if (candidate.length < 20) return undefined;
		const bytes = base64UrlDecode(candidate);
		if (bytes.byteLength !== ROOM_KEY_BYTES && bytes.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)
			return undefined;
		return bytes;
	};

	// Bare `<roomId>.<key>` → default relay `/r/<roomId>.<key>`.
	if (!text.includes("/")) {
		const bare = BARE_LINK_RE.exec(text);
		if (bare && trySecret(bare[2])) text = `${DEFAULT_RELAY_URL}/r/${text}`;
	}

	// Full web deep link: fragment carries `<roomId>.<key>`.
	if (/^https?:\/\//u.test(text)) {
		const url = new URL(text);
		const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (fragment) {
			const bare = BARE_LINK_RE.exec(fragment);
			if (bare && trySecret(bare[2])) {
				const base = url.origin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:");
				return parseCollabLink(`${base}/r/${fragment}`);
			}
		}
		// Fall through to path form below if no usable fragment.
	}

	let host = DEFAULT_RELAY_URL;
	let pathPart = text;
	if (text.includes("/")) {
		const schemeMatch = /^(wss?:\/\/)/u.exec(text);
		const scheme = schemeMatch?.[1] ?? "wss://";
		let remainder = schemeMatch ? text.slice(scheme.length) : text;
		if (!schemeMatch && !text.startsWith("//")) remainder = text;
		const slash = remainder.indexOf("/");
		if (slash < 0) throw new Error("collab link is missing a /r/<roomId>.<key> path");
		const hostPart = remainder.slice(0, slash);
		const bareScheme = scheme === "ws://" ? "ws" : "wss";
		const hostname = hostPart.replace(/:\d+$/u, "");
		if (!isWsAllowed(bareScheme, hostname))
			throw new Error(`collab relay must use wss (got ${bareScheme} for ${hostname})`);
		host = `${scheme}${hostPart}`;
		pathPart = remainder.slice(slash);
	}

	const match = ROOM_PATH_RE.exec(pathPart);
	if (!match) throw new Error("collab link has no room path");
	const roomId = match[1];
	const after = pathPart.slice(match.index + match[0].length);
	const dot = after.startsWith(".") ? after.slice(1) : after;
	const secret = trySecret(dot);
	if (!secret) throw new Error("collab link has an invalid key");
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken =
		secret.byteLength === ROOM_KEY_BYTES + WRITE_TOKEN_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${host}/r/${roomId}`, roomId, key, writeToken };
}
