#!/bin/sh
set -eu

umask 077

mode=${1:-}
component=${2:-}
repository_suffix=${3:-}
case "$component:$repository_suffix" in
  controller:t4-cluster-operator | cluster-server:t4-cluster-server | session-runtime:t4-session-runtime | model-gateway:t4-model-gateway) ;;
  *)
    echo "component and repository suffix do not match the fixed T4 image contract" >&2
    exit 64
    ;;
esac
case "$mode" in
  sbom | vulnerability | provenance) ;;
  *)
    echo "evidence mode must be sbom, vulnerability, or provenance" >&2
    exit 64
    ;;
esac

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"

artifact_dir="artifacts/cluster-proof/images"
digest=$(cat "$artifact_dir/$component.digest")
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "image digest artifact is malformed" >&2
    exit 65
    ;;
esac
reference="$HARBOR_REGISTRY/$HARBOR_PROJECT/quarantine/$repository_suffix@$digest"

case "$mode" in
  sbom)
    syft "registry:$reference" -o "spdx-json=$artifact_dir/$component.spdx.json"
    test -s "$artifact_dir/$component.spdx.json"
    ;;
  vulnerability)
    trivy image \
      --format json \
      --output "$artifact_dir/$component.trivy.json" \
      --scanners vuln \
      --severity HIGH,CRITICAL \
      --exit-code 1 \
      "$reference"
    test -s "$artifact_dir/$component.trivy.json"
    ;;
  provenance)
    identity=${T4_COSIGN_CERTIFICATE_IDENTITY:-}
    identity_type=${T4_COSIGN_CERTIFICATE_IDENTITY_TYPE:-}
    issuer=${T4_COSIGN_CERTIFICATE_OIDC_ISSUER:-}
    authorized_identity='https://github.com/wolfiesch/omperator/.github/workflows/ci.yml@refs/heads/main'
    authorized_identity_type='uri'
    authorized_issuer='https://token.actions.githubusercontent.com'
    if [ -n "$identity" ] && [ -n "$issuer" ]; then
      if [ "$identity" != "$authorized_identity" ] || [ "$identity_type" != "$authorized_identity_type" ] || [ "$issuer" != "$authorized_issuer" ]; then
        echo "configured cosign signer is not authorized for Omperator image provenance" >&2
        exit 64
      fi
      case "$identity_type" in
        uri | email) ;;
        *)
          echo "T4_COSIGN_CERTIFICATE_IDENTITY_TYPE must be uri or email" >&2
          exit 64
          ;;
      esac
      cosign verify-attestation \
        --type slsaprovenance \
        --certificate-identity "$identity" \
        --certificate-oidc-issuer "$issuer" \
        --new-bundle-format \
        "$reference" > /dev/null
      downloaded="$artifact_dir/$component.provenance.download.jsonl"
      cosign download attestation \
        --predicate-type slsaprovenance \
        "$reference" > "$downloaded"
      node -e '
        const { readFileSync, writeFileSync } = require("node:fs");
        const [downloaded, envelopesPath, bundlesPath] = process.argv.slice(1);
        const values = readFileSync(downloaded, "utf8").split("\n").filter(Boolean).map(JSON.parse);
        const bundles = values.filter((value) =>
          value?.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json" &&
          value?.dsseEnvelope
        );
        if (bundles.length === 0 || bundles.length !== values.length) {
          throw new Error("every downloaded provenance attestation must be a standard Sigstore v0.3 DSSE bundle");
        }
        writeFileSync(envelopesPath, `${bundles.map((bundle) => JSON.stringify(bundle.dsseEnvelope)).join("\n")}\n`);
        writeFileSync(bundlesPath, `${bundles.map(JSON.stringify).join("\n")}\n`);
      ' \
        "$downloaded" \
        "$artifact_dir/$component.provenance.jsonl" \
        "$artifact_dir/$component.provenance.sigstore.jsonl"
      rm -f "$downloaded"
      test -s "$artifact_dir/$component.provenance.sigstore.jsonl"
      node -e '
        const [identity, identityType, issuer] = process.argv.slice(1);
        process.stdout.write(`${JSON.stringify({
          mode: "cosign-keyless",
          certificateIdentity: identity,
          certificateIdentityType: identityType,
          certificateIssuer: issuer,
        })}\n`);
      ' "$identity" "$identity_type" "$issuer" > "$artifact_dir/$component.provenance-verification.json"
    elif [ -z "$identity" ] && [ -z "$issuer" ] && [ -z "$identity_type" ]; then
      cosign download attestation "$reference" > "$artifact_dir/$component.provenance.jsonl"
      printf '%s\n' '{"mode":"buildkit-content"}' > "$artifact_dir/$component.provenance-verification.json"
    else
      echo "cosign certificate identity and OIDC issuer must be configured together" >&2
      exit 64
    fi
    unset identity identity_type issuer authorized_identity authorized_identity_type authorized_issuer
    test -s "$artifact_dir/$component.provenance.jsonl"
    test -s "$artifact_dir/$component.provenance-verification.json"
    ;;
esac
