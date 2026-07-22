# T4 Kubernetes cluster operator

The portable `t4-cluster` chart runs the infrastructure control plane for T4 workspaces and one-session runtime pods. It is disabled by default. Kubernetes owns only infrastructure desired state, placement, PVCs, pods, Services, retention, and infrastructure conditions. OMP remains the sole authority for sessions, agent ids and parentage, lifecycle, turns, prompts, approvals, jobs, IRC, artifacts, terminals, browser commands, cancellation, and takeover through `t4-omp-authority/1`.

## Prerequisites

- Kubernetes 1.30 or newer.
- An administrator-managed StorageClass that actually provisions `ReadWriteMany` volumes.
- Three core immutable image digests: `t4-cluster-operator`, `t4-cluster-server`, and `t4-session-runtime`. The optional built-in credential gateway also requires `t4-model-gateway`.
- An administrator-owned same-namespace ConfigMap containing the OMP `models.yml` and `config.yml` inputs. Every provider in `models.yml` must use `auth: none` and resolve to a private, NetworkPolicy-isolated model route.
- Narrow Kubernetes API, model-route, CI-provider, ingress-controller, and metrics-scraper network identities and ports for the enabled integrations.
- A local T4 client explicitly configured to request the default-false `cluster.operator` feature. Installing this chart does not enable the client feature.

The chart does not install NFS, CSI drivers, a StorageClass, host paths, or backend-specific storage configuration. The cluster administrator must create and validate the RWX StorageClass. Mark a class as reviewed for this controller:

```yaml
metadata:
  annotations:
    cluster.t4.dev/access-modes: ReadWriteMany
```

That declaration does not make a non-RWX backend safe. Missing classes, classes without this exact declaration, unbound claims, and claims without `ReadWriteMany` fail closed. A `T4Session` pod is never created before its workspace claim is both Bound and RWX.

## Install

Installing with defaults creates no controller, gateway, session workload, RBAC, Secret, or network policy. Use the lifecycle runner even for a fresh install so existing live objects and compatibility fixtures are checked against the proposed schemas before the CRDs are server-validated, established, and storage-version-checked and before Helm runs:

```sh
scripts/cluster-ci/crd-lifecycle.sh install -- \
  helm install t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --create-namespace --skip-crds
```

Helm processes files in `crds/` separately on a direct install, but does not upgrade or delete them later. The release procedure therefore administers CRDs independently and always passes `--skip-crds` to Helm. To enable the control plane, provide a private values file or a deployment controller values source:

```yaml
enabled: true
storage:
  adminRWXStorageClass: portable-rwx
images:
  controller:
    repository: registry.example/t4-cluster-operator
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    pullPolicy: IfNotPresent
  server:
    repository: registry.example/t4-cluster-server
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    pullPolicy: IfNotPresent
  sessionRuntime:
    repository: registry.example/t4-session-runtime
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    pullPolicy: IfNotPresent
  modelGateway:
    repository: registry.example/t4-model-gateway
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    pullPolicy: IfNotPresent
kubernetes:
  # Set this to an audience accepted by this cluster's API server.
  apiAudience: https://kubernetes.default.svc
session:
  nodeExclude: [k3s-worker-02]
  omp:
    # Existing same-namespace ConfigMap; the chart does not create it.
    configMap: omp-runtime-config
    modelsKey: models.yml
    settingsKey: config.yml
modelGateway:
  enabled: true
  upstreamOrigin: https://api.provider.example
  # Exact endpoints OMP needs; other provider APIs remain unavailable.
  allowedPaths: [/v1/responses, /v1/models]
  # Existing same-namespace Secret. The chart never creates it.
  existingSecret: model-provider
  credentialKey: credential
  # The Secret value is the complete header value, such as "Bearer ...".
  credentialHeader: authorization
networkPolicy:
  kubernetesApiCIDRs: [192.0.2.10/32]
  # Resolve and pin the provider's current destinations. Default routes are rejected.
  modelGatewayUpstreamCIDRs: [198.51.100.20/32]
  modelGatewayUpstreamPorts: [443]
  ciProviderCIDRs: [203.0.113.30/32]
  ciProviderPorts: [8080]
  ciProvider:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: private-ci-service
    podSelector:
      matchLabels:
        app.kubernetes.io/name: ci-trigger
  dns:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
    podSelector:
      matchLabels:
        k8s-app: kube-dns
  gatewayIngress:
    namespaceSelector:
      matchLabels:
        ingress.example/namespace: gateway
    podSelector:
      matchLabels:
        ingress.example/component: proxy
  observability:
    namespaceSelector:
      matchLabels:
        monitoring.example/namespace: metrics
    podSelector:
      matchLabels:
        monitoring.example/component: prometheus
```

