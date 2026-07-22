#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
unset GIT_NAMESPACE GIT_INDEX_FILE GIT_COMMON_DIR GIT_REPLACE_REF_BASE
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_SSH GIT_SSH_COMMAND
unset GIT_PUSH_OPTION_COUNT GIT_PUSH_OPTION_0
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
export GIT_NO_REPLACE_OBJECTS=1

GIT=${T4_MAINTAINER_GIT:-git}
GH=${T4_MAINTAINER_GH:-gh}
JQ=${T4_MAINTAINER_JQ:-jq}
SYNC=${T4_MAINTAINER_SYNC:-/bin/sync}
DATE=${T4_MAINTAINER_DATE:-/bin/date}
STATE_ROOT=${T4_ATOMIC_STATE_DIR:?T4_ATOMIC_STATE_DIR is required}
EXPECTED_UPSTREAM_TAG=${T4_ATOMIC_EXPECTED_UPSTREAM_TAG:?T4_ATOMIC_EXPECTED_UPSTREAM_TAG is required}
EXPECTED_UPSTREAM_COMMIT=${T4_ATOMIC_EXPECTED_UPSTREAM_COMMIT:?T4_ATOMIC_EXPECTED_UPSTREAM_COMMIT is required}
TEST_MODE=${T4_ATOMIC_TEST_MODE:-0}

readonly OFFICIAL_REPOSITORY=can1357/oh-my-pi
readonly FORK_REPOSITORY=wolfiesch/oh-my-pi
readonly PRODUCT_BRANCH=t4code/main
readonly OFFICIAL_REPOSITORY_ID=1125856365
readonly FORK_REPOSITORY_ID=1271775475
readonly OFFICIAL_REPOSITORY_NODE_ID=R_kgDOQxs0bQ
readonly FORK_REPOSITORY_NODE_ID=R_kgDOS83A8w

if [[ $TEST_MODE == 1 ]]; then
  OFFICIAL_URL=${T4_ATOMIC_OFFICIAL_URL:?T4_ATOMIC_OFFICIAL_URL is required in test mode}
  FORK_URL=${T4_ATOMIC_FORK_URL:?T4_ATOMIC_FORK_URL is required in test mode}
else
  OFFICIAL_URL=https://github.com/can1357/oh-my-pi.git
  FORK_URL=https://github.com/wolfiesch/oh-my-pi.git
fi

fail() {
  printf 'atomic OMP publication: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s --repo PATH --integration-tag TAG\n' "$0"
}

