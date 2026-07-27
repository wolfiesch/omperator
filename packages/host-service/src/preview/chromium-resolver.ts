import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import manifestJson from "../../../../compat/preview-chromium.json" with { type: "json" };
import type { PreviewChromiumExecutable, PreviewChromiumResolver } from "./types.ts";

interface ChromiumArtifact {
	readonly name: string;
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
	readonly executable: readonly string[];
}

interface ChromiumManifest {
	readonly browserVersion: string;
	readonly sourceRepository: string;
	readonly sourcePath: string;
	readonly artifacts: Readonly<Record<string, ChromiumArtifact>>;
}

export interface PreviewChromiumResolverOptions {
	/** Persistent staging directory. Defaults to the user's Omperator cache. */
	readonly artifactsRoot?: string;
	/** Test seam for a pinned manifest. */
	readonly manifest?: ChromiumManifest;
}

const defaultArtifactsRoot = join(
	process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
	"omperator",
	"preview-chromium",
);

function platformKey(): string {
	const platform =
		process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
	if (!platform || !arch)
		throw new Error(`unsupported preview chromium platform: ${process.platform}-${process.arch}`);
	return `${platform}-${arch}`;
}

function validArtifact(artifact: ChromiumArtifact | undefined): artifact is ChromiumArtifact {
	return Boolean(
		artifact &&
			/^[a-z0-9][a-z0-9._-]{1,80}$/u.test(artifact.name) &&
			/^[a-z0-9][a-z0-9._/-]{1,128}$/u.test(artifact.path) &&
			Number.isSafeInteger(artifact.size) &&
			artifact.size > 0 &&
			/^[0-9a-f]{64}$/u.test(artifact.sha256) &&
			Array.isArray(artifact.executable) &&
			artifact.executable.length > 0 &&
			artifact.executable.every(part => /^[a-z0-9][a-z0-9._-]{0,80}$/iu.test(part)),
	);
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function executableReady(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isFile() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

async function extractZip(
	zipPath: string,
	extractRoot: string,
	executable: readonly string[],
): Promise<void> {
	await mkdir(extractRoot, { recursive: true, mode: 0o700 });
	const buffer = await readFile(zipPath);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	let offset = 0;
	while (offset + 30 <= buffer.byteLength) {
		if (view.getUint32(offset, true) !== 0x04034b50) break;
		const compressionMethod = view.getUint16(offset + 8, true);
		const compressedSize = view.getUint32(offset + 18, true);
		const uncompressedSize = view.getUint32(offset + 22, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const name = buffer
			.subarray(offset + 30, offset + 30 + nameLength)
			.toString("latin1");
		const dataOffset = offset + 30 + nameLength + extraLength;
		const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
		offset = dataOffset + compressedSize;
		if (name.endsWith("/")) continue;
		const target = join(extractRoot, name);
		const resolved = resolve(target);
		const child = relative(extractRoot, resolved);
		if (child === "" || child.startsWith("..") || child.startsWith("/"))
			throw new Error("zip entry escapes the extract root");
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		let bytes: Uint8Array;
		if (compressionMethod === 0) bytes = data;
		else if (compressionMethod === 8) {
			const inflated = inflateRawSync(data, { maxOutputLength: uncompressedSize });
			if (inflated.length !== uncompressedSize)
				throw new Error(`uncompressed zip entry size mismatch for ${name}`);
			bytes = inflated;
		} else {
			throw new Error(`unsupported zip compression method ${compressionMethod} for ${name}`);
		}
		await writeFile(target, bytes, {
			mode: name === executable.join("/") ? 0o755 : 0o644,
		});
	}
}

async function stageChromium(
	manifest: ChromiumManifest,
	artifact: ChromiumArtifact,
	key: string,
	artifactsRoot: string,
): Promise<string> {
	const extractRoot = join(artifactsRoot, key);
	const executablePath = join(extractRoot, ...artifact.executable);
	await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
	if (!(await executableReady(executablePath))) {
		const zipPath = join(artifactsRoot, artifact.name);
		let zipReady = false;
		try {
			const info = await stat(zipPath);
			zipReady = info.size === artifact.size && (await sha256(zipPath)) === artifact.sha256;
		} catch {}
		if (!zipReady) {
			const temporary = `${zipPath}.partial-${process.pid}`;
			const url = `${manifest.sourceRepository}/${manifest.sourcePath}/${artifact.path}`;
			const response = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(180_000),
			});
			if (!response.ok || !response.body)
				throw new Error(`chromium download failed with HTTP ${response.status}`);
			try {
				await pipeline(
					Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
					createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
				);
				const downloaded = await stat(temporary);
				if (
					downloaded.size !== artifact.size ||
					(await sha256(temporary)) !== artifact.sha256
				)
					throw new Error(
						"downloaded chromium archive does not match the pinned size and SHA-256 digest",
					);
				await rename(temporary, zipPath);
			} catch (error) {
				await unlink(temporary).catch(() => undefined);
				throw error;
			}
		}
		await extractZip(zipPath, extractRoot, artifact.executable);
		if (!(await executableReady(executablePath)))
			throw new Error("extracted chromium executable is missing or not executable");
		await chmod(executablePath, 0o755).catch(() => undefined);
	}
	await writeFile(
		join(artifactsRoot, "manifest.json"),
		`${JSON.stringify(
			{
				version: 1,
				browserVersion: manifest.browserVersion,
				platform: process.platform,
				arch: process.arch,
				executable: artifact.executable.join("/"),
				size: artifact.size,
				sha256: artifact.sha256,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	return executablePath;
}

/**
 * Resolves and lazily stages the pinned headless Chromium build. All staging
 * logic and manifest data are compiled into t4-host, so packaged execution
 * does not depend on a JavaScript runtime or repository files.
 */
export function createPreviewChromiumResolver(
	options: PreviewChromiumResolverOptions = {},
): PreviewChromiumResolver {
	const manifest = options.manifest ?? (manifestJson as ChromiumManifest);
	const artifactsRoot = options.artifactsRoot ?? defaultArtifactsRoot;
	return async (): Promise<PreviewChromiumExecutable> => {
		const key = platformKey();
		const artifact = manifest.artifacts[key];
		if (!validArtifact(artifact)) throw new Error(`no valid pinned preview chromium for ${key}`);
		const path = await stageChromium(manifest, artifact, key, artifactsRoot);
		return { path, browserVersion: manifest.browserVersion };
	};
}