The sample destination CIDRs, TCP ports, model/CI endpoint selectors, and gateway/observability labels are documentation values, not usable defaults. Keep the chart backend-neutral and set destinations and integration sources to the actual cluster endpoints. When the built-in model gateway is enabled, Helm requires NetworkPolicy, at least one exact provider destination, and no direct session model route. Session Pods can then reach only the gateway Service on port 8080, while only the gateway Pods can reach the configured provider CIDRs and ports. For an administrator-owned external gateway, leave `modelGateway.enabled: false` and configure `modelRouteCIDRs` or the paired `modelRoute` selectors plus exact `modelRoutePorts`. The default CI port remains inert until a CI CIDR or complete selector pair is supplied. Empty paired selectors and destination lists deny those flows.

The chart never creates the referenced OMP ConfigMap. The administrator must create it in the chart namespace. `modelsKey` is projected as read-only `models.yml` and `settingsKey` as read-only `config.yml`. Before creating a session Pod, the controller parses both files as YAML, rejects aliases and duplicate keys, requires a nonempty `providers` mapping with `auth: none` on every provider, and rejects credential-bearing fields such as `apiKey`, `authHeader`, `Authorization`, custom header maps, tokens, passwords, credentials, secrets, and URL userinfo/query data. The same credential-field rules apply to `config.yml`, including dotted or nested settings such as `auth.broker.token`. The entrypoint then atomically installs private copies under the OMP authority child's actual named-profile directory `${T4_SESSION_STATE_ROOT}/home/.omp/profiles/${T4_SESSION_NAME}/agent` before starting Xvfb or OMP. This must match the `OMP_PROFILE=${T4_SESSION_NAME}` passed by the session host to the pinned authority bridge child.

The controller uses uncached, exact-name `get` permission for only that administrator-owned ConfigMap; it has no Secret permission and cannot list or watch namespace configuration. It validates the selected keys without logging or hashing their contents, incorporates the ConfigMap's Kubernetes `resourceVersion` into the session Pod hash, and rechecks ready sessions every 30 seconds. Updating the ConfigMap therefore recreates the session Pod and reloads OMP configuration from the durable workspace state. Deleting it, emptying a selected key, or making `models.yml` unsafe deletes the owned authority Pod and clears the advertised Pod and Service route before reporting the exact fail-closed condition.

Reusable credential projection is unsupported because OMP and arbitrary session tools share one workload security boundary. The former `session.omp.credentialSecret`, `credentialKey`, and `allowUnauthenticated` migration sentinels have been removed from the pre-production values contract; delete them before upgrading. Before OMP starts, the image requires the pinned `auth_credentials` table to be empty, rejects the pinned secret settings (`auth.broker.token`, `hindsight.apiToken`, `searxng.token`, and `dev.autoqaPush.token`), rejects broker token and encrypted snapshot files, and fails closed on unknown schemas or linked profile paths. It never deletes or rewrites durable user state.

The optional built-in model gateway is a separate workload and the only chart-managed Pod that mounts the existing provider Secret. It accepts only `GET` and `POST`, pins one credential-free HTTPS upstream origin and an exact path allowlist, preserves allowed queries, strips caller-supplied authorization, cookie, proxy, forwarding, and hop-by-hop headers, injects one allowlisted credential header, refuses upstream redirects, bounds request size and duration, and omits URLs and headers from structured logs. The exact path allowlist is the provider capability boundary: include only inference and model-discovery endpoints OMP actually uses, never account, billing, file-management, fine-tuning, or administrative endpoints. It streams provider responses, including SSE. It validates the credential at startup and readiness and rereads the projected Secret for each request, so a valid Kubernetes Secret rotation does not require placing the value in an environment variable or restarting the gateway. Its Service is ClusterIP-only; its NetworkPolicy admits same-namespace T4 session Pods and allows egress only to administrator-supplied provider CIDRs and ports. This boundary assumes namespace RBAC prevents untrusted workloads from creating Pods with T4 labels. Do not expose the Service to the Internet or a shared untrusted network. The chart remains provider- and model-neutral.

