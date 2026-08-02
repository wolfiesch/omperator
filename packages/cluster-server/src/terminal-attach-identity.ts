import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { hostId, sessionId } from "@t4-code/host-wire";

const ATTACH_IDENTITY_FILE = "terminal-attach.json";
const ATTACH_SOCKET_FILE = "attach.sock";
const MAX_IDENTITY_BYTES = 4_096;

export interface TerminalAttachIdentity {
	readonly runtimeId: string;
	readonly generation: string;
	readonly hostId: string;
	readonly sessionId: string;
	readonly socketPath: string;
}

export interface TerminalAttachConfig extends TerminalAttachIdentity {
	readonly identityPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function exactRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("terminal attach identity is invalid");
	const record = value as Record<string, unknown>;
	const expected = ["generation", "hostId", "runtimeId", "sessionId", "socketPath"];
	if (Object.keys(record).sort().join("\u0000") !== expected.join("\u0000")) throw new Error("terminal attach identity is invalid");
	return record;
}

function textField(record: Record<string, unknown>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value.length === 0) throw new Error(`terminal attach identity ${name} is invalid`);
	return value;
}

export async function terminalAttachConfigFromEnv(env: NodeJS.ProcessEnv): Promise<TerminalAttachConfig> {
	const runtimeId = required(env, "T4_RUNTIME_ID");
	const generation = required(env, "T4_RUNTIME_GENERATION");
	const sessionName = required(env, "T4_SESSION_NAME");
	const runtimeRoot = required(env, "T4_HOST_RUNTIME_DIR");
	if (!/^runtime-[a-z0-9](?:[-a-z0-9]{0,53}[a-z0-9])?$/u.test(runtimeId)) throw new Error("T4_RUNTIME_ID is invalid");
	if (!/^gen_[A-Za-z0-9_-]{24}$/u.test(generation)) throw new Error("T4_RUNTIME_GENERATION is invalid");
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u.test(sessionName)) throw new Error("T4_SESSION_NAME is invalid");
	if (!isAbsolute(runtimeRoot) || runtimeRoot !== `/run/t4/${runtimeId}`) throw new Error("T4_HOST_RUNTIME_DIR does not match T4_RUNTIME_ID");
	const identityPath = join(runtimeRoot, ATTACH_IDENTITY_FILE);
	const stat = await lstat(identityPath);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o640 || stat.size < 2 || stat.size > MAX_IDENTITY_BYTES) throw new Error("terminal attach identity file is invalid");
	const record = exactRecord(JSON.parse(await readFile(identityPath, "utf8")));
	const identity: TerminalAttachIdentity = {
		runtimeId: textField(record, "runtimeId"),
		generation: textField(record, "generation"),
		hostId: String(hostId(textField(record, "hostId"))),
		sessionId: String(sessionId(textField(record, "sessionId"))),
		socketPath: textField(record, "socketPath"),
	};
	if (identity.runtimeId !== runtimeId || identity.generation !== generation) throw new Error("terminal attach identity does not match this runtime generation");
	if (identity.hostId !== `pod:${sessionName}`) throw new Error("terminal attach host identity does not match this runtime");
	if (identity.socketPath !== join(runtimeRoot, ATTACH_SOCKET_FILE)) throw new Error("terminal attach socket does not match this runtime");
	return { ...identity, identityPath };
}

export async function writeTerminalAttachIdentity(runtimeRoot: string, identity: Omit<TerminalAttachIdentity, "socketPath">): Promise<string> {
	const path = join(runtimeRoot, ATTACH_IDENTITY_FILE);
	const socketPath = join(runtimeRoot, ATTACH_SOCKET_FILE);
	const temporary = join(runtimeRoot, `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
	const body = `${JSON.stringify({ ...identity, socketPath })}\n`;
	if (Buffer.byteLength(body) > MAX_IDENTITY_BYTES) throw new Error("terminal attach identity exceeds its size bound");
	await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o640 });
	try {
		await chmod(temporary, 0o640);
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
	return path;
}

export async function removeTerminalAttachIdentity(runtimeRoot: string): Promise<void> {
	await unlink(join(runtimeRoot, ATTACH_IDENTITY_FILE)).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}
