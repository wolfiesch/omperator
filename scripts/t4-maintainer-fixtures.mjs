import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { makeCanonicalTemporaryDirectory } from "./test-temporary-directory.mjs";

export const repoRoot = resolve(import.meta.dirname, "..");
export const deployScript = resolve(repoRoot, "ops/t4-maintainer/deploy-local.sh");
export const runnerScript = resolve(repoRoot, "ops/t4-maintainer/run.sh");
export const bashPath = "/bin/bash";
// Full-suite contention on shared CI and macOS can push a successful convergence
// run past one minute. Keep this above the production process boundary so the fixture
// reports the child result instead of a test-harness timeout.
export const integrationProcessTimeoutMs = 180_000;
export const upstreamCommit = "a".repeat(40);
export const integrationCommit = "b".repeat(40);
export const t4Commit = "c".repeat(40);
export const mainCommit = "d".repeat(40);
export const changedT4MainCommit = "1".repeat(40);
export const upstreamTagObject = "e".repeat(40);
export const integrationTagObject = "f".repeat(40);
export const mockDebSize = Buffer.byteLength("mock-deb\n");
export const mockAssetSize = Buffer.byteLength("mock-asset\n");
export const mockDebSha512 = createHash("sha512").update("mock-deb\n").digest("base64");
export const mockAssetSha512 = createHash("sha512").update("mock-asset\n").digest("base64");
export const mockDriftSha512 = createHash("sha512").update("drift\n").digest("base64");
export const flockUnavailable =
  spawnSync("flock", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT";
export const statModeProbe = spawnSync("stat", ["-c", "%a", import.meta.filename], {
  encoding: "utf8",
});
export const statModeUnavailable =
  statModeProbe.status !== 0 || !/^[0-7]+\n$/u.test(statModeProbe.stdout);
export const nullSortExpected = Buffer.from("a\0b\0");
export const nullSortProbe = spawnSync("sort", ["-z"], { input: Buffer.from("b\0a\0") });
export const nullSortUnavailable =
  nullSortProbe.status !== 0 || nullSortProbe.stdout?.equals(nullSortExpected) !== true;
export const portableFlockMock = "#!/usr/bin/env bash\nexit 0\n";
export const portableStatMock = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "if [[ ${1:-} == -c && ${2:-} == %a && $# -eq 3 ]]; then",
  '  exec "$MOCK_NODE_EXECUTABLE" -e \'const fs=require("node:fs");const mode=fs.statSync(process.argv[1]).mode&0o7777;process.stdout.write(mode.toString(8)+"\\n")\' "$3"',
  "fi",
  'exec /usr/bin/stat "$@"',
  "",
].join("\n");
export const portableNullSortMock = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "if [[ ${1:-} == -z && $# -eq 1 ]]; then",
  '  exec "$MOCK_NODE_EXECUTABLE" -e \'const fs=require("node:fs");const data=fs.readFileSync(0);const parts=[];let start=0;for(let index=0;index<data.length;index+=1){if(data[index]===0){parts.push(data.subarray(start,index));start=index+1;}}if(start<data.length)parts.push(data.subarray(start));parts.sort(Buffer.compare);const output=[];for(const part of parts)output.push(part,Buffer.from([0]));process.stdout.write(Buffer.concat(output));\'',
  "fi",
  'exec /usr/bin/sort "$@"',
  "",
].join("\n");


