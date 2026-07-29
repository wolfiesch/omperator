import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

const REGISTRY_VERSION = 2;
const MAX_REGISTRY_BYTES = 64 * 1024;
const PS_TIMEOUT_MS = 2_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_POLL_MS = 50;

export interface RpcChildIdentity {
	readonly pid: number;
	readonly pgid: number;
	readonly bootId: string;
	readonly startedAt: string;
	readonly commandSha256: string;
}

export interface RpcChildRegistryDependencies {
	readonly inspect?: (pid: number) => RpcChildIdentity | undefined;
	readonly killGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
	readonly wait?: (milliseconds: number) => Promise<void>;
}

interface RegistryFile {
	readonly version: 2;
	readonly ownerNonce: string;
	readonly owner: RpcChildIdentity;
	readonly children: readonly RpcChildIdentity[];
}

interface RegistryState {
	readonly ownerNonce: string;
	readonly owner: RpcChildIdentity;
	readonly children: readonly RpcChildIdentity[];
}

function commandDigest(command: string): string {
	return createHash("sha256").update(command, "utf8").digest("hex");
}

function ps(pid: number, field: "pgid" | "lstart" | "command"): string | undefined {
	try {
		const output = execFileSync("/bin/ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], {
			encoding: "utf8",
			timeout: PS_TIMEOUT_MS,
			maxBuffer: 16 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output.length === 0 ? undefined : output;
	} catch {
		return undefined;
	}
}

function bootIdentifier(): string | undefined {
	try {
		if (process.platform === "linux")
			return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (process.platform === "darwin")
			return execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
				encoding: "utf8",
				timeout: PS_TIMEOUT_MS,
				maxBuffer: 1024,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
	} catch {}
	return undefined;
}

function inspectProcess(pid: number): RpcChildIdentity | undefined {
	const bootId = bootIdentifier();
	if (bootId === undefined) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd < 0) return undefined;
			const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
			const pgid = Number(fields[2]);
			const startedAt = fields[19];
			const command = readFileSync(`/proc/${pid}/cmdline`)
				.toString("utf8")
				.replaceAll("\0", " ")
				.trim();
			if (
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				!Number.isSafeInteger(pgid) ||
				pgid <= 0 ||
				!startedAt ||
				!command
			)
				return undefined;
			return { pid, pgid, bootId, startedAt, commandSha256: commandDigest(command) };
		} catch {
			return undefined;
		}
	}
	const rawPgid = ps(pid, "pgid");
	const startedAt = ps(pid, "lstart");
	const command = ps(pid, "command");
	const pgid = rawPgid === undefined ? Number.NaN : Number(rawPgid);
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!Number.isSafeInteger(pgid) ||
		pgid <= 0 ||
		startedAt === undefined ||
		command === undefined
	)
		return undefined;
	return { pid, pgid, bootId, startedAt, commandSha256: commandDigest(command) };
}

function decodeIdentity(value: unknown): RpcChildIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("rpc child registry is malformed");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "bootId,commandSha256,pgid,pid,startedAt" ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.pgid !== "number" ||
		!Number.isSafeInteger(record.pgid) ||
		record.pgid <= 0 ||
		typeof record.bootId !== "string" ||
		record.bootId.length === 0 ||
		record.bootId.length > 256 ||
		typeof record.startedAt !== "string" ||
		record.startedAt.length === 0 ||
		record.startedAt.length > 128 ||
		typeof record.commandSha256 !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.commandSha256)
	)
		throw new Error("rpc child registry is malformed");
	return {
		pid: record.pid,
		pgid: record.pgid,
		bootId: record.bootId,
		startedAt: record.startedAt,
		commandSha256: record.commandSha256,
	};
}

function sameIdentity(left: RpcChildIdentity, right: RpcChildIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.pgid === right.pgid &&
		left.bootId === right.bootId &&
		left.startedAt === right.startedAt &&
		left.commandSha256 === right.commandSha256
	);
}

/**
 * Durable identity ledger for per-session OMP process groups. A stale entry is
 * reaped only after PID, PGID, start time, and command digest all still match.
 */
export class RpcChildRegistry {
	readonly #path: string;
	readonly #inspect: (pid: number) => RpcChildIdentity | undefined;
	readonly #killGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
	readonly #wait: (milliseconds: number) => Promise<void>;
	readonly #owner: RpcChildIdentity;
	readonly #ownerNonce = randomUUID();

