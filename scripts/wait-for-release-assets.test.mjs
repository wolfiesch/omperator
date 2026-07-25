import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseAssetUrls, waitForReleaseAssets } from "./wait-for-release-assets.mjs";

const quiet = { log() {} };

test("builds the five package, Linux updater, and checksum URLs for one release tag", () => {
  assert.deepEqual(
    releaseAssetUrls("0.1.17").map(({ filename }) => filename),
    [
      "T4-Code-0.1.17-android.apk",
      "T4-Code-0.1.17-linux-amd64.deb",
      "T4-Code-0.1.17-linux-x86_64.AppImage",
      "T4-Code-0.1.17-mac-arm64.dmg",
      "T4-Code-0.1.17-mac-arm64.zip",
      "latest-linux.yml",
      "SHA256SUMS.txt",
    ],
  );
});

test("passes only when every public release file returns HTTP 200", async () => {
  const result = await waitForReleaseAssets({
    version: "0.1.17",
    fetchImpl: async () => ({ status: 200 }),
    logger: quiet,
  });
  assert.equal(result.attempts, 1);
  assert.equal(result.assets.length, 7);
});

test("retries unavailable files and stays inside the configured timeout", async () => {
  let currentTime = 0;
  let calls = 0;
  const result = await waitForReleaseAssets({
    version: "0.1.17",
    timeoutMs: 100,
    intervalMs: 20,
    requestTimeoutMs: 5,
    now: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
    fetchImpl: async () => ({ status: ++calls > 5 ? 200 : 404 }),
    logger: quiet,
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.elapsedMs, 20);
});

test("fails closed at the timeout and reports filenames without response content", async () => {
  let currentTime = 0;
  await assert.rejects(
    waitForReleaseAssets({
      version: "0.1.17",
      timeoutMs: 40,
      intervalMs: 25,
      requestTimeoutMs: 5,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
      fetchImpl: async () => ({ status: 404, body: "private-response-body" }),
      logger: quiet,
    }),
    (error) => {
      assert.match(error.message, /Timed out after 40 ms/);
      assert.match(error.message, /SHA256SUMS\.txt/);
      assert.doesNotMatch(error.message, /private-response-body/);
      return true;
    },
  );
});

// `deploy-site.yml` confirms release assets from the trusted workflow checkout,
// before dependencies are installed. Importing anything that reaches a package
// in `node_modules` crashed that step whenever a release existed.
test("loads with no installed dependencies", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "release-assets-nodeps-"));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["release-assets.mjs", "wait-for-release-assets.mjs"]) {
      await copyFile(join(here, name), join(sandbox, name));
    }
    const probe = join(sandbox, "probe.mjs");
    await writeFile(
      probe,
      'import { releaseAssetUrls } from "./wait-for-release-assets.mjs";\n' +
        'process.stdout.write(String(releaseAssetUrls("1.2.3").length));\n',
    );
    const child = spawnSync(process.execPath, [probe], { cwd: sandbox, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "7");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
