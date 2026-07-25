import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SIGNED_RUNTIME_TEAM_ID = "WJLM3D3DK6";
const SIGNED_RUNTIME_CERTIFICATE = "Developer ID Application: Michael Schoenberger (WJLM3D3DK6)";
const SIGNED_RUNTIME_CERTIFICATE_AUTHORITY = "Developer ID Certification Authority";
const SIGNED_RUNTIME_CERTIFICATE_SHA256 =
  "753d2fce58b7f542c119c21e086943d5f56cc39b101fea11a6b734bcd1e022e3";

export interface BundledRuntimeManifest {
  readonly version: 1;
  readonly tag: string;
  readonly platform: "darwin";
  readonly arch: "arm64";
  readonly executable: "omp";
  readonly size: number;
  readonly sha256: string;
}

function decodeManifest(value: unknown): BundledRuntimeManifest {
  const record = value as Partial<BundledRuntimeManifest> | null;
  if (
    record?.version !== 1 ||
    record.platform !== "darwin" ||
    record.arch !== "arm64" ||
    record.executable !== "omp" ||
    typeof record.tag !== "string" ||
    !/^t4code-[0-9]+\.[0-9]+\.[0-9]+-appserver-[1-9][0-9]*$/u.test(record.tag) ||
    !Number.isSafeInteger(record.size) ||
    (record.size ?? 0) < 1 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256)
  ) throw new Error("bundled OMP runtime manifest is invalid");
  return record as BundledRuntimeManifest;
}

interface RuntimeIntegrity {
  readonly size: number;
  readonly sha256: string;
}

async function inspectIntegrity(path: string): Promise<RuntimeIntegrity> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: (await stat(path)).size, sha256: hash.digest("hex") };
}

async function matches(path: string, integrity: RuntimeIntegrity): Promise<boolean> {
  try {
    const actual = await inspectIntegrity(path);
    return actual.size === integrity.size && actual.sha256 === integrity.sha256;
  } catch {
    return false;
  }
}

async function verifySignedDeveloperIdRuntime(path: string): Promise<string> {
  const certificateDirectory = await mkdtemp(join(tmpdir(), "t4-runtime-certificate-"));
  const certificatePrefix = join(certificateDirectory, "certificate");
  try {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path], {
      maxBuffer: 1024 * 1024,
    });
    const display = await execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", `--extract-certificates=${certificatePrefix}`, path],
      { maxBuffer: 1024 * 1024 },
    );
    const output = `${display.stdout}\n${display.stderr}`;
    const leafCertificate = await readFile(`${certificatePrefix}0`);
    const certificateSha256 = createHash("sha256").update(leafCertificate).digest("hex");
    const cdHash = /^CDHash=([0-9a-f]+)$/imu.exec(output)?.[1];
    if (
      !output.includes("Identifier=omp") ||
      !output.includes(`TeamIdentifier=${SIGNED_RUNTIME_TEAM_ID}`) ||
      !output.includes(`Authority=${SIGNED_RUNTIME_CERTIFICATE}`) ||
      !output.includes(`Authority=${SIGNED_RUNTIME_CERTIFICATE_AUTHORITY}`) ||
      (!output.includes("flags=0x10000(runtime)") && !output.includes("Runtime Version=")) ||
      !output.includes("Timestamp=") ||
      !cdHash ||
      certificateSha256 !== SIGNED_RUNTIME_CERTIFICATE_SHA256
    ) throw new Error("signed bundled OMP runtime identity is invalid");
    return cdHash;
  } finally {
    await rm(certificateDirectory, { recursive: true, force: true });
  }
}

async function readSignedRuntimeCodeHash(path: string): Promise<string> {
  const display = await execFileAsync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", path],
    { maxBuffer: 1024 * 1024 },
  );
  const output = `${display.stdout}\n${display.stderr}`;
  const cdHash = /^CDHash=([0-9a-f]+)$/imu.exec(output)?.[1];
  if (!cdHash) throw new Error("bundled OMP runtime code identity is invalid");
  return cdHash;
}

export async function installBundledOmpRuntime(options: {
  readonly resourcesPath: string;
  readonly applicationSupportPath: string;
  readonly verifySignedRuntime?: (path: string) => Promise<string>;
}): Promise<string> {
  const sourceRoot = join(options.resourcesPath, "runtime");
  const manifest = decodeManifest(JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8")));
  const source = join(sourceRoot, manifest.executable);
  const destinationRoot = join(options.applicationSupportPath, "runtime", manifest.tag);
  const destination = join(destinationRoot, "omp");
  const verifySignedRuntime = options.verifySignedRuntime ?? verifySignedDeveloperIdRuntime;

  try {
    const destinationCdHash = await verifySignedRuntime(destination);
    const sourceCdHash = options.verifySignedRuntime
      ? await options.verifySignedRuntime(source)
      : await readSignedRuntimeCodeHash(source);
    if (destinationCdHash === sourceCdHash) {
      await chmod(destination, 0o755);
      return destination;
    }
  } catch {
    if (await matches(destination, manifest)) {
      await chmod(destination, 0o755);
      return destination;
    }
  }

  let sourceIntegrity: RuntimeIntegrity;
  try {
    sourceIntegrity = await inspectIntegrity(source);
    if (
      sourceIntegrity.size !== manifest.size ||
      sourceIntegrity.sha256 !== manifest.sha256
    ) {
      await verifySignedRuntime(source);
    }
  } catch {
    throw new Error("bundled OMP runtime failed its integrity check");
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const temporary = join(destinationRoot, `.omp-${randomUUID()}.partial`);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    if (!(await matches(temporary, sourceIntegrity))) {
      throw new Error("installed OMP runtime failed its integrity check");
    }
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}