Install a new release with immutable digests by adding `--values operator-values.yaml` to the lifecycle-runner `install` command above. For an existing release, use the lifecycle-runner `upgrade` procedure below. Do not use `helm upgrade --install`: install and upgrade have different compatibility preflights.

The controller always has two replicas and uses a Kubernetes Lease named from `t4-cluster-operator.cluster.t4.dev`; one replica reconciles at a time. The server defaults to three stateless replicas and supports a minimum of two. Its Deployment uses `maxUnavailable: 0`, a `minAvailable: 2` PDB, topology spread, anti-affinity, readiness draining, and an explicit `k3s-worker-02` exclusion. Session pods also exclude that node by default. Additional cluster-specific exclusions belong in deployment values, not this portable chart.

The chart creates dedicated controller, server, session, and optional model-gateway ServiceAccounts. Controller and server pods disable automatic token mounting and receive explicit short-lived Kubernetes API projections. The model gateway receives no Kubernetes API token or RBAC. Each server pod also receives a separate 10-minute projected token with the fixed `t4-cluster-internal` audience and presents it only in the existing `omp-app/1` upstream authentication field when dialing a session host. Session pods use `automountServiceAccountToken: false`; their only Kubernetes identity mount is an explicit short-lived API-audience token plus the cluster CA and namespace. The session ServiceAccount may only create `authentication.k8s.io/tokenreviews`, and the host accepts a connection only when TokenReview confirms the expected server ServiceAccount username and audience.

The Kubernetes API audience is configurable because managed clusters can reject the conventional `https://kubernetes.default.svc` audience. The same value is used for the controller API token, server API token, and session-host TokenReview credential. The internal server identity audience remains the fixed `t4-cluster-internal` boundary. DNS selectors default to the conventional `kube-system`/`k8s-app: kube-dns` pair and can be replaced together for clusters using a different DNS deployment.

The managed gateway has one explicit identity-provider contract: Tailscale. Startup requires `T4_CLUSTER_IDENTITY_PROVIDER=tailscale`, a narrow list of trusted proxy addresses or CIDRs, HTTPS forwarding, and the `Tailscale-User-Login` header supplied by Tailscale Serve or the Tailscale Kubernetes operator. Display-name headers are never principals. A direct deployment that omits the identity-provider setting fails at startup.

When chart-managed ingress is enabled, the class must be `tailscale`, and a host and TLS stanza are mandatory. The chart renders the TLS host without a Secret reference so the Tailscale operator can provision and manage the certificate. Generic ingress controllers are deliberately unsupported because preserving caller-supplied `Tailscale-User-*` headers would allow identity spoofing even when their source network is trusted.

## API configuration

All APIs are namespaced under `cluster.t4.dev/v1alpha1`:

- `T4ClusterHost` selects the reviewed RWX StorageClass, allowed runtime profile names, bounded projection policy, exact HTTPS origins, and optional CI Secret/ConfigMap references.
- `T4Workspace` selects a host, bounded repository metadata, size, and `Retain` or `Delete` storage retention. The controller always requests `ReadWriteMany`.
- `T4Session` selects a host, workspace, allowlisted runtime profile, optional initial-prompt Secret reference, GUI policy, and optional allowlisted CI repository/ref/commit metadata.

Images, provider endpoints, resource policy, model routes, shell text, raw prompts, tokens, and secret values are not accepted in CRs. Status contains only `observedGeneration`, Kubernetes object references, infrastructure phases, PVC capacity/phase, and bounded conditions. It never reports OMP ids, agent trees, or runtime lifecycle truth.

The optional initial prompt is referenced by Secret name and key `prompt`; the Secret is mounted only into that session pod. Do not place prompt content in the CR or Helm values.

