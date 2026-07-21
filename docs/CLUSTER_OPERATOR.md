# T4 Kubernetes cluster operator

The portable `t4-cluster` chart runs the infrastructure control plane for T4 workspaces and one-session runtime pods. It is disabled by default. Kubernetes owns only infrastructure desired state, placement, PVCs, pods, Services, retention, and infrastructure conditions. OMP remains the sole authority for sessions, agent ids and parentage, lifecycle, turns, prompts, approvals, jobs, IRC, artifacts, terminals, browser commands, cancellation, and takeover through `t4-omp-authority/1`.

## Prerequisites

- Kubernetes 1.30 or newer.
- An administrator-managed StorageClass that actually provisions `ReadWriteMany` volumes.
- Three immutable image digests: `t4-cluster-operator`, `t4-cluster-server`, and `t4-session-runtime`.
- An administrator-owned same-namespace ConfigMap containing the OMP `models.yml` and `config.yml` inputs, plus either a same-namespace credential Secret or an explicit private unauthenticated-provider opt-in.
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

Installing with defaults creates no controller, gateway, session workload, RBAC, Secret, or network policy:

```sh
helm install t4-cluster deploy/charts/t4-cluster --namespace t4-system --create-namespace
```

Helm processes files in `crds/` separately. Use `--skip-crds` if CRD lifecycle is administered independently. To enable the control plane, provide a private values file or a deployment controller values source:

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
kubernetes:
  # Set this to an audience accepted by this cluster's API server.
  apiAudience: https://kubernetes.default.svc
session:
  nodeExclude: [k3s-worker-02]
  omp:
    # Existing same-namespace objects; the chart creates neither one.
    configMap: omp-runtime-config
    modelsKey: models.yml
    settingsKey: config.yml
    credentialSecret: omp-runtime-credential
    # This existing Secret key is also the environment variable name seen by OMP.
    credentialKey: PI_MODEL_API_KEY
    allowUnauthenticated: false
networkPolicy:
  kubernetesApiCIDRs: [192.0.2.10/32]
  modelRouteCIDRs: [198.51.100.20/32]
  modelRoutePorts: [19481]
  modelRoute:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: private-model-service
    podSelector:
      matchLabels:
        app.kubernetes.io/name: private-model-endpoint
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

The sample destination CIDRs, TCP ports, model/CI endpoint selectors, and gateway/observability labels are documentation values, not usable defaults. Keep the chart backend-neutral and set destinations and integration sources to the actual cluster endpoints. Model and CI route CIDRs and their optional paired namespace/pod selectors are allowed only on the corresponding exact port lists. An empty model port list renders no model route; the default CI port remains inert until a CI CIDR or complete selector pair is supplied. Empty paired selectors render no selector rule, and other empty destination lists likewise deny those flows.

The chart never creates the referenced OMP ConfigMap or Secret and never accepts their contents. The administrator must create them in the chart namespace. `modelsKey` is projected as read-only `models.yml`, `settingsKey` as read-only `config.yml`, and the configured `credentialKey` selects the same Secret key and OMP environment-variable name. The entrypoint validates both projected files and the nonempty credential without logging values, then atomically installs private copies under the OMP authority child's actual named-profile directory `${T4_SESSION_STATE_ROOT}/home/.omp/profiles/${T4_SESSION_NAME}/agent` before starting Xvfb or OMP. This must match the `OMP_PROFILE=${T4_SESSION_NAME}` passed by the session host to the pinned authority bridge child.

The controller uses uncached, exact-name `get` permissions for only those two administrator-owned objects; it cannot list or watch namespace configuration. It validates the selected keys without logging or hashing their contents, incorporates each object's Kubernetes `resourceVersion` into the session Pod hash, and rechecks ready sessions every 30 seconds. Updating either object therefore recreates the session Pod and reloads OMP configuration from the durable workspace state. Deleting a required object or emptying a selected key deletes the owned authority Pod and clears the advertised Pod and Service route before reporting the exact fail-closed condition. In unauthenticated mode the controller has no Secret permission.

