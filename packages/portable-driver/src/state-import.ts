import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface PortableStateImportSources {
  readonly omp?: string;
  readonly cmux?: string;
}

export interface PortableStateImportRequest {
  readonly importId: string;
  readonly destinationRoot: string;
  readonly sources: PortableStateImportSources;
}

export interface PortableStateImportResult {
  readonly importId: string;
  readonly state: "complete";
  readonly destination: string;
  readonly copiedFiles: number;
  readonly reusedFiles: number;
}

interface ImportManifest {
  readonly version: 1;
  readonly importId: string;
  readonly sources: PortableStateImportSources;
  readonly state: "copying" | "complete";
  readonly copiedFiles: number;
  readonly reusedFiles: number;
}

const IMPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANIFEST = "import.json";

function absolute(value: string, name: string): string {
  if (value.length < 1 || value.length > 3000 || resolve(value) !== value || !value.startsWith(sep)) throw new TypeError(`${name} must be a bounded absolute path`);
  return value;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !resolve(path).startsWith(sep);
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function sameFile(source: string, destination: string): Promise<boolean> {
  const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
  return sourceStat.isFile() && destinationStat.isFile() && sourceStat.size === destinationStat.size
    && await digest(source) === await digest(destination);
}

async function writeManifest(path: string, manifest: ImportManifest): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

function parseManifest(raw: string, expectedId: string, expectedSources: PortableStateImportSources): ImportManifest {
  const value = JSON.parse(raw) as Partial<ImportManifest>;
  if (value.version !== 1 || value.importId !== expectedId || value.state !== "copying" || JSON.stringify(value.sources) !== JSON.stringify(expectedSources))
    throw new Error("partial import does not match the requested immutable sources");
  return value as ImportManifest;
}

async function copyTree(source: string, destination: string, counts: { copied: number; reused: number }): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`import source must be a directory without indirection: ${source}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") throw new Error("invalid import entry");
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, counts);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported state entry: ${from}`);
    try {
      await copyFile(from, to, 1);
      counts.copied += 1;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || !await sameFile(from, to)) throw cause;
      counts.reused += 1;
    }
  }
}

/**
 * Copies existing OMP/cmux state into an import-owned staging directory. A
 * failure leaves the staging directory resumable; callers may explicitly
 * discard it with discardPortableStateImport. Source paths are never opened
 * for writing and are never renamed.
 */
export async function importPortableState(request: PortableStateImportRequest): Promise<PortableStateImportResult> {
  if (!IMPORT_ID.test(request.importId)) throw new TypeError("import id is invalid");
  const destinationRoot = absolute(request.destinationRoot, "destination root");
  const sources = Object.freeze({
    ...(request.sources.omp === undefined ? {} : { omp: absolute(request.sources.omp, "OMP source") }),
    ...(request.sources.cmux === undefined ? {} : { cmux: absolute(request.sources.cmux, "cmux source") }),
  });
  if (sources.omp === undefined && sources.cmux === undefined) throw new TypeError("at least one state source is required");
  for (const source of Object.values(sources)) if (within(source, destinationRoot) || within(destinationRoot, source)) throw new TypeError("import source and destination must not contain one another");

  const importsRoot = join(destinationRoot, "imports");
  const staging = join(importsRoot, `${request.importId}.partial`);
  const complete = join(importsRoot, request.importId);
  const manifestPath = join(staging, MANIFEST);
  await mkdir(importsRoot, { recursive: true, mode: 0o700 });
  try {
    const finalManifest = JSON.parse(await readFile(join(complete, MANIFEST), "utf8")) as ImportManifest;
    if (finalManifest.state !== "complete" || JSON.stringify(finalManifest.sources) !== JSON.stringify(sources)) throw new Error("completed import id belongs to different sources");
    return { importId: request.importId, state: "complete", destination: complete, copiedFiles: finalManifest.copiedFiles, reusedFiles: finalManifest.reusedFiles };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  let manifest: ImportManifest;
  try {
    manifest = parseManifest(await readFile(manifestPath, "utf8"), request.importId, sources);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await mkdir(staging, { recursive: false, mode: 0o700 });
    manifest = { version: 1, importId: request.importId, sources, state: "copying", copiedFiles: 0, reusedFiles: 0 };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  const counts = { copied: manifest.copiedFiles, reused: manifest.reusedFiles };
  if (sources.omp !== undefined) await copyTree(sources.omp, join(staging, "omp"), counts);
  if (sources.cmux !== undefined) await copyTree(sources.cmux, join(staging, "cmux"), counts);
  const completed: ImportManifest = { ...manifest, state: "complete", copiedFiles: counts.copied, reusedFiles: counts.reused };
  await writeManifest(manifestPath, completed);
  await rename(staging, complete);
  return { importId: request.importId, state: "complete", destination: complete, copiedFiles: counts.copied, reusedFiles: counts.reused };
}

export async function discardPortableStateImport(destinationRootValue: string, importId: string): Promise<void> {
  if (!IMPORT_ID.test(importId)) throw new TypeError("import id is invalid");
  const destinationRoot = absolute(destinationRootValue, "destination root");
  const partial = join(destinationRoot, "imports", `${importId}.partial`);
  if (!within(destinationRoot, partial)) throw new TypeError("partial import path escapes destination root");
  await rm(partial, { recursive: true, force: true });
}
