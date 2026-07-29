import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareIosCiCache } from "./prepare-ios-ci-cache.mjs";

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "omperator-ios-cache-"));
  const root = join(
    temporary,
    "Library",
    "Caches",
    "omperator-ci",
    "ios",
    "xcode-test",
  );
  mkdirSync(join(root, "derived-data"), { recursive: true });
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return { temporary, root };
}

test("rejects a cache root outside the project-owned cache boundary", () => {
  assert.throws(
    () => prepareIosCiCache("/tmp/derived-data"),
    /Library\/Caches\/omperator-ci\/ios/u,
  );
});

test("keeps a bounded cache when free space is healthy", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "derived-data", "cached"), "warm");
  const report = prepareIosCiCache(root, {
    maxBytes: 1024,
    minFreeBytes: 100,
    measureAvailableBytes: () => 1000,
  });
  assert.equal(report.resetReason, "none");
  assert.equal(readFileSync(join(root, "derived-data", "cached"), "utf8"), "warm");
});

test("resets only DerivedData when the cache exceeds its bound", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "derived-data", "oversized"), "too large");
  writeFileSync(join(root, "preserved"), "sibling");
  const report = prepareIosCiCache(root, {
    maxBytes: 1,
    minFreeBytes: 100,
    measureAvailableBytes: () => 1000,
  });
  assert.equal(report.resetReason, "size-limit");
  assert.equal(existsSync(join(root, "derived-data", "oversized")), false);
  assert.equal(readFileSync(join(root, "preserved"), "utf8"), "sibling");
});

test("prunes obsolete Xcode version roots", (t) => {
  const { temporary, root } = fixture(t);
  const obsolete = join(
    temporary,
    "Library",
    "Caches",
    "omperator-ci",
    "ios",
    "xcode-old",
  );
  mkdirSync(join(obsolete, "derived-data"), { recursive: true });
  writeFileSync(join(obsolete, "derived-data", "stale"), "stale");
  const report = prepareIosCiCache(root, {
    maxBytes: 1024,
    minFreeBytes: 100,
    measureAvailableBytes: () => 1000,
  });
  assert.deepEqual(report.prunedVersionRoots, ["xcode-old"]);
  assert.equal(existsSync(obsolete), false);
  assert.equal(existsSync(root), true);
});

test("fails before building when pruning cannot restore the free-space floor", (t) => {
  const { root } = fixture(t);
  assert.throws(
    () =>
      prepareIosCiCache(root, {
        minFreeBytes: 100,
        measureAvailableBytes: () => 50,
      }),
    /requires 1 GiB free after cache pruning/u,
  );
});