export const mockDispatcher = String.raw`#!/usr/bin/env bash
set -euo pipefail

tool=$(basename -- "$0")
state=\${MOCK_STATE:?}
calls=\${MOCK_CALLS:?}

printf '%s' "$tool" >>"$calls"
printf '\t%q' "$@" >>"$calls"
printf '\n' >>"$calls"

read_state() {
  local name=$1 fallback=\${2:-}
  if [[ -f $state/$name ]]; then
    cat "$state/$name"
  else
    printf '%s' "$fallback"
  fi
}

write_state() {
  printf '%s' "$2" >"$state/$1"
}

linux_update_metadata() {
  local version=$1
  local deb_name="T4-Code-$version-linux-amd64.deb"
  local appimage_name="T4-Code-$version-linux-x86_64.AppImage"
  local deb_size=${mockDebSize}
  local appimage_size=${mockAssetSize}
  local deb_sha512=${mockDebSha512}
  local appimage_sha512=${mockAssetSha512}
  case \${MOCK_LINUX_UPDATE_MODE:-valid} in
    deb-name) deb_name="T4-Code-$version-linux-renamed.deb" ;;
    deb-size) deb_size=$((deb_size - 1)) ;;
    deb-sha512) deb_sha512=${mockDriftSha512} ;;
    appimage-name) appimage_name="T4-Code-$version-linux-renamed.AppImage" ;;
    appimage-size) appimage_size=$((appimage_size - 1)) ;;
    appimage-sha512) appimage_sha512=${mockDriftSha512} ;;
    compatibility-sha512) ;;
  esac
  cat <<YAML
version: $version
files:
  - url: $appimage_name
    sha512: $appimage_sha512
    size: $appimage_size
    blockMapSize: 1
  - url: $deb_name
    sha512: $deb_sha512
    size: $deb_size
path: $appimage_name
sha512: $(if [[ \${MOCK_LINUX_UPDATE_MODE:-valid} == compatibility-sha512 ]]; then printf '%s' '${mockDriftSha512}'; else printf '%s' "$appimage_sha512"; fi)
releaseDate: '2026-07-15T00:00:00Z'
YAML
}

case $tool in
  gh)
    endpoint=''
    for argument in "$@"; do
      [[ $argument == repos/* ]] && endpoint=$argument
    done
    case $endpoint in
      repos/can1357/oh-my-pi)
        official_id=1125856365
        official_node=R_kgDOQxs0bQ
        official_clone=https://github.com/can1357/oh-my-pi.git
        [[ \${MOCK_OMP_OFFICIAL_ID_MISMATCH:-0} != 1 ]] || official_id=1
        [[ \${MOCK_OMP_OFFICIAL_CLONE_MISMATCH:-0} != 1 ]] || official_clone=https://example.invalid/oh-my-pi.git
        printf '{"id":%s,"node_id":"%s","full_name":"can1357/oh-my-pi","clone_url":"%s"}\n' \
          "$official_id" "$official_node" "$official_clone"
        ;;
      repos/wolfiesch/oh-my-pi)
        fork_id=1271775475
        fork_node=R_kgDOS83A8w
        parent_id=1125856365
        parent_node=R_kgDOQxs0bQ
        fork_clone=https://github.com/wolfiesch/oh-my-pi.git
        [[ \${MOCK_OMP_FORK_ID_MISMATCH:-0} != 1 ]] || fork_id=1
        [[ \${MOCK_OMP_FORK_NODE_MISMATCH:-0} != 1 ]] || fork_node=wrong
        [[ \${MOCK_OMP_FORK_PARENT_MISMATCH:-0} != 1 ]] || parent_id=1
        [[ \${MOCK_OMP_FORK_CLONE_MISMATCH:-0} != 1 ]] || fork_clone=https://example.invalid/oh-my-pi.git
        printf '{"id":%s,"node_id":"%s","full_name":"wolfiesch/oh-my-pi","clone_url":"%s","fork":true,"parent":{"id":%s,"node_id":"%s","full_name":"can1357/oh-my-pi"}}\n' \
          "$fork_id" "$fork_node" "$fork_clone" "$parent_id" "$parent_node"
        ;;
      'repos/wolfiesch/omperator/pulls?state=open&base=main&per_page=100')
        count=$(read_state t4-pr-queries 0)
        count=$((count + 1))
        write_state t4-pr-queries "$count"
        if [[ -n \${MOCK_PR_FAIL_AFTER:-} && $count -gt \${MOCK_PR_FAIL_AFTER} ]]; then
          exit 1
        elif [[ \${MOCK_PR_SEQUENTIAL:-0} == 1 && $count -ge 2 ]] ||
             [[ -n \${MOCK_PR_CHANGE_AFTER:-} && $count -gt \${MOCK_PR_CHANGE_AFTER} ]]; then
          printf '%s\n' '[{"number":42,"draft":false,"title":"Release cutover","labels":[]}]'
        else
          printf '%s\n' '[]'
        fi
        ;;
      repos/wolfiesch/omperator/pulls/42/files?per_page=100)
        printf '%s\n' '[{"filename":"ops/t4-maintainer/run.sh"}]'
        ;;
      repos/can1357/oh-my-pi/releases/latest)
        printf '{"draft":false,"prerelease":false,"tag_name":"v1.2.3"}\n'
        ;;
      repos/can1357/oh-my-pi/commits/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/commits/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/commits/$MOCK_UPSTREAM_COMMIT)
        printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        ;;
      repos/can1357/oh-my-pi/git/ref/tags/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_TAG_OBJECT"
        ;;
      repos/wolfiesch/oh-my-pi/git/ref/tags/v1.2.3)
        [[ \${MOCK_FORK_BASE_TAG_MISSING:-0} != 1 ]] || exit 1
        if [[ \${MOCK_FORK_BASE_TAG_MISMATCH:-0} == 1 ]]; then
          printf '%040d\n' 8
        else
          printf '%s\n' "$MOCK_UPSTREAM_TAG_OBJECT"
        fi
        ;;
      repos/wolfiesch/oh-my-pi/git/ref/tags/t4code-1.2.3-appserver-1)
        printf '%s\n' "$MOCK_INTEGRATION_TAG_OBJECT"
        ;;
      repos/can1357/oh-my-pi/commits/main)
        printf '%s\n' "$MOCK_MAIN_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/commits/main)
        if [[ -f $state/fork-main-synced ]]; then
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        elif [[ \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
          printf '%040d\n' 9
        elif [[ \${MOCK_FORK_MAIN_BEHIND:-0} == 1 ]]; then
          printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        else
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        fi
        ;;
      repos/wolfiesch/oh-my-pi/actions/workflows/ci.yml)
        printf '%s\n' "$(read_state fork-workflow active)"
        ;;
      repos/wolfiesch/oh-my-pi/actions/workflows/ci.yml/disable)
        [[ \${MOCK_FORK_WORKFLOW_DISABLE_FAIL:-0} != 1 ]] || exit 1
        write_state fork-workflow disabled_manually
        printf '{}\n'
        ;;
      repos/wolfiesch/oh-my-pi/actions/workflows/ci.yml/enable)
        [[ \${MOCK_FORK_WORKFLOW_ENABLE_FAIL:-0} != 1 ]] || exit 1
        write_state fork-workflow active
        printf '{}\n'
        ;;
      repos/wolfiesch/omperator/releases/latest)
        printf '{"draft":false,"prerelease":false,"tag_name":"v1.2.3"}\n'
        ;;
      repos/wolfiesch/omperator/contents/package.json?ref=*)
        printf '{"version":"1.2.3"}\n'
        ;;
      repos/wolfiesch/omperator/contents/compat/omp-app-matrix.json?ref=*)
        if [[ \${MOCK_PUBLIC_INCOMPATIBLE:-0} == 1 ||
              (\${MOCK_MAIN_INCOMPATIBLE:-0} == 1 && $endpoint == *'?ref=main') ]]; then
          upstream_tag=v9.9.9
        else
          upstream_tag=v1.2.3
        fi
        printf '{"desktop":{"version":"1.2.3"},"verifiedRuntime":{"upstreamTag":"%s","upstreamCommit":"%s","sourceTag":"t4code-1.2.3-appserver-1","sourceCommit":"%s"}}\n' \
          "$upstream_tag" "$MOCK_UPSTREAM_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/commits/t4code-1.2.3-appserver-1)
        printf '%s\n' "$MOCK_INTEGRATION_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/commits/t4code/main)
        printf '%s\n' "$MOCK_INTEGRATION_COMMIT"
        ;;
      repos/wolfiesch/omperator/commits/main)
        count=$(read_state t4-main-queries 0)
        count=$((count + 1))
        write_state t4-main-queries "$count"
        if [[ -n \${MOCK_T4_MAIN_COMMIT_AFTER:-} && $count -gt \${MOCK_T4_MAIN_COMMIT_AFTER} ]]; then
          printf '%s\n' "\${MOCK_T4_MAIN_COMMIT_CHANGED:?}"
        else
          printf '%s\n' "$MOCK_T4_COMMIT"
        fi
        ;;
      repos/wolfiesch/omperator/commits/v1.2.3)
        printf '%s\n' "$MOCK_T4_COMMIT"
        ;;
      repos/wolfiesch/oh-my-pi/compare/*)
        if [[ $endpoint == *"$MOCK_INTEGRATION_COMMIT...t4code/main" &&
              \${MOCK_PRODUCT_BRANCH_MISSING:-0} != 1 ]]; then
          printf '{"status":"ahead","ahead_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[]}\n' \
            "$MOCK_INTEGRATION_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        else
          printf '{"status":"ahead","ahead_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$MOCK_UPSTREAM_COMMIT" \
            "$MOCK_UPSTREAM_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        fi
        ;;
      repos/wolfiesch/omperator/compare/*)
        printf '{"status":"identical","merge_base_commit":{"sha":"%s"}}\n' "$MOCK_T4_COMMIT"
        ;;
      repos/wolfiesch/omperator/actions/runs*)
        t4_ci_path='.github/workflows/ci.yml'
        t4_release_path='.github/workflows/release.yml'
        t4_site_path='.github/workflows/deploy-site.yml'
        mock_workflow_updated_at=$( /bin/date -u +%Y-%m-%dT%H:%M:%SZ )
        [[ \${MOCK_T4_WORKFLOW_WRONG_PATH:-0} != 1 ]] || t4_ci_path='.github/workflows/not-ci.yml'
        if [[ (\${MOCK_WORKFLOWS_TERMINAL:-0} == 1 && ! -f $state/sol-ran) ||
              (\${MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL:-0} == 1 && -f $state/sol-ran && ! -f $state/workflows-failed-once) ]]; then
          [[ \${MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL:-0} != 1 || ! -f $state/sol-ran ]] \
            || write_state workflows-failed-once 1
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"},
 {"name":"Deploy project site v1.2.3 mock-dispatch","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"v1.2.3","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"}
]}
JSON
        elif [[ \${MOCK_WORKFLOWS_ACTIVE:-0} == 1 ]]; then
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"in_progress","conclusion":null,"updated_at":"$mock_workflow_updated_at"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"queued","conclusion":null,"updated_at":"$mock_workflow_updated_at"},
 {"name":"Deploy project site v1.2.3 mock-dispatch","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"v1.2.3","status":"queued","conclusion":null,"updated_at":"$mock_workflow_updated_at"}
]}
JSON
        else
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"completed","conclusion":"success","updated_at":"$mock_workflow_updated_at"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"completed","conclusion":"success","updated_at":"$mock_workflow_updated_at"},
 {"name":"Deploy project site v1.2.3 mock-dispatch","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"v1.2.3","status":"completed","conclusion":"success","updated_at":"$mock_workflow_updated_at"}
]}
JSON
        fi
        ;;
      repos/wolfiesch/oh-my-pi/actions/workflows/ci.yml/runs*)
        if [[ $endpoint == *'branch=main'* && $endpoint == *"head_sha=$MOCK_MAIN_COMMIT"* ]]; then
          [[ \${MOCK_FORK_MAIN_RUN_LIST_FAIL:-0} != 1 ]] || exit 1
          if [[ \${MOCK_FORK_MAIN_RUN_MALFORMED:-0} == 1 ]]; then
            printf '{"workflow_runs":"invalid"}\n'
          else
            query_count=$(read_state fork-main-run-queries 0)
            query_count=$((query_count + 1))
            write_state fork-main-run-queries "$query_count"
            delay=\${MOCK_FORK_MAIN_RUN_DELAY_POLLS:-0}
            post_push_queries=$(read_state fork-main-post-push-queries 0)
            if [[ -f $state/fork-main-synced ]]; then
              post_push_queries=$((post_push_queries + 1))
              write_state fork-main-post-push-queries "$post_push_queries"
            fi
            if [[ \${MOCK_FORK_MAIN_RUN:-0} == 1 &&
                  (\${MOCK_FORK_MAIN_RUN_PREEXISTING:-0} == 1 ||
                   ( -f $state/fork-main-synced && $post_push_queries -gt $delay )) ]]; then
              if [[ -f $state/fork-main-run-cancelled ]]; then
                run_status=completed
                conclusion='"cancelled"'
              else
                run_status=queued
                conclusion=null
              fi
              total_count=1
              [[ \${MOCK_FORK_MAIN_RUN_TRUNCATED:-0} != 1 ]] || total_count=101
              created_at=\${MOCK_FORK_MAIN_RUN_CREATED_AT:-2099-01-01T00:00:00Z}
              run_attempt=\${MOCK_FORK_MAIN_RUN_ATTEMPT:-1}
              printf '{"total_count":%s,"workflow_runs":[{"id":4242,"name":"CI","path":".github/workflows/ci.yml","head_sha":"%s","event":"push","head_branch":"main","created_at":"%s","run_attempt":%s,"status":"%s","conclusion":%s}]}\n' \
                "$total_count" "$MOCK_MAIN_COMMIT" "$created_at" "$run_attempt" "$run_status" "$conclusion"
            else
              printf '{"total_count":0,"workflow_runs":[]}\n'
            fi
          fi
        else
          omp_workflow_path='.github/workflows/ci.yml'
          [[ \${MOCK_OMP_WORKFLOW_WRONG_PATH:-0} != 1 ]] || omp_workflow_path='.github/workflows/not-ci.yml'
          if [[ \${MOCK_OMP_WORKFLOW_MISSING:-0} == 1 ]]; then
            printf '{"workflow_runs":[]}\n'
          elif [[ \${MOCK_OMP_WORKFLOW_FAILED:-0} == 1 ]]; then
            printf '{"workflow_runs":[{"name":"CI","path":"%s","head_sha":"%s","event":"push","head_branch":"t4code/main","status":"completed","conclusion":"failure"}]}\n' "$omp_workflow_path" "$MOCK_INTEGRATION_COMMIT"
          else
            printf '{"workflow_runs":[{"name":"CI","path":"%s","head_sha":"%s","event":"push","head_branch":"t4code/main","status":"completed","conclusion":"success"}]}\n' "$omp_workflow_path" "$MOCK_INTEGRATION_COMMIT"
          fi
        fi
        ;;
      repos/wolfiesch/oh-my-pi/actions/runs/4242/cancel)
        if [[ \${MOCK_FORK_MAIN_RUN_CANCEL_STUCK:-0} != 1 ]]; then
          write_state fork-main-run-cancelled 1
        fi
        if [[ \${MOCK_FORK_MAIN_RUN_CANCEL_RACE:-0} == 1 ]]; then
          exit 1
        elif [[ \${MOCK_FORK_MAIN_RUN_CANCEL_FAIL:-0} == 1 ]]; then
          exit 1
        else
          printf '{}\n'
        fi
        ;;
      repos/wolfiesch/oh-my-pi/releases/tags/t4code-1.2.3-appserver-1)
        omp_digest=$(printf 'mock-asset\n' | sha256sum | awk '{print $1}')
        omp_asset_prefix='mock://'
        [[ \${MOCK_OMP_ASSET_WRONG_ORIGIN:-0} != 1 ]] || omp_asset_prefix='https://example.invalid/'
        extra=''
        [[ \${MOCK_OMP_ASSET_EXTRA:-0} != 1 ]] || extra=',{"name":"unexpected","state":"uploaded","size":10,"digest":"sha256:'"$omp_digest"'","browser_download_url":"mock://unexpected"}'
        missing='{"name":"omp-linux-x64","state":"uploaded","size":11,"digest":"sha256:'"$omp_digest"'","browser_download_url":"'"$omp_asset_prefix"'omp-linux-x64"},'
        [[ \${MOCK_OMP_ASSET_MISSING:-0} != 1 ]] || missing=''
        size=11
        [[ \${MOCK_OMP_ASSET_ZERO:-0} != 1 ]] || size=0
        digest="sha256:$omp_digest"
        [[ \${MOCK_OMP_ASSET_DIGESTLESS:-0} != 1 ]] || digest='null'
        [[ $digest == null ]] || digest='"'"$digest"'"'
        cat <<JSON
{"tag_name":"t4code-1.2.3-appserver-1","html_url":"https://github.com/wolfiesch/oh-my-pi/releases/tag/t4code-1.2.3-appserver-1","draft":false,"prerelease":false,"assets":[
  $missing
  {"name":"omp-linux-arm64","state":"uploaded","size":$size,"digest":$digest,"browser_download_url":"\${omp_asset_prefix}omp-linux-arm64"},
  {"name":"omp-darwin-x64","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-darwin-x64"},
  {"name":"omp-darwin-arm64","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-darwin-arm64"},
  {"name":"omp-windows-x64.exe","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-windows-x64.exe"}$extra
]}
JSON
        ;;
      */releases/tags/*)
        release_tag=\${endpoint##*/}
        release_version=\${release_tag#v}
        release_prefix="https://github.com/wolfiesch/omperator/releases/download/$release_tag"
        deb_digest=$(printf 'mock-deb\n' | sha256sum | awk '{print $1}')
        asset_digest=$(printf 'mock-asset\n' | sha256sum | awk '{print $1}')
        metadata=$(linux_update_metadata "$release_version")
        metadata_digest=$(printf '%s\n' "$metadata" | sha256sum | awk '{print $1}')
        metadata_size=$(printf '%s\n' "$metadata" | wc -c)
        manifest=$(printf '%s  T4-Code-%s-android.apk\n%s  T4-Code-%s-linux-amd64.deb\n%s  T4-Code-%s-linux-x86_64.AppImage\n%s  T4-Code-%s-mac-arm64.dmg\n%s  T4-Code-%s-mac-arm64.zip\n%s  latest-linux.yml\n' \
          "$asset_digest" "$release_version" "$deb_digest" "$release_version" "$asset_digest" "$release_version" \
          "$asset_digest" "$release_version" "$asset_digest" "$release_version" "$metadata_digest")
        manifest_digest=$(printf '%s\n' "$manifest" | sha256sum | awk '{print $1}')
        manifest_size=$(printf '%s\n' "$manifest" | wc -c)
        cat <<JSON
{"tag_name":"$release_tag","html_url":"https://github.com/wolfiesch/omperator/releases/tag/$release_tag","published_at":"2026-07-15T00:00:00Z","draft":false,"prerelease":false,"assets":[
  {"name":"SHA256SUMS.txt","state":"uploaded","size":$manifest_size,"digest":"sha256:$manifest_digest","browser_download_url":"$release_prefix/SHA256SUMS.txt"},
  {"name":"T4-Code-$release_version-android.apk","state":"uploaded","size":${mockAssetSize},"digest":"sha256:$asset_digest","browser_download_url":"$release_prefix/T4-Code-$release_version-android.apk"},
  {"name":"T4-Code-$release_version-linux-amd64.deb","state":"uploaded","size":${mockDebSize},"digest":"sha256:$deb_digest","browser_download_url":"$release_prefix/T4-Code-$release_version-linux-amd64.deb"},
  {"name":"T4-Code-$release_version-linux-x86_64.AppImage","state":"uploaded","size":${mockAssetSize},"digest":"sha256:$asset_digest","browser_download_url":"$release_prefix/T4-Code-$release_version-linux-x86_64.AppImage"},
  {"name":"T4-Code-$release_version-mac-arm64.dmg","state":"uploaded","size":${mockAssetSize},"digest":"sha256:$asset_digest","browser_download_url":"$release_prefix/T4-Code-$release_version-mac-arm64.dmg"},
  {"name":"T4-Code-$release_version-mac-arm64.zip","state":"uploaded","size":${mockAssetSize},"digest":"sha256:$asset_digest","browser_download_url":"$release_prefix/T4-Code-$release_version-mac-arm64.zip"},
  {"name":"latest-linux.yml","state":"uploaded","size":$metadata_size,"digest":"sha256:$metadata_digest","browser_download_url":"$release_prefix/latest-linux.yml"}
]}
JSON
        ;;
      *) printf '{}\n' ;;
    esac
    ;;

  curl)
    output=''
    url=''
    previous=''
    for argument in "$@"; do
      if [[ $previous == -o ]]; then output=$argument; fi
      [[ $argument == mock://* || $argument == http://* || $argument == https://* ]] && url=$argument
      previous=$argument
    done
    if [[ -n $output ]]; then
      mkdir -p -- "$(dirname -- "$output")"
      if [[ $url == https://t4code.net/releases/latest.json* ]]; then
        version=1.2.3
        release_tag=v$version
        release_url="https://github.com/wolfiesch/omperator/releases/tag/$release_tag"
        release_prefix="https://github.com/wolfiesch/omperator/releases/download/$release_tag"
        published_at=2026-07-15T00:00:00Z
        schema=1
        manifest_version=$version
        manifest_tag=$release_tag
        deb_size=${mockDebSize}
        deb_digest=$(printf 'mock-deb\n' | sha256sum | awk '{print $1}')
        asset_digest=$(printf 'mock-asset\n' | sha256sum | awk '{print $1}')
        apk_digest=$asset_digest
        apk_url="$release_prefix/T4-Code-$version-android.apk"
        extra=''
        case \${MOCK_SITE_MANIFEST_MODE:-valid} in
          schema) schema=2 ;;
          version) manifest_version=9.9.9 ;;
          tag) manifest_tag=v9.9.9 ;;
          release-url) release_url=https://example.invalid/release ;;
          extra-asset) extra=',{"platform":"linux","kind":"deb","arch":"x86_64","name":"extra.deb","url":"https://example.invalid/extra.deb","size":${mockAssetSize},"sha256":"'"$asset_digest"'"}' ;;
          size) deb_size=$((deb_size - 1)) ;;
          digest) apk_digest=$(printf '%064d' 0) ;;
          asset-url) apk_url=https://example.invalid/android.apk ;;
        esac
        cat >"$output" <<JSON
{"schemaVersion":$schema,"channel":"stable","version":"$manifest_version","tag":"$manifest_tag","publishedAt":"$published_at","releaseUrl":"$release_url","assets":[
  {"platform":"android","kind":"apk","arch":"universal","name":"T4-Code-$version-android.apk","url":"$apk_url","size":${mockAssetSize},"sha256":"$apk_digest"},
  {"platform":"linux","kind":"deb","arch":"x86_64","name":"T4-Code-$version-linux-amd64.deb","url":"$release_prefix/T4-Code-$version-linux-amd64.deb","size":$deb_size,"sha256":"$deb_digest"},
  {"platform":"linux","kind":"appimage","arch":"x86_64","name":"T4-Code-$version-linux-x86_64.AppImage","url":"$release_prefix/T4-Code-$version-linux-x86_64.AppImage","size":${mockAssetSize},"sha256":"$asset_digest"},
  {"platform":"mac","kind":"dmg","arch":"arm64","name":"T4-Code-$version-mac-arm64.dmg","url":"$release_prefix/T4-Code-$version-mac-arm64.dmg","size":${mockAssetSize},"sha256":"$asset_digest"},
  {"platform":"mac","kind":"zip","arch":"arm64","name":"T4-Code-$version-mac-arm64.zip","url":"$release_prefix/T4-Code-$version-mac-arm64.zip","size":${mockAssetSize},"sha256":"$asset_digest"}$extra
]}
JSON
      elif [[ $url == *SHA256SUMS* ]]; then
        version=1.2.3
        [[ $url =~ /v([0-9]+\.[0-9]+\.[0-9]+)/SHA256SUMS\.txt ]] && version=\${BASH_REMATCH[1]}
        deb_digest=$(printf 'mock-deb\n' | sha256sum | awk '{print $1}')
        asset_digest=$(printf 'mock-asset\n' | sha256sum | awk '{print $1}')
        metadata=$(linux_update_metadata "$version")
        metadata_digest=$(printf '%s\n' "$metadata" | sha256sum | awk '{print $1}')
        printf '%s  T4-Code-%s-android.apk\n%s  T4-Code-%s-linux-amd64.deb\n%s  T4-Code-%s-linux-x86_64.AppImage\n%s  T4-Code-%s-mac-arm64.dmg\n%s  T4-Code-%s-mac-arm64.zip\n%s  latest-linux.yml\n' \
          "$asset_digest" "$version" "$deb_digest" "$version" "$asset_digest" "$version" \
          "$asset_digest" "$version" "$asset_digest" "$version" "$metadata_digest" >"$output"
      elif [[ $url == *latest-linux.yml ]]; then
        linux_update_metadata 1.2.3 >"$output"
      elif [[ $url == *linux-amd64.deb ]]; then
        printf 'mock-deb\n' >"$output"
      elif [[ $url == mock://omp-* && \${MOCK_OMP_ASSET_UNREACHABLE:-0} == 1 ]]; then
        exit 22
      elif [[ $url == mock://omp-* && \${MOCK_OMP_ASSET_DIGEST_MISMATCH:-0} == 1 ]]; then
        printf 'mismatched-omp-asset\n' >"$output"
      else
        printf 'mock-asset\n' >"$output"
      fi
      exit 0
    fi
    if [[ $url == http://127.0.0.1:* ]]; then
      [[ $(read_state gateway-service inactive) == active ]] || exit 22
      [[ $(read_state gateway-health healthy) == healthy ]] || exit 22
      sessions=$(read_state active-sessions 0)
      identity=$(read_state deployment-identity "sha256:$(printf old | sha256sum | awk '{print $1}')")
      if [[ \${MOCK_STALE_LOOPBACK_IDENTITY:-0} == 1 ]]; then
        identity="sha256:$(printf stale-loopback | sha256sum | awk '{print $1}')"
      fi
      printf '{"ok":true,"web":true,"upstream":true,"transport":"local-unix","activeSessions":%s,"deploymentIdentity":"%s"}\n' "$sessions" "$identity"
      exit 0
    fi
    if [[ $url == https://* ]]; then
      if [[ $url == https://github.com/wolfiesch/omperator/releases/download/* ]]; then
        exit 0
      fi
      if [[ $url == https://t4code.net/*assets/* ]]; then
        printf 'v1.2.3 t4code-1.2.3-appserver-1 T4-Code-1.2.3-android.apk T4-Code-1.2.3-linux-amd64.deb T4-Code-1.2.3-linux-x86_64.AppImage T4-Code-1.2.3-mac-arm64.dmg T4-Code-1.2.3-mac-arm64.zip\n'
        exit 0
      fi
      if [[ $url == https://t4code.net/* ]]; then
        printf '<script src="/assets/mock.js"></script>\n'
        exit 0
      fi
      [[ $(read_state tailnet-health healthy) == healthy ]] || exit 22
      identity=$(read_state deployment-identity "sha256:$(printf old | sha256sum | awk '{print $1}')")
      if [[ \${MOCK_STALE_TAILNET_IDENTITY:-0} == 1 ]]; then
        identity="sha256:$(printf stale | sha256sum | awk '{print $1}')"
      fi
      printf '{"ok":true,"web":true,"upstream":true,"transport":"local-unix","activeSessions":0,"deploymentIdentity":"%s"}\n' "$identity"
      exit 0
    fi
    ;;

  git)
    root=''
    if [[ \${1:-} == -C ]]; then
      root=$2
      shift 2
    fi
    if [[ \${1:-} == clone ]]; then
      destination=\${!#}
      mkdir -p -- "$destination"
      if [[ $destination == *omp-source ]]; then
        mkdir -p -- "$destination/packages/coding-agent/dist"
        printf 'omp\n' >"$destination/.mock-kind"
      else
        mkdir -p -- "$destination/compat" "$destination/scripts" \
          "$destination/apps/web/dist" \
          "$destination/node_modules/.pnpm/ws@mock/node_modules/ws"
        printf '{"version":"1.2.3"}\n' >"$destination/package.json"
        cat >"$destination/compat/omp-app-matrix.json" <<JSON
{"desktop":{"version":"1.2.3"},"verifiedRuntime":{"upstreamTag":"v1.2.3","upstreamCommit":"\${MOCK_UPSTREAM_COMMIT}","sourceTag":"t4code-1.2.3-appserver-1","sourceCommit":"\${MOCK_INTEGRATION_COMMIT}"}}
JSON
        printf 'service\n' >"$destination/scripts/tailnet-service.mjs"
        printf 'gateway\n' >"$destination/scripts/tailnet-gateway.mjs"
        printf '<html>built</html>\n' >"$destination/apps/web/dist/index.html"
        printf '{"name":"ws"}\n' >"$destination/node_modules/.pnpm/ws@mock/node_modules/ws/package.json"
        if [[ \${MOCK_WS_ESCAPE:-0} == 1 ]]; then
          ln -s -- "$state/escaping-ws" "$destination/node_modules/ws"
        else
          ln -s -- .pnpm/ws@mock/node_modules/ws "$destination/node_modules/ws"
        fi
        printf 't4\n' >"$destination/.mock-kind"
        write_state prepared 1
      fi
      exit 0
    fi
    case \${1:-} in
      init) exit 0 ;;
      rev-parse)
        if [[ $* == *refs/remotes/official/main* ]]; then
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        elif [[ $* == *refs/remotes/fork/main* ]]; then
          if [[ -f $state/fork-main-synced ]]; then
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          elif [[ \${MOCK_FORK_MAIN_RACE_ONCE:-0} == 1 && ! -f $state/fork-main-race-consumed ]]; then
            write_state fork-main-race-consumed 1
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          elif [[ \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
            printf '%040d\n' 9
          elif [[ \${MOCK_FORK_MAIN_BEHIND:-0} == 1 ]]; then
            printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
          else
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          fi
        elif [[ -f $root/.mock-kind && $(cat "$root/.mock-kind") == omp ]]; then
          printf '%s\n' "$MOCK_INTEGRATION_COMMIT"
        else
          printf '%s\n' "$MOCK_T4_COMMIT"
        fi
        ;;
      merge-base)
        if [[ $* == *refs/remotes/fork/main* && \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
          exit 1
        fi
        if [[ \${MOCK_PRODUCT_BRANCH_MISSING:-0} == 1 && $* == *refs/remotes/origin/t4code/main* ]]; then
          exit 1
        fi
        exit 0
        ;;
      push)
        if [[ \${MOCK_FORK_MAIN_PUSH_ACCEPTED_FAIL:-0} == 1 ]]; then
          write_state fork-main-synced 1
          exit 1
        fi
        [[ \${MOCK_FORK_MAIN_PUSH_FAIL:-0} != 1 ]] || exit 1
        write_state fork-main-synced 1
        exit 0
        ;;
      hash-object) /usr/bin/git "$@" ;;
      diff|remote|fetch) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;

  bun)
    if [[ \${*:-} == *'run build'* ]]; then
      candidate="$PWD/packages/coding-agent/dist/omp"
      mkdir -p -- "$(dirname -- "$candidate")"
      cat >"$candidate" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'omp-candidate' >>"$MOCK_CALLS"
printf '\t%q' "$@" >>"$MOCK_CALLS"
printf '\n' >>"$MOCK_CALLS"
case \${1:-} in
  --version) printf 'omp/1.2.3\n' ;;
  --smoke-test) exit 0 ;;
  appserver)
    case \${2:-} in
      status)
        [[ \${3:-} == --json ]] || exit 2
        printf '{"state":"running","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
        ;;
      drain-if-idle)
        if [[ \${3:-} == --help ]]; then
          printf 'drain-if-idle help\n'
          exit 0
        fi
        [[ \${3:-} == --json ]] || exit 2
        [[ \${MOCK_NEW_APP_DRAIN_UNSUPPORTED:-0} != 1 ]] || exit 2
        expected_host= expected_epoch=
        shift 3
        while (($#)); do
          case $1 in
            --expected-host-id) expected_host=$2; shift 2 ;;
            --expected-epoch) expected_epoch=$2; shift 2 ;;
            *) exit 2 ;;
          esac
        done
        if [[ $expected_host != mock-host || $expected_epoch != mock-epoch ]]; then
          if [[ \${MOCK_NEW_APP_DRAIN_MALFORMED:-0} == 1 ]]; then
            printf 'not-json\n'
          elif [[ \${MOCK_NEW_APP_DRAIN_WRONG_IDENTITY:-0} == 1 ]]; then
            printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"changed-host","epoch":"changed-epoch"}}\n'
          else
            printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
          fi
          [[ \${MOCK_NEW_APP_DRAIN_WRONG_STATUS:-0} != 1 ]] || exit 0
          exit 75
        fi
        [[ \${MOCK_NEW_APP_DRAIN_BUSY:-0} != 1 ]] || exit 75
        if [[ \${MOCK_NEW_APP_DRAIN_IDENTITY_MISMATCH:-0} == 1 ]]; then
          host_id=changed-host
          epoch=changed-epoch
        else
          host_id=mock-host
          epoch=mock-epoch
        fi
        printf '{"state":"draining","health":{"ok":true,"hostId":"%s","epoch":"%s"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\n' "$host_id" "$epoch"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 0 ;;
esac
SH
      chmod 0755 "$candidate"
    fi
    ;;

  pnpm)
    exit 0
    ;;

  omp)
    count=$(read_state sol-count 0)
    write_state sol-count $((count + 1))
    printf 'sol-env\t%q\t%q\t%q\n' "$T4_MAINTENANCE_CONTEXT" "$T4_MAINTENANCE_RESULT" "$T4_MAINTENANCE_DEFERRAL_FILE" >>"$calls"
    write_state sol-ran 1
    if [[ \${MOCK_SOL_BACKGROUND_HOLDER:-0} == 1 ]]; then
      (sleep 30) >/dev/null 2>&1 &
      write_state sol-background-pid $!
    fi
    if [[ -n \${MOCK_SOL_RESULT_SYMLINK_SOURCE:-} ]]; then
      ln -s -- "$MOCK_SOL_RESULT_SYMLINK_SOURCE" "$T4_MAINTENANCE_RESULT"
    elif [[ -n \${MOCK_SOL_RESULT_SOURCE:-} ]]; then
      cp -- "$MOCK_SOL_RESULT_SOURCE" "$T4_MAINTENANCE_RESULT"
    fi
    if [[ -n \${MOCK_SOL_DEFERRAL_SYMLINK_SOURCE:-} ]]; then
      ln -s -- "$MOCK_SOL_DEFERRAL_SYMLINK_SOURCE" "$T4_MAINTENANCE_DEFERRAL_FILE"
    elif [[ -n \${MOCK_SOL_DEFERRAL_SOURCE:-} ]]; then
      cp -- "$MOCK_SOL_DEFERRAL_SOURCE" "$T4_MAINTENANCE_DEFERRAL_FILE"
    fi
    if [[ -n \${MOCK_SOL_DEFERRAL_MODE:-} && -e $T4_MAINTENANCE_DEFERRAL_FILE ]]; then
      chmod "$MOCK_SOL_DEFERRAL_MODE" "$T4_MAINTENANCE_DEFERRAL_FILE"
    fi
    exit \${MOCK_SOL_STATUS:-86}
    ;;

  node)
    script=\${1:-}
    action=\${2:-}
    if [[ $script == */inspect-linux-update.mjs ]]; then
      exec "$MOCK_NODE_EXECUTABLE" "$@"
    fi
    if [[ $script == */scripts/tailnet-service.mjs && $action == install ]]; then
      runtime=$(dirname -- "$(dirname -- "$script")")
      shift 2
      origin='' port='' web_root='' app_socket='' label='' deployment_identity='' defer_start=false
      profile_routes=null start_profiles=false
      while (($#)); do
        case $1 in
          --defer-start) defer_start=true; shift ;;
          --origin) origin=$2; shift 2 ;;
          --port) port=$2; shift 2 ;;
          --web-root) web_root=$2; shift 2 ;;
          --app-socket) app_socket=$2; shift 2 ;;
          --label) label=$2; shift 2 ;;
          --deployment-identity) deployment_identity=$2; shift 2 ;;
          --profile-routes) profile_routes=$2; shift 2 ;;
          --start-profiles) start_profiles=true; shift ;;
          *) shift ;;
        esac
      done
      jq -n \
        --arg sourceRoot "$runtime" \
        --arg nodeExecutable "$MOCK_NODE_EXECUTABLE" \
        --arg gatewayScript "$runtime/scripts/tailnet-gateway.mjs" \
        --arg allowedOrigin "$origin" \
        --argjson port "$port" \
        --arg appSocket "$app_socket" \
        --arg hostLabel "$label" \
        --arg deploymentIdentity "$deployment_identity" \
        --arg webRoot "$web_root" \
        --argjson profileRoutes "$profile_routes" \
        --argjson startProfiles "$start_profiles" \
        '{
          sourceRoot:$sourceRoot,
          nodeExecutable:$nodeExecutable,
          gatewayScript:$gatewayScript,
          webRoot:$webRoot,
          allowedOrigin:$allowedOrigin,
          port:$port,
          appSocket:$appSocket,
          "label":$hostLabel,
          deploymentIdentity:$deploymentIdentity
        } + (if $profileRoutes == null then {} else {
          profileRoutes:$profileRoutes,
          startProfiles:$startProfiles
        } end)' \
        >"$MOCK_GATEWAY_CONFIG"
      printf 'new-unit\n' >"$MOCK_GATEWAY_UNIT"
      write_state deployment-identity "$deployment_identity"
      if [[ $defer_start == true ]]; then
        write_state gateway-enablement disabled
        write_state gateway-service inactive
      else
        write_state gateway-enablement enabled
        write_state gateway-service active
      fi
      write_state gateway-health healthy
      exit 0
    fi
    if [[ $script == */scripts/tailnet-service.mjs && $action == start ]]; then
      write_state gateway-enablement enabled
      write_state gateway-service active
      write_state gateway-health healthy
      exit 0
    fi
    if [[ $script == */scripts/tailnet-service.mjs && $action == status ]]; then
      [[ $(read_state gateway-service inactive) == active ]]
      exit
    fi
    exit 2
    ;;

  systemctl)
    args=("$@")
    filtered=()
    for argument in "\${args[@]}"; do
      [[ $argument == --user ]] || filtered+=("$argument")
    done
    command=\${filtered[0]:-}
    service=''
    for argument in "\${filtered[@]:1}"; do
      [[ $argument == *.service ]] && service=$argument
    done
    key=gateway-service
    [[ $service == "$MOCK_OMP_SERVICE" ]] && key=app-service
    case $command in
      is-active) [[ $(read_state "$key" inactive) == active ]] ;;
      is-enabled)
        enablement=$(read_state gateway-enablement disabled)
        printf '%s\n' "$enablement"
        [[ $enablement == enabled ]]
        ;;
      enable)
        write_state gateway-enablement enabled
        for argument in "\${filtered[@]:1}"; do
          if [[ $argument == --now ]]; then write_state "$key" active; fi
        done
        exit 0
        ;;
      disable)
        if [[ $key == gateway-service && \${MOCK_GATEWAY_DISABLE_FAIL_AFTER_FIRST:-0} == 1 ]]; then
          disable_count=$(read_state gateway-disable-count 0)
          disable_count=$((disable_count + 1))
          write_state gateway-disable-count "$disable_count"
          [[ $disable_count -le 1 ]] || exit 72
        fi
        write_state gateway-enablement disabled
        for argument in "\${filtered[@]:1}"; do
          if [[ $argument == --now ]]; then write_state "$key" inactive; fi
        done
        exit 0
        ;;
      show)
        if [[ $key == app-service && $(read_state "$key" inactive) == active ]]; then
          if [[ -f $state/mainpid-zero ]]; then printf '0\n'; else cat "$state/app-pid"; fi
        else
          printf '0\n'
        fi
        ;;
      stop) write_state "$key" inactive ;;
      start|restart)
        write_state "$key" active
        if [[ $key == app-service ]]; then
          cp -- "$MOCK_OMP_TARGET" "$MOCK_PROC_EXE"
          rm -f -- "$state/mainpid-zero" "$state/app-drained"
          if [[ \${MOCK_APP_START_FAIL_ACTIVE:-0} == 1 && ! -f $state/app-start-failed-once ]]; then
            write_state app-start-failed-once 1
            exit 69
          fi
        fi
        exit 0
        ;;
      daemon-reload) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;

  realpath)
    [[ \${1:-} == -e ]] && shift
    [[ \${1:-} == -- ]] && shift
    exec "$MOCK_NODE_EXECUTABLE" -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync.native(process.argv[1])+"\n")' "$1"
    ;;

  uname)
    [[ \${1:-} == -s ]] && printf 'Linux\n' || printf 'Linux\n'
    ;;

  pgrep)
    if [[ \${1:-} == -x || \${1:-} == -f ]]; then
      if [[ -f $state/desktop-busy ]]; then exit 0; fi
      if [[ -f $state/busy-after-stage && -f $state/prepared ]]; then exit 0; fi
      exit 1
    fi
    if [[ \${1:-} == -P ]]; then
      [[ -f $state/child-busy ]]
      exit
    fi
    exit 1
    ;;

  sudo)
    count=$(read_state sudo-count 0)
    count=$((count + 1))
    write_state sudo-count "$count"
    [[ \${MOCK_SUDO_DENY:-0} != 1 ]] || exit 1
    [[ \${MOCK_SUDO_DENY_AFTER_FIRST:-0} != 1 || $count -le 1 ]] || exit 1
    [[ \${1:-} == -n ]] && shift
    exec "$@"
    ;;

  apt-get)
    for argument in "$@"; do
      [[ $argument != --simulate ]] || exit 0
    done
    count=$(read_state apt-count 0)
    count=$((count + 1))
    write_state apt-count "$count"
    if [[ \${MOCK_ROLLBACK_APT_FAIL:-0} == 1 && $count -gt 1 ]]; then exit 70; fi
    deb=\${!#}
    version=1.2.3
    [[ $deb =~ T4-Code-([0-9]+\.[0-9]+\.[0-9]+)-linux-amd64\.deb$ ]] && version=\${BASH_REMATCH[1]}
    write_state package-version "$version"
    if [[ \${MOCK_MUTATE_OVERLAY_AFTER_APT:-0} == 1 && $count -eq 1 ]]; then
      printf 'mutated-overlay\n' >"$MOCK_OVERLAY_PACKAGE"
    fi
    if [[ \${MOCK_TAMPER_SEALED_AFTER_APT:-0} == 1 && $count -eq 1 ]]; then
      chmod 600 "$MOCK_SEALED_PACKAGE"
      printf 'tampered-sealed-overlay\n' >"$MOCK_SEALED_PACKAGE"
    fi
    mkdir -p -- "$(dirname -- "$MOCK_T4_EXECUTABLE")" "$MOCK_T4_WEB_ROOT"
    printf '#!/bin/sh\nexit 0\n' >"$MOCK_T4_EXECUTABLE"
    chmod 0755 "$MOCK_T4_EXECUTABLE"
    printf '<html>installed</html>\n' >"$MOCK_T4_WEB_ROOT/index.html"
    ;;

  dpkg-query)
    printf 'install ok installed\t%s\n' "$(read_state package-version 1.2.3)"
    ;;

  dpkg)
    if [[ -f $state/package-dirty ]]; then printf 'dirty\n'; fi
    ;;

  dpkg-deb)
    if [[ \${1:-} == --fsys-tarfile ]]; then
      tar_root=$(mktemp -d)
      mkdir -p "$tar_root/opt/T4 Code/resources"
      printf 'mock-app-asar\n' >"$tar_root/opt/T4 Code/resources/app.asar"
      tar -cf - -C "$tar_root" './opt/T4 Code/resources/app.asar'
      rm -rf -- "$tar_root"
      exit 0
    fi
    field=\${!#}
    if [[ $field == Package ]]; then
      printf 't4-code\n'
    else
      deb=\${*: -2:1}
      version=1.2.3
      [[ $deb =~ T4-Code-([0-9]+\.[0-9]+\.[0-9]+)-linux-amd64\.deb$ ]] && version=\${BASH_REMATCH[1]}
      printf '%s\n' "$version"
    fi
    ;;

  sha256sum)
    if [[ \${1:-} == /proc/*/exe ]]; then
      set -- "$MOCK_PROC_EXE"
    fi
    exec "$MOCK_NODE_EXECUTABLE" -e 'const fs=require("node:fs");const crypto=require("node:crypto");const path=process.argv[1];const data=path ? fs.readFileSync(path) : fs.readFileSync(0);process.stdout.write(crypto.createHash("sha256").update(data).digest("hex")+"  "+(path || "-")+"\n")' "$@"
    ;;

  *)
    printf 'unsupported mock tool: %s\n' "$tool" >&2
    exit 127
    ;;
esac
`.replaceAll("\\${", "${");

