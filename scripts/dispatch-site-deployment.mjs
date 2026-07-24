import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const REPOSITORY = "LycaonLLC/t4-code";
const WORKFLOW = "deploy-site.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const CONTROL_BRANCH = "main";
const VERSION_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DISPATCH_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function apiHeaders(token, includeJson = false) {
  if (!token) throw new Error("GH_TOKEN is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "t4-code-site-deployment-dispatcher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function apiRequest(url, { token, fetchImpl, method = "GET", body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: apiHeaders(token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub ${method} request failed for ${url}`, { cause: error });
  }
  return response;
}

async function apiJson(url, options) {
  const response = await apiRequest(url, options);
  if (response.status !== 200) throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_API_RESPONSE_BYTES,
    label: "GitHub workflow response",
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub workflow response was not valid JSON");
  }
}

function exactRuns(payload, controlCommit, tag, dispatchNonce) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.workflow_runs)) {
    throw new Error("GitHub workflow run list was malformed");
  }
  return payload.workflow_runs.filter(
    (run) =>
      run &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      run.path === WORKFLOW_PATH &&
      run.event === "workflow_dispatch" &&
      run.head_sha === controlCommit &&
      run.head_branch === CONTROL_BRANCH &&
      run.display_title === `Deploy project site ${tag} ${dispatchNonce}`,
  );
}

export async function dispatchAndWaitForSiteDeployment({
  tag,
  commit,
  controlCommit,
  token,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = Date.now,
  pollIntervalMs = 5_000,
  creationTimeoutMs = 120_000,
  completionTimeoutMs = 55 * 60_000,
  dispatchNonce = randomUUID(),
}) {
  if (!VERSION_TAG_PATTERN.test(tag)) throw new Error("tag must be vX.Y.Z");
  if (!COMMIT_PATTERN.test(commit)) throw new Error("commit must be a lowercase 40-character SHA");
  if (!COMMIT_PATTERN.test(controlCommit)) {
    throw new Error("controlCommit must be a lowercase 40-character SHA");
  }
  if (!DISPATCH_NONCE_PATTERN.test(dispatchNonce)) throw new Error("dispatchNonce must be a UUIDv4");
  positiveInteger(pollIntervalMs, "pollIntervalMs");
  positiveInteger(creationTimeoutMs, "creationTimeoutMs");
  positiveInteger(completionTimeoutMs, "completionTimeoutMs");

  const workflowUrl = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;
  const runsUrl = `${workflowUrl}/runs?event=workflow_dispatch&head_sha=${controlCommit}&per_page=100`;
  const before = exactRuns(
    await apiJson(runsUrl, { token, fetchImpl }),
    controlCommit,
    tag,
    dispatchNonce,
  );
  const existingIds = new Set(before.map(({ id }) => id));

  const dispatch = await apiRequest(`${workflowUrl}/dispatches`, {
    token,
    fetchImpl,
    method: "POST",
    body: {
      ref: CONTROL_BRANCH,
      inputs: {
        release_tag: tag,
        release_commit: commit,
        control_sha: controlCommit,
        dispatch_nonce: dispatchNonce,
      },
    },
  });
  if (dispatch.status !== 204) {
    throw new Error(`GitHub workflow dispatch returned HTTP ${dispatch.status}`);
  }

  const creationDeadline = now() + creationTimeoutMs;
  let run;
  while (now() <= creationDeadline) {
    const runs = exactRuns(
      await apiJson(runsUrl, { token, fetchImpl }),
      controlCommit,
      tag,
      dispatchNonce,
    );
    run = runs.find(({ id }) => !existingIds.has(id));
    if (run) break;
    await sleep(pollIntervalMs);
  }
  if (!run) {
    throw new Error(`GitHub did not create an exact ${WORKFLOW} run for ${controlCommit}`);
  }

  const completionDeadline = now() + completionTimeoutMs;
  const runUrl = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${run.id}`;
  while (now() <= completionDeadline) {
    const current = await apiJson(runUrl, { token, fetchImpl });
    const exact = exactRuns({ workflow_runs: [current] }, controlCommit, tag, dispatchNonce)[0];
    if (!exact || exact.id !== run.id) throw new Error("GitHub site deployment run changed identity");
    if (exact.status === "completed") {
      if (exact.conclusion !== "success") {
        throw new Error(`Site deployment run ${exact.id} concluded ${exact.conclusion ?? "without a result"}`);
      }
      return { runId: exact.id, url: exact.html_url };
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Site deployment run ${run.id} did not complete before the timeout`);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--tag") options.tag = value;
    else if (flag === "--commit") options.commit = value;
    else if (flag === "--control-commit") options.controlCommit = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.tag || !options.commit || !options.controlCommit) {
    throw new Error(
      "usage: dispatch-site-deployment.mjs --tag vX.Y.Z --commit SHA --control-commit SHA",
    );
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await dispatchAndWaitForSiteDeployment({
      ...parseArguments(process.argv.slice(2)),
      token: process.env.GH_TOKEN?.trim() ?? "",
    });
    console.log(`Production site deployment ${result.runId} completed successfully: ${result.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
