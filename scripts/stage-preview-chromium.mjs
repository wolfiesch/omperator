#!/usr/bin/env node

// Pins and lazily stages a headless Chromium build for the host preview
// service. Mirrors scripts/stage-omp-runtime.mjs: a JSON manifest in compat/
// pins each platform artifact by name, byte size, and SHA-256 digest. The
// download runs on first use (from the preview service or the CLI), never at
// install time. Re-runs are no-ops when the staged executable already matches
// the pinned digest.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const manifestPath = join(repoRoot, "compat", "preview-chromium.json");

const option = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
};

const platform = option("platform") ?? process.platform;
const arch = option("arch") ?? process.arch;
const key = `${platform}-${arch}`;

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const artifact = manifest.artifacts?.[key];
if (
	!artifact ||
	!/^[a-z0-9][a-z0-9._-]{1,80}$/u.test(artifact.name) ||
	typeof artifact.path !== "string" ||
	!/^[a-z0-9][a-z0-9._/-]{1,128}$/u.test(artifact.path) ||
	!/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
	!Array.isArray(artifact.executable) ||
	artifact.executable.length === 0
) {
	throw new Error(`compat/preview-chromium.json has no valid ${key} artifact`);
}

const outputRoot = join(repoRoot, ".artifacts", "preview-chromium");
const extractRoot = join(outputRoot, key);
const executablePath = join(extractRoot, ...artifact.executable);
const url = `${manifest.sourceRepository}/${manifest.sourcePath}/${artifact.path}`;

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function executableReady() {
	try {
		const info = await stat(executablePath);
		return info.isFile() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

// Walk local file headers in the zip and inflate each stored entry. The
// headless-shell archives are flat (no central-directory-only metadata we
// need), so a single forward pass over local headers is sufficient and avoids
// a native unzip dependency.
async function extractZip(zipPath) {
	await mkdir(extractRoot, { recursive: true, mode: 0o700 });
	const buffer = await readFile(zipPath);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const text = (offset, length) => buffer.subarray(offset, offset + length).toString("latin1");
	let offset = 0;
	while (offset + 30 <= buffer.byteLength) {
		const signature = view.getUint32(offset, true);
		if (signature !== 0x04034b50) break; // local file header
		const compressionMethod = view.getUint16(offset + 8, true);
		const compressedSize = view.getUint32(offset + 18, true);
		const uncompressedSize = view.getUint32(offset + 22, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const name = text(offset + 30, nameLength);
		const dataOffset = offset + 30 + nameLength + extraLength;
		const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
		offset = dataOffset + compressedSize;
		if (name.endsWith("/")) continue;
		const target = join(extractRoot, name);
		const resolved = resolve(target);
		if (relativePath(extractRoot, resolved).startsWith(".."))
			throw new Error("zip entry escapes the extract root");
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		let bytes;
		if (compressionMethod === 0) bytes = data;
		else if (compressionMethod === 8) {
			const inflated = inflateRawSync(data, { maxOutputLength: uncompressedSize });
			if (inflated.length !== uncompressedSize)
				throw new Error(`uncompressed zip entry size mismatch for ${name}`);
			bytes = inflated;
		} else throw new Error(`unsupported zip compression method ${compressionMethod} for ${name}`);
		const isExecutable = name === artifact.executable.join("/");
		await writeFile(target, bytes, { mode: isExecutable ? 0o755 : 0o644 });
	}
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
if (!(await executableReady())) {
	const zipPath = join(outputRoot, artifact.name);
	let zipReady = false;
	try {
		const info = await stat(zipPath);
		zipReady = info.size === artifact.size && (await sha256(zipPath)) === artifact.sha256;
	} catch {}
	if (!zipReady) {
		const zipTemporary = `${zipPath}.partial-${process.pid}`;
		const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
		if (!response.ok || !response.body) throw new Error(`chromium download failed with HTTP ${response.status}`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(zipTemporary, { flags: "wx", mode: 0o600 }));
		const downloaded = await stat(zipTemporary);
		if (downloaded.size !== artifact.size || (await sha256(zipTemporary)) !== artifact.sha256) {
			await unlink(zipTemporary).catch(() => {});
			throw new Error("downloaded chromium archive does not match the pinned size and SHA-256 digest");
		}
		await rename(zipTemporary, zipPath);
	}
	await extractZip(zipPath);
	if (!(await executableReady()))
		throw new Error("extracted chromium executable is missing or not executable");
	await chmod(executablePath, 0o755).catch(() => {});
}

await writeFile(
	join(outputRoot, "manifest.json"),
	`${JSON.stringify(
		{
			version: 1,
			browserVersion: manifest.browserVersion,
			platform,
			arch,
			executable: artifact.executable.join("/"),
			size: artifact.size,
			sha256: artifact.sha256,
		},
		null,
		2,
	)}\n`,
	{ mode: 0o600 },
);
console.log(`staged preview chromium ${manifest.browserVersion} ${key}`);