	constructor(path: string, dependencies: RpcChildRegistryDependencies = {}) {
		if (!isAbsolute(path)) throw new Error("rpc child registry path must be absolute");
		this.#path = path;
		this.#inspect = dependencies.inspect ?? inspectProcess;
		const owner = this.#inspect(process.pid);
		if (!owner) throw new Error("rpc child registry could not identify its host process");
		this.#owner = owner;
		this.#killGroup =
			dependencies.killGroup ??
			((pgid, signal): void => {
				process.kill(-pgid, signal);
			});
		this.#wait =
			dependencies.wait ??
			(milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
	}

	register(pid: number): RpcChildIdentity {
		const identity = this.#inspect(pid);
		if (!identity || identity.pid !== pid || identity.pgid !== pid)
			throw new Error("rpc child did not start in a dedicated process group");
		const state = this.#read();
		if (state && !sameIdentity(state.owner, this.#owner) && state.children.length > 0)
			throw new Error("rpc child registry belongs to another host process");
		const children = state?.children ?? [];
		this.#write(this.#ownerNonce, this.#owner, [...children.filter(child => child.pid !== pid), identity]);
		return identity;
	}

	unregister(identity: RpcChildIdentity): void {
		const state = this.#read();
		if (!state || !sameIdentity(state.owner, this.#owner)) return;
		this.#write(
			state.ownerNonce,
			state.owner,
			state.children.filter(child => !sameIdentity(child, identity)),
		);
	}

	async reap(): Promise<{ readonly killed: readonly number[]; readonly skipped: readonly number[] }> {
		const state = this.#read();
		if (!state) return { killed: [], skipped: [] };
		const liveOwner = this.#inspect(state.owner.pid);
		if (liveOwner && sameIdentity(state.owner, liveOwner))
			return { killed: [], skipped: state.children.map(child => child.pid) };
		const killed: number[] = [];
		const skipped: number[] = [];
		const retained: RpcChildIdentity[] = [];
		for (const recorded of state.children) {
			const current = this.#inspect(recorded.pid);
			if (!current) continue;
			if (!sameIdentity(recorded, current) || current.pgid !== current.pid) {
				skipped.push(recorded.pid);
				retained.push(recorded);
				continue;
			}
			try {
				this.#killGroup(current.pgid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					skipped.push(recorded.pid);
					retained.push(recorded);
					continue;
				}
				killed.push(recorded.pid);
				continue;
			}
			const deadline = Date.now() + TERMINATION_GRACE_MS;
			let afterTerm = this.#inspect(recorded.pid);
			while (afterTerm && sameIdentity(recorded, afterTerm) && Date.now() < deadline) {
				await this.#wait(Math.min(TERMINATION_POLL_MS, Math.max(1, deadline - Date.now())));
				afterTerm = this.#inspect(recorded.pid);
			}
			if (!afterTerm) {
				killed.push(recorded.pid);
				continue;
			}
			if (!sameIdentity(recorded, afterTerm)) {
				skipped.push(recorded.pid);
				continue;
			}
			try {
				this.#killGroup(afterTerm.pgid, "SIGKILL");
				killed.push(recorded.pid);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") killed.push(recorded.pid);
				else {
					skipped.push(recorded.pid);
					retained.push(recorded);
				}
			}
		}
		this.#write(state.ownerNonce, state.owner, retained);
		return { killed, skipped };
	}

	#read(): RegistryState | undefined {
		let info;
		try {
			info = lstatSync(this.#path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600)
			throw new Error("rpc child registry is unsafe");
		const bytes = readFileSync(this.#path);
		if (bytes.byteLength > MAX_REGISTRY_BYTES) throw new Error("rpc child registry is oversized");
		let parsed: unknown;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("rpc child registry is malformed");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("rpc child registry is malformed");
		const record = parsed as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(",") !== "children,owner,ownerNonce,version" ||
			record.version !== REGISTRY_VERSION ||
			typeof record.ownerNonce !== "string" ||
			!/^[0-9a-f-]{36}$/u.test(record.ownerNonce) ||
			record.owner === undefined ||
			!Array.isArray(record.children) ||
			record.children.length > 256
		)
			throw new Error("rpc child registry is malformed");
		return {
			ownerNonce: record.ownerNonce,
			owner: decodeIdentity(record.owner),
			children: record.children.map(decodeIdentity),
		};
	}

	#write(ownerNonce: string, owner: RpcChildIdentity, children: readonly RpcChildIdentity[]): void {
		if (children.length === 0) {
			try {
				unlinkSync(this.#path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return;
		}
		mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
		const temporary = `${this.#path}.tmp-${process.pid}-${randomUUID()}`;
		const body: RegistryFile = { version: REGISTRY_VERSION, ownerNonce, owner, children };
		try {
			writeFileSync(temporary, `${JSON.stringify(body)}\n`, { flag: "wx", mode: 0o600 });
			renameSync(temporary, this.#path);
			chmodSync(this.#path, 0o600);
		} finally {
			try {
				unlinkSync(temporary);
			} catch {}
		}
	}
}