`T4Workspace` has `cluster.t4.dev/workspace-protection`. With `retentionPolicy: Delete`, deletion waits for its PVC to disappear. With `Retain`, the controller first removes its owner reference and marks it retained, then permits workspace deletion. `T4Session` has `cluster.t4.dev/session-cleanup` and waits for its pod and Service to disappear.

## Images and runtime

`cluster/images/controller/Dockerfile`, `cluster/images/cluster-server/Dockerfile`, `cluster/images/session-runtime/Dockerfile`, and `cluster/images/model-gateway/Dockerfile` use digest-pinned multi-platform build bases. BuildKit selects the requested target platform; the Dockerfiles do not hardcode or label an architecture that was not built. Debian packages are resolved through a dated snapshot. Published chart values still require per-image immutable digests.

The session runtime verifies and builds the exact OMP tag `t4code-17.0.5-appserver-10` at commit `8476f4451ed95c5d5401785d279a93d3c659fac4`. It preserves `t4-omp-authority/1`, starts the existing T4 session-host entrypoint, and provides Xvfb, a minimal window manager, and Chromium without privileged mode or host display access. The shared claim is mounted at `/workspace`; authority and browser state live in controller-selected per-session subdirectories. OMP configuration is copied from the read-only administrator ConfigMap projection into the private authority child home before launch. `/dev/shm` is an explicit memory-backed volume. Browser Preview remains the existing GUI stream and control surface.

Session pods do not receive an automatically mounted ServiceAccount token. The explicit projected reviewer token can only create TokenReviews and is not resource-authorized. The namespace-local ConfigMap projection contains credential-free `auth: none` OMP models and credential-free settings; session, controller, and server Pods receive no provider Secret reference or reusable provider credential. All containers drop capabilities, disallow privilege escalation, use RuntimeDefault seccomp, and use read-only root filesystems. No per-session NodePort, LoadBalancer, host network, host PID, host display, or hostPath is created.

## Upgrade, storage migration, and rollback

The three namespaced CRDs have exactly one version: `cluster.t4.dev/v1alpha1`, with `served: true`, `storage: true`, a structural schema, and a status subresource. Changes in this version must remain additive: existing fields keep their meaning and validation, while new fields are optional or have safe defaults. The compatibility fixtures in `packages/cluster-operator/api/v1alpha1/testdata/compat/` are persisted old-object shapes, including status and finalizers, and must continue to validate and round-trip without losing any declared field.

Helm does not upgrade CRDs. For every workload upgrade, run the fail-closed lifecycle command:

```sh
scripts/cluster-ci/crd-lifecycle.sh upgrade -- \
  helm upgrade t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds
```

The command performs this exact order:

1. Before any cluster access, validate every complete compatibility fixture (including `status`) against the proposed structural OpenAPI schema and CEL programs with the Kubernetes apiextensions validators. The check also rejects declared fields that the structural pruner would remove.
2. With `get` access to the three exact CRD definitions and `list` access to the corresponding namespaced T4 resources, save each installed definition, enumerate every live CR for each existing definition across namespaces, and validate each complete object, including `status`, against the same proposed OpenAPI, CEL create, CEL unchanged-update, and pruning checks. A denied CRD read, denied or malformed object list, or incompatible object fails closed; an absent definition is safely empty on a fresh install.
3. Compare every installed schema with the candidate and enforce the additive-only contract structurally. Existing schema nodes must retain identical validation semantics; properties may only be added when optional. The version-name, served/storage, and conversion contracts must remain exactly unchanged in this lifecycle mode. This rejects removed fields, new required fields, changed defaults, tighter bounds, patterns or enums, new CEL on existing nodes, list/map topology changes, additional versions, and conversion webhooks even if the current object snapshot happens to pass.
4. Generate a merge patch for each installed CRD from the candidate spec plus the validated object's `metadata.resourceVersion` and UID, then server-side dry-run it. For an absent definition, server-side dry-run an atomic create instead. Upgrades stop before any mutation if a local proposed-schema validation, live-object enumeration, structural compatibility check, patch generation, or server dry-run fails.
5. Apply each guarded merge patch with field manager `t4-crd-lifecycle`, or create an absent definition. JSON merge patch uses update ownership semantics, so fields initially created by Helm do not block an additive update; the API server returns a conflict rather than overwriting a CRD that changed or was deleted and recreated after validation.
6. Wait for all three CRDs to report `Established`.
7. Poll the served `cluster.t4.dev/v1alpha1` OpenAPI v3 document until three consecutive observations match the semantics generated from the proposed CRDs, resetting the counter after any stale or unavailable response and failing after a bounded number of attempts. Each request has its own 10-second client timeout, so a connected but unresponsive API endpoint cannot block an attempt forever. Retained `Established=True` is not readiness when discovery still serves an old schema.
8. Server-side dry-run the compatibility fixtures against the converged admission path.
9. Require each CRD's `status.storedVersions` to be exactly `v1alpha1`.
10. Execute the supplied Helm command, which must use `--skip-crds`.

