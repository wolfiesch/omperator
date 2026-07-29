import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PATH = "provenance/cmux-machine-provider-v1.json";
const FIXTURE_ROOT = "vendor/cmux-machine-provider-v1/fixtures";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const expected = Object.freeze({
  repository: "https://github.com/manaflow-ai/cmux",
  commit: "192e44428c16b98210c951ec4bd5a86bc7139014",
  cratePath: "cmux-tui/crates/cmux-tui-machine-protocol",
  crateGitTree: "983bee74116c7d5f5832a7695379c870cd41ef60",
  sourceTreeSha256: "ecf8ea6183275110d6270bd6d563d39eb3cecf7296a7c8e44e21f9ca6a46ca63",
  workspace: {
    path: "vendor/cmux-machine-provider-v1/upstream/cmux-tui/Cargo.toml",
    upstreamPath: "cmux-tui/Cargo.toml",
    gitBlob: "d94793ccf1b1dde3ce82b58a76f04b24bf1c840a",
    size: 2_247,
    sha256: "b16c08d406c87a312b2bcdcdb23f4eb01dd3614a5e891e4363576587fa8ec19c",
  },
  license: {
    path: "licenses/CMUX-UPSTREAM-LICENSE.txt",
    upstreamPath: "LICENSE",
    gitBlob: "d10fe411b3ae74c27d15742e3ccb723b232a4b4c",
    size: 36_050,
    sha256: "f306eceb0a2964828e2fc3315a2924d1a685f538d5b5d5f4b5bb17d4da2865ea",
  },
  generator: {
    source: {
      path: "scripts/cmux-machine-protocol-fixtures/src/main.rs",
      size: 11_441,
      sha256: "fb480a6ca5ab27e8ee1e77b7932e5bf5ed9278598ed822a9ff0ebd0309e05dd8",
    },
    cargoManifest: {
      path: "scripts/cmux-machine-protocol-fixtures/Cargo.toml",
      size: 234,
      sha256: "35e4e3a799bba6839c4c157b85ef887c44905a77d7341442d7f91b27443456c6",
    },
    cargoLock: {
      path: "scripts/cmux-machine-protocol-fixtures/Cargo.lock",
      size: 3_093,
      sha256: "001a795aa52d72806d92dcb0e9405d93283df83c835d8605be1445656123fd97",
    },
  },
  sourceFiles: [
    {
      path: "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/Cargo.toml",
      upstreamPath: "cmux-tui/crates/cmux-tui-machine-protocol/Cargo.toml",
      gitBlob: "afe2fe1e84f3209f8026e484b239f33965d04de7",
      size: 420,
      sha256: "9b57c40fc3d4a26c9ba4b3ef432e95c2bb9d6cf90b8ad2bad85e2c43ea80dd02",
    },
    {
      path: "vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs",
      upstreamPath: "cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs",
      gitBlob: "0ce9dc54a626890d95a2dce00219feced7f14c0f",
      size: 72_133,
      sha256: "63265fa12394d7bf0942421bdfdc835fbbc808ffa2c8a349362f47148b2644be",
    },
  ],
  fixturePaths: [
    "vendor/cmux-machine-provider-v1/fixtures/control/close-machine.request.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/close-machine.success.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/durable-notice.event.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/failure.response.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/hello.request.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/hello.success.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/negotiate-client-capabilities.request.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/negotiate-client-capabilities.success.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/open-machine.request.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/open-machine.success.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/snapshot.request.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/control/snapshot.success.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/stream/transport-handshake-accepted.ndjson",
    "vendor/cmux-machine-provider-v1/fixtures/stream/transport-handshake.ndjson",
  ],
});

function diagnostic(message) {
  return `${MANIFEST_PATH}: ${message}`;
}

function strictKeys(failures, label, value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(diagnostic(`${label} must be an object`));
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(diagnostic(`${label} keys must be exactly ${JSON.stringify(wanted)}`));
    return false;
  }
  return true;
}

function requireEqual(failures, label, actual, wanted) {
  if (actual !== wanted) failures.push(diagnostic(`${label} must be ${JSON.stringify(wanted)}`));
}

