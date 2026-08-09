//  collab/crypto.ts
//  AES-256-GCM sealing of collab frames, matching the host's wire layout
//  [4B u32BE peerId][12B IV][ciphertext+16B tag] over a raw 32-byte room key.

export const ENVELOPE_HEADER_LENGTH = 4;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Pack a peerId prefix + sealed payload into one binary WS message. */
export function packEnvelope(peerId: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + payload.byteLength);
	new DataView(out.buffer).setUint32(0, peerId >>> 0, false);
	out.set(payload, ENVELOPE_HEADER_LENGTH);
	return out;
}

/** Split an envelope into its peerId prefix and sealed payload. */
export function unpackEnvelope(bytes: Uint8Array): { peerId: number; sealed: Uint8Array } {
	if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) throw new Error("collab envelope too short");
	const peerId = new DataView(bytes.buffer, bytes.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, sealed: bytes.subarray(ENVELOPE_HEADER_LENGTH) };
}

export interface CollabCipher {
	seal(plaintext: Uint8Array): Promise<Uint8Array>;
	open(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** WebCrypto-backed AES-256-GCM cipher bound to a raw 32-byte room key. */
export function createCollabCipher(key: Uint8Array): CollabCipher {
	if (key.byteLength !== 32) throw new Error("collab room key must be 32 bytes");
	const subtle = globalThis.crypto.subtle;
	let cached: CryptoKey | undefined;

	const importKey = async (): Promise<CryptoKey> => {
		if (cached) return cached;
		cached = await subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, [
			"encrypt",
			"decrypt",
		]);
		return cached;
	};

	return {
		async seal(plaintext) {
			const k = await importKey();
			const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
			const sealed = await subtle.encrypt({ name: "AES-GCM", iv }, k, plaintext as unknown as BufferSource);
			const out = new Uint8Array(IV_LENGTH + sealed.byteLength);
			out.set(iv, 0);
			out.set(new Uint8Array(sealed), IV_LENGTH);
			return out;
		},
		async open(ciphertext) {
			if (ciphertext.byteLength <= IV_LENGTH) throw new Error("collab frame is malformed");
			const k = await importKey();
			const iv: BufferSource = ciphertext.subarray(0, IV_LENGTH) as unknown as BufferSource;
			const data: BufferSource = ciphertext.subarray(IV_LENGTH) as unknown as BufferSource;
			const opened = await subtle.decrypt({ name: "AES-GCM", iv }, k, data);
			return new Uint8Array(opened);
		},
	};
}