The corresponding administrative checks are executable independently:

```sh
(cd packages/cluster-operator && \
  go run ./cmd/crd-preflight fixtures ../../deploy/charts/t4-cluster/crds api/v1alpha1/testdata/compat)
live_objects=$(mktemp)
installed_crds=$(mktemp -d)
merge_patches=$(mktemp -d)
trap 'rm -f "$live_objects"; rm -rf "$installed_crds" "$merge_patches"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for resource in t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev; do
  installed_crd="$installed_crds/$resource.yaml"
  kubectl get "crd/$resource" --ignore-not-found -o yaml >"$installed_crd"
  if [ ! -s "$installed_crd" ]; then
    rm -f "$installed_crd"
    continue
  fi
  kubectl get "$resource" --all-namespaces -o json >"$live_objects"
  (cd packages/cluster-operator && \
    go run ./cmd/crd-preflight objects ../../deploy/charts/t4-cluster/crds <"$live_objects")
done
(cd packages/cluster-operator && \
  go run ./cmd/crd-preflight compatible ../../deploy/charts/t4-cluster/crds "$installed_crds")
for resource in t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev; do
  if [ -s "$installed_crds/$resource.yaml" ]; then
    (cd packages/cluster-operator && \
      go run ./cmd/crd-preflight patch \
        "../../deploy/charts/t4-cluster/crds/$resource.yaml" \
        "$installed_crds/$resource.yaml") >"$merge_patches/$resource.json"
    kubectl patch "crd/$resource" --type=merge --dry-run=server \
      --field-manager=t4-crd-lifecycle --patch-file="$merge_patches/$resource.json" >/dev/null
  else
    kubectl create --dry-run=server --validate=strict \
      --field-manager=t4-crd-lifecycle \
      -f "deploy/charts/t4-cluster/crds/$resource.yaml" >/dev/null
  fi
done
for resource in t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev; do
  if [ -s "$merge_patches/$resource.json" ]; then
    kubectl patch "crd/$resource" --type=merge \
      --field-manager=t4-crd-lifecycle --patch-file="$merge_patches/$resource.json"
  else
    kubectl create --validate=strict --field-manager=t4-crd-lifecycle \
      -f "deploy/charts/t4-cluster/crds/$resource.yaml"
  fi
done
rm -f "$live_objects"
rm -rf "$installed_crds" "$merge_patches"
trap - EXIT HUP INT TERM
kubectl wait --for=condition=Established --timeout=120s \
  crd/t4clusterhosts.cluster.t4.dev \
  crd/t4workspaces.cluster.t4.dev \
  crd/t4sessions.cluster.t4.dev
openapi_document=$(mktemp)
trap 'rm -f "$openapi_document"' EXIT
observation=0
attempt=0
while [ "$observation" -lt 3 ] && [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  if kubectl get --request-timeout=10s --raw /openapi/v3/apis/cluster.t4.dev/v1alpha1 >"$openapi_document" && \
    (cd packages/cluster-operator && \
      go run ./cmd/crd-preflight served ../../deploy/charts/t4-cluster/crds <"$openapi_document"); then
    observation=$((observation + 1))
  else
    observation=0
  fi
  if [ "$observation" -lt 3 ]; then sleep 2; fi
done
test "$observation" -eq 3
rm -f "$openapi_document"
trap - EXIT
kubectl apply --dry-run=server --validate=strict --namespace default \
  -f packages/cluster-operator/api/v1alpha1/testdata/compat/
for crd in t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev; do
  test "$(kubectl get "crd/$crd" -o 'jsonpath={.status.storedVersions[*]}')" = v1alpha1
done
```

