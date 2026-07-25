import assert from "node:assert/strict";
import test from "node:test";

import { exactCiRuns, waitForExactCiSuccess } from "./wait-for-exact-ci.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function workflowRun(overrides = {}) {
  return {
    id: 101,
    run_attempt: 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: COMMIT,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/wolfiesch/omperator/actions/runs/101",
    ...overrides,
  };
}

function runList(runs) {
  return { total_count: runs.length, workflow_runs: runs };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("selects only completed-success canonical main push CI for the exact SHA", () => {
  const exact = workflowRun();
  const runs = exactCiRuns(
    runList([
      workflowRun({ id: 1, head_sha: "f".repeat(40) }),
      workflowRun({ id: 2, event: "workflow_dispatch" }),
      workflowRun({ id: 3, head_branch: "feature" }),
      workflowRun({ id: 4, path: ".github/workflows/not-ci.yml" }),
      workflowRun({ id: 5, name: "Not CI" }),
      exact,
    ]),
    COMMIT,
  );

  assert.deepEqual(exact, runs[0]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].conclusion, "success");
});

test("waits for the exact whole-workflow run to complete successfully", async () => {
  let requestCount = 0;
  let currentTime = 0;
  const states = [
    runList([]),
    runList([workflowRun({ status: "queued", conclusion: null })]),
    runList([workflowRun({ status: "in_progress", conclusion: null })]),
    runList([workflowRun({ run_attempt: 2 })]),
  ];

  const result = await waitForExactCiSuccess({
    commit: COMMIT,
    token: "test-token",
    fetchImpl: async (url, options) => {
      assert.match(
        url,
        new RegExp(`actions/workflows/ci\\.yml/runs\\?.*head_sha=${COMMIT}`, "u"),
      );
      assert.equal(options.headers.Authorization, "Bearer test-token");
      const state = states[Math.min(requestCount, states.length - 1)];
      requestCount += 1;
      return jsonResponse(state);
    },
    now: () => currentTime,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
    },
    pollIntervalMs: 5,
    timeoutMs: 50,
  });

  assert.deepEqual(result, {
    id: 101,
    runAttempt: 2,
    url: "https://github.com/wolfiesch/omperator/actions/runs/101",
  });
  assert.equal(requestCount, 4);
});

test("fails closed when every exact run is terminal without success", async () => {
  await assert.rejects(
    waitForExactCiSuccess({
      commit: COMMIT,
      token: "test-token",
      fetchImpl: async () =>
        jsonResponse(
          runList([
            workflowRun({ id: 201, conclusion: "failure" }),
            workflowRun({ id: 202, conclusion: "cancelled" }),
          ]),
        ),
      pollIntervalMs: 5,
      timeoutMs: 50,
    }),
    new RegExp(`Exact CI for ${COMMIT} completed without success`, "u"),
  );
});

test("does not accept a success-shaped run with the wrong authority identity", async () => {
  let currentTime = 0;
  await assert.rejects(
    waitForExactCiSuccess({
      commit: COMMIT,
      token: "test-token",
      fetchImpl: async () =>
        jsonResponse(
          runList([
            workflowRun({ id: 301, event: "pull_request" }),
            workflowRun({ id: 302, head_branch: "release" }),
            workflowRun({ id: 303, path: ".github/workflows/release.yml" }),
          ]),
        ),
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      pollIntervalMs: 5,
      timeoutMs: 10,
    }),
    new RegExp(`Exact CI for ${COMMIT} did not complete successfully`, "u"),
  );
});

test("rejects malformed, oversized, and incomplete exact workflow state", () => {
  assert.throws(() => exactCiRuns({ workflow_runs: [] }, COMMIT), /malformed/u);
  assert.throws(
    () => exactCiRuns({ total_count: 101, workflow_runs: [] }, COMMIT),
    /exceeded its bound/u,
  );
  assert.throws(
    () =>
      exactCiRuns(
        runList([workflowRun({ id: 0, status: "completed", conclusion: "success" })]),
        COMMIT,
      ),
    /malformed state/u,
  );
  assert.throws(
    () => exactCiRuns(runList([workflowRun({ conclusion: null })]), COMMIT),
    /malformed state/u,
  );
});