Credential mode is the default and requires both `credentialSecret` and `credentialKey`. The projected models and settings keys must be distinct. Credential keys cannot overlap the session runtime's `T4_*`, `OMP_*`, `PI_*`, `XDG_*`, loader, shell, display, or path environment; collisions fail chart validation, controller reconciliation, and entrypoint preflight instead of silently replacing runtime authority. An administrator may instead set `allowUnauthenticated: true` only when both credential fields are empty and the private, identity- and NetworkPolicy-isolated model endpoint is intentionally unauthenticated. In that mode the referenced `models.yml` must declare `auth: none` and must not declare `apiKey` or `authHeader`; never use this opt-in for an Internet-reachable or shared endpoint. The chart does not select or hardcode a provider, model, or prompt policy in either mode.

Install or enable with immutable digests:

```sh
helm upgrade --install t4-cluster deploy/charts/t4-cluster --namespace t4-system --values operator-values.yaml
```

The controller always has two replicas and uses a Kubernetes Lease named from `t4-cluster-operator.cluster.t4.dev`; one replica reconciles at a time. The server defaults to three stateless replicas and supports a minimum of two. Its Deployment uses `maxUnavailable: 0`, a `minAvailable: 2` PDB, topology spread, anti-affinity, readiness draining, and an explicit `k3s-worker-02` exclusion. Session pods also exclude that node by default. Additional cluster-specific exclusions belong in deployment values, not this portable chart.

The chart creates dedicated controller, server, and session ServiceAccounts instead of a shared credential Secret. Controller and server pods disable automatic token mounting and receive explicit short-lived Kubernetes API projections. Each server pod also receives a separate 10-minute projected token with the fixed `t4-cluster-internal` audience and presents it only in the existing `omp-app/1` upstream authentication field when dialing a session host. Session pods use `automountServiceAccountToken: false`; their only Kubernetes identity mount is an explicit short-lived API-audience token plus the cluster CA and namespace. The session ServiceAccount may only create `authentication.k8s.io/tokenreviews`, and the host accepts a connection only when TokenReview confirms the expected server ServiceAccount username and audience.

The Kubernetes API audience is configurable because managed clusters can reject the conventional `https://kubernetes.default.svc` audience. The same value is used for the controller API token, server API token, and session-host TokenReview credential. The internal server identity audience remains the fixed `t4-cluster-internal` boundary. DNS selectors default to the conventional `kube-system`/`k8s-app: kube-dns` pair and can be replaced together for clusters using a different DNS deployment.

When chart-managed ingress is enabled, a host, ingress class, and TLS stanza are mandatory. For `ingressClassName: tailscale`, the chart renders the TLS host without a Secret reference so the Tailscale operator can provision and manage the certificate. Other ingress classes must reference an administrator-managed TLS Secret.

## API configuration

All APIs are namespaced under `cluster.t4.dev/v1alpha1`:

- `T4ClusterHost` selects the reviewed RWX StorageClass, allowed runtime profile names, bounded projection policy, exact HTTPS origins, and optional CI Secret/ConfigMap references.
- `T4Workspace` selects a host, bounded repository metadata, size, and `Retain` or `Delete` storage retention. The controller always requests `ReadWriteMany`.
- `T4Session` selects a host, workspace, allowlisted runtime profile, optional initial-prompt Secret reference, GUI policy, and optional allowlisted CI repository/ref/commit metadata.

Images, provider endpoints, resource policy, model routes, shell text, raw prompts, tokens, and secret values are not accepted in CRs. Status contains only `observedGeneration`, Kubernetes object references, infrastructure phases, PVC capacity/phase, and bounded conditions. It never reports OMP ids, agent trees, or runtime lifecycle truth.

