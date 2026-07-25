import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const REPOSITORY = "wolfiesch/omperator";
const WORKFLOW = "ci.yml";
const WORKFLOW_NAME = "CI";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const MAIN_BRANCH = "main";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LISTED_RUNS = 100;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function requireCommit(commit) {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("commit must be a lowercase 40-character SHA");
  }
  return commit;
}

function apiHeaders(token) {
  if (!token) throw new Error("GH_TOKEN is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "t4-code-release-ci-authority",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function apiJson(url, { token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: apiHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub CI request failed for ${url}`, { cause: error });
  }
  if (response.status !== 200) {
    throw new Error(`GitHub CI request returned HTTP ${response.status} for ${url}`);
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_API_RESPONSE_BYTES,
    label: "GitHub CI workflow response",
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub CI workflow response was not valid JSON");
  }
}

function validateExactRun(run) {
  if (
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    typeof run.status !== "string" ||
    run.status.length === 0 ||
    (run.status === "completed" && typeof run.conclusion !== "string")
  ) {
    throw new Error("GitHub returned malformed state for the exact CI run");
  }
  return run;
}

export function exactCiRuns(payload, commit) {
  requireCommit(commit);
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.workflow_runs) ||
    !Number.isSafeInteger(payload.total_count) ||
    payload.total_count < 0 ||
    payload.total_count > MAX_LISTED_RUNS ||
    payload.workflow_runs.length > MAX_LISTED_RUNS
  ) {
    throw new Error("GitHub CI workflow run list was malformed or exceeded its bound");
  }

  return payload.workflow_runs
    .filter(
      (run) =>
        run &&
        typeof run === "object" &&
        !Array.isArray(run) &&
        run.name === WORKFLOW_NAME &&
        run.path === WORKFLOW_PATH &&
        run.head_sha === commit &&
        run.event === "push" &&
        run.head_branch === MAIN_BRANCH,
    )
    .map(validateExactRun);
}

export async function waitForExactCiSuccess({
  commit,
  token,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = Date.now,
  pollIntervalMs = 5_000,
  timeoutMs = 45 * 60_000,
}) {
  requireCommit(commit);
  positiveInteger(pollIntervalMs, "pollIntervalMs");
  positiveInteger(timeoutMs, "timeoutMs");

  const workflowUrl = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;
  const runsUrl = `${workflowUrl}/runs?branch=${MAIN_BRANCH}&event=push&head_sha=${commit}&per_page=${MAX_LISTED_RUNS}`;
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    const runs = exactCiRuns(await apiJson(runsUrl, { token, fetchImpl }), commit);
    const successful = runs.find(
      ({ status, conclusion }) => status === "completed" && conclusion === "success",
    );
    if (successful) {
      return {
        id: successful.id,
        runAttempt: successful.run_attempt,
        url: successful.html_url,
      };
    }

    const active = runs.some(({ status }) => status !== "completed");
    if (runs.length > 0 && !active) {
      const conclusions = runs.map(({ id, conclusion }) => `${id}:${conclusion}`).join(", ");
      throw new Error(`Exact CI for ${commit} completed without success (${conclusions})`);
    }

    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  throw new Error(`Exact CI for ${commit} did not complete successfully before the timeout`);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--commit") options.commit = value;
    else if (flag === "--interval-ms") options.pollIntervalMs = Number(value);
    else if (flag === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.commit) {
    throw new Error("usage: wait-for-exact-ci.mjs --commit SHA [--timeout-ms N] [--interval-ms N]");
  }
  return options;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await waitForExactCiSuccess({
      ...parseArguments(process.argv.slice(2)),
      token: process.env.GH_TOKEN?.trim() ?? "",
    });
    console.log(
      `Exact main CI run ${result.id} attempt ${result.runAttempt} succeeded for the release source: ${result.url}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
