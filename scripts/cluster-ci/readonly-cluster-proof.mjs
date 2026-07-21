import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LEASE_AGE_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const DIGEST_PATTERN = /@sha256:[0-9a-f]{64}$/u;
const FORBIDDEN_SESSION_NODES = new Set(["k3s-worker-02", "k3s-worker-03"]);
const WORKLOAD_KINDS = new Set(["CronJob", "DaemonSet", "Deployment", "Job", "Pod", "StatefulSet"]);
const LEASE_NAME = "t4-cluster-operator.cluster.t4.dev";
const DEPLOYMENTS = Object.freeze([
  { name: "t4-cluster-controller", component: "controller", container: "controller", replicas: 2, maxUnavailable: 0, minimumAvailable: 1 },
  { name: "t4-cluster-server", component: "server", container: "server", replicas: 3, maxUnavailable: 0, minimumAvailable: 2 },
]);

const REQUESTS = Object.freeze([
  ["deployments", ["get", "deployments", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["lease", ["get", "lease", LEASE_NAME, "-n", "$NAMESPACE", "-o", "json"]],
  [
    "customresourcedefinitions",
    [
      "get",
      "customresourcedefinitions",
      "t4clusterhosts.cluster.t4.dev",
      "t4workspaces.cluster.t4.dev",
      "t4sessions.cluster.t4.dev",
      "-o",
      "json",
    ],
  ],
  ["t4clusterhosts", ["get", "t4clusterhosts", "-n", "$NAMESPACE", "-o", "json"]],
  ["t4workspaces", ["get", "t4workspaces", "-n", "$NAMESPACE", "-o", "json"]],
  ["t4sessions", ["get", "t4sessions", "-n", "$NAMESPACE", "-o", "json"]],
  ["persistentvolumeclaims", ["get", "persistentvolumeclaims", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["pods", ["get", "pods", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["services", ["get", "services", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
]);

function fail(message) {
  throw new Error(`T4 read-only cluster proof ${message}`);
}

function list(snapshot, key) {
  const value = snapshot?.[key];
  if (!value || typeof value !== "object" || !Array.isArray(value.items) || value.items.length > 256) {
    fail(`${key} response was malformed or exceeded its bound`);
  }
  return value.items;
}

function exactNamed(items, name, label) {
  const matches = items.filter(({ metadata }) => metadata?.name === name);
  if (matches.length !== 1) fail(`expected exactly one ${label} named ${name}`);
  return matches[0];
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function observed(resource, label) {
  if (!positive(resource.metadata?.generation) || resource.status?.observedGeneration !== resource.metadata.generation) {
    fail(`${label} status does not observe metadata.generation exactly`);
  }
}

function label(resource, key, expected, resourceLabel) {
  if (resource.metadata?.labels?.[key] !== expected) {
    fail(`${resourceLabel} label ${key} is not exactly ${expected}`);
  }
}

function readyPod(pod, labelText) {
  if (
    pod.status?.phase !== "Running" ||
    !Array.isArray(pod.status?.conditions) ||
    !pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True")
  ) {
    fail(`${labelText} is not Running and Ready`);
  }
}

function currentContainer(pod, name, labelText) {
  const statuses = pod.status?.containerStatuses;
  const matches = Array.isArray(statuses) ? statuses.filter((status) => status?.name === name) : [];
  const imageDigest = matches[0]?.image?.match(/@(sha256:[0-9a-f]{64})$/u)?.[1];
  if (
    matches.length !== 1 ||
    matches[0].ready !== true ||
    !imageDigest ||
    !DIGEST_PATTERN.test(matches[0].imageID ?? "") ||
    !matches[0].imageID.endsWith(`@${imageDigest}`)
  ) {
    fail(`${labelText} has no exact ready ${name} container at its declared current digest`);
  }
  return matches[0];
}

function deploymentContract(deployment, contract) {
  label(deployment, "app.kubernetes.io/part-of", "t4-cluster", `${contract.name} Deployment`);
  label(deployment, "app.kubernetes.io/component", contract.component, `${contract.name} Deployment`);
  observed(deployment, `${contract.name} Deployment`);
  if (
    deployment.spec?.replicas !== contract.replicas ||
    deployment.spec?.strategy?.type !== "RollingUpdate" ||
    ![contract.maxUnavailable, String(contract.maxUnavailable)].includes(deployment.spec?.strategy?.rollingUpdate?.maxUnavailable) ||
    (deployment.status?.availableReplicas ?? 0) < contract.minimumAvailable
  ) {
    fail(`${contract.name} Deployment did not satisfy its exact HA rollout contract`);
  }
}

function defaultRunner(command, args) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_RESPONSE_BYTES,
    timeout: 30_000,
    windowsHide: true,
  }).then(({ stdout }) => stdout);
}

export async function collectReadOnlyClusterSnapshot({ namespace, run = defaultRunner }) {
  if (!NAMESPACE_PATTERN.test(namespace ?? "")) fail("namespace is invalid");
  const snapshot = {};
  for (const [key, template] of REQUESTS) {
    const args = template.map((argument) => (argument === "$NAMESPACE" ? namespace : argument));
    const stdout = await run("kubectl", args);
    if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
      fail(`${key} response exceeded its byte bound`);
    }
    try {
      snapshot[key] = JSON.parse(stdout);
    } catch {
      fail(`${key} response was not JSON`);
    }
  }
  return snapshot;
}

function validateCiMapping(sessions, expected) {
  const mappings = sessions.filter(({ spec }) => {
    const ci = spec?.ci;
    return (
      ci &&
      typeof ci.repositoryId === "string" && ci.repositoryId.length > 0 && ci.repositoryId.length <= 128 &&
      typeof ci.ref === "string" && ci.ref.length > 0 && ci.ref.length <= 256 &&
      typeof ci.commit === "string" && /^[0-9a-f]{40}$/u.test(ci.commit)
    );
  });
  if (mappings.length < 1) fail("no live T4Session carries an exact CI mapping");
  if (expected) {
    const matches = mappings.filter(({ spec }) =>
      spec.ci.repositoryId === expected.repositoryId &&
      spec.ci.ref === expected.ref &&
      spec.ci.commit === expected.commit,
    );
    if (matches.length !== 1) fail("live T4Session CI mapping does not exactly match this repository, ref, and commit");
    return matches;
  }
  return mappings;
}

export function validateClusterSnapshot(snapshot, { now = Date.now(), ciMapping } = {}) {
  const deployments = list(snapshot, "deployments");
  for (const contract of DEPLOYMENTS) {
    deploymentContract(exactNamed(deployments, contract.name, `${contract.component} Deployment`), contract);
  }

  const lease = snapshot?.lease;
  const renewTime = Date.parse(lease?.spec?.renewTime ?? "");
  if (
    !lease ||
    lease.metadata?.name !== LEASE_NAME ||
    typeof lease.spec?.holderIdentity !== "string" ||
    lease.spec.holderIdentity.length < 1 ||
    lease.spec.holderIdentity.length > 253 ||
    !Number.isFinite(renewTime) ||
    renewTime > now + MAX_CLOCK_SKEW_MS ||
    now - renewTime > MAX_LEASE_AGE_MS
  ) {
    fail(`controller leader Lease ${LEASE_NAME} is not freshly held`);
  }

  const crds = list(snapshot, "customresourcedefinitions");
  for (const plural of ["t4clusterhosts", "t4workspaces", "t4sessions"]) {
    const crd = exactNamed(crds, `${plural}.cluster.t4.dev`, `${plural} CRD`);
    const versions = Array.isArray(crd.spec?.versions) ? crd.spec.versions : [];
    const version = versions.find(({ name }) => name === "v1alpha1");
    if (
      crd.spec?.group !== "cluster.t4.dev" ||
      crd.spec?.scope !== "Namespaced" ||
      crd.spec?.names?.plural !== plural ||
      version?.served !== true ||
      version?.storage !== true
    ) {
      fail(`${plural} CRD does not satisfy the exact v1alpha1 contract`);
    }
  }

  const hosts = list(snapshot, "t4clusterhosts");
  if (hosts.length < 1) fail("T4ClusterHost proof resource is absent");
  hosts.forEach((host) => observed(host, `T4ClusterHost ${host.metadata?.name ?? "unknown"}`));

  const workspaces = list(snapshot, "t4workspaces");
  const sessions = list(snapshot, "t4sessions");
  const pvcs = list(snapshot, "persistentvolumeclaims");
  const pods = list(snapshot, "pods");
  if (workspaces.length < 1 || sessions.length < 1 || pvcs.length < 1) {
    fail("workspace/session/storage proof resources are absent");
  }
  for (const workspace of workspaces) {
    const name = workspace.metadata?.name ?? "unknown";
    observed(workspace, `workspace ${name}`);
    if (workspace.status?.phase !== "Ready" || !["Retain", "Delete"].includes(workspace.spec?.retentionPolicy)) {
      fail(`workspace ${name} is not reconciled Ready`);
    }
    const pvcName = workspace.status?.pvcName;
    if (typeof pvcName !== "string" || pvcName.length < 1 || pvcName.length > 63) {
      fail(`workspace ${name} status.pvcName is invalid`);
    }
    const pvc = exactNamed(pvcs, pvcName, `workspace ${name} PVC`);
    label(pvc, "app.kubernetes.io/part-of", "t4-cluster", `workspace ${name} PVC`);
    label(pvc, "cluster.t4.dev/workspace", name, `workspace ${name} PVC`);
    if (pvc.status?.phase !== "Bound") fail(`workspace ${name} PVC is not Bound`);
    if (
      !Array.isArray(pvc.spec?.accessModes) ||
      pvc.spec.accessModes.length !== 1 ||
      pvc.spec.accessModes[0] !== "ReadWriteMany"
    ) {
      fail(`workspace ${name} PVC is not ReadWriteMany`);
    }
    if (typeof pvc.spec?.storageClassName !== "string" || pvc.spec.storageClassName.length === 0) {
      fail(`workspace ${name} PVC has no StorageClass`);
    }
  }

  for (const session of sessions) {
    const name = session.metadata?.name ?? "unknown";
    observed(session, `session ${name}`);
    if (session.status?.phase !== "Running") fail(`session ${name} is not reconciled Running`);
    if (!workspaces.some(({ metadata }) => metadata?.name === session.spec?.workspaceRef)) {
      fail(`session ${name} references an unknown workspace`);
    }
    const podName = session.status?.podName;
    if (typeof podName !== "string" || podName.length < 1 || podName.length > 63) {
      fail(`session ${name} status.podName is invalid`);
    }
    const pod = exactNamed(pods, podName, `session ${name} Pod`);
    label(pod, "app.kubernetes.io/name", "t4-session-runtime", `session ${name} Pod`);
    label(pod, "app.kubernetes.io/part-of", "t4-cluster", `session ${name} Pod`);
    label(pod, "cluster.t4.dev/session", podName, `session ${name} Pod`);
    readyPod(pod, `session ${name} Pod`);
    currentContainer(pod, "session-runtime", `session ${name} Pod`);
    if (FORBIDDEN_SESSION_NODES.has(pod.spec?.nodeName)) {
      fail(`durable session placement is invalid for ${podName}`);
    }
  }
  validateCiMapping(sessions, ciMapping);

  for (const contract of DEPLOYMENTS) {
    const matchingPods = pods.filter((pod) =>
      pod.metadata?.labels?.["app.kubernetes.io/part-of"] === "t4-cluster" &&
      pod.metadata?.labels?.["app.kubernetes.io/component"] === contract.component,
    );
    if (matchingPods.length < contract.minimumAvailable) {
      fail(`${contract.name} has too few exactly labelled pods`);
    }
    for (const pod of matchingPods) {
      readyPod(pod, `${contract.name} Pod ${pod.metadata?.name ?? "unknown"}`);
      currentContainer(pod, contract.container, `${contract.name} Pod ${pod.metadata?.name ?? "unknown"}`);
    }
  }

  const services = list(snapshot, "services");
  const serverService = exactNamed(services, "t4-cluster-server", "cluster-server Service");
  label(serverService, "app.kubernetes.io/part-of", "t4-cluster", "cluster-server Service");
  label(serverService, "app.kubernetes.io/component", "server", "cluster-server Service");
  const ports = new Map((serverService.spec?.ports ?? []).map(({ name, port }) => [name, port]));
  if (ports.get("websocket") !== 8080 || ports.size !== 1) {
    fail("cluster-server Service does not expose the exact websocket port");
  }
  const metricsService = exactNamed(services, "t4-cluster-metrics", "cluster metrics Service");
  label(metricsService, "app.kubernetes.io/part-of", "t4-cluster", "cluster metrics Service");
  label(metricsService, "app.kubernetes.io/component", "server", "cluster metrics Service");
  const metricsPorts = new Map((metricsService.spec?.ports ?? []).map(({ name, port }) => [name, port]));
  if (metricsPorts.get("metrics") !== 9090 || metricsPorts.size !== 1) {
    fail("cluster metrics Service does not expose the exact admin metrics port");
  }
  return snapshot;
}

export function validateDefaultOffRender(documents) {
  if (!Array.isArray(documents) || documents.length > 512) fail("default-off render was malformed or exceeded its bound");
  const workloads = documents.filter((document) => document && WORKLOAD_KINDS.has(document.kind));
  if (workloads.length > 0) {
    fail(`default-off render created workload ${workloads[0].kind}/${workloads[0].metadata?.name ?? "unknown"}`);
  }
  return { clusterOperatorEnabled: false, workloadCount: 0 };
}

export function summarizeClusterSnapshot(snapshot, options = {}) {
  validateClusterSnapshot(snapshot, options);
  const deployments = list(snapshot, "deployments");
  const workspaces = list(snapshot, "t4workspaces");
  const sessions = list(snapshot, "t4sessions");
  const pvcs = list(snapshot, "persistentvolumeclaims");
  const allPods = list(snapshot, "pods");
  const lease = snapshot.lease;
  const capturedAt = new Date(options.now ?? Date.now()).toISOString();
  return {
    schemaVersion: "t4-cluster-readonly-snapshot/1",
    observedAt: capturedAt,
    deployments: deployments.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      component: metadata.labels["app.kubernetes.io/component"],
      replicas: spec.replicas,
      maxUnavailable: spec.strategy.rollingUpdate.maxUnavailable,
      availableReplicas: status.availableReplicas,
      generation: metadata.generation,
      observedGeneration: status.observedGeneration,
    })),
    leader: { lease: lease.metadata.name, holderIdentity: lease.spec.holderIdentity, renewTime: lease.spec.renewTime },
    crds: list(snapshot, "customresourcedefinitions").map(({ metadata }) => metadata.name),
    workspaces: workspaces.map(({ metadata, status }) => ({ name: metadata.name, phase: status.phase, pvc: status.pvcName })),
    sessions: sessions.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      phase: status.phase,
      pod: status.podName,
      ...(spec.ci ? { ci: { repositoryId: spec.ci.repositoryId, ref: spec.ci.ref, commit: spec.ci.commit } } : {}),
    })),
    storage: pvcs.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      storageClassName: spec.storageClassName,
      accessModes: spec.accessModes,
      phase: status.phase,
      capacity: status.capacity?.storage ?? "unknown",
    })),
    placements: allPods
      .filter(({ metadata }) => metadata?.labels?.["cluster.t4.dev/session"])
      .map(({ metadata, spec }) => ({ name: metadata.name, node: spec.nodeName })),
    images: allPods.flatMap(({ metadata, status }) =>
      (status?.containerStatuses ?? []).map(({ name, image, imageID, ready }) => ({
        pod: metadata.name,
        labels: {
          name: metadata.labels?.["app.kubernetes.io/name"],
          component: metadata.labels?.["app.kubernetes.io/component"],
          session: metadata.labels?.["cluster.t4.dev/session"],
          partOf: metadata.labels?.["app.kubernetes.io/part-of"],
        },
        phase: status.phase,
        ready: ready === true,
        container: name,
        image,
        imageID,
      })),
    ),
  };
}