The optional initial prompt is referenced by Secret name and key `prompt`; the Secret is mounted only into that session pod. Do not place prompt content in the CR or Helm values.

`T4Workspace` has `cluster.t4.dev/workspace-protection`. With `retentionPolicy: Delete`, deletion waits for its PVC to disappear. With `Retain`, the controller first removes its owner reference and marks it retained, then permits workspace deletion. `T4Session` has `cluster.t4.dev/session-cleanup` and waits for its pod and Service to disappear.

## Images and runtime

`cluster/images/controller/Dockerfile`, `cluster/images/cluster-server/Dockerfile`, and `cluster/images/session-runtime/Dockerfile` use digest-pinned multi-platform build bases. BuildKit selects the requested target platform; the Dockerfiles do not hardcode or label an architecture that was not built. Debian packages are resolved through a dated snapshot. Published chart values still require per-image immutable digests.

The session runtime verifies and builds the exact OMP tag `t4code-17.0.5-appserver-10` at commit `8476f4451ed95c5d5401785d279a93d3c659fac4`. It preserves `t4-omp-authority/1`, starts the existing T4 session-host entrypoint, and provides Xvfb, a minimal window manager, and Chromium without privileged mode or host display access. The shared claim is mounted at `/workspace`; authority and browser state live in controller-selected per-session subdirectories. OMP configuration is copied from the read-only administrator ConfigMap projection into the private authority child home before launch. `/dev/shm` is an explicit memory-backed volume. Browser Preview remains the existing GUI stream and control surface.

Session pods do not receive an automatically mounted ServiceAccount token. The explicit projected reviewer token can only create TokenReviews and is not resource-authorized. ConfigMap and credential inputs are namespace-local references; credential mode uses an explicit non-optional `SecretKeyRef`, while explicit unauthenticated mode adds no Secret reference. All containers drop capabilities, disallow privilege escalation, use RuntimeDefault seccomp, and use read-only root filesystems. No per-session NodePort, LoadBalancer, host network, host PID, host display, or hostPath is created.

## Upgrade and rollback

CRD changes must remain structural and additive. Helm installs files under `crds/` on first install but does not upgrade or delete them. Before every `helm upgrade`, an administrator must review and apply each newer CRD independently, wait for API discovery to serve the updated schemas, and only then upgrade workloads with the new immutable image digests:

```sh
kubectl apply --server-side -f deploy/charts/t4-cluster/crds/
kubectl wait --for=condition=Established crd/t4clusterhosts.cluster.t4.dev crd/t4workspaces.cluster.t4.dev crd/t4sessions.cluster.t4.dev
```

Do not rely on `helm upgrade` to change CRDs. If a CRD pre-upgrade apply fails validation, stop the upgrade and keep the currently deployed controller/server images; do not force-replace the CRD or remove stored versions.

```sh
helm upgrade t4-cluster deploy/charts/t4-cluster --namespace t4-system --values operator-values.yaml
```

For an application rollback, retain the additive CRDs and use the previous known-compatible values and image digest set:

```sh
helm rollback t4-cluster REVISION --namespace t4-system
```

Do not roll OMP independently of the T4 session runtime. Roll back the known-compatible T4/OMP image set together. The pinned authority boundary is not negotiated down.

## Uninstall

1. Stop accepting new workspace/session mutations at the gateway.
2. Delete `T4Session` resources and wait for their pods and Services to be removed.
3. Review every `T4Workspace` retention policy. `Delete` removes its PVC; `Retain` deliberately leaves an orphaned PVC for administrator recovery.
4. Run `helm uninstall t4-cluster --namespace t4-system`.
5. Remove retained PVCs only after their contents have been recovered or confirmed disposable.

CRDs are not removed by `helm uninstall`. This preserves custom resources and retained storage across rollback/reinstall. Remove the three CRDs only as a separate, explicit administrative operation after confirming no instances remain; CRD deletion removes all instances regardless of their retention intent.