Do not rely on `helm upgrade` to change CRDs. Never use `kubectl replace --force`, delete/recreate a CRD, or apply an unguarded force-conflict update. Do not alter `status.storedVersions` outside the verified migration sequence below. A preflight failure leaves the live CRDs, custom resources, controller/server workloads, and session workloads untouched. A resource-version conflict means the validated snapshot is stale: stop, investigate the concurrent CRD change, and rerun the complete lifecycle rather than retrying only the patch. A failure after an additive CRD patch but before Helm leaves the prior workloads running against the still-backward-compatible schema; investigate and rerun the gates rather than attempting CRD rollback.

### Future `v1beta1` conversion and storage procedure

There is no `v1beta1` API today. A future proposal is a separate incompatible lifecycle change and may proceed only through these gates:

1. Back up all three CRDs and every custom resource, record per-kind object counts, and prove a restore in an isolated cluster.
2. Review separate `v1beta1` schemas, defaults, conversion semantics, downgrade semantics, and old/new/old fixture round-trips. Every field represented in either version must survive conversion; conversion may not manufacture product or runtime state in status.
3. Deploy a highly available conversion webhook with a PodDisruptionBudget, strict TLS/service identity, readiness checks, failure policy, metrics, and alerts. Prove conversion availability before adding a served version to any CRD.
4. Add `v1beta1` as served but not storage, retain `v1alpha1` as served and storage, wait for `Established`, and prove reads and writes through both versions plus all compatibility fixtures. Do not advance while any controller, gateway, backup, or recovery tool cannot read both versions.
5. In a later reviewed CRD apply, set `v1beta1` storage to true and `v1alpha1` storage to false while keeping both served. Reconfirm conversion health, then rewrite every object through the Kubernetes API using an approved storage-version migrator; merely changing `spec.versions[*].storage` does not migrate stored objects.
6. Compare pre/post object counts and read every rewritten object through both served versions. Verify identity, declared spec and status fields, finalizers, and conversion round-trips. Stop on any missing object or lossy read.
7. Only after that verification, explicitly retire the old storage record through the CRD status subresource for each CRD, for example `kubectl patch customresourcedefinition t4sessions.cluster.t4.dev --subresource=status --type=json -p='[{"op":"replace","path":"/status/storedVersions","value":["v1beta1"]}]'`. Repeat for hosts and workspaces. This status update records completed storage migration; it does not perform migration.
8. Read each CRD back and require `status.storedVersions` to be exactly `[v1beta1]`. Keep `v1alpha1` served, the webhook available, the verified backup, and dual-read binaries for the entire rollback window. Removing the old served version is a later explicit change after the window expires.

If conversion or migration fails, stop forward rollout. Do not force-replace or downgrade CRDs. While both versions remain served and conversion is healthy, roll workloads back to the prior dual-read image set. If in-place compatibility cannot be proven, stop mutations and restore the verified backup under the reviewed recovery procedure before resuming service.

### Workload rollback

CRDs remain additive and installed. Roll back the known-compatible controller, server, T4 session runtime, and OMP digest set together:

```sh
helm rollback t4-cluster REVISION --namespace t4-system
```

Do not roll OMP independently of the T4 session runtime. The pinned authority boundary is not negotiated down.

## Uninstall

1. Stop accepting new workspace/session mutations at the gateway.
2. Delete `T4Session` resources and wait for their pods and Services to be removed.
3. Review every `T4Workspace` retention policy. `Delete` removes its PVC; `Retain` deliberately leaves an orphaned PVC for administrator recovery.
4. Run `helm uninstall t4-cluster --namespace t4-system`.
5. Remove retained PVCs only after their contents have been recovered or confirmed disposable.

CRDs are not removed by `helm uninstall`. This preserves custom resources and retained storage across rollback/reinstall. Remove the three CRDs only as a separate, explicit administrative operation after confirming no instances remain; CRD deletion removes all instances regardless of their retention intent.
