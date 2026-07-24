import assert from "node:assert/strict";
import test from "node:test";

import { dispatchAndWaitForSiteDeployment } from "./dispatch-site-deployment.mjs";

const tag = "v0.1.17";
const commit = "a".repeat(40);
const controlCommit = "b".repeat(40);
const dispatchNonce = "11111111-1111-4111-8111-111111111111";

function run(id, overrides = {}) {
  return {
    id,
    name: `Deploy project site ${tag} ${dispatchNonce}`,
    path: ".github/workflows/deploy-site.yml",
    event: "workflow_dispatch",
    head_sha: controlCommit,
    head_branch: "main",
    display_title: `Deploy project site ${tag} ${dispatchNonce}`,
    status: "queued",
    conclusion: null,
    html_url: `https://github.com/LycaonLLC/t4-code/actions/runs/${id}`,
    ...overrides,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

test("dispatches the site workflow at the immutable tag and awaits its exact successful run", async () => {
  const requests = [];
  let listCount = 0;
  let runCount = 0;
  const result = await dispatchAndWaitForSiteDeployment({
    tag,
    commit,
    controlCommit,
    token: "test-token",
    dispatchNonce,
    pollIntervalMs: 1,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/actions/runs/22")) {
        runCount += 1;
        return json(run(22, runCount === 1 ? { status: "in_progress" } : {
          status: "completed",
          conclusion: "success",
        }));
      }
      listCount += 1;
      return json({ workflow_runs: listCount === 1 ? [run(11)] : [run(22), run(11)] });
    },
  });

  assert.equal(result.runId, 22);
  const dispatch = requests.find(({ url }) => url.endsWith("/dispatches"));
  assert.deepEqual(JSON.parse(dispatch.init.body), {
    ref: "main",
    inputs: {
      release_tag: tag,
      release_commit: commit,
      control_sha: controlCommit,
      dispatch_nonce: dispatchNonce,
    },
  });
});

test("fails the release when the exact site deployment run fails", async () => {
  let listCount = 0;
  await assert.rejects(
    dispatchAndWaitForSiteDeployment({
      tag,
      commit,
      controlCommit,
      token: "test-token",
      dispatchNonce,
      pollIntervalMs: 1,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
        if (url.includes("/actions/runs/22")) {
          return json(run(22, { status: "completed", conclusion: "failure" }));
        }
        listCount += 1;
        return json({ workflow_runs: listCount === 1 ? [] : [run(22)] });
      },
    }),
    /concluded failure/u,
  );
});

test("ignores mutable-main and independently dispatched runs at the release commit", async () => {
  let clock = 0;
  await assert.rejects(
    dispatchAndWaitForSiteDeployment({
      tag,
      commit,
      controlCommit,
      token: "test-token",
      dispatchNonce,
      pollIntervalMs: 1,
      creationTimeoutMs: 2,
      now: () => clock,
      sleep: async () => { clock += 1; },
      fetchImpl: async (url) => {
        if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
        return json({
          workflow_runs: [
            run(22, { head_branch: tag }),
            run(23, {
              display_title: `Deploy project site ${tag} 22222222-2222-4222-8222-222222222222`,
            }),
          ],
        });
      },
    }),
    /did not create an exact/u,
  );
});
