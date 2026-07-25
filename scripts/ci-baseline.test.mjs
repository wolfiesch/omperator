import assert from "node:assert/strict";
import test from "node:test";

import { greenAncestorCandidates, selectBaseline } from "./ci-baseline.mjs";

const sha = (seed) => seed.repeat(40).slice(0, 40);
const HEAD = sha("a");

function run(overrides = {}) {
  return {
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_sha: sha("b"),
    run_number: 10,
    ...overrides,
  };
}

test("only completed successful main pushes can baseline a merge run", () => {
  const payload = {
    workflow_runs: [
      run({ head_sha: sha("b"), run_number: 10 }),
      run({ head_sha: sha("c"), run_number: 11, conclusion: "failure" }),
      run({ head_sha: sha("d"), run_number: 12, status: "in_progress", conclusion: null }),
      run({ head_sha: sha("e"), run_number: 13, event: "pull_request" }),
      run({ head_sha: sha("f"), run_number: 14, head_branch: "topic" }),
      run({ head_sha: sha("0"), run_number: 15, conclusion: "cancelled" }),
    ],
  };

  assert.deepEqual(greenAncestorCandidates(payload, HEAD), [sha("b")]);
});

test("a failed merge run keeps its own commits inside the next run's diff", () => {
  // The release waiter reads the run conclusion for an exact commit, so a
  // green docs-only run must never be able to inherit proof across a commit
  // whose own run failed.
  const failed = sha("c");
  const green = sha("b");
  const payload = {
    workflow_runs: [
      run({ head_sha: green, run_number: 10 }),
      run({ head_sha: failed, run_number: 11, conclusion: "failure" }),
    ],
  };

  const candidates = greenAncestorCandidates(payload, HEAD);
  assert.equal(candidates.includes(failed), false);
  assert.equal(selectBaseline({ candidates, isAncestor: () => true }), green);
});

test("a re-run of the head commit never baselines against itself", () => {
  const payload = { workflow_runs: [run({ head_sha: HEAD, run_number: 20 })] };

  assert.deepEqual(greenAncestorCandidates(payload, HEAD), []);
  assert.equal(
    selectBaseline({ candidates: greenAncestorCandidates(payload, HEAD), isAncestor: () => true }),
    null,
  );
});

test("the newest green ancestor wins and unreachable commits are skipped", () => {
  const payload = {
    workflow_runs: [
      run({ head_sha: sha("b"), run_number: 10 }),
      run({ head_sha: sha("c"), run_number: 30 }),
      run({ head_sha: sha("d"), run_number: 20 }),
    ],
  };

  const candidates = greenAncestorCandidates(payload, HEAD);
  assert.deepEqual(candidates, [sha("c"), sha("d"), sha("b")]);
  // A rewritten or force-pushed history leaves newer runs unreachable.
  assert.equal(
    selectBaseline({ candidates, isAncestor: (candidate) => candidate === sha("d") }),
    sha("d"),
  );
});

test("no reachable green run means the caller must widen to the full matrix", () => {
  const payload = { workflow_runs: [] };

  assert.equal(
    selectBaseline({ candidates: greenAncestorCandidates(payload, HEAD), isAncestor: () => true }),
    null,
  );
  assert.equal(
    selectBaseline({ candidates: [sha("b")], isAncestor: () => false }),
    null,
  );
});

test("malformed run payloads and commits fail closed", () => {
  assert.throws(() => greenAncestorCandidates({ workflow_runs: {} }, HEAD), /malformed/u);
  assert.throws(() => greenAncestorCandidates(null, HEAD), /malformed/u);
  assert.throws(
    () => greenAncestorCandidates({ workflow_runs: Array.from({ length: 101 }, () => run()) }, HEAD),
    /bound/u,
  );
  assert.throws(() => greenAncestorCandidates({ workflow_runs: [] }, "abc"), /40-character/u);
  assert.deepEqual(
    greenAncestorCandidates({ workflow_runs: [run({ head_sha: "not-a-sha" })] }, HEAD),
    [],
  );
  assert.deepEqual(
    greenAncestorCandidates({ workflow_runs: [run({ run_number: 0 })] }, HEAD),
    [],
  );
});
