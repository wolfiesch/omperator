import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("keeps workspace dependency installation ahead of mutable source", async () => {
  const dockerfile = await readFile(resolve(repositoryRoot, "cluster/images/session-runtime/Dockerfile"), "utf8");
  const installOffset = dockerfile.indexOf("pnpm install --frozen-lockfile --ignore-scripts");
  const mutableSourceOffset = dockerfile.indexOf("COPY . /opt/t4");
  assert.notEqual(installOffset, -1);
  assert.notEqual(mutableSourceOffset, -1);
  assert(installOffset < mutableSourceOffset, "pnpm install must remain cacheable across ordinary source edits");

  for (const manifest of [
    "apps/desktop/package.json",
    "apps/mobile/package.json",
    "apps/site/package.json",
    "apps/web/package.json",
    "packages/client/package.json",
    "packages/cluster-server/package.json",
    "packages/cmux-runtime/package.json",
    "packages/fixture-server/package.json",
    "packages/host-daemon/package.json",
    "packages/host-service/package.json",
    "packages/host-wire/package.json",
    "packages/model-gateway/package.json",
    "packages/p1-07-scenario/package.json",
    "packages/portable-control-store/package.json",
    "packages/portable-core/package.json",
    "packages/portable-driver/package.json",
    "packages/protocol/package.json",
    "packages/provider-adapter/package.json",
    "packages/provider-engine/package.json",
    "packages/remote/package.json",
    "packages/service-manager/package.json",
    "packages/ssh-gateway/package.json",
    "packages/t4-api-client/package.json",
    "packages/t4-api-contract/package.json",
    "packages/t4-cli/package.json",
    "packages/ui/package.json",
  ]) {
    const manifestOffset = dockerfile.indexOf(`COPY ${manifest} ./${manifest}`);
    assert(manifestOffset >= 0 && manifestOffset < installOffset, `missing cache-stable copy for ${manifest}`);
  }
  assert.match(dockerfile, /id=t4-pnpm-store,target=\/root\/\.local\/share\/pnpm\/store,sharing=locked/u);
});

test("persists expensive OMP and cmux caches while bounding compiler jobs", async () => {
  const dockerfile = await readFile(resolve(repositoryRoot, "cluster/images/session-runtime/Dockerfile"), "utf8");
  const cmuxBuilder = await readFile(resolve(repositoryRoot, "scripts/build-pinned-cmux.mjs"), "utf8");
  assert.match(dockerfile, /id=t4-omp-bun-cache,target=\/root\/\.bun\/install\/cache,sharing=locked/u);
  assert.match(dockerfile, /id=t4-cmux-cargo-target,target=\/var\/cache\/t4-cmux-target,sharing=locked/u);
  assert.match(dockerfile, /CARGO_BUILD_JOBS=2/u);
  assert.match(cmuxBuilder, /T4_CMUX_CARGO_TARGET_DIR/u);
});

test("keeps generated local build products out of the Docker context", async () => {
  const dockerignore = await readFile(resolve(repositoryRoot, ".dockerignore"), "utf8");
  const ignored = new Set(dockerignore.split("\n").filter(Boolean));
  for (const generatedRoot of [
    ".artifacts",
    "apps/ios/.build",
    "**/dist",
    "**/dist-*",
    "apps/mobile/android/build",
  ]) {
    assert(ignored.has(generatedRoot), `Docker context still includes ${generatedRoot}`);
  }
});