export const mockLocalDeploy = String.raw`#!/usr/bin/env bash
set -euo pipefail
result=$1
receipt=$2
work=$3
printf 'local-deploy\t%q\t%q\t%q\n' "$result" "$receipt" "$work" >>"$MOCK_CALLS"
count=0
[[ ! -f $MOCK_STATE/local-deploy-count ]] || count=$(<"$MOCK_STATE/local-deploy-count")
printf '%s' "$((count + 1))" >"$MOCK_STATE/local-deploy-count"
[[ \${MOCK_LOCAL_DEPLOY_FAIL:-0} != 1 ]] || exit 75
mkdir -p -- "$(dirname -- "$receipt")" "$work"
mkdir -p -- \
  "$MOCK_RUNTIME_ROOT/scripts" \
  "$MOCK_RUNTIME_ROOT/apps/web/dist" \
  "$MOCK_RUNTIME_ROOT/node_modules/ws"
printf 'service\n' >"$MOCK_RUNTIME_ROOT/scripts/tailnet-service.mjs"
printf 'gateway\n' >"$MOCK_RUNTIME_ROOT/scripts/tailnet-gateway.mjs"
printf '<html>runner</html>\n' >"$MOCK_RUNTIME_ROOT/apps/web/dist/index.html"
printf '{"name":"ws"}\n' >"$MOCK_RUNTIME_ROOT/node_modules/ws/package.json"
printf 'new-unit\n' >"$MOCK_GATEWAY_UNIT"
cat >"$MOCK_OMP_TARGET" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case \${1:-} in
  --version) printf 'omp/1.2.3\n' ;;
  appserver)
    [[ \${2:-} == status && \${3:-} == --json ]] || exit 2
    printf '{"state":"running","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
    ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$MOCK_OMP_TARGET"
cp -- "$MOCK_OMP_TARGET" "$MOCK_PROC_EXE"
omp_sha=$(sha256sum "$MOCK_OMP_TARGET" | awk '{print $1}')
deployment_identity="sha256:$(printf '%s\0%s\0%s\0' "$MOCK_T4_COMMIT" "$MOCK_INTEGRATION_COMMIT" "$omp_sha" | sha256sum | awk '{print $1}')"
printf '1.2.3' >"$MOCK_STATE/package-version"
printf 'active' >"$MOCK_STATE/app-service"
printf 'active' >"$MOCK_STATE/gateway-service"
printf 'enabled' >"$MOCK_STATE/gateway-enablement"
printf 'healthy' >"$MOCK_STATE/gateway-health"
printf '%s' "$deployment_identity" >"$MOCK_STATE/deployment-identity"

gateway_script="$MOCK_RUNTIME_ROOT/scripts/tailnet-gateway.mjs"
web_root="$MOCK_RUNTIME_ROOT/apps/web/dist"
ws_root="$MOCK_RUNTIME_ROOT/node_modules/ws"
node_executable="$MOCK_NODE_EXECUTABLE"
gateway_origin=https://mock.tailnet.ts.net
gateway_port=4319
gateway_socket=$(<"$MOCK_STATE/socket-path")
gateway_label=mock
jq -n \
  --arg sourceRoot "$MOCK_RUNTIME_ROOT" \
  --arg allowedOrigin "$gateway_origin" \
  --argjson port "$gateway_port" \
  --arg appSocket "$gateway_socket" \
  --arg hostLabel "$gateway_label" \
  --arg nodeExecutable "$node_executable" \
  --arg gatewayScript "$gateway_script" \
  --arg webRoot "$web_root" \
  --arg deploymentIdentity "$deployment_identity" \
  '{
    sourceRoot: $sourceRoot,
    allowedOrigin: $allowedOrigin,
    port: $port,
    appSocket: $appSocket,
    "label": $hostLabel,
    nodeExecutable: $nodeExecutable,
    gatewayScript: $gatewayScript,
    webRoot: $webRoot,
    deploymentIdentity: $deploymentIdentity
  }' >"$MOCK_GATEWAY_CONFIG"

tree_sha() {
  local root=$1 relative digest
  (
    cd -- "$root"
    while IFS= read -r -d '' relative; do
      digest=$(sha256sum "$relative" | awk '{print $1}')
      printf '%s\0%s\0' "$relative" "$digest"
    done < <(find . -type f -print0 | LC_ALL=C sort -z)
  ) | sha256sum | awk '{print $1}'
}

gateway_script_sha=$(sha256sum "$gateway_script" | awk '{print $1}')
web_tree_sha=$(tree_sha "$web_root")
ws_tree_sha=$(tree_sha "$ws_root")
config_sha=$(sha256sum "$MOCK_GATEWAY_CONFIG" | awk '{print $1}')
unit_sha=$(sha256sum "$MOCK_GATEWAY_UNIT" | awk '{print $1}')
jq -n \
  --slurpfile publication "$result" \
  --arg omp_target "$MOCK_OMP_TARGET" \
  --arg omp_sha "$omp_sha" \
  --arg runtime_root "$MOCK_RUNTIME_ROOT" \
  --arg runtime_commit "$MOCK_T4_COMMIT" \
  --arg work "$work" \
  --arg gateway_script_sha "$gateway_script_sha" \
  --arg web_tree_sha "$web_tree_sha" \
  --arg ws_tree_sha "$ws_tree_sha" \
  --arg config_sha "$config_sha" \
  --arg unit_sha "$unit_sha" \
  --arg gateway_origin "$gateway_origin" \
  --argjson gateway_port "$gateway_port" \
  --arg gateway_socket "$gateway_socket" \
  --arg gateway_label "$gateway_label" \
  --arg deployment_identity "$deployment_identity" \
  --arg node_executable "$node_executable" '
  {
    schemaVersion: 1,
    status: "complete",
    upstream: $publication[0].upstream,
    integration: $publication[0].integration,
    t4: $publication[0].t4,
    omp: {
      target: $omp_target,
      version: "omp/1.2.3",
      installedSha256: $omp_sha,
      runningExecutableSha256: $omp_sha,
      previousSha256: $omp_sha,
      service: "mock-omp.service",
      mainPid: 1,
      health: "healthy",
      hostId: "mock-host",
      epoch: "mock-epoch"
    },
    desktop: {
      package: "t4-code",
      installedVersion: "1.2.3",
      previousVersion: "1.2.2",
      debSha256: $omp_sha,
      dpkgVerification: "clean"
    },
    gateway: {
      service: "mock-gateway.service",
      activeState: "active",
      health: "healthy",
      helperStatus: "healthy",
      loopbackHealth: "healthy",
      tailnetHealth: "pending",
      runtimeSourceRoot: $runtime_root,
      runtimeCommit: $runtime_commit,
      allowedOrigin: $gateway_origin,
      port: $gateway_port,
      appSocket: $gateway_socket,
      "label": $gateway_label,
        nodeExecutable: $node_executable,
        deploymentIdentity: $deployment_identity,
      artifacts: {
        gatewayScriptSha256: $gateway_script_sha,
        webTreeSha256: $web_tree_sha,
        wsTreeSha256: $ws_tree_sha,
        configSha256: $config_sha,
        unitSha256: $unit_sha
      }
    },
    rollback: {available: true, backupDirectory: $work}
  }
' >"$receipt"
`.replaceAll("\\${", "${");

