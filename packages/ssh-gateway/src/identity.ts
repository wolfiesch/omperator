import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SshGatewayError } from "./index.js";

const MAX_AUTH_INFO_BYTES = 16_384;
const MAX_AUTH_INFO_LINES = 32;
const PUBLIC_KEY_AUTH = /^publickey(?:-hostbound-v00@openssh\.com)?\s+(?:(?:ssh-|ecdsa-)[^\s]+\s+)?(?:SHA256:[A-Za-z0-9+/_=-]{16,128}|[A-Za-z0-9+/=]{32,8192})(?:\s+[^\r\n]*)?$/u;
export interface SshAuthorizedIdentityScope {
	readonly scopeId: string;
	readonly roles: readonly string[];
}

export interface SshRequestIdentity {
	readonly principalId: string;
	readonly authorizedScopes: readonly SshAuthorizedIdentityScope[];
	readonly adapter: Readonly<{ id: "openssh-expose-auth-info"; type: "ssh" }>;
	readonly policyRevision: "ssh-expose-auth-info-v1";
}


export async function authenticatedSshPrincipal(path: string | undefined): Promise<string> {
	if (!path || !isAbsolute(path) || path.includes("\0")) throw new SshGatewayError("IDENTITY_REQUIRED");
	let file: FileHandle | undefined;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_AUTH_INFO_BYTES || (metadata.mode & 0o022) !== 0)
			throw new SshGatewayError("IDENTITY_REQUIRED");
		const bytes = Buffer.allocUnsafe(metadata.size + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.byteLength) {
			const result = await file.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead !== metadata.size) throw new SshGatewayError("IDENTITY_REQUIRED");
		let authInfo: string;
		try { authInfo = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)); }
		catch { throw new SshGatewayError("IDENTITY_REQUIRED"); }
		const lines = authInfo.replace(/\n$/u, "").split("\n");
		if (lines.length < 1 || lines.length > MAX_AUTH_INFO_LINES || lines.some(line => !line || line.length > 8192 || /\p{Cc}/u.test(line.replaceAll("\t", ""))))
			throw new SshGatewayError("IDENTITY_REQUIRED");
		const authenticatedKeys = lines.filter(line => PUBLIC_KEY_AUTH.test(line));
		if (authenticatedKeys.length !== 1) throw new SshGatewayError("IDENTITY_REQUIRED");
		return `id_${createHash("sha256").update("t4.identity.ssh-expose-auth-info.v1\0").update(bytes.subarray(0, bytesRead)).digest("base64url")}`;
	} catch (error) {
		if (error instanceof SshGatewayError) throw error;
		throw new SshGatewayError("IDENTITY_REQUIRED");
	} finally {
		await file?.close().catch(() => undefined);
	}
}

export async function authenticatedSshIdentity(path: string | undefined): Promise<SshRequestIdentity> {
	const principalId = await authenticatedSshPrincipal(path);
	return Object.freeze({
		principalId,
		authorizedScopes: Object.freeze([]),
		adapter: Object.freeze({ id: "openssh-expose-auth-info", type: "ssh" }),
		policyRevision: "ssh-expose-auth-info-v1",
	});
}
