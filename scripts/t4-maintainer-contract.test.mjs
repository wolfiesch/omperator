import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { makeCanonicalTemporaryDirectory } from "./test-temporary-directory.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const maintainerRoot = resolve(repoRoot, "ops/t4-maintainer");
const bashPath = "/bin/bash";

async function source(name) {
  return readFile(resolve(maintainerRoot, name), "utf8");
}

function assertOrdered(text, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = text.indexOf(fragment, previous + 1);
    assert.notEqual(current, -1, `missing contract fragment: ${fragment}`);
    assert.ok(current > previous, `contract fragment is out of order: ${fragment}`);
    previous = current;
  }
}

function shellFunction(text, name) {
  const marker = `${name}() {`;
  let start = text.indexOf(marker);
  while (start > 0 && text[start - 1] !== "\n") {
    start = text.indexOf(marker, start + marker.length);
  }
  assert.notEqual(start, -1, `missing shell function: ${name}`);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated shell function: ${name}`);
  return text.slice(start, end + 3);
}

function assertIncludesAll(text, fragments, context) {
  for (const fragment of fragments) {
    assert.ok(text.includes(fragment), `${context} is missing: ${fragment}`);
  }
}

test("maintainer shell entrypoints remain syntactically valid", async () => {
  for (const name of [
    "deploy-local.sh",
    "publish-omp-atomic.sh",
    "install.sh",
    "run.sh",
    "validate.sh",
  ]) {
    const path = resolve(maintainerRoot, name);
    const result = spawnSync(bashPath, ["-n", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("runner preflights the configured date helper before creating state", async () => {
  const scratch = await makeCanonicalTemporaryDirectory("t4-maintainer-date-");
  const stateRoot = join(scratch, "state");
  const missingDate = join(scratch, "missing-date");
  await mkdir(stateRoot, { mode: 0o700 });
  try {
    const result = spawnSync(bashPath, [resolve(maintainerRoot, "run.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        T4_MAINTAINER_DATE: missingDate,
        T4_MAINTAINER_ROOT: stateRoot,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`required command is unavailable: ${missingDate}`, "u"));
    await assert.rejects(access(join(stateRoot, "state")));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("runner preflights the Linux Sol privilege runner before creating state", async () => {
  const scratch = await makeCanonicalTemporaryDirectory("t4-maintainer-setpriv-");
  const stateRoot = join(scratch, "maintainer");
  const bin = join(scratch, "bin");
  const realpath = join(bin, "realpath");
  const uname = join(stateRoot, "uname");
  const missingSetpriv = join(stateRoot, "missing-setpriv");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  for (const command of [
    "curl",
    "dpkg",
    "dpkg-query",
    "flock",
    "gh",
    "git",
    "jq",
    "sha256sum",
    "systemctl",
  ]) {
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  await writeFile(
    realpath,
    `#!/bin/sh
[ "\${1:-}" = "-e" ] && shift
[ "\${1:-}" = "--" ] && shift
exec "$T4_TEST_NODE" -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync.native(process.argv[1])+"\\n")' "$1"
`,
    { mode: 0o700 },
  );
  await writeFile(uname, "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o700 });
  try {
    const result = spawnSync(bashPath, [resolve(maintainerRoot, "run.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        T4_TEST_NODE: process.execPath,
        T4_MAINTAINER_TEST_MODE: "1",
        T4_MAINTAINER_ROOT: stateRoot,
        T4_MAINTAINER_UNAME: uname,
        T4_MAINTAINER_OMP: bashPath,
        T4_MAINTAINER_NODE: process.execPath,
        T4_MAINTAINER_SETPRIV: missingSetpriv,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test privilege runner must exist and be canonical/u);
    await assert.rejects(access(join(stateRoot, "state")));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("direct deployer preflights every configured command used during cutover", async () => {
  const deployer = await source("deploy-local.sh");
  assert.match(
    deployer,
    /for command in[\s\S]*"\$DPKG_QUERY" "\$DPKG" "\$DPKG_DEB" "\$SHA256SUM" "\$SYSTEMCTL" "\$INSTALL" "\$SYNC"[\s\S]*require_command "\$command"/u,
  );
});

test("runner warns when delivered blocker dedupe state cannot be persisted", async () => {
  const runner = await source("run.sh");
  assert.match(
    runner,
    /Hermes delivery succeeded but notification dedupe state could not be persisted/u,
  );
});

test("installer and validator ship every deterministic verification helper", async () => {
  const [installer, validator] = await Promise.all([source("install.sh"), source("validate.sh")]);
  assert.match(
    installer,
    /install -m 0700 "\$SCRIPT_DIR\/deploy-local\.sh" "\$MAINTAINER_ROOT\/libexec\/deploy-local\.sh"/u,
  );
  assert.match(
    installer,
    /install -m 0700 "\$SCRIPT_DIR\/publish-omp-atomic\.sh" "\$MAINTAINER_ROOT\/libexec\/publish-omp-atomic\.sh"/u,
  );
  assert.match(
    installer,
    /install -m 0600 "\$SCRIPT_DIR\/\.\.\/\.\.\/scripts\/inspect-linux-update\.mjs"/u,
  );
  assert.match(
    validator,
    /for file in run\.sh deploy-local\.sh publish-omp-atomic\.sh install\.sh validate\.sh/u,
  );
  assert.match(
    validator,
    /install -m 0700 "\$SCRIPT_DIR\/deploy-local\.sh" "\$runtime_root\/libexec\/deploy-local\.sh"/u,
  );
  assert.match(
    validator,
    /install -m 0700 "\$SCRIPT_DIR\/publish-omp-atomic\.sh" "\$runtime_root\/libexec\/publish-omp-atomic\.sh"/u,
  );
  assert.match(
    validator,
    /install -m 0600 "\$SCRIPT_DIR\/\.\.\/\.\.\/scripts\/inspect-linux-update\.mjs"/u,
  );
  assert.match(installer, /--stage-only/u);
  assert.ok(installer.indexOf("systemctl --user daemon-reload") < installer.indexOf("stage_only == true"));
  const runner = await source("run.sh");
  assert.match(runner, /NOTIFY_SECRET_FILE=\$\{T4_MAINTAINER_HERMES_SECRET_FILE:-"\$MAINTAINER_ROOT\/secrets\/hermes-webhook\.secret"\}/u);
  assert.match(runner, /publication_gate \|\| \{\s+local gate_status=\$\?/u);
  assert.match(runner, /--profile t4-maintainer[\s\S]*--model openai-codex\/gpt-5\.6-sol[\s\S]*--thinking max[\s\S]*--approval-mode yolo/u);
});

test("reinstall waits for the active maintainer lock before replacing its bundle", async (t) => {
  if (spawnSync("flock", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
    t.skip("flock semantics are verified on Linux");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "t4-maintainer-install-lock-"));
  const home = join(root, "home");
  const maintainer = join(root, "maintainer");
  const state = join(maintainer, "state");
  const libexec = join(maintainer, "libexec");
  const bin = join(root, "bin");
  const token = join(root, "broker.token");
  const lock = join(state, "maintainer.lock");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(state, { recursive: true });
  await mkdir(libexec, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(libexec, "run.sh"), "old-run\n");
  await writeFile(token, "test-token\n", { mode: 0o600 });
  for (const command of [
    "apt-get",
    "bun",
    "dpkg",
    "dpkg-deb",
    "dpkg-query",
    "gh",
    "omp",
    "realpath",
    "sha256sum",
    "sudo",
    "systemctl",
    "systemd-analyze",
  ]) {
    const commandPath = join(bin, command);
    await writeFile(commandPath, "#!/usr/bin/env bash\nexit 1\n");
    await chmod(commandPath, 0o700);
  }
  await writeFile(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(bin, "systemctl"), 0o700);
  await writeFile(join(bin, "systemd-analyze"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(bin, "systemd-analyze"), 0o700);

  const holder = spawn(
    bashPath,
    ["-c", 'exec 8>"$1"; flock 8; printf "ready\\n"; read -r _', "holder", lock],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("lock holder did not start")), 5_000);
    holder.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      assert.match(chunk.toString(), /ready/u);
      resolveReady();
    });
  });

  let stderr = "";
  const installer = spawn(bashPath, [resolve(maintainerRoot, "install.sh")], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      PATH: `${bin}:${process.env.PATH}`,
      T4_MAINTAINER_ROOT: maintainer,
      OMP_AUTH_BROKER_URL: "https://broker.invalid",
      OMP_AUTH_BROKER_TOKEN_FILE: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  installer.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.equal(await readFile(join(libexec, "run.sh"), "utf8"), "old-run\n");

  holder.stdin.end("release\n");
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      installer.kill("SIGKILL");
      rejectExit(new Error(`installer timed out: ${stderr}`));
    }, 15_000);
    installer.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(await readFile(join(libexec, "run.sh"), "utf8"), /^#!\/usr\/bin\/env bash/u);
});

test("timer polls every two hours and catches up after downtime", async () => {
  const timer = await source("t4-omp-maintainer.timer");
  assert.match(timer, /^OnCalendar=\*-\*-\* 00\/2:17:00$/mu);
  assert.match(timer, /^Persistent=true$/mu);
  assert.match(timer, /^RandomizedDelaySec=5min$/mu);
  assert.match(timer, /^Unit=t4-omp-maintainer\.service$/mu);
});

test("service preserves the unrestricted host execution contract", async () => {
  const service = await source("t4-omp-maintainer.service.in");
  assert.match(service, /^Type=oneshot$/mu);
  for (const directive of [
    "TimeoutStartSec=infinity",
    "TimeoutStopSec=infinity",
    "RuntimeMaxSec=infinity",
    "TasksMax=infinity",
    "MemoryMax=infinity",
  ]) {
    assert.match(service, new RegExp(`^${directive}$`, "mu"));
  }
  assert.match(service, /^ExecStart=@MAINTAINER_ROOT@\/libexec\/run\.sh$/mu);
  assert.doesNotMatch(
    service,
    /^(?:PrivateUsers|ProtectSystem|ProtectHome|NoNewPrivileges|RestrictNamespaces)=/mu,
  );
});

test("runner gives Sol the requested model, tools, and release ownership", async () => {
  const [runner, prompt] = await Promise.all([source("run.sh"), source("prompt.md")]);
  assert.match(runner, /--model openai-codex\/gpt-5\.6-sol/u);
  assert.match(runner, /--thinking max/u);
  assert.match(runner, /--approval-mode yolo/u);
  assert.match(runner, /"\$SETPRIV" --no-new-privs -- "\$OMP"/u);
  assert.doesNotMatch(runner, /--no-tools|--tools=|--no-pty|\bbwrap\b/u);
  for (const responsibility of [
    "`wolfiesch/oh-my-pi` fork",
    "wrapper has already synchronized",
    "merge the exact official `vX.Y.Z` base into the durable `t4code/main` product branch",
    "reachable from `t4code/main`",
    "Use `$T4_ATOMIC_PUBLISH_HELPER` as the only OMP publication path",
    "atomic three-ref transaction",
    "Complete every OMP publication through that single helper invocation",
    "carry forward every capability T4 needs",
    "complete release gate",
    "Verify the public GitHub release",
    "deterministic wrapper will install the verified compatibility pair",
    "`$T4_MAINTENANCE_DEFERRAL_FILE`",
    "`t4-main-changed`",
    "`release-critical-pr`",
    "`classification-incomplete`",
    "Never use `sudo`",
    "never install, remove, upgrade, or downgrade a host package",
    "The deterministic wrapper and `deploy-local.sh` alone own host mutation",
    "Reuse the highest existing revision only when all of those facts exactly match",
  ]) {
    assert.ok(prompt.includes(responsibility), `maintainer prompt is missing: ${responsibility}`);
  }
});

test("public verification requires exact GitHub provenance despite admin bypass capability", async () => {
  const runner = await source("run.sh");
  const publicVerification = shellFunction(runner, "verify_result_once");
  assertIncludesAll(
    publicVerification,
    [
      'integration_descends_from_upstream "$upstream_commit" "$integration_commit"',
      'integration_is_reachable_from_product_branch "$integration_commit"',
      'resolve_public_tag_object "$OMP_UPSTREAM_REPOSITORY" "$upstream_tag"',
      'resolve_public_tag_object "$OMP_INTEGRATION_REPOSITORY" "$upstream_tag"',
      'resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" "$upstream_tag"',
      't4_commit_is_reachable_from_main "$t4_commit"',
      'tagged_t4_metadata_matches "$result_file"',
      'publication_workflows_succeeded "$t4_commit" "$t4_tag"',
      'omp_publication_workflow_succeeded "$integration_commit"',
      'verify_omp_release_assets "$result_file" "$omp_release_json" "$integration_tag"',
      'release_assets_are_public "$release_json" "$t4_version"',
      'site_release_manifest_matches "$release_json" "$t4_version"',
      'verify_live_linux_update "$result_file" "$release_json" "$t4_version"',
    ],
    "public publication verification",
  );

  const productBranchReachability = shellFunction(
    runner,
    "integration_is_reachable_from_product_branch",
  );
  assertIncludesAll(
    productBranchReachability,
    [
      "repos/$OMP_INTEGRATION_REPOSITORY/compare/$integration_commit...$OMP_PRODUCT_BRANCH",
      ".base_commit.sha",
      ".merge_base_commit.sha",
      "== $integration",
    ],
    "durable fork product-branch reachability",
  );

  const integrationAncestry = shellFunction(runner, "integration_descends_from_upstream");
  assertIncludesAll(
    integrationAncestry,
    [
      "repos/$OMP_INTEGRATION_REPOSITORY/compare/$upstream_commit...$integration_commit",
      ".base_commit.sha",
      ".merge_base_commit.sha",
      '== $upstream',
      ".ahead_by > 0",
    ],
    "integration ancestry verification",
  );

  const t4Reachability = shellFunction(runner, "t4_commit_is_reachable_from_main");
  assertIncludesAll(
    t4Reachability,
    [
      "repos/$T4_REPOSITORY/compare/$commit...main",
      ".merge_base_commit.sha",
      '== $commit',
    ],
    "T4 main reachability verification",
  );

  const taggedMetadata = shellFunction(runner, "tagged_t4_metadata_matches");
  assertIncludesAll(
    taggedMetadata,
    [
      "contents/package.json?ref=$t4_tag",
      "contents/compat/omp-app-matrix.json?ref=$t4_tag",
      ".version == $publication.t4.version",
      ".desktop.version == $publication.t4.version",
      ".verifiedRuntime.upstreamTag == $publication.upstream.tag",
      ".verifiedRuntime.upstreamCommit == $publication.upstream.commit",
      ".verifiedRuntime.sourceTag == $publication.integration.tag",
      ".verifiedRuntime.sourceCommit == $publication.integration.commit",
    ],
    "tagged T4 metadata verification",
  );

  const workflows = shellFunction(runner, "publication_workflows_succeeded");
  assertIncludesAll(
    workflows,
    [
      "actions/runs?head_sha=$commit",
      ".head_sha == $commit",
      '.name == "CI"',
      '.path == ".github/workflows/ci.yml"',
      '.name == "Release app builds"',
      '.path == ".github/workflows/release.yml"',
      '.path == ".github/workflows/deploy-site.yml"',
      ".head_branch == $tag",
      '.status == "completed"',
      '.conclusion == "success"',
    ],
    "exact-commit workflow verification",
  );
  assert.doesNotMatch(
    workflows,
    /\.name == "Deploy project site"/u,
    "site workflow identity must use the stable path because run-name is dynamic",
  );

  const assets = shellFunction(runner, "release_assets_are_public");
  for (const name of [
    "SHA256SUMS.txt",
    "android.apk",
    "linux-amd64.deb",
    "linux-x86_64.AppImage",
    "mac-arm64.dmg",
    "mac-arm64.zip",
    "latest-linux.yml",
  ]) {
    assert.ok(assets.includes(name), `release asset contract is missing: ${name}`);
  }
  assertIncludesAll(
    assets,
    [
      ".digest",
      'actual_manifest_digest=$($SHA256SUM "$manifest_file"',
      'asset_digest == "sha256:$expected_digest"',
      "manifest_entries == 6",
    ],
    "release checksum verification",
  );
  assert.match(assets, /\.assets\s*\|\s*length/u);
  assert.match(assets, /\.assets\s*\|\s*length\s*==\s*7/u);

  const linuxUpdate = shellFunction(runner, "verify_live_linux_update");
  assertIncludesAll(
    linuxUpdate,
    [
      'canonical_linux_update_assets "$release_json" "$version"',
      'download_exact_release_asset "$url" "$download_dir/$name" "$size"',
      'actual_digest=$($SHA256SUM "$download_dir/$name"',
      '"$NODE" "$LINUX_UPDATE_INSPECTOR"',
      '--metadata "$metadata_path"',
      '--artifact "$deb_path"',
      '--artifact "$appimage_path"',
      ".publicProof.t4LinuxUpdate",
    ],
    "live Linux updater verification",
  );
  const boundedDownload = shellFunction(runner, "download_exact_release_asset");
  assertIncludesAll(
    boundedDownload,
    [
      "ulimit -c 0",
      "ulimit -f",
      "--proto '=https'",
      "--proto-redir '=https'",
      "--max-redirs 5",
      "--connect-timeout 15",
      '--max-time "$maximum_seconds"',
      '--max-filesize "$expected_size"',
      "wc -c",
    ],
    "bounded Linux updater download",
  );

  const siteManifest = shellFunction(runner, "site_release_manifest_matches");
  assertIncludesAll(
    siteManifest,
    [
      "$T4_SITE/releases/latest.json?maintainer=$cache_bust",
      "SHA256SUMS.txt",
      "latest-linux.yml",
      ".schemaVersion == 1",
      '.channel == "stable"',
      ".publishedAt == $release.published_at",
      ".releaseUrl == $release.html_url",
      "(.assets | type == \"array\" and length == 5)",
      "$published.size == $actual.size",
      "$published.browser_download_url == $actual.url",
      '$published.digest == "sha256:\\($actual.sha256)"',
      "$checksums[$wanted.name] == $actual.sha256",
      "($checksums | keys | sort)",
    ],
    "deployed stable-release manifest verification",
  );
  assertOrdered(publicVerification, [
    'release_assets_are_public "$release_json" "$t4_version"',
    'site_release_manifest_matches "$release_json" "$t4_version"',
    'site_has_release "$t4_tag" "$integration_tag" "$t4_version"',
  ]);
});

test("atomic publisher pins the owned OMP fork identity", async () => {
  const publisher = await source("publish-omp-atomic.sh");
  assertIncludesAll(
    publisher,
    [
      "readonly FORK_REPOSITORY=wolfiesch/oh-my-pi",
      "readonly FORK_REPOSITORY_ID=1271775475",
      "readonly FORK_REPOSITORY_NODE_ID=R_kgDOS83A8w",
      ".id == $id and .node_id == $node_id",
      '.full_name == "wolfiesch/oh-my-pi" and .fork == true',
      '.parent.full_name == "can1357/oh-my-pi"',
    ],
    "owned OMP fork identity",
  );
});

test("pending publication is atomic and gates local deployment before processed state", async () => {
  const runner = await source("run.sh");
  const recordPending = shellFunction(runner, "record_pending");
  assertOrdered(recordPending, [
    'mktemp "$STATE_DIR/pending.json.XXXXXX"',
    '>"$temporary"',
    'durable_replace "$temporary" "$PENDING_FILE"',
  ]);

  const durableReplace = shellFunction(runner, "durable_replace");
  assertOrdered(durableReplace, [
    'chmod 600 "$temporary"',
    '"$SYNC" -f "$temporary"',
    'mv -f -- "$temporary" "$target"',
    '"$SYNC" -f "$target_dir"',
  ]);

  const deployPending = shellFunction(runner, "deploy_pending_publication");
  assertOrdered(deployPending, [
    "pending_publication_is_valid",
    'verify_result "$staged_result" "$target"',
    '"$LOCAL_DEPLOY" "$result_file" "$receipt_file" "$run_dir/local-work"',
    'local_receipt_is_valid "$receipt_file" "$result_file"',
    'record_local_applied "$result_file" "$publication_run_id" "$receipt_file"',
    'local_state_matches_record "$LOCAL_APPLIED_FILE"',
    'tailnet_gateway_is_healthy "$LOCAL_APPLIED_FILE"',
    "finalize_local_applied",
  ]);

  const finalize = shellFunction(runner, "finalize_local_applied");
  assertOrdered(finalize, [
    '.localDeployment.gateway.tailnetHealth = "healthy"',
    'durable_replace "$temporary" "$PROCESSED_FILE"',
    "clear_local_applied",
    "clear_pending",
  ]);

  const live = shellFunction(runner, "run_live_maintenance");
  assertOrdered(live, [
    'verify_result "$result_file" "$target"',
    'record_pending "$result_file" "$run_id"',
    "deploy_pending_publication",
  ]);

  const main = shellFunction(runner, "main");
  assertOrdered(main, ["deploy_pending_publication", "run_live_maintenance"]);
  assert.match(live, /invoke_sol \\\n[\s\S]*--model openai-codex\/gpt-5\.6-sol/u);
});

test("processed state is a receipt, not permission to ignore live workstation drift", async () => {
  const runner = await source("run.sh");
  const localState = shellFunction(runner, "local_state_matches_record");
  assertIncludesAll(
    localState,
    [
      ".localDeployment.omp.target",
      ".localDeployment.omp.installedSha256",
      'recorded_omp_target == "$OMP_TARGET"',
      '$SHA256SUM "$OMP_TARGET"',
      '--property MainPID --value',
      '$PROC_ROOT/$app_pid/exe',
      '"$OMP_TARGET" appserver status --json',
      '.state == "running"',
      ".health.ok == true",
      ".localDeployment.desktop.installedVersion",
      '$DPKG_QUERY -W',
      '$DPKG -V "$T4_PACKAGE"',
      ".localDeployment.gateway.runtimeSourceRoot",
      ".t4.commit",
      'rev-parse HEAD',
      ".sourceRoot",
      '"$NODE" "$runtime_root/scripts/tailnet-service.mjs" status',
      '$SYSTEMCTL --user is-enabled --quiet "$gateway_service"',
      "/healthz",
      ".allowedOrigin",
      ".gateway.artifacts.gatewayScriptSha256",
      ".gateway.artifacts.webTreeSha256",
      ".gateway.artifacts.wsTreeSha256",
      ".gateway.artifacts.configSha256",
      ".gateway.artifacts.unitSha256",
      '$SHA256SUM "$GATEWAY_CONFIG"',
      '$SHA256SUM "$GATEWAY_UNIT"',
      'tree_sha256 "$web_root" "$runtime_root"',
      'tree_sha256 "$runtime_root/node_modules/ws" "$runtime_root"',
      '.transport == "local-unix"',
    ],
    "live local-state proof",
  );
  assert.doesNotMatch(
    localState,
    /\$\{gateway_origin\}\/healthz/u,
    "local receipt drift proof must not depend on external Tailnet reachability",
  );

  const tailnetState = shellFunction(runner, "tailnet_gateway_is_healthy");
  assertIncludesAll(
    tailnetState,
    ['.allowedOrigin', '"${gateway_origin}/healthz"', '.transport == "local-unix"'],
    "separate Tailnet convergence proof",
  );

  const requeue = shellFunction(runner, "requeue_processed_publication");
  assertIncludesAll(
    requeue,
    ["$PROCESSED_FILE", "record_pending", "repair-"],
    "drift repair requeue",
  );

  const processedMatches = shellFunction(runner, "processed_matches");
  assertOrdered(processedMatches, ["processed_metadata_matches", "local_state_matches_processed"]);

  const main = shellFunction(runner, "main");
  assertOrdered(main, [
    "deploy_pending_publication",
    "finish_verified_processed_noop",
    "requeue_processed_publication",
    "deploy_pending_publication",
    "run_live_maintenance",
  ]);
  const processedNoop = shellFunction(runner, "finish_verified_processed_noop");
  assertOrdered(processedNoop, [
    "processed_metadata_matches",
    "local_state_matches_processed",
    'verify_result "$PROCESSED_FILE" "$target"',
  ]);

  const pending = shellFunction(runner, "deploy_pending_publication");
  const skipStart = pending.indexOf('if [[ -s $PROCESSED_FILE ]]');
  const clearStart = pending.indexOf("clear_pending", skipStart);
  assert.notEqual(skipStart, -1, "missing already-processed pending guard");
  assert.notEqual(clearStart, -1, "missing already-processed pending cleanup");
  assert.ok(
    pending.slice(skipStart, clearStart).includes("local_state_matches_processed"),
    "pending state must not be cleared from processed JSON without live-state proof",
  );
});

test("tagged sources prove ancestry, compatibility, artifacts, and required checks before mutation", async () => {
  const deployment = await source("deploy-local.sh");
  const beforeMutation = deployment.slice(0, deployment.indexOf("MUTATION_STARTED=true"));

  assert.match(beforeMutation, /OMP_UPSTREAM_REPOSITORY/u);
  assert.match(beforeMutation, /merge-base --is-ancestor/u);
  assertIncludesAll(
    beforeMutation,
    [
      '"$UPSTREAM_COMMIT"',
      '"$INTEGRATION_COMMIT"',
      '"$T4_BUILD_ROOT/compat/omp-app-matrix.json"',
      ".verifiedRuntime.upstreamTag",
      ".verifiedRuntime.upstreamCommit",
      ".verifiedRuntime.sourceTag",
      ".verifiedRuntime.sourceCommit",
      ".desktop.version",
      '"$T4_BUILD_ROOT/package.json"',
      '"refs/heads/$OMP_PRODUCT_BRANCH:refs/remotes/origin/$OMP_PRODUCT_BRANCH"',
      '"$INTEGRATION_COMMIT" "refs/remotes/origin/$OMP_PRODUCT_BRANCH"',
    ],
    "tagged-source verification",
  );

  const checksum = shellFunction(deployment, "download_verified_deb");
  assertOrdered(checksum, [
    "SHA256SUMS.txt",
    'download_release_asset "v$version" "$name" "$deb"',
    'verify_release_checksum "$sums" "$deb"',
  ]);
  assertIncludesAll(
    beforeMutation,
    [
      '"$BUN" run build:native',
      '"$BUN" --cwd packages/app-wire run check',
      '"$BUN" --cwd packages/app-wire test',
      '"$BUN" --cwd packages/appserver run build',
      '"$BUN" --cwd packages/appserver test',
      '"$BUN" --cwd packages/coding-agent run check',
      "packages/coding-agent/test/appserver-session-lifecycle.test.ts",
      "packages/coding-agent/test/rpc-managed-images.test.ts",
      '"$OMP_CANDIDATE" --smoke-test',
      'candidate_drain_help=$("$OMP_CANDIDATE" appserver drain-if-idle --help',
      '[[ $candidate_drain_help == *drain-if-idle* ]]',
      'OMP_CANDIDATE_SHA=$($SHA256SUM "$OMP_CANDIDATE"',
      '"$PNPM" check',
      '"$PNPM" build',
    ],
    "tagged-source release gates",
  );
  assertOrdered(beforeMutation, [
    '"$BUN" install --frozen-lockfile',
    '"$BUN" run build:native',
    '"$BUN" --cwd packages/appserver test',
  ]);

  const mutationFlow = deployment.slice(deployment.indexOf("MUTATION_STARTED=true"));
  assertOrdered(mutationFlow, [
    'mv -f -- "$omp_temporary" "$OMP_TARGET"',
    "appserver_proof=$(wait_for_appserver)",
    '[[ $INSTALLED_OMP_SHA == "$OMP_CANDIDATE_SHA" ]]',
  ]);
});

test("local cutover binds public mirror, live drain, exposure, and gateway identity", async () => {
  const [deployment, runner] = await Promise.all([source("deploy-local.sh"), source("run.sh")]);

  const mirror = shellFunction(deployment, "verify_fork_publication_base");
  assertIncludesAll(
    mirror,
    [
      'repos/$OMP_UPSTREAM_SLUG/commits/main',
      'repos/$OMP_INTEGRATION_SLUG/commits/main',
      'repos/$OMP_UPSTREAM_SLUG/git/ref/tags/$UPSTREAM_TAG',
      'repos/$OMP_INTEGRATION_SLUG/git/ref/tags/$UPSTREAM_TAG',
      'repos/$OMP_UPSTREAM_SLUG/commits/$UPSTREAM_TAG',
      'repos/$OMP_INTEGRATION_SLUG/commits/$UPSTREAM_TAG',
      "MAIN_MIRROR_ATTEMPTS",
      "MAIN_MIRROR_INTERVAL_SECONDS",
      'fork_main == "$official_main"',
      'fork_tag_object == "$official_tag_object"',
      'fork_tag_commit == "$UPSTREAM_COMMIT"',
    ],
    "clean fork main and exact base-tag mirror gate",
  );
  assert.match(deployment, /\[\[ \$\("\$UNAME" -s\) == Linux \]\]/u);

  const liveProof = shellFunction(deployment, "prove_installed_drain_contract");
  assertIncludesAll(
    liveProof,
    [
      '--property MainPID --value',
      '"$PROC_ROOT/$current_pid/exe"',
      'current_sha == "$expected_sha"',
      'current_sha == "$OMP_CANDIDATE_SHA"',
      'mismatch_host="t4-maintainer-host-$nonce"',
      'mismatch_epoch="t4-maintainer-epoch-$nonce"',
      "probe_status == 75",
      '.state == "identity_mismatch"',
      ".health.hostId == $host_id",
      ".health.epoch == $epoch",
    ],
    "installed live drain proof",
  );
  const startupProof = shellFunction(deployment, "wait_for_appserver");
  assertIncludesAll(
    startupProof,
    [
      '-r "$PROC_ROOT/$pid/exe"',
      '$SHA256SUM "$PROC_ROOT/$pid/exe"',
      'running_sha == "$installed_sha"',
    ],
    "installed appserver executable identity proof",
  );
  const rollbackProof = shellFunction(deployment, "prepare_post_exposure_rollback");
  assertIncludesAll(
    rollbackProof,
    [
      '-r "$PROC_ROOT/$current_pid/exe"',
      '$SHA256SUM "$PROC_ROOT/$current_pid/exe"',
      'current_sha == "$($SHA256SUM "$OMP_TARGET"',
    ],
    "post-exposure rollback executable identity proof",
  );

  const cutover = deployment.slice(deployment.indexOf("MUTATION_STARTED=true"));
  assertOrdered(cutover, [
    "stop_gateway_durably",
    "write_transaction_marker appserver-exposure-starting",
    "APP_EXPOSURE_ATTEMPTED=true",
    '$SYSTEMCTL --user start "$OMP_SERVICE"',
    "appserver_proof=$(wait_for_appserver)",
    'prove_installed_drain_contract "$APP_PID"',
    "--deployment-identity",
    "before-gateway-exposure",
  ]);
  assertIncludesAll(
    deployment,
    [
      'DEPLOYMENT_IDENTITY="sha256:$(printf',
      ".deploymentIdentity",
      'wait_for_gateway "$GATEWAY_PORT" "$DEPLOYMENT_IDENTITY"',
      "gateway_is_disabled",
    ],
    "immutable gateway deployment identity",
  );
  assertIncludesAll(
    runner,
    [
      "fork_main_commit",
      "official_base_tag_object",
      "fork_base_tag_object",
      "fork_base_commit",
      'resolve_public_commit "$OMP_UPSTREAM_REPOSITORY" main',
      'resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" main',
      ".deploymentIdentity == $identity",
      "deployment_identity()",
    ],
    "wrapper mirror and identity verification",
  );
});

test("local cutover defers while T4 or OMP sessions are active", async () => {
  const deployment = await source("deploy-local.sh");
  const desktop = shellFunction(deployment, "require_t4_desktop_closed");
  assertIncludesAll(
    desktop,
    ["pgrep -x t4-code", "pgrep -f '(^|/)t4-code( |$)'", "later idle retry"],
    "desktop idle guard",
  );

  const appserver = shellFunction(deployment, "require_appserver_sessionless");
  assertIncludesAll(
    appserver,
    ['--property MainPID --value', 'pgrep -P "$app_pid"', "later idle retry"],
    "appserver child-session guard",
  );

  const capability = shellFunction(deployment, "require_atomic_drain_capability");
  assertIncludesAll(
    capability,
    [
      'help_output=$("$OMP_TARGET" appserver drain-if-idle --help',
      '[[ $help_output == *drain-if-idle* ]]',
      '"$OMP_TARGET" appserver status --json',
      'mismatch_host="t4-maintainer-capability-host-$nonce"',
      'mismatch_epoch="t4-maintainer-capability-epoch-$nonce"',
      '[[ $mismatch_host != "$running_host_id" && $mismatch_epoch != "$running_epoch" ]]',
      '--expected-host-id "$mismatch_host"',
      '--expected-epoch "$mismatch_epoch"',
      "probe_status == 75",
      '.state == "identity_mismatch"',
      ".health.hostId == $host_id",
      ".health.epoch == $epoch",
    ],
    "atomic drain capability sentinel",
  );

  const idle = shellFunction(deployment, "require_workstation_idle");
  assertIncludesAll(
    idle,
    [
      "require_t4_desktop_closed",
      ".activeSessions",
      "active_sessions == 0",
      "require_appserver_sessionless",
      "retaining the pending publication for a later idle retry",
    ],
    "idle cutover guard",
  );

  const drain = shellFunction(deployment, "drain_active_appserver_if_idle");
  assertIncludesAll(
    drain,
    [
      '"$OMP_TARGET" appserver status --json',
      '"$OMP_TARGET" appserver drain-if-idle --json',
      '--expected-host-id "$expected_host_id"',
      '--expected-epoch "$expected_epoch"',
      'drain_receipt_is_valid "$drain_result" "$expected_host_id" "$expected_epoch"',
    ],
    "identity-bound atomic drain",
  );
  const drainReceipt = shellFunction(deployment, "drain_receipt_is_valid");
  assertIncludesAll(
    drainReceipt,
    [
      ".state == \"draining\"",
      ".health.hostId == $host_id",
      ".health.epoch == $epoch",
      ".busy.connections",
      ".busy.inflightMessages",
      ".busy.startingSupervisors",
      ".busy.lifecycleMutations",
      ".busy.sessionOperations",
      ".busy.activePrompts",
      ".busy.rpcSupervisorsWithPendingCalls",
      ".busy.busySessions",
      ".busy.openTerminalSessions",
      ".busy.pendingConfirmations",
      ".busy.outboundSends",
      "safe_count and . == 0",
    ],
    "canonical zero-work drain receipt",
  );

  const mutationFlow = deployment.slice(deployment.indexOf("\nfor command in"));
  assertOrdered(mutationFlow, [
    "require_workstation_idle",
    "stop_gateway_durably",
    "require_t4_desktop_closed",
    "require_appserver_sessionless",
    "drain_active_appserver_if_idle",
    'stop "$OMP_SERVICE"',
  ]);
  assert.ok(
    mutationFlow.indexOf("require_workstation_idle") < mutationFlow.indexOf("MUTATION_STARTED=true"),
    "the idle guard must finish before mutation starts",
  );
});

test("local deployment prepares everything before mutation and writes proof last", async () => {
  const deployment = await source("deploy-local.sh");
  const mutationFlow = deployment.slice(deployment.indexOf("\nfor command in"));
  assertOrdered(mutationFlow, [
    '$GIT clone --quiet --filter=blob:none --branch "$INTEGRATION_TAG"',
    'rev-parse HEAD) == "$INTEGRATION_COMMIT"',
    '"$BUN" run build',
    '$GIT clone --quiet --filter=blob:none --depth 1 --branch "$T4_TAG"',
    'rev-parse HEAD) == "$T4_COMMIT"',
    'TARGET_DEB=$(download_verified_deb "$T4_VERSION" "$DOWNLOAD_DIR")',
    '$INSTALL -m 0644 -- "$GATEWAY_UNIT" "$BACKUP_DIR/$GATEWAY_SERVICE"',
    "require_workstation_idle",
    '"$SYNC" -f "$BACKUP_DIR"',
    "write_transaction_marker deployment-in-progress",
    "MUTATION_STARTED=true",
    "stop_gateway_durably",
    '$SYSTEMCTL --user stop "$OMP_SERVICE"',
    'mv -f -- "$omp_temporary" "$OMP_TARGET"',
    '"$SYNC" -f "$OMP_TARGET"',
    '"$SYNC" -f "$(dirname -- "$OMP_TARGET")"',
    '$SYSTEMCTL --user start "$OMP_SERVICE"',
    "appserver_proof=$(wait_for_appserver)",
    '$SUDO -n "$APT_GET" install -y --reinstall --allow-downgrades "$TARGET_DEB"',
    'dpkg_verification=$($DPKG -V "$T4_PACKAGE")',
    '"$SYNC" -f "$T4_EXECUTABLE"',
    "GATEWAY_INSTALL_ARGS=(",
    "--defer-start",
    '"$NODE" "${GATEWAY_INSTALL_ARGS[@]}"',
    '"$SYNC" -f "$GATEWAY_CONFIG"',
    '"$SYNC" -f "$(dirname -- "$GATEWAY_CONFIG")"',
    '"$SYNC" -f "$(dirname -- "$GATEWAY_UNIT")"',
    "before-gateway-exposure",
    '$NODE "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs" start',
    'wait_for_gateway "$GATEWAY_PORT"',
    'receipt_temporary=$(mktemp',
    'mv -f -- "$receipt_temporary" "$RECEIPT_FILE"',
    "MUTATION_STARTED=false",
  ]);
});

test("local deployment preserves gateway identity and rolls every component back", async () => {
  const deployment = await source("deploy-local.sh");
  for (const proof of [
    '.allowedOrigin',
    '.port',
    '.appSocket',
    '.label',
    "Tailnet gateway config did not adopt the target runtime",
    "Tailnet gateway origin changed during deployment",
    "Tailnet gateway port changed during deployment",
    "Tailnet gateway socket changed during deployment",
    "Tailnet gateway label changed during deployment",
  ]) {
    assert.ok(deployment.includes(proof), `gateway deployment proof is missing: ${proof}`);
  }

  const rollback = shellFunction(deployment, "rollback");
  for (const restoration of [
    'rm -f -- "$RECEIPT_FILE"',
    'install -y --reinstall --allow-downgrades "$PREVIOUS_DEB"',
    'atomic_restore_file "$BACKUP_DIR/omp" "$OMP_TARGET"',
    'atomic_restore_file "$BACKUP_DIR/tailnet-gateway.json" "$GATEWAY_CONFIG"',
    'atomic_restore_file "$BACKUP_DIR/$GATEWAY_SERVICE" "$GATEWAY_UNIT"',
    'restore_service_enablement "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ENABLEMENT"',
    'restore_service_state "$OMP_SERVICE" "$PREVIOUS_APP_ACTIVE"',
    'restore_service_state "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ACTIVE"',
  ]) {
    assert.ok(rollback.includes(restoration), `rollback restoration is missing: ${restoration}`);
  }

  assertIncludesAll(
    rollback,
    [
      '[[ $($SHA256SUM "$OMP_TARGET"',
      'wait_for_appserver >/dev/null',
      "PREVIOUS_T4_VERSION",
      'cmp -s -- "$BACKUP_DIR/tailnet-gateway.json" "$GATEWAY_CONFIG"',
      'cmp -s -- "$BACKUP_DIR/$GATEWAY_SERVICE" "$GATEWAY_UNIT"',
      'wait_for_gateway "$GATEWAY_PORT"',
    ],
    "verified rollback",
  );
  assertOrdered(rollback, [
    'atomic_restore_file "$BACKUP_DIR/tailnet-gateway.json" "$GATEWAY_CONFIG"',
    'atomic_restore_file "$BACKUP_DIR/$GATEWAY_SERVICE" "$GATEWAY_UNIT"',
    '"$SYNC" -f "$GATEWAY_CONFIG"',
    '"$SYNC" -f "$(dirname -- "$GATEWAY_CONFIG")"',
    '"$SYNC" -f "$(dirname -- "$GATEWAY_UNIT")"',
    '"$SYSTEMCTL" --user daemon-reload',
    'restore_service_enablement "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ENABLEMENT"',
    '"$SYNC" -f "$OMP_TARGET"',
    '"$SYNC" -f "$(dirname -- "$OMP_TARGET")"',
    '"$SYNC" -f "$T4_EXECUTABLE"',
    'restore_service_state "$OMP_SERVICE" "$PREVIOUS_APP_ACTIVE"',
    'restore_service_state "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ACTIVE"',
  ]);

  assertIncludesAll(
    deployment.slice(0, deployment.indexOf("MUTATION_STARTED=true")),
    [
      'PREVIOUS_GATEWAY_ENABLEMENT=$("$SYSTEMCTL" --user is-enabled "$GATEWAY_SERVICE"',
      "enabled|disabled",
    ],
    "gateway enablement snapshot",
  );

  assert.match(rollback, /write_transaction_marker rollback-incomplete/u);

  const marker = shellFunction(deployment, "write_transaction_marker");
  assertOrdered(marker, [
    'mktemp "$marker_dir/.deployment-blocked.XXXXXX"',
    '--arg status "$status"',
    "status: $status",
    'chmod 600 "$temporary"',
    '"$SYNC" -f "$temporary"',
    'mv -f -- "$temporary" "$BLOCKED_FILE"',
    '"$SYNC" -f "$marker_dir"',
  ]);

  const postExposure = shellFunction(deployment, "prepare_post_exposure_rollback");
  assertOrdered(postExposure, [
    "stop_gateway_durably",
    'drain-if-idle --json',
    '--expected-host-id "$APP_HOST_ID"',
    '--expected-epoch "$APP_EPOCH"',
    'drain_receipt_is_valid "$drain_result" "$APP_HOST_ID" "$APP_EPOCH"',
    "rollback-drained-after-exposure",
  ]);
  assertIncludesAll(
    postExposure,
    [
      "gateway-quarantine-incomplete",
      "rollback-blocked-appserver-identity",
      "rollback-blocked-active-work",
      "rollback-blocked-invalid-drain-proof",
    ],
    "post-exposure safe rollback",
  );

  const exitTrap = shellFunction(deployment, "on_exit");
  assertOrdered(exitTrap, [
    'if [[ $APP_EXPOSURE_ATTEMPTED == true ]]',
    "prepare_post_exposure_rollback",
    "rollback",
  ]);

  const runner = await source("run.sh");
  const main = shellFunction(runner, "main");
  assert.match(
    main,
    /\[\[ ! -e \$BLOCKED_FILE \]\] \|\| fail "maintainer is blocked by an unfinished or incompletely rolled-back deployment/u,
  );
});

test("processed state accepts only a complete post-cutover health receipt", async () => {
  const [runner, deployment] = await Promise.all([source("run.sh"), source("deploy-local.sh")]);
  const receiptValidation = shellFunction(runner, "local_receipt_is_valid");
  assertIncludesAll(
    receiptValidation,
    [
      '.status == "complete"',
      ".upstream == $publication[0].upstream",
      ".integration == $publication[0].integration",
      ".t4 == $publication[0].t4",
      ".omp.installedSha256 == .omp.runningExecutableSha256",
      ".desktop.installedVersion == $publication[0].t4.version",
      '.desktop.dpkgVerification == "clean"',
      '.gateway.activeState == "active"',
      '.gateway.health == "healthy"',
      '.gateway.helperStatus == "healthy"',
      '.gateway.loopbackHealth == "healthy"',
      ".gateway.runtimeCommit == $publication[0].t4.commit",
      '.gateway.tailnetHealth == "pending"',
      ".gateway.artifacts.gatewayScriptSha256",
      ".gateway.artifacts.webTreeSha256",
      ".gateway.artifacts.wsTreeSha256",
      ".gateway.artifacts.configSha256",
      ".gateway.artifacts.unitSha256",
      ".rollback.available == true",
    ],
    "processed receipt validator",
  );

  const appserverHealth = shellFunction(deployment, "wait_for_appserver");
  assertIncludesAll(
    appserverHealth,
    [
      '"$OMP_TARGET" appserver status --json',
      '.state == "running"',
      ".health.ok == true",
      ".health.hostId",
      ".health.epoch",
    ],
    "appserver health proof",
  );
  const gatewayCutover = deployment.slice(deployment.indexOf("MUTATION_STARTED=true"));
  assertOrdered(gatewayCutover, [
    "GATEWAY_INSTALL_ARGS=(",
    "--defer-start",
    '"$NODE" "${GATEWAY_INSTALL_ARGS[@]}"',
    "before-gateway-exposure",
    'write_transaction_marker gateway-exposure-starting',
    '$NODE "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs" start',
    '$NODE "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs" status',
    'wait_for_gateway "$GATEWAY_PORT"',
    "receipt_temporary=$(mktemp",
  ]);

  const finalize = shellFunction(runner, "finalize_local_applied");
  assertOrdered(finalize, [
    '.localDeployment.gateway.tailnetHealth = "healthy"',
    'durable_replace "$temporary" "$PROCESSED_FILE"',
    "clear_local_applied",
    "clear_pending",
  ]);
});

test("bootstrap installs automation first and defers incompatible public adoption to Sol", async () => {
  const [installer, runner] = await Promise.all([source("install.sh"), source("run.sh")]);
  assert.doesNotMatch(installer, /"\$SCRIPT_DIR\/run\.sh" --adopt-current(?:\s|$)/u);
  assertOrdered(installer, [
    'install -m 0700 "$SCRIPT_DIR/run.sh" "$MAINTAINER_ROOT/libexec/run.sh"',
    'install -m 0700 "$SCRIPT_DIR/deploy-local.sh" "$MAINTAINER_ROOT/libexec/deploy-local.sh"',
    'install -m 0600 "$SCRIPT_DIR/prompt.md" "$MAINTAINER_ROOT/libexec/prompt.md"',
    'install -m 0644 "$temporary/$SERVICE_NAME" "$SYSTEMD_USER_DIR/$SERVICE_NAME"',
    'systemctl --user enable --now "$TIMER_NAME"',
    "--adopt-current-if-compatible",
  ]);
  assert.match(installer, /systemctl --user start --no-block "\$SERVICE_NAME"/u);

  const main = shellFunction(runner, "main");
  assert.match(main, /--adopt-current-if-compatible/u);
  assert.match(main, /--adopt-current-if-compatible\)[\s\S]*adopt_current_public_release true/u);
  const compatibleAdoption = shellFunction(runner, "adopt_current_public_release");
  assertIncludesAll(
    compatibleAdoption,
    [
      "allow_incompatible",
      "contents/package.json?ref=main",
      "contents/compat/omp-app-matrix.json?ref=main",
      'public_metadata_is_compatible "$matrix" "$target" "$package_version"',
      "publication_workflows_active_or_recent",
      "RESUME_PUBLICATION_JSON",
      "repos/$T4_REPOSITORY/releases/latest",
      "contents/package.json?ref=$t4_tag",
      "contents/compat/omp-app-matrix.json?ref=$t4_tag",
      "publication_workflows_succeeded",
      'adopt_publication "$target"',
      "starting the positive Sol release workflow",
      "return 0",
    ],
    "compatible bootstrap adoption",
  );
  assertOrdered(compatibleAdoption, [
    "contents/package.json?ref=main",
    "repos/$T4_REPOSITORY/releases/latest",
    "if [[ $allow_incompatible == true ]]",
  ]);
  assert.doesNotMatch(compatibleAdoption, /T4_SOURCE_ROOT/u);
});
