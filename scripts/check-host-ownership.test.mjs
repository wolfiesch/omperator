import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function json(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("T4 owns the active host wire and generic host packages", () => {
  const release = json("package.json");
  const wire = json("packages/host-wire/package.json");
  const host = json("packages/host-service/package.json");
  const protocol = json("packages/protocol/package.json");

  assert.equal(wire.name, "@t4-code/host-wire");
  assert.equal(host.name, "@t4-code/host-service");
  assert.equal(wire.version, release.version);
  assert.equal(host.version, release.version);
  assert.equal(host.dependencies["@t4-code/host-wire"], "workspace:*");
  assert.equal(protocol.dependencies["@t4-code/host-wire"], "workspace:*");
  assert.equal(protocol.dependencies["@oh-my-pi/app-wire"], undefined);
});

test("planning documents describe the released T4-owned host boundary", () => {
  const brief = readFileSync(join(root, "PRODUCT_BRIEF.md"), "utf8");
  const ownership = readFileSync(join(root, "docs", "OWNERSHIP.md"), "utf8");

  assert.match(brief, /persistent T4 Host/u);
  assert.match(brief, /packages\/host-service/u);
  assert.doesNotMatch(brief, /persistent OMP appserver/u);
  assert.doesNotMatch(brief, /OMP `packages\/appserver`/u);
  assert.match(ownership, /packages\/host-wire/u);
  assert.match(ownership, /packages\/host-service/u);
  assert.match(brief, /shared OMP runtime adapter/u);
  assert.match(ownership, /reused by the local T4 Host and\s+future T4 Nodes/u);
  assert.doesNotMatch(ownership, /OMP `packages\/appserver`/u);
});

test("generic host source has no private OMP source-tree dependency", () => {
  const roots = [join(root, "packages", "host-wire"), join(root, "packages", "host-service")];
  const forbidden = ["@oh-my-pi/app-wire", "@oh-my-pi/appserver", "../../coding-agent", "../coding-agent"];
  const violations = roots.flatMap((directory) =>
    files(directory)
      .filter((path) => /\.(?:json|md|ts)$/u.test(path))
      .flatMap((path) => {
        const content = readFileSync(path, "utf8");
        return forbidden.filter((value) => content.includes(value)).map((value) => ({
          path: relative(root, path),
          value,
        }));
      }),
  );
  assert.deepEqual(violations, []);
});

test("compatibility metadata records the artifact-backed OMP bridge", () => {
  const matrix = json("compat/omp-app-matrix.json");
  const provenance = json("provenance/omp-host-migration.json");

  assert.deepEqual(matrix.t4Host.sourcePaths, [
    "packages/host-wire",
    "packages/host-service",
    "packages/host-daemon",
  ]);
  assert.equal(matrix.t4Host.runtimeAuthority, "omp");
  assert.equal(matrix.t4Host.deploymentState, "standalone-t4-host-thin-omp-bridge");
  assert.equal(matrix.t4Host.wireSchemaVersion, "0.7.0");
  assert.equal(matrix.t4Host.daemonPackage, "@t4-code/host-daemon");
  assert.equal(matrix.t4Host.daemonPackageVersion, "0.1.30");
  assert.equal(matrix.t4Host.authorityBridgeProtocol, "t4-omp-authority/1");
  assert.equal(matrix.verifiedRuntime.artifacts["darwin-arm64"].releaseCodeSignature, "adhoc");
  assert.equal(
    matrix.verifiedRuntime.artifacts["darwin-arm64"].distributionSigningBoundary,
    "t4-product-package",
  );
  assert.deepEqual(matrix.t4Host.migrationInputs, {
    repository: provenance.sourceRepository,
    baseCommit: provenance.inputs.t4codeBase,
    operationsCommit: provenance.inputs.operationsContinuity,
    artifactReviewCommit: provenance.inputs.artifactAndTurnReview,
    runtimeWorkspaceCommit: provenance.inputs.runtimeAndWorkspaceAdapters,
  });
});