export function forgedOmpPublicProof() {
  const digest = createHash("sha256").update("mock-asset\n").digest("hex");
  const canonical = {
    tagName: "t4code-1.2.3-appserver-1",
    htmlUrl:
      "https://github.com/wolfiesch/oh-my-pi/releases/tag/t4code-1.2.3-appserver-1",
    assets: [
      "omp-linux-x64",
      "omp-linux-arm64",
      "omp-darwin-x64",
      "omp-darwin-arm64",
      "omp-windows-x64.exe",
    ]
      .sort()
      .map((name) => ({
        name,
        state: "uploaded",
        size: 11,
        digest: `sha256:${digest}`,
        browserDownloadUrl: `mock://${name}`,
      })),
  };
  const canonicalJson = spawnSync("jq", ["-cS", "."], {
    encoding: "utf8",
    input: JSON.stringify(canonical),
  });
  assert.equal(canonicalJson.status, 0, canonicalJson.stderr);
  return {
    verifiedAt: "2099-01-01T00:00:00Z",
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson.stdout.trim()).digest("hex")}`,
    canonical,
  };
}

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

export async function createDeployFixture(options = {}) {
  const previousVersion = options.sameVersion ? "1.2.3" : "1.2.2";
  const manifestKind = options.manifestKind ?? "t4-maintainer-local-deployment";
  const root = await makeCanonicalTemporaryDirectory("t4-maintainer-contract-");
  const home = join(root, "home");
  const state = join(root, "mock-state");
  const bin = join(root, "bin");
  const maintainerRoot = join(root, "maintainer");
  const privilegeBin = join(maintainerRoot, "test-bin");
  const runRoot = join(maintainerRoot, "runs", "fixture");
  const work = join(runRoot, "local-work");
  const result = join(runRoot, "result.json");
  const receipt = join(runRoot, "local-deployment.json");
  const calls = join(root, "calls.log");
  const ompTarget = join(home, "bin", "omp");
  const socket = join(root, "runtime", "omp.sock");
  const gatewayConfig = join(home, ".config", "t4-code", "tailnet-gateway.json");
  const gatewayService = "mock-gateway.service";
  const ompService = "mock-omp.service";
  const gatewayUnit = join(home, ".config", "systemd", "user", gatewayService);
  const t4Executable = join(root, "opt", "T4 Code", "t4-code");
  const t4AppAsar = join(root, "opt", "T4 Code", "resources", "app.asar");
  const t4WebRoot = join(root, "opt", "T4 Code", "resources", "web");
  const previousRuntime = join(root, "previous-runtime");
  const overlayPackage = join(root, "operator-overlay.deb");
  const overlayReceipt = join(maintainerRoot, "state", "operator-overlay.json");
  const deployments = join(maintainerRoot, "deployments");
  const procRoot = join(maintainerRoot, "mock-proc");
  const procExecutableCopy = join(procRoot, "immutable-omp");

  await mkdir(dirname(ompTarget), { recursive: true });
  await mkdir(dirname(socket), { recursive: true });
  await mkdir(dirname(gatewayConfig), { recursive: true });
  await mkdir(dirname(gatewayUnit), { recursive: true });
  await mkdir(dirname(t4AppAsar), { recursive: true });
  await mkdir(t4WebRoot, { recursive: true });
  await mkdir(previousRuntime, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(privilegeBin, { recursive: true });
  await mkdir(procRoot, { recursive: true });

  await writeFile(calls, "");
  if (options.wsEscape) {
    const escapingWs = join(state, "escaping-ws");
    await mkdir(escapingWs, { recursive: true });
    await writeFile(join(escapingWs, "package.json"), '{"name":"ws"}\n');
  }

  await writeFile(
    result,
    `${JSON.stringify({
      upstream: { tag: "v1.2.3", commit: upstreamCommit },
      integration: { tag: "t4code-1.2.3-appserver-1", commit: integrationCommit },
      t4: { version: "1.2.3", tag: "v1.2.3", commit: t4Commit },
      release: { url: "https://github.com/wolfiesch/omperator/releases/tag/v1.2.3" },
      site: { url: "https://t4code.net", releaseTag: "v1.2.3" },
    })}\n`,
  );
  await writeFile(
    ompTarget,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'omp-target' >>"$MOCK_CALLS"
printf '\\t%q' "$@" >>"$MOCK_CALLS"
printf '\\n' >>"$MOCK_CALLS"
case \${1:-} in
  --version) printf 'omp/1.2.2\\n' ;;
  appserver)
    case \${2:-} in
      status)
        [[ \${3:-} == --json ]] || exit 2
        if [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
          printf '{"state":"running","health":{"ok":true,"hostId":"t4-maintainer-capability-probe","epoch":"t4-maintainer-capability-probe"}}\\n'
        else
          printf '{"state":"running","health":{"ok":true,"hostId":"old-host","epoch":"old-epoch"}}\\n'
        fi
        ;;
      drain-if-idle)
        if [[ \${3:-} == --help ]]; then
          [[ \${MOCK_DRAIN_CAPABILITY_MISSING:-0} != 1 ]] || exit 2
          if [[ \${MOCK_DRAIN_GENERIC_HELP:-0} == 1 ]]; then
            printf 'generic appserver help\\n'
            exit 0
          fi
          printf 'drain-if-idle help\\n'
          exit 0
        fi
        [[ \${3:-} == --json ]] || exit 2
        if [[ \${5:-} == t4-maintainer-capability-host-* &&
              \${7:-} == t4-maintainer-capability-epoch-* ]]; then
          if [[ \${MOCK_DRAIN_PROBE_WRONG_IDENTITY:-0} == 1 ]]; then
            host_id=changed-host
            epoch=changed-epoch
          elif [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
            host_id=t4-maintainer-capability-probe
            epoch=t4-maintainer-capability-probe
          else
            host_id=old-host
            epoch=old-epoch
          fi
          printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"%s","epoch":"%s"}}\\n' "$host_id" "$epoch"
          if [[ \${MOCK_DRAIN_PROBE_WRONG_STATUS:-0} == 1 ]]; then exit 0; fi
          exit 75
        fi
        [[ \${MOCK_DRAIN_BUSY:-0} != 1 ]] || exit 75
        printf '1' >"$MOCK_STATE/app-drained"
        if [[ \${MOCK_DRAIN_IDENTITY_MISMATCH:-0} == 1 ]]; then
          printf '{"state":"draining","health":{"ok":true,"hostId":"changed-host","epoch":"changed-epoch"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        elif [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
          printf '{"state":"draining","health":{"ok":true,"hostId":"t4-maintainer-capability-probe","epoch":"t4-maintainer-capability-probe"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        else
          printf '{"state":"draining","health":{"ok":true,"hostId":"old-host","epoch":"old-epoch"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
  );
  await copyFile(ompTarget, procExecutableCopy);
  await chmod(procExecutableCopy, 0o751);
  await chmod(ompTarget, 0o751);
  await writeFile(t4Executable, "#!/bin/sh\nexit 0\n");
  await chmod(t4Executable, 0o755);
  await writeFile(t4AppAsar, "mock-app-asar\n");
  const installedOmpSha = createHash("sha256").update(await readFile(ompTarget)).digest("hex");
  const deploymentIdentity = `sha256:${createHash("sha256")
    .update(`${t4Commit}\0${integrationCommit}\0${installedOmpSha}\0`)
    .digest("hex")}`;
  await writeFile(join(t4WebRoot, "index.html"), "old-web\n");
  await writeFile(
    gatewayConfig,
    `${JSON.stringify({
      sourceRoot: join(root, "previous-runtime"),
      allowedOrigin: "https://mock.tailnet.ts.net",
      port: 4319,
      appSocket: socket,
      label: "mock",
      ...(options.sameVersion ? { deploymentIdentity } : {}),
      ...(options.profileRoutes === undefined
        ? {}
        : { profileRoutes: options.profileRoutes, startProfiles: options.startProfiles === true }),
    })}\n`,
  );
  if (options.sameVersion) {
    const appAsarSha = createHash("sha256").update("mock-app-asar\n").digest("hex");
    await writeFile(overlayPackage, "mock-overlay\n");
    const overlayPackageBytes = await readFile(overlayPackage);
    const overlayPackageSha = createHash("sha256").update(overlayPackageBytes).digest("hex");
    await writeFile(
      join(previousRuntime, "LOCAL_DEPLOYMENT.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: manifestKind,
        t4Commit,
        installedOmpSha256: installedOmpSha,
        reportedPackageVersion: previousVersion,
        deploymentIdentity,
      })}\n`,
    );
    if (options.overlayReceipt !== "missing") {
      await mkdir(dirname(overlayReceipt), { recursive: true });
      await writeFile(
        overlayReceipt,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "t4-maintainer-operator-overlay",
          artifact: {
            package: {
              path: overlayPackage,
              canonicalPath: overlayPackage,
              size: overlayPackageBytes.length,
              sha256: overlayPackageSha,
              version: previousVersion,
            },
            t4: { commit: t4Commit, appAsarSha256: appAsarSha },
            omp: { sha256: installedOmpSha },
            gateway: { deploymentIdentity },
          },
        })}\n`,
      );
      await chmod(overlayReceipt, 0o600);
    }
  }
  await writeFile(gatewayUnit, "old-unit\n");
  await writeFile(join(state, "package-version"), previousVersion);
  await writeFile(join(state, "active-sessions"), String(options.activeSessions ?? 0));
  await writeFile(join(state, "gateway-health"), options.gatewayHealthy === false ? "unhealthy" : "healthy");
  await writeFile(join(state, "tailnet-health"), "healthy");
  await writeFile(
    join(state, "deployment-identity"),
    options.sameVersion ? deploymentIdentity : `sha256:${createHash("sha256").update("old").digest("hex")}`,
  );
  await writeFile(join(state, "socket-path"), socket);
  await writeFile(join(state, "app-service"), options.appActive === false ? "inactive" : "active");
  await writeFile(
    join(state, "gateway-service"),
    options.gatewayActive === false ? "inactive" : "active",
  );
  await writeFile(
    join(state, "gateway-enablement"),
    options.gatewayEnabled === false ? "disabled" : "enabled",
  );
  if (options.desktopBusy) await writeFile(join(state, "desktop-busy"), "1");
  if (options.childBusy) await writeFile(join(state, "child-busy"), "1");
  if (options.mainPidZero) await writeFile(join(state, "mainpid-zero"), "1");
  if (options.busyAfterStage) await writeFile(join(state, "busy-after-stage"), "1");
  const dispatcher = join(bin, "mock-tool");
  await writeFile(dispatcher, mockDispatcher);
  const uname = join(privilegeBin, "uname");
  const setpriv = join(privilegeBin, "setpriv");
  await writeFile(uname, `#!/usr/bin/env bash\nprintf '${options.platform ?? "Linux"}\\n'\n`);
  await writeFile(
    setpriv,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'setpriv' >>"$MOCK_CALLS"
printf '\\t%q' "$@" >>"$MOCK_CALLS"
printf '\\n' >>"$MOCK_CALLS"
[[ \${1:-} == --no-new-privs && \${2:-} == -- ]] || exit 64
shift 2
exec "$@"
`,
  );
  await chmod(uname, 0o755);
  await chmod(setpriv, 0o755);
  await chmod(dispatcher, 0o755);
  for (const tool of [
    "gh",
    "curl",
    "git",
    "bun",
    "pnpm",
    "omp",
    "node",
    "systemctl",
    "pgrep",
    "sudo",
    "apt-get",
    "dpkg-query",
    "dpkg",
    "dpkg-deb",
    "sha256sum",
    "realpath",
  ]) {
    await symlink(dispatcher, join(bin, tool));
  }
  const portableTools = [
    ...(flockUnavailable ? [["flock", portableFlockMock]] : []),
    ...(statModeUnavailable ? [["stat", portableStatMock]] : []),
    ...(nullSortUnavailable ? [["sort", portableNullSortMock]] : []),
  ];
  for (const [tool, source] of portableTools) {
    const toolPath = join(bin, tool);
    await writeFile(toolPath, source);
    await chmod(toolPath, 0o755);
  }

  const socketProcess = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const fs=require('node:fs');const p=process.env.SOCKET;try{fs.unlinkSync(p)}catch{};net.createServer(()=>{}).listen(p)",
    ],
    { env: { ...process.env, SOCKET: socket }, stdio: "ignore" },
  );
  await waitForPath(socket);
  await writeFile(join(state, "app-pid"), `${socketProcess.pid}\n`);
  const procExecutable = join(procRoot, String(socketProcess.pid), "exe");
  await mkdir(dirname(procExecutable), { recursive: true });
  await symlink(procExecutableCopy, procExecutable);

  const env = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: dirname(socket),
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_STATE: state,
    MOCK_CALLS: calls,
    MOCK_UPSTREAM_COMMIT: upstreamCommit,
    MOCK_INTEGRATION_COMMIT: integrationCommit,
    MOCK_T4_COMMIT: t4Commit,
    MOCK_MAIN_COMMIT: mainCommit,
    MOCK_UPSTREAM_TAG_OBJECT: upstreamTagObject,
    MOCK_INTEGRATION_TAG_OBJECT: integrationTagObject,
    MOCK_BIN: bin,
    MOCK_OMP_TARGET: ompTarget,
    MOCK_PROC_EXE: procExecutableCopy,
    MOCK_OMP_SERVICE: ompService,
    MOCK_GATEWAY_CONFIG: gatewayConfig,
    MOCK_GATEWAY_UNIT: gatewayUnit,
    MOCK_NODE_EXECUTABLE: process.execPath,
    MOCK_T4_EXECUTABLE: t4Executable,
    MOCK_T4_WEB_ROOT: t4WebRoot,
    T4_MAINTAINER_ROOT: maintainerRoot,
    T4_MAINTAINER_TEST_MODE: "1",
    ...(process.platform === "linux" ? {} : { T4_MAINTAINER_TEST_PROC_ROOT: procRoot }),
    T4_MAINTAINER_GH: join(bin, "gh"),
    T4_MAINTAINER_CURL: join(bin, "curl"),
    T4_MAINTAINER_JQ: "jq",
    T4_MAINTAINER_GIT: join(bin, "git"),
    T4_MAINTAINER_BUN: join(bin, "bun"),
    T4_MAINTAINER_PNPM: join(bin, "pnpm"),
    T4_MAINTAINER_NODE: join(bin, "node"),
    T4_MAINTAINER_SUDO: join(bin, "sudo"),
    T4_MAINTAINER_APT_GET: join(bin, "apt-get"),
    T4_MAINTAINER_DPKG_QUERY: join(bin, "dpkg-query"),
    T4_MAINTAINER_DPKG: join(bin, "dpkg"),
    T4_MAINTAINER_DPKG_DEB: join(bin, "dpkg-deb"),
    T4_MAINTAINER_SHA256SUM: join(bin, "sha256sum"),
    T4_MAINTAINER_REALPATH: join(bin, "realpath"),
    ...(options.useHostPrivilegeTools
      ? {}
      : {
          T4_MAINTAINER_UNAME: uname,
          T4_MAINTAINER_SETPRIV: setpriv,
        }),
    T4_MAINTAINER_SYSTEMCTL: join(bin, "systemctl"),
    T4_MAINTAINER_SLEEP: "/usr/bin/true",
    T4_MAINTAINER_FORK_SYNC_EVENT_QUIESCE_SECONDS: "1",
    T4_MAINTAINER_FORK_SYNC_RUN_SETTLE_ATTEMPTS: "9",
    T4_MAINTAINER_FORK_SYNC_RUN_SETTLE_INTERVAL_SECONDS: "1",
    T4_MAINTAINER_FORK_SYNC_RUN_QUIET_POLLS: "3",
    T4_MAINTAINER_FORK_SYNC_RUN_MIN_OBSERVATION_POLLS: "7",
    T4_MAINTAINER_INSTALL: "install",
    MOCK_OVERLAY_PACKAGE: overlayPackage,
    MOCK_SEALED_PACKAGE: join(maintainerRoot, "state", "operator-overlays", `${createHash("sha256").update("mock-overlay\n").digest("hex")}.deb`),
    T4_MAINTAINER_SYNC: "/bin/sync",
    T4_LOCAL_OMP_TARGET: ompTarget,
    T4_LOCAL_OMP_SERVICE: ompService,
    T4_LOCAL_OMP_SOCKET: socket,
    T4_LOCAL_T4_EXECUTABLE: t4Executable,
    T4_LOCAL_T4_WEB_ROOT: t4WebRoot,
    T4_LOCAL_T4_APP_ASAR: t4AppAsar,
    T4_LOCAL_ROLLBACK_RECEIPT: overlayReceipt,
    T4_LOCAL_GATEWAY_SERVICE: gatewayService,
    T4_LOCAL_GATEWAY_CONFIG: gatewayConfig,
    T4_LOCAL_GATEWAY_UNIT: gatewayUnit,
    T4_LOCAL_DEPLOYMENTS_DIR: deployments,
    T4_LOCAL_HEALTH_ATTEMPTS: "1",
    T4_LOCAL_HEALTH_INTERVAL_SECONDS: "1",
    T4_LOCAL_MAIN_MIRROR_ATTEMPTS: "2",
    T4_LOCAL_MAIN_MIRROR_INTERVAL_SECONDS: "1",
    ...(options.wsEscape ? { MOCK_WS_ESCAPE: "1" } : {}),
    ...(options.rollbackAptFail ? { MOCK_ROLLBACK_APT_FAIL: "1" } : {}),
    ...(options.noSudo ? { MOCK_SUDO_DENY: "1" } : {}),
    ...(options.sudoExpires ? { MOCK_SUDO_DENY_AFTER_FIRST: "1" } : {}),
    ...(options.drainCapabilityMissing ? { MOCK_DRAIN_CAPABILITY_MISSING: "1" } : {}),
    ...(options.drainGenericHelp ? { MOCK_DRAIN_GENERIC_HELP: "1" } : {}),
    ...(options.drainProbeWrongStatus ? { MOCK_DRAIN_PROBE_WRONG_STATUS: "1" } : {}),
    ...(options.drainProbeWrongIdentity ? { MOCK_DRAIN_PROBE_WRONG_IDENTITY: "1" } : {}),
    ...(options.drainConstantIdentity ? { MOCK_DRAIN_CONSTANT_IDENTITY: "1" } : {}),
    ...(options.drainBusy ? { MOCK_DRAIN_BUSY: "1" } : {}),
    ...(options.drainIdentityMismatch ? { MOCK_DRAIN_IDENTITY_MISMATCH: "1" } : {}),
    ...(options.newAppDrainBusy ? { MOCK_NEW_APP_DRAIN_BUSY: "1" } : {}),
    ...(options.newAppDrainIdentityMismatch
      ? { MOCK_NEW_APP_DRAIN_IDENTITY_MISMATCH: "1" }
      : {}),
    ...(options.newAppDrainUnsupported ? { MOCK_NEW_APP_DRAIN_UNSUPPORTED: "1" } : {}),
    ...(options.newAppDrainMalformed ? { MOCK_NEW_APP_DRAIN_MALFORMED: "1" } : {}),
    ...(options.newAppDrainWrongStatus ? { MOCK_NEW_APP_DRAIN_WRONG_STATUS: "1" } : {}),
    ...(options.newAppDrainWrongIdentity ? { MOCK_NEW_APP_DRAIN_WRONG_IDENTITY: "1" } : {}),
    ...(options.appStartFailsActive ? { MOCK_APP_START_FAIL_ACTIVE: "1" } : {}),
    ...(options.forkMainDiverged ? { MOCK_FORK_MAIN_DIVERGED: "1" } : {}),
    ...(options.forkMainBehind ? { MOCK_FORK_MAIN_BEHIND: "1" } : {}),
    ...(options.forkMainRaceOnce ? { MOCK_FORK_MAIN_RACE_ONCE: "1" } : {}),
    ...(options.forkMainPushFail ? { MOCK_FORK_MAIN_PUSH_FAIL: "1" } : {}),
    ...(options.forkMainPushAcceptedFail ? { MOCK_FORK_MAIN_PUSH_ACCEPTED_FAIL: "1" } : {}),
    ...(options.forkWorkflowDisableFail ? { MOCK_FORK_WORKFLOW_DISABLE_FAIL: "1" } : {}),
    ...(options.forkWorkflowEnableFail ? { MOCK_FORK_WORKFLOW_ENABLE_FAIL: "1" } : {}),
    ...(options.forkMainRun ? { MOCK_FORK_MAIN_RUN: "1" } : {}),
    ...(options.forkMainRunPreexisting ? { MOCK_FORK_MAIN_RUN_PREEXISTING: "1" } : {}),
    ...(options.forkMainRunDelayPolls !== undefined
      ? { MOCK_FORK_MAIN_RUN_DELAY_POLLS: String(options.forkMainRunDelayPolls) }
      : {}),
    ...(options.forkMainRunCreatedAt
      ? { MOCK_FORK_MAIN_RUN_CREATED_AT: options.forkMainRunCreatedAt }
      : {}),
    ...(options.forkMainRunAttempt
      ? { MOCK_FORK_MAIN_RUN_ATTEMPT: String(options.forkMainRunAttempt) }
      : {}),
    ...(options.forkMainRunListFail ? { MOCK_FORK_MAIN_RUN_LIST_FAIL: "1" } : {}),
    ...(options.forkMainRunMalformed ? { MOCK_FORK_MAIN_RUN_MALFORMED: "1" } : {}),
    ...(options.forkMainRunTruncated ? { MOCK_FORK_MAIN_RUN_TRUNCATED: "1" } : {}),
    ...(options.forkMainRunCancelFail ? { MOCK_FORK_MAIN_RUN_CANCEL_FAIL: "1" } : {}),
    ...(options.forkMainRunCancelRace ? { MOCK_FORK_MAIN_RUN_CANCEL_RACE: "1" } : {}),
    ...(options.forkMainRunCancelStuck ? { MOCK_FORK_MAIN_RUN_CANCEL_STUCK: "1" } : {}),
    ...(options.forkBaseTagMissing ? { MOCK_FORK_BASE_TAG_MISSING: "1" } : {}),
    ...(options.forkBaseTagMismatch ? { MOCK_FORK_BASE_TAG_MISMATCH: "1" } : {}),
    ...(options.ompOfficialIdMismatch ? { MOCK_OMP_OFFICIAL_ID_MISMATCH: "1" } : {}),
    ...(options.ompOfficialCloneMismatch ? { MOCK_OMP_OFFICIAL_CLONE_MISMATCH: "1" } : {}),
    ...(options.ompForkIdMismatch ? { MOCK_OMP_FORK_ID_MISMATCH: "1" } : {}),
    ...(options.ompForkNodeMismatch ? { MOCK_OMP_FORK_NODE_MISMATCH: "1" } : {}),
    ...(options.ompForkParentMismatch ? { MOCK_OMP_FORK_PARENT_MISMATCH: "1" } : {}),
    ...(options.ompForkCloneMismatch ? { MOCK_OMP_FORK_CLONE_MISMATCH: "1" } : {}),
    ...(options.staleLoopbackIdentity ? { MOCK_STALE_LOOPBACK_IDENTITY: "1" } : {}),
    ...(options.staleTailnetIdentity ? { MOCK_STALE_TAILNET_IDENTITY: "1" } : {}),
    ...(options.gatewayDisableFailAfterFirst
      ? { MOCK_GATEWAY_DISABLE_FAIL_AFTER_FIRST: "1" }
      : {}),
    ...(options.productBranchMissing ? { MOCK_PRODUCT_BRANCH_MISSING: "1" } : {}),
    ...(options.prSequential ? { MOCK_PR_SEQUENTIAL: "1" } : {}),
    ...(options.prChangeAfter !== undefined
      ? { MOCK_PR_CHANGE_AFTER: String(options.prChangeAfter) }
      : {}),
    ...(options.prFailAfter !== undefined
      ? { MOCK_PR_FAIL_AFTER: String(options.prFailAfter) }
      : {}),
    ...(options.t4MainCommitChangeAfter !== undefined
      ? {
          MOCK_T4_MAIN_COMMIT_AFTER: String(options.t4MainCommitChangeAfter),
          MOCK_T4_MAIN_COMMIT_CHANGED: changedT4MainCommit,
        }
      : {}),
  };

  return {
    root,
    state,
    maintainerRoot,
    work,
    result,
    receipt,
    calls,
    ompTarget,
    t4AppAsar,
    previousRuntime,
    overlayPackage,
    overlayReceipt,
    gatewayConfig,
    procRoot,
    gatewayUnit,
    deployments,
    env,
    initial: {
      omp: await readFile(ompTarget),
      ompMode: (await lstat(ompTarget)).mode & 0o777,
      gatewayConfig: await readFile(gatewayConfig),
      gatewayUnit: await readFile(gatewayUnit),
      packageVersion: previousVersion,
      appService: options.appActive === false ? "inactive" : "active",
      gatewayService: options.gatewayActive === false ? "inactive" : "active",
      gatewayEnablement: options.gatewayEnabled === false ? "disabled" : "enabled",
    },
    run(extraEnv = {}) {
      return spawnSync(bashPath, [deployScript, result, receipt, work], {
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        timeout: integrationProcessTimeoutMs,
      });
    },
    async callsText() {
      return readFile(calls, "utf8");
    },
    async cleanup() {
      socketProcess.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createRunnerFixture(options = {}) {
  const fixture = await createDeployFixture({
    sameVersion: true,
    forkMainDiverged: options.forkMainDiverged,
    forkMainBehind: options.forkMainBehind,
    forkMainRaceOnce: options.forkMainRaceOnce,
    forkMainPushFail: options.forkMainPushFail,
    forkMainPushAcceptedFail: options.forkMainPushAcceptedFail,
    forkWorkflowDisableFail: options.forkWorkflowDisableFail,
    forkWorkflowEnableFail: options.forkWorkflowEnableFail,
    forkMainRun: options.forkMainRun,
    forkMainRunPreexisting: options.forkMainRunPreexisting,
    forkMainRunDelayPolls: options.forkMainRunDelayPolls,
    forkMainRunCreatedAt: options.forkMainRunCreatedAt,
    forkMainRunAttempt: options.forkMainRunAttempt,
    forkMainRunListFail: options.forkMainRunListFail,
    forkMainRunMalformed: options.forkMainRunMalformed,
    forkMainRunTruncated: options.forkMainRunTruncated,
    forkMainRunCancelFail: options.forkMainRunCancelFail,
    forkMainRunCancelRace: options.forkMainRunCancelRace,
    forkMainRunCancelStuck: options.forkMainRunCancelStuck,
    forkBaseTagMissing: options.forkBaseTagMissing,
    forkBaseTagMismatch: options.forkBaseTagMismatch,
    ompOfficialIdMismatch: options.ompOfficialIdMismatch,
    ompOfficialCloneMismatch: options.ompOfficialCloneMismatch,
    ompForkIdMismatch: options.ompForkIdMismatch,
    ompForkNodeMismatch: options.ompForkNodeMismatch,
    ompForkParentMismatch: options.ompForkParentMismatch,
    ompForkCloneMismatch: options.ompForkCloneMismatch,
    staleLoopbackIdentity: options.staleLoopbackIdentity,
    staleTailnetIdentity: options.staleTailnetIdentity,
    ompWorkflowMissing: options.ompWorkflowMissing,
    ompWorkflowFailed: options.ompWorkflowFailed,
    ompWorkflowWrongPath: options.ompWorkflowWrongPath,
    ompAssetMissing: options.ompAssetMissing,
    ompAssetExtra: options.ompAssetExtra,
    ompAssetZero: options.ompAssetZero,
    ompAssetDigestless: options.ompAssetDigestless,
    ompAssetDigestMismatch: options.ompAssetDigestMismatch,
    platform: options.platform,
    useHostPrivilegeTools: options.useHostPrivilegeTools,
    ompAssetUnreachable: options.ompAssetUnreachable,
    prSequential: options.prSequential,
    prChangeAfter: options.prChangeAfter,
    prFailAfter: options.prFailAfter,
    t4MainCommitChangeAfter: options.t4MainCommitChangeAfter,
    ompAssetWrongOrigin: options.ompAssetWrongOrigin,
  });
  const localDeploy = join(fixture.root, "bin", "local-deploy");
  const prompt = join(fixture.root, "prompt.md");
  const runtimeRoot = join(fixture.root, "runner-runtime");
  await writeFile(localDeploy, mockLocalDeploy);
  await chmod(localDeploy, 0o755);
  await writeFile(prompt, "Maintain the verified compatibility publication.\n");
  await mkdir(join(runtimeRoot, "scripts"), { recursive: true });
  await mkdir(join(runtimeRoot, "apps", "web", "dist"), { recursive: true });
  await mkdir(join(runtimeRoot, "node_modules", "ws"), { recursive: true });
  await writeFile(join(runtimeRoot, ".mock-kind"), "t4\n");
  await writeFile(join(runtimeRoot, "scripts", "tailnet-service.mjs"), "service\n");
  await writeFile(join(runtimeRoot, "scripts", "tailnet-gateway.mjs"), "gateway\n");
  await writeFile(join(runtimeRoot, "apps", "web", "dist", "index.html"), "<html>runner</html>\n");
  await writeFile(join(runtimeRoot, "node_modules", "ws", "package.json"), '{"name":"ws"}\n');
  const atomicState = join(fixture.maintainerRoot, "state", "atomic-publication");
  const atomicReceiptDirectory = join(atomicState, "t4code-1.2.3-appserver-1");
  await mkdir(atomicReceiptDirectory, { recursive: true });
  const atomicIntentPath = join(atomicReceiptDirectory, "intent.json");
  await writeFile(
    atomicIntentPath,
    `${JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-07-15T00:00:00Z",
      upstream: { tag: "v1.2.3", commit: upstreamCommit },
      integrationTag: "t4code-1.2.3-appserver-1",
      before: { baseTagObject: "", integrationTagObject: "", productCommit: "" },
      desired: {
        baseTagObject: upstreamTagObject,
        integrationTagObject,
        productCommit: integrationCommit,
      },
      atomicRefspecs: [
        "official-base-tag",
        "t4code/main",
        "annotated-integration-tag",
      ],
    })}\n`,
  );
  const intentHash = spawnSync("git", ["hash-object", atomicIntentPath], {
    encoding: "utf8",
  });
  assert.equal(intentHash.status, 0, intentHash.stderr);
  await writeFile(
    join(atomicReceiptDirectory, "receipt.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      completedAt: "2026-07-15T00:00:00Z",
      helperOwned: true,
      atomicPush: true,
      pushedRefCount: 3,
      productionRemoteIdentity: true,
      officialRepository: "can1357/oh-my-pi",
      forkRepository: options.legacyAtomicReceipt ? "lyc-aon/oh-my-pi" : "wolfiesch/oh-my-pi",
      upstream: {
        tag: "v1.2.3",
        commit: upstreamCommit,
        tagObject: upstreamTagObject,
      },
      product: { branch: "t4code/main", commit: integrationCommit },
      integration: {
        tag: "t4code-1.2.3-appserver-1",
        tagObject: integrationTagObject,
        commit: integrationCommit,
      },
      intentObject: intentHash.stdout.trim(),
    })}\n`,
  );
  const transferProof = join(fixture.root, "omp-fork-authority-transfer.json");
  const mockDigest = createHash("sha256").update("mock-asset\n").digest("hex");
  await writeFile(
    transferProof,
    `${JSON.stringify({
      schemaVersion: 1,
      purpose: "one-time-omp-fork-authority-transfer",
      repositories: {
        official: {
          fullName: "can1357/oh-my-pi",
          id: 1125856365,
          nodeId: "R_kgDOQxs0bQ",
        },
        legacy: {
          fullName: "lyc-aon/oh-my-pi",
          id: 1271877000,
          nodeId: "R_kgDOS89NiA",
          parentId: 1125856365,
          parentNodeId: "R_kgDOQxs0bQ",
        },
        current: {
          fullName: "wolfiesch/oh-my-pi",
          id: 1271775475,
          nodeId: "R_kgDOS83A8w",
          parentId: 1125856365,
          parentNodeId: "R_kgDOQxs0bQ",
        },
      },
      publication: {
        upstreamTag: "v1.2.3",
        upstreamCommit,
        upstreamTagObject,
        currentBaseTagObject: null,
        currentBaseCommitAccessible: true,
        productBranch: "t4code/main",
        productCommit: integrationCommit,
        integrationTag: "t4code-1.2.3-appserver-1",
        integrationCommit,
        integrationTagObject,
      },
      releaseAssets: [
        "omp-darwin-arm64",
        "omp-darwin-x64",
        "omp-linux-arm64",
        "omp-linux-x64",
        "omp-windows-x64.exe",
      ].map((name) => ({ name, size: 11, digest: `sha256:${mockDigest}` })),
    })}\n`,
  );
  const runnerEnv = {
    ...fixture.env,
    MOCK_RUNTIME_ROOT: runtimeRoot,
    T4_MAINTAINER_OMP: join(fixture.root, "bin", "omp"),
    T4_MAINTAINER_LOCAL_DEPLOY: localDeploy,
    T4_MAINTAINER_PROMPT_FILE: prompt,
    T4_MAINTAINER_VERIFY_ATTEMPTS: "1",
    T4_MAINTAINER_VERIFY_INTERVAL_SECONDS: "1",
    T4_MAINTAINER_ATOMIC_STATE_DIR: atomicState,
    T4_MAINTAINER_OMP_AUTHORITY_TRANSFER_FILE: transferProof,
    ...(options.localDeployFail ? { MOCK_LOCAL_DEPLOY_FAIL: "1" } : {}),
    ...(options.publicIncompatible ? { MOCK_PUBLIC_INCOMPATIBLE: "1" } : {}),
    ...(options.mainIncompatible ? { MOCK_MAIN_INCOMPATIBLE: "1" } : {}),
    ...(options.workflowsTerminal ? { MOCK_WORKFLOWS_TERMINAL: "1" } : {}),
    ...(options.workflowsActive ? { MOCK_WORKFLOWS_ACTIVE: "1" } : {}),
    ...(options.t4WorkflowWrongPath ? { MOCK_T4_WORKFLOW_WRONG_PATH: "1" } : {}),
    ...(options.ompWorkflowMissing ? { MOCK_OMP_WORKFLOW_MISSING: "1" } : {}),
    ...(options.ompWorkflowFailed ? { MOCK_OMP_WORKFLOW_FAILED: "1" } : {}),
    ...(options.ompWorkflowWrongPath ? { MOCK_OMP_WORKFLOW_WRONG_PATH: "1" } : {}),
    ...(options.ompAssetMissing ? { MOCK_OMP_ASSET_MISSING: "1" } : {}),
    ...(options.ompAssetExtra ? { MOCK_OMP_ASSET_EXTRA: "1" } : {}),
    ...(options.ompAssetZero ? { MOCK_OMP_ASSET_ZERO: "1" } : {}),
    ...(options.ompAssetDigestless ? { MOCK_OMP_ASSET_DIGESTLESS: "1" } : {}),
    ...(options.ompAssetDigestMismatch ? { MOCK_OMP_ASSET_DIGEST_MISMATCH: "1" } : {}),
    ...(options.ompAssetUnreachable ? { MOCK_OMP_ASSET_UNREACHABLE: "1" } : {}),
    ...(options.ompAssetWrongOrigin ? { MOCK_OMP_ASSET_WRONG_ORIGIN: "1" } : {}),
    ...(options.linuxUpdateMode ? { MOCK_LINUX_UPDATE_MODE: options.linuxUpdateMode } : {}),
    ...(options.productBranchMissing ? { MOCK_PRODUCT_BRANCH_MISSING: "1" } : {}),
  };

  return {
    ...fixture,
    runnerEnv,
    runtimeRoot,
    pending: join(fixture.maintainerRoot, "state", "pending.json"),
    processed: join(fixture.maintainerRoot, "state", "processed.json"),
    localApplied: join(fixture.maintainerRoot, "state", "local-applied.json"),
    async seedPending() {
      await mkdir(join(fixture.maintainerRoot, "state"), { recursive: true });
      const publication = JSON.parse(await readFile(fixture.result, "utf8"));
      await writeFile(
        join(fixture.maintainerRoot, "state", "pending.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          publicVerifiedAt: "2026-07-15T00:00:00Z",
          publicationRunId: "mock-publication",
          publication,
        })}\n`,
      );
    },
    runRunner(extraEnv = {}, args = []) {
      return spawnSync(bashPath, [runnerScript, ...args], {
        encoding: "utf8",
        env: { ...runnerEnv, ...extraEnv },
        timeout: integrationProcessTimeoutMs,
      });
    },
  };
}

export async function writeSolDeferral(fixture, marker) {
  const path = join(fixture.root, `sol-deferral-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  return path;
}

export async function assertRestored(fixture, { blocked = false } = {}) {
  assert.deepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
  assert.equal((await lstat(fixture.ompTarget)).mode & 0o777, fixture.initial.ompMode);
  assert.deepEqual(await readFile(fixture.gatewayConfig), fixture.initial.gatewayConfig);
  assert.deepEqual(await readFile(fixture.gatewayUnit), fixture.initial.gatewayUnit);
  assert.equal(
    (await readFile(join(fixture.state, "package-version"), "utf8")).trim(),
    fixture.initial.packageVersion,
  );
  assert.equal(
    (await readFile(join(fixture.state, "app-service"), "utf8")).trim(),
    fixture.initial.appService,
  );
  assert.equal(
    (await readFile(join(fixture.state, "gateway-service"), "utf8")).trim(),
    fixture.initial.gatewayService,
  );
  assert.equal(
    (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
    fixture.initial.gatewayEnablement,
  );
  assert.equal(await pathExists(fixture.receipt), false);
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  const markerExists = await pathExists(marker);
  assert.equal(
    markerExists,
    blocked,
    markerExists
      ? `${await readFile(marker, "utf8")}\n${await fixture.callsText()}`
      : "deployment marker unexpectedly absent",
  );
}