repo=
integration_tag=
while (($#)); do
  case $1 in
    --repo) (($# >= 2)) || fail '--repo requires a value'; repo=$2; shift 2 ;;
    --integration-tag) (($# >= 2)) || fail '--integration-tag requires a value'; integration_tag=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) fail "unsupported argument: $1" ;;
  esac
done

[[ -n $repo && -d $repo ]] || fail 'the prepared OMP repository is unavailable'
[[ $EXPECTED_UPSTREAM_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'the expected official tag is invalid'
[[ $EXPECTED_UPSTREAM_COMMIT =~ ^[0-9a-f]{40}$ ]] \
  || fail 'the expected official commit is invalid'
[[ $integration_tag =~ ^t4code-${EXPECTED_UPSTREAM_TAG#v}-appserver-[1-9][0-9]*$ ]] \
  || fail 'the integration tag is invalid for the expected official release'

[[ $STATE_ROOT == /* ]] || fail 'T4_ATOMIC_STATE_DIR must be an absolute path'
command -v "$DATE" >/dev/null 2>&1 \
  || fail "required command is unavailable: $DATE"
mkdir -p -- "$STATE_ROOT" || fail 'the atomic state root cannot be created'
STATE_ROOT=$(cd -P -- "$STATE_ROOT" && pwd -P) \
  || fail 'the atomic state root cannot be normalized'
state_dir="$STATE_ROOT/$integration_tag"
intent_file="$state_dir/intent.json"
receipt_file="$state_dir/receipt.json"
preparation_file="$state_dir/preparation.json"
staging="$state_dir/repository.git"
staging_preparing="$state_dir/repository.git.preparing"
mkdir -p -- "$state_dir"
chmod 700 "$STATE_ROOT" "$state_dir"

durable_json() {
  local destination=$1 source=$2 temporary
  temporary=$(mktemp "$state_dir/.json.XXXXXX")
  $JQ -S . "$source" >"$temporary"
  chmod 600 "$temporary"
  "$SYNC" -f "$temporary"
  mv -f -- "$temporary" "$destination"
  "$SYNC" -f "$state_dir"
}

durable_remove() {
  local target=$1
  [[ -e $target ]] || return 0
  rm -f -- "$target"
  "$SYNC" -f "$state_dir"
}

remote_ref() {
  local url=$1 ref=$2 value
  value=$($GIT ls-remote "$url" "$ref" | awk -v ref="$ref" '$2 == ref {print $1}') || return 1
  [[ $value != *$'\n'* ]] || return 1
  printf '%s' "$value"
}

tag_commit() {
  local url=$1 tag=$2 object peeled
  object=$(remote_ref "$url" "refs/tags/$tag") || return 1
  [[ $object =~ ^[0-9a-f]{40}$ ]] || return 1
  peeled=$(remote_ref "$url" "refs/tags/$tag^{}") || true
  if [[ $peeled =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s' "$peeled"
  else
    printf '%s' "$object"
  fi
}

official_tag_is_still_exact() {
  local object commit
  object=$(remote_ref "$OFFICIAL_URL" "refs/tags/$EXPECTED_UPSTREAM_TAG") || return 1
  commit=$(tag_commit "$OFFICIAL_URL" "$EXPECTED_UPSTREAM_TAG") || return 1
  [[ $object == "$official_tag_object" && $commit == "$EXPECTED_UPSTREAM_COMMIT" ]]
}

snapshot_remote() {
  local base integration product
  base=$(remote_ref "$FORK_URL" "refs/tags/$EXPECTED_UPSTREAM_TAG") || true
  integration=$(remote_ref "$FORK_URL" "refs/tags/$integration_tag") || true
  product=$(remote_ref "$FORK_URL" "refs/heads/$PRODUCT_BRANCH") || true
  $JQ -cn --arg base "$base" --arg integration "$integration" --arg product "$product" \
    '{baseTagObject:$base,integrationTagObject:$integration,productCommit:$product}'
}

assert_production_identity() {
  [[ $TEST_MODE == 1 ]] && return 0
  local official fork origin official_remote
  official=$($GH api "repos/$OFFICIAL_REPOSITORY") || return 1
  fork=$($GH api "repos/$FORK_REPOSITORY") || return 1
  printf '%s' "$official" | $JQ -e \
    --argjson id "$OFFICIAL_REPOSITORY_ID" \
    --arg node_id "$OFFICIAL_REPOSITORY_NODE_ID" '
    .id == $id and .node_id == $node_id and .full_name == "can1357/oh-my-pi"
  ' >/dev/null || return 1
  printf '%s' "$fork" | $JQ -e \
    --argjson id "$FORK_REPOSITORY_ID" \
    --arg node_id "$FORK_REPOSITORY_NODE_ID" \
    --argjson parent_id "$OFFICIAL_REPOSITORY_ID" \
    --arg parent_node_id "$OFFICIAL_REPOSITORY_NODE_ID" '
      .id == $id and .node_id == $node_id and
      .full_name == "wolfiesch/oh-my-pi" and .fork == true and
      .parent.id == $parent_id and .parent.node_id == $parent_node_id and
      .parent.full_name == "can1357/oh-my-pi"
    ' >/dev/null || return 1
  origin=$($GIT -C "$repo" remote get-url origin) || return 1
  official_remote=$($GIT -C "$repo" remote get-url official) || return 1
  [[ $origin == "$FORK_URL" && $official_remote == "$OFFICIAL_URL" ]]
}

remote_matches_json() {
  local expected=$1 actual
  actual=$(snapshot_remote) || return 1
  $JQ -e --argjson actual "$actual" '
    .baseTagObject == $actual.baseTagObject and
    .integrationTagObject == $actual.integrationTagObject and
    .productCommit == $actual.productCommit
  ' <<<"$expected" >/dev/null
}

write_receipt() {
  local desired=$1 intent_sha temporary
  intent_sha=$($GIT hash-object "$intent_file") || return 1
  temporary=$(mktemp "$state_dir/.receipt-source.XXXXXX")
  $JQ -n \
    --arg completed_at "$("$DATE" -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg official_repository "$OFFICIAL_REPOSITORY" \
    --arg fork_repository "$FORK_REPOSITORY" \
    --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
    --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
    --arg integration_tag "$integration_tag" \
    --arg product_branch "$PRODUCT_BRANCH" \
    --arg intent_sha "$intent_sha" \
    --argjson production "$([[ $TEST_MODE == 1 ]] && printf false || printf true)" \
    --argjson desired "$desired" '
      {
        schemaVersion: 1,
        completedAt: $completed_at,
        helperOwned: true,
        atomicPush: true,
        pushedRefCount: 3,
        productionRemoteIdentity: $production,
        officialRepository: $official_repository,
        forkRepository: $fork_repository,
        upstream: {tag:$upstream_tag,commit:$upstream_commit,tagObject:$desired.baseTagObject},
        product: {branch:$product_branch,commit:$desired.productCommit},
        integration: {tag:$integration_tag,tagObject:$desired.integrationTagObject,commit:$desired.productCommit},
        intentObject: $intent_sha
      }
    ' >"$temporary"
  durable_json "$receipt_file" "$temporary"
  rm -f -- "$temporary"
}

validate_intent_file() {
  [[ -s $intent_file && -f $intent_file && ! -L $intent_file ]] || return 1
  $JQ -e \
    --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
    --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
    --arg integration_tag "$integration_tag" \
    --arg official_tag_object "$official_tag_object" '
      def oid: type == "string" and test("^[0-9a-f]{40}$");
      def oid_or_empty: . == "" or oid;
      .schemaVersion == 1 and (.createdAt | type == "string") and
      .upstream.tag == $upstream_tag and .upstream.commit == $upstream_commit and
      .integrationTag == $integration_tag and
      (.before | type == "object") and (.desired | type == "object") and
      (.before.baseTagObject == "" or .before.baseTagObject == $official_tag_object) and
      .before.integrationTagObject == "" and
      (.before.productCommit | oid_or_empty) and
      .desired.baseTagObject == $official_tag_object and
      (.desired.integrationTagObject | oid) and (.desired.productCommit | oid) and
      .before.productCommit != .desired.productCommit and
      .atomicRefspecs == [
        "official-base-tag",
        "t4code/main",
        "annotated-integration-tag"
      ]
    ' "$intent_file" >/dev/null
}

validate_staging_for_intent() {
  local desired=$1 desired_base desired_product desired_integration before_product
  local staged_base staged_base_commit staged_product staged_integration staged_integration_commit
  local staged_tag_header
  [[ -d $staging && ! -L $staging ]] || return 1
  desired_base=$($JQ -r '.baseTagObject' <<<"$desired") || return 1
  desired_product=$($JQ -r '.productCommit' <<<"$desired") || return 1
  desired_integration=$($JQ -r '.integrationTagObject' <<<"$desired") || return 1
  before_product=$($JQ -r '.before.productCommit' "$intent_file") || return 1
  staged_base=$($GIT -C "$staging" rev-parse "refs/tags/$EXPECTED_UPSTREAM_TAG") || return 1
  staged_base_commit=$($GIT -C "$staging" rev-parse "refs/tags/$EXPECTED_UPSTREAM_TAG^{}") \
    || return 1
  staged_product=$($GIT -C "$staging" rev-parse "refs/heads/$PRODUCT_BRANCH") || return 1
  staged_integration=$($GIT -C "$staging" rev-parse "refs/tags/$integration_tag") || return 1
  [[ $($GIT -C "$staging" cat-file -t "$staged_integration") == tag ]] || return 1
  staged_integration_commit=$($GIT -C "$staging" rev-parse "refs/tags/$integration_tag^{}") \
    || return 1
  staged_tag_header=$($GIT -C "$staging" cat-file -p "$staged_integration" \
    | sed -n 's/^tag //p') || return 1
  [[ $staged_base == "$desired_base" && $staged_base_commit == "$EXPECTED_UPSTREAM_COMMIT" ]] \
    || return 1
  [[ $staged_product == "$desired_product" \
    && $staged_integration == "$desired_integration" \
    && $staged_integration_commit == "$desired_product" \
    && $staged_tag_header == "$integration_tag" ]] || return 1
  $GIT -C "$staging" merge-base --is-ancestor "$EXPECTED_UPSTREAM_COMMIT" "$desired_product" \
    || return 1
  if [[ -n $before_product ]]; then
    $GIT -C "$staging" merge-base --is-ancestor "$before_product" "$desired_product" \
      || return 1
  fi
}

assert_production_identity \
  || fail 'the prepared repository or GitHub repositories do not match the fixed production identities'

official_tag_object=$(remote_ref "$OFFICIAL_URL" "refs/tags/$EXPECTED_UPSTREAM_TAG") \
  || fail 'the exact official base tag is unavailable'
official_tag_commit=$(tag_commit "$OFFICIAL_URL" "$EXPECTED_UPSTREAM_TAG") \
  || fail 'the official base tag cannot be peeled'
[[ $official_tag_object =~ ^[0-9a-f]{40}$ && $official_tag_commit == "$EXPECTED_UPSTREAM_COMMIT" ]] \
  || fail 'the official base tag no longer resolves to the expected commit'

if [[ -s $receipt_file ]]; then
  validate_intent_file || fail 'the durable atomic intent behind the receipt is invalid'
  intent_sha=$($GIT hash-object "$intent_file") \
    || fail 'the durable atomic intent could not be hashed'
  desired=$($JQ -c '{baseTagObject:.upstream.tagObject,integrationTagObject:.integration.tagObject,productCommit:.product.commit}' "$receipt_file") \
    || fail 'the durable atomic receipt is invalid'
  [[ $($JQ -cS '.desired' "$intent_file") == "$(printf '%s' "$desired" | $JQ -cS .)" ]] \
    || fail 'the durable atomic receipt is not bound to its intent'
  $JQ -e \
    --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
    --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
    --arg integration_tag "$integration_tag" \
    --arg intent_sha "$intent_sha" \
    --argjson production "$([[ $TEST_MODE == 1 ]] && printf false || printf true)" '
      .schemaVersion == 1 and .helperOwned == true and .atomicPush == true and
      .pushedRefCount == 3 and
      .productionRemoteIdentity == $production and
      .officialRepository == "can1357/oh-my-pi" and
      .forkRepository == "wolfiesch/oh-my-pi" and
      .upstream.tag == $upstream_tag and .upstream.commit == $upstream_commit and
      .product.branch == "t4code/main" and
      .integration.tag == $integration_tag and
      .integration.commit == .product.commit and
      .intentObject == $intent_sha
    ' "$receipt_file" >/dev/null \
    || fail 'the durable atomic receipt does not match this publication'
  remote_matches_json "$desired" \
    || fail 'public OMP refs no longer match the durable atomic receipt'
  official_tag_is_still_exact \
    || fail 'the official base tag changed after this durable atomic receipt was created'
  printf '%s\n' "$receipt_file"
  exit 0
fi

if [[ -s $intent_file ]]; then
  durable_remove "$preparation_file"
  validate_intent_file || fail 'the durable atomic intent is invalid'
  before=$($JQ -c '.before' "$intent_file") || fail 'the durable atomic intent is invalid'
  desired=$($JQ -c '.desired' "$intent_file") || fail 'the durable atomic intent is invalid'
  if remote_matches_json "$desired"; then
    official_tag_is_still_exact \
      || fail 'the official base tag changed before atomic receipt recovery'
    write_receipt "$desired" || fail 'could not recover the completed atomic publication receipt'
    printf '%s\n' "$receipt_file"
    exit 0
  fi
  remote_matches_json "$before" \
    || fail 'atomic publication recovery found a mixed or unexpected remote state; refusing every further push'
  [[ -d $staging && ! -L $staging ]] \
    || fail 'the durable atomic staging repository is missing during recovery'
else
  if [[ -e $preparation_file || -L $preparation_file ]]; then
    [[ -s $preparation_file && -f $preparation_file && ! -L $preparation_file ]] \
      || fail 'the durable atomic preparation state is invalid'
    $JQ -e \
      --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
      --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
      --arg integration_tag "$integration_tag" '
        .schemaVersion == 1 and .phase == "preparing" and
        .upstream.tag == $upstream_tag and .upstream.commit == $upstream_commit and
        .integrationTag == $integration_tag
      ' "$preparation_file" >/dev/null \
      || fail 'the durable atomic preparation state does not match this publication'
  else
    temporary_preparation=$(mktemp "$state_dir/.preparation-source.XXXXXX")
    $JQ -n \
      --arg created_at "$("$DATE" -u +'%Y-%m-%dT%H:%M:%SZ')" \
      --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
      --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
      --arg integration_tag "$integration_tag" '
        {
          schemaVersion:1,
          phase:"preparing",
          createdAt:$created_at,
          upstream:{tag:$upstream_tag,commit:$upstream_commit},
          integrationTag:$integration_tag
        }
      ' >"$temporary_preparation"
    durable_json "$preparation_file" "$temporary_preparation"
    rm -f -- "$temporary_preparation"
  fi
  [[ ! -L $staging && ! -L $staging_preparing ]] \
    || fail 'atomic preparation found an unsafe staging path'
  rm -rf -- "$staging" "$staging_preparing"
  "$SYNC" -f "$state_dir"
  $GIT clone --quiet --bare "$repo" "$staging_preparing" \
    || fail 'could not create the durable atomic staging repository'
  $GIT -C "$staging_preparing" fetch --quiet --force "$OFFICIAL_URL" \
    "refs/tags/$EXPECTED_UPSTREAM_TAG:refs/tags/$EXPECTED_UPSTREAM_TAG" \
    || fail 'could not stage the exact official base tag'
  staged_official_tag_object=$($GIT -C "$staging_preparing" rev-parse \
    "refs/tags/$EXPECTED_UPSTREAM_TAG") || fail 'the staged official tag object is unavailable'
  staged_official_tag_commit=$($GIT -C "$staging_preparing" rev-parse \
    "refs/tags/$EXPECTED_UPSTREAM_TAG^{}") || fail 'the staged official tag cannot be peeled'
  [[ $staged_official_tag_object == "$official_tag_object" \
    && $staged_official_tag_commit == "$EXPECTED_UPSTREAM_COMMIT" ]] \
    || fail 'the official base tag changed while the exact object was staged'
  mv -- "$staging_preparing" "$staging"
  "$SYNC" -f "$state_dir"
  if [[ $TEST_MODE == 1 && ${T4_ATOMIC_TEST_CRASH_AFTER_STAGING:-0} == 1 ]]; then
    exit 86
  fi

  product_commit=$($GIT -C "$staging" rev-parse "refs/heads/$PRODUCT_BRANCH") \
    || fail 'the prepared product branch is missing'
  integration_tag_object=$($GIT -C "$staging" rev-parse "refs/tags/$integration_tag") \
    || fail 'the prepared integration tag is missing'
  [[ $($GIT -C "$staging" cat-file -t "$integration_tag_object") == tag ]] \
    || fail 'the integration tag must be annotated'
  tag_header=$($GIT -C "$staging" cat-file -p "$integration_tag_object" \
    | sed -n 's/^tag //p') || fail 'the annotated integration tag header is unavailable'
  [[ $tag_header == "$integration_tag" ]] \
    || fail 'the annotated integration tag header does not match its fixed ref name'
  integration_commit=$($GIT -C "$staging" rev-parse "refs/tags/$integration_tag^{}") \
    || fail 'the annotated integration tag cannot be peeled'
  [[ $product_commit =~ ^[0-9a-f]{40}$ && $integration_commit == "$product_commit" ]] \
    || fail 'the integration tag and product branch must identify the same exact commit'
  $GIT -C "$staging" merge-base --is-ancestor "$EXPECTED_UPSTREAM_COMMIT" "$product_commit" \
    || fail 'the product commit does not descend from the exact official release'

  before=$(snapshot_remote) || fail 'could not resolve the fork refs before publication'
  before_base=$($JQ -r '.baseTagObject' <<<"$before")
  before_integration=$($JQ -r '.integrationTagObject' <<<"$before")
  before_product=$($JQ -r '.productCommit' <<<"$before")
  [[ -z $before_base || $before_base == "$official_tag_object" ]] \
    || fail 'the fork base tag differs from the exact official tag object'
  [[ -z $before_integration ]] \
    || fail 'the fork integration tag already exists without this helper-owned atomic intent'
  [[ $before_product != "$product_commit" ]] \
    || fail 'the product branch must advance in the same new atomic publication'
  if [[ -n $before_product ]]; then
    $GIT -C "$staging" fetch --quiet "$FORK_URL" \
      "refs/heads/$PRODUCT_BRANCH:refs/remotes/fork/$PRODUCT_BRANCH" \
      || fail 'could not stage the current fork product branch'
    [[ $($GIT -C "$staging" rev-parse "refs/remotes/fork/$PRODUCT_BRANCH") == "$before_product" ]] \
      || fail 'the fork product branch changed while it was staged'
    $GIT -C "$staging" merge-base --is-ancestor "$before_product" "$product_commit" \
      || fail 'the product branch update is not fast-forward-only'
  fi
  desired=$($JQ -cn \
    --arg base "$official_tag_object" \
    --arg integration "$integration_tag_object" \
    --arg product "$product_commit" \
    '{baseTagObject:$base,integrationTagObject:$integration,productCommit:$product}')
  temporary_intent=$(mktemp "$state_dir/.intent-source.XXXXXX")
  $JQ -n \
    --arg created_at "$("$DATE" -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg upstream_tag "$EXPECTED_UPSTREAM_TAG" \
    --arg upstream_commit "$EXPECTED_UPSTREAM_COMMIT" \
    --arg integration_tag "$integration_tag" \
    --argjson before "$before" \
    --argjson desired "$desired" '
      {
        schemaVersion:1,
        createdAt:$created_at,
        upstream:{tag:$upstream_tag,commit:$upstream_commit},
        integrationTag:$integration_tag,
        before:$before,
        desired:$desired,
        atomicRefspecs:[
          "official-base-tag",
          "t4code/main",
          "annotated-integration-tag"
        ]
      }
    ' >"$temporary_intent"
  durable_json "$intent_file" "$temporary_intent"
  rm -f -- "$temporary_intent"
  durable_remove "$preparation_file"
fi

validate_intent_file || fail 'the durable atomic intent is invalid before publication'
desired=$($JQ -c '.desired' "$intent_file") || fail 'the durable atomic intent is invalid'
validate_staging_for_intent "$desired" \
  || fail 'the durable atomic staging refs do not match the exact publication intent'
product_commit=$($JQ -r '.productCommit' <<<"$desired")
integration_tag_object=$($JQ -r '.integrationTagObject' <<<"$desired")
before=$($JQ -c '.before' "$intent_file") || fail 'the durable atomic intent is invalid'
before_base=$($JQ -r '.baseTagObject' <<<"$before")
before_product=$($JQ -r '.productCommit' <<<"$before")
before_integration=$($JQ -r '.integrationTagObject' <<<"$before")
if [[ $TEST_MODE == 1 ]]; then
  git_push=("$GIT")
else
  git_push=("$GIT" -c 'credential.helper=!gh auth git-credential')
fi
push_log="$state_dir/push.log"
official_tag_is_still_exact \
  || fail 'the official base tag changed before the atomic publication push'
if ! "${git_push[@]}" -C "$staging" push \
  --atomic --porcelain --no-follow-tags --no-signed --no-verify \
  --force-with-lease="refs/tags/$EXPECTED_UPSTREAM_TAG:$before_base" \
  --force-with-lease="refs/heads/$PRODUCT_BRANCH:$before_product" \
  --force-with-lease="refs/tags/$integration_tag:$before_integration" \
  "$FORK_URL" \
  "$official_tag_object:refs/tags/$EXPECTED_UPSTREAM_TAG" \
  "$product_commit:refs/heads/$PRODUCT_BRANCH" \
  "$integration_tag_object:refs/tags/$integration_tag" \
  >"$push_log" 2>&1; then
  cat "$push_log" >&2 || true
  fail 'the single atomic three-ref publication push was rejected; durable intent is retained'
fi
chmod 600 "$push_log"
"$SYNC" -f "$push_log"

remote_matches_json "$desired" \
  || fail 'the atomic push returned successfully, but exact public refs could not be re-proven'
official_tag_is_still_exact \
  || fail 'the official base tag changed while the atomic publication was being proven'
assert_production_identity \
  || fail 'the atomic push completed, but production repository identity could not be re-proven'
write_receipt "$desired" || fail 'the atomic publication succeeded but its durable receipt could not be written'
printf '%s\n' "$receipt_file"
