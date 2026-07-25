#!/usr/bin/env node

// Selects the commit a merge run should classify against.
//
// A merge run may only narrow its legs relative to a commit whose own run was
// green, because a green run is the proof that everything selected up to that
// commit passed. Diffing against the immediate parent would break that: if
// commit A fails its official OMP gate and commit B only touches docs, B would
// skip the gate, conclude green, and let `scripts/wait-for-exact-ci.mjs`
// publish a release containing A's unproven change.
//
// Diffing against the newest green ancestor closes that hole by induction. A
// failed or cancelled run is never a baseline, so its commits stay inside the
// next run's diff until some run actually proves them. When no green ancestor
// exists the caller must fall back to the full matrix.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const REPOSITORY = "wolfiesch/omperator";
const WORKFLOW = "ci.yml";
const MAIN_BRANCH = "main";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LISTED_RUNS = 100;

function requireCommit(commit) {
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    throw new Error("a baseline lookup needs an exact 40-character commit");
  }
  return commit;
}

export function greenAncestorCandidates(payload, headSha) {
  requireCommit(headSha);
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.workflow_runs) ||
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
        run.event === "push" &&
        run.head_branch === MAIN_BRANCH &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        typeof run.head_sha === "string" &&
        COMMIT_PATTERN.test(run.head_sha) &&
        // A re-run of the current commit would diff the commit against itself
        // and select nothing at all.
        run.head_sha !== headSha &&
        Number.isSafeInteger(run.run_number) &&
        run.run_number > 0,
    )
    .sort((left, right) => right.run_number - left.run_number)
    .map((run) => run.head_sha);
}

export function selectBaseline({ candidates, isAncestor }) {
  for (const candidate of candidates) {
    if (isAncestor(candidate)) return candidate;
  }
  return null;
}

function gitIsAncestor(candidate, headSha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidate, headSha], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function listRuns(token, fetchImpl) {
  if (!token) throw new Error("GH_TOKEN is required");
  const url =
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs` +
    `?branch=${MAIN_BRANCH}&event=push&status=success&per_page=${MAX_LISTED_RUNS}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "t4-code-ci-baseline",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error("GitHub CI baseline request failed", { cause: error });
  }
  if (response.status !== 200) {
    throw new Error(`GitHub CI baseline request returned HTTP ${response.status}`);
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_API_RESPONSE_BYTES,
    label: "GitHub CI baseline response",
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub CI baseline response was not valid JSON");
  }
}

export async function resolveBaseline({
  headSha,
  token,
  fetchImpl = fetch,
  isAncestor = (candidate) => gitIsAncestor(candidate, headSha),
}) {
  requireCommit(headSha);
  const candidates = greenAncestorCandidates(await listRuns(token, fetchImpl), headSha);
  return selectBaseline({ candidates, isAncestor });
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const headIndex = process.argv.indexOf("--head");
  const headSha = headIndex === -1 ? "" : process.argv[headIndex + 1];
  try {
    const baseline = await resolveBaseline({ headSha, token: process.env.GH_TOKEN });
    // An empty line is the documented "no green ancestor" signal; the caller
    // must widen to the full matrix rather than treat it as an empty diff.
    process.stdout.write(baseline ? `${baseline}\n` : "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.stdout.write("\n");
  }
}
