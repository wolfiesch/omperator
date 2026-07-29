import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PreviewChromiumExecutable, PreviewChromiumResolver } from "./types.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const artifactsRoot = join(repoRoot, ".artifacts", "preview-chromium");

interface ChromiumManifest {
	readonly browserVersion: string;
	readonly artifacts: Readonly<Record<string, {
		readonly name: string;
		readonly path: string;
		readonly size: number;
		readonly sha256: string;
		readonly executable: readonly string[];
	}>>;
}

interface StagedManifest {
	readonly browserVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly executable: string;
}

function platformKey(): string {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
	if (!platform || !arch)
		throw new Error(`unsupported preview chromium platform: ${process.platform}-${process.arch}`);
	return `${platform}-${arch}`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolves the pinned headless Chromium executable. When the staged binary is
 * absent, it runs scripts/stage-preview-chromium.mjs to download and extract
 * it lazily. Re-runs are no-ops once the executable is present.
 */
export function createPreviewChromiumResolver(
	stagingScript = join(repoRoot, "scripts", "stage-preview-chromium.mjs"),
): PreviewChromiumResolver {
	return async (): Promise<PreviewChromiumExecutable> => {
		const manifestPath = join(repoRoot, "compat", "preview-chromium.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ChromiumManifest;
		const key = platformKey();
		const artifact = manifest.artifacts[key];
		if (!artifact) throw new Error(`no pinned preview chromium for ${key}`);
		const executablePath = join(artifactsRoot, key, ...artifact.executable);
		if (!(await fileExists(executablePath))) {
			await stageChromium(stagingScript);
			if (!(await fileExists(executablePath)))
				throw new Error("preview chromium staging did not produce an executable");
		}
		const staged = JSON.parse(
			await readFile(join(artifactsRoot, "manifest.json"), "utf8"),
		) as StagedManifest;
		return { path: executablePath, browserVersion: staged.browserVersion };
	};
}

function stageChromium(script: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("exit", code => {
		if (code === 0) resolve();
		else reject(new Error(`preview chromium staging failed: ${stderr.trim() || `exit ${code}`}`));
	});
	return promise;
}