function requireRecordFields(failures, label, record, wanted) {
  for (const [key, value] of Object.entries(wanted)) {
    requireEqual(failures, `${label}.${key}`, record?.[key], value);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false;
  if (path.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  return !value.split("/").includes("..");
}

async function checkedFile(root, failures, record, label) {
  if (!strictKeys(failures, label, record, ["path", "sha256", "size"])) return;
  if (!safeRelativePath(record.path)) {
    failures.push(diagnostic(`${label}.path must be a normalized repository-relative path`));
    return;
  }
  if (!Number.isSafeInteger(record.size) || record.size <= 0) {
    failures.push(diagnostic(`${label}.size must be a positive safe integer`));
  }
  if (!SHA256.test(record.sha256 ?? "")) failures.push(diagnostic(`${label}.sha256 must be lowercase SHA-256`));
  try {
    const rootPath = await realpath(root);
    const targetPath = path.resolve(rootPath, record.path);
    const targetRealPath = await realpath(targetPath);
    if (targetRealPath !== rootPath && !targetRealPath.startsWith(`${rootPath}${path.sep}`)) {
      failures.push(diagnostic(`${label}.path must resolve inside the repository root`));
      return;
    }
    const stats = await lstat(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      failures.push(diagnostic(`${label}.path must be a regular non-symlink file`));
      return;
    }
    const bytes = await readFile(targetRealPath);
    requireEqual(failures, `${label}.size`, bytes.length, record.size);
    requireEqual(failures, `${label}.sha256`, sha256(bytes), record.sha256);
    return bytes;
  } catch (error) {
    failures.push(diagnostic(`${label}.path is unreadable: ${error.message}`));
  }
}

function canonicalDigest(records, pathField = "path") {
  const hash = createHash("sha256");
  for (const record of [...records].sort((left, right) => left[pathField].localeCompare(right[pathField]))) {
    hash.update(`${record[pathField]}\0${record.sha256}\0${record.size}\n`);
  }
  return hash.digest("hex");
}

async function actualFixturePaths(root) {
  const paths = [];
  for (const directory of ["control", "stream"]) {
    const entries = await readdir(path.join(root, FIXTURE_ROOT, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) throw new Error(`unexpected non-file fixture: ${directory}/${entry.name}`);
      paths.push(`${FIXTURE_ROOT}/${directory}/${entry.name}`);
    }
  }
  return paths.sort();
}

export async function checkCmuxMachineProtocol(root = process.cwd()) {
  const failures = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), "utf8"));
  } catch (error) {
    return { failures: [diagnostic(`cannot read valid JSON: ${error.message}`)] };
  }

  strictKeys(failures, "manifest", manifest, [
    "fixtures",
    "generator",
    "protocol",
    "repositoryLicenseEvidence",
    "schemaVersion",
    "source",
    "usage",
    "workspaceEvidence",
  ]);
  requireEqual(failures, "schemaVersion", manifest.schemaVersion, 1);

  if (strictKeys(failures, "protocol", manifest.protocol, ["muxHandoffProtocol", "name", "version"])) {
    requireEqual(failures, "protocol.name", manifest.protocol.name, "cmux.machine-provider");
    requireEqual(failures, "protocol.version", manifest.protocol.version, 1);
    requireEqual(failures, "protocol.muxHandoffProtocol", manifest.protocol.muxHandoffProtocol, 10);
  }

  const source = manifest.source;
  if (strictKeys(failures, "source", source, ["canonicalTreeSha256", "commit", "crateGitTree", "cratePath", "files", "repository"])) {
    requireEqual(failures, "source.repository", source.repository, expected.repository);
    requireEqual(failures, "source.commit", source.commit, expected.commit);
    requireEqual(failures, "source.cratePath", source.cratePath, expected.cratePath);
    requireEqual(failures, "source.crateGitTree", source.crateGitTree, expected.crateGitTree);
    if (!SHA1.test(source.commit ?? "") || !SHA1.test(source.crateGitTree ?? "")) {
      failures.push(diagnostic("source commit and crate tree must be full lowercase Git object IDs"));
    }
    if (!Array.isArray(source.files) || source.files.length !== expected.sourceFiles.length) {
      failures.push(diagnostic(`source.files must contain exactly ${expected.sourceFiles.length} entries`));
    } else {
      for (let index = 0; index < expected.sourceFiles.length; index += 1) {
        const record = source.files[index];
        const wanted = expected.sourceFiles[index];
        if (strictKeys(failures, `source.files[${index}]`, record, ["gitBlob", "path", "sha256", "size", "upstreamPath"])) {
          for (const key of ["gitBlob", "path", "sha256", "size", "upstreamPath"]) {
            requireEqual(failures, `source.files[${index}].${key}`, record[key], wanted[key]);
          }
          await checkedFile(root, failures, { path: record.path, sha256: record.sha256, size: record.size }, `source.files[${index}].content`);
        }
      }
      const digestRecords = source.files.map((record) => ({ path: record.upstreamPath, sha256: record.sha256, size: record.size }));
      requireEqual(failures, "source.canonicalTreeSha256", canonicalDigest(digestRecords), expected.sourceTreeSha256);
      requireEqual(failures, "source.canonicalTreeSha256", source.canonicalTreeSha256, expected.sourceTreeSha256);
    }
  }

  const workspace = manifest.workspaceEvidence;
  if (strictKeys(failures, "workspaceEvidence", workspace, ["crateDeclaredLicense", "edition", "gitBlob", "path", "rustVersion", "sha256", "size", "upstreamPath"])) {
    requireRecordFields(failures, "workspaceEvidence", workspace, expected.workspace);
    requireEqual(failures, "workspaceEvidence.rustVersion", workspace.rustVersion, "1.88");
    requireEqual(failures, "workspaceEvidence.edition", workspace.edition, "2024");
    requireEqual(failures, "workspaceEvidence.crateDeclaredLicense", workspace.crateDeclaredLicense, "MIT");
    await checkedFile(root, failures, { path: workspace.path, sha256: workspace.sha256, size: workspace.size }, "workspaceEvidence.content");
  }

  const license = manifest.repositoryLicenseEvidence;
  if (strictKeys(failures, "repositoryLicenseEvidence", license, ["gitBlob", "path", "repositoryDefault", "sha256", "size", "upstreamPath"])) {
    requireRecordFields(failures, "repositoryLicenseEvidence", license, expected.license);
    requireEqual(failures, "repositoryLicenseEvidence.repositoryDefault", license.repositoryDefault, "GPL-3.0-or-later");
    await checkedFile(root, failures, { path: license.path, sha256: license.sha256, size: license.size }, "repositoryLicenseEvidence.content");
  }

  const generator = manifest.generator;
  if (strictKeys(failures, "generator", generator, ["cargoLock", "cargoManifest", "path", "sha256", "size", "usesVerbatimUpstreamTypes"])) {
    requireEqual(failures, "generator.usesVerbatimUpstreamTypes", generator.usesVerbatimUpstreamTypes, true);
    requireRecordFields(failures, "generator", generator, expected.generator.source);
    requireRecordFields(failures, "generator.cargoManifest", generator.cargoManifest, expected.generator.cargoManifest);
    requireRecordFields(failures, "generator.cargoLock", generator.cargoLock, expected.generator.cargoLock);
    await checkedFile(root, failures, { path: generator.path, sha256: generator.sha256, size: generator.size }, "generator.source");
    await checkedFile(root, failures, generator.cargoManifest, "generator.cargoManifest");
    await checkedFile(root, failures, generator.cargoLock, "generator.cargoLock");
  }

  const fixtures = manifest.fixtures;
  if (strictKeys(failures, "fixtures", fixtures, ["canonicalCorpusSha256", "files", "format", "postHandshakeProtocol", "root"])) {
    requireEqual(failures, "fixtures.root", fixtures.root, FIXTURE_ROOT);
    requireEqual(failures, "fixtures.format", fixtures.format, "one-lf-terminated-json-frame-per-ndjson-file");
    requireEqual(failures, "fixtures.postHandshakeProtocol", fixtures.postHandshakeProtocol, "cmux-v10-opaque-jsonl");
    const paths = Array.isArray(fixtures.files) ? fixtures.files.map((record) => record.path).sort() : [];
    if (JSON.stringify(paths) !== JSON.stringify(expected.fixturePaths)) {
      failures.push(diagnostic("fixtures.files must be the exact generated fixture allowlist"));
    }
    try {
      const actual = await actualFixturePaths(root);
      if (JSON.stringify(actual) !== JSON.stringify(expected.fixturePaths)) {
        failures.push(diagnostic("fixture directory membership must match the exact generated allowlist"));
      }
    } catch (error) {
      failures.push(diagnostic(`cannot enumerate fixtures: ${error.message}`));
    }
    if (Array.isArray(fixtures.files)) {
      for (let index = 0; index < fixtures.files.length; index += 1) {
        const bytes = await checkedFile(root, failures, fixtures.files[index], `fixtures.files[${index}]`);
        if (bytes && (!bytes.subarray(0, -1).includes(0x0a) && bytes.at(-1) === 0x0a)) {
          try {
            JSON.parse(bytes.toString("utf8").trimEnd());
          } catch (error) {
            failures.push(diagnostic(`fixtures.files[${index}] is not one valid JSON frame: ${error.message}`));
          }
        } else if (bytes) {
          failures.push(diagnostic(`fixtures.files[${index}] must contain exactly one LF-terminated JSON frame`));
        }
      }
      requireEqual(failures, "fixtures.canonicalCorpusSha256", fixtures.canonicalCorpusSha256, canonicalDigest(fixtures.files));
    }
  }

  if (strictKeys(failures, "usage", manifest.usage, ["packagedInProduct", "toolingAndConformanceOnly"])) {
    requireEqual(failures, "usage.toolingAndConformanceOnly", manifest.usage.toolingAndConformanceOnly, true);
    requireEqual(failures, "usage.packagedInProduct", manifest.usage.packagedInProduct, false);
  }

  failures.sort((left, right) => left.localeCompare(right));
  return { failures };
}

export function formatCmuxMachineProtocolReport(result) {
  return `cmux machine-provider-v1 provenance: ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}.${
    result.failures.length ? `\n${result.failures.join("\n")}` : ""
  }`;
}

if (import.meta.main) {
  const result = await checkCmuxMachineProtocol(process.cwd());
  console.log(formatCmuxMachineProtocolReport(result));
  if (result.failures.length) process.exitCode = 1;
}
