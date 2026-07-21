import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import {
  IMAGE_COMPONENTS,
  OBSERVATION_SYSTEMS,
  PROOF_SCENARIOS,
  createFileEvidence,
  redactFrame,
  validateProofManifest,
} from "./proof-contract.mjs";
import {
  collectReadOnlyClusterSnapshot,
  validateClusterSnapshot,
  validateDefaultOffRender,
} from "./readonly-cluster-proof.mjs";
import { grafanaHealthSummary, lokiLogSummary, prometheusSample } from "./collect-readonly-cluster.mjs";
import { HARBOR_REGISTRY_ALIASES, normalizeRegistryAuth } from "./normalize-registry-auth.mjs";
import { provenanceVerificationMode, verifyProvenance, verifySpdx, vulnerabilityCounts } from "./assemble-image-manifest.mjs";
import { clusterWebSocketUrl, proofHelloFrame } from "./capture-redacted-frames.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const FILE_SHA = "b".repeat(64);
const CANONICAL_BUILD_SOURCE_REPOSITORY = "usr-bin-roygbiv/t4-code";
const AUTHORIZED_CI_MIRROR = "z-peterson/t4-code";
const OBSERVED_AT = "2026-07-20T12:34:56.000Z";
const repoRoot = resolve(import.meta.dirname, "../..");
const OBSERVATION_HOSTS = {
  woodpecker: "woodpecker-ci-dev.tailb18de3.ts.net",
  prometheus: "interview-responder-prometheus.tailb18de3.ts.net",
  loki: "interview-responder-loki.tailb18de3.ts.net",
  grafana: "grafana.tailb18de3.ts.net",
};
const CONTRACT_SCENARIOS = new Set(["wire-reconnect-idempotency", "gui-auth-isolation", "desktop-viewport", "mobile-viewport"]);
const CLUSTER_VALIDATION = {
  now: Date.parse(OBSERVED_AT),
  ciMapping: { repositoryId: "71", ref: "refs/heads/agent/t4-cluster-operator", commit: COMMIT },
};

function fileEvidence(path) {
  return { path: `artifacts/cluster-proof/${path}`, sha256: FILE_SHA };
}

function validProof() {
  const suffixes = {
    controller: "t4-cluster-operator",
    "cluster-server": "t4-cluster-server",
    "session-runtime": "t4-session-runtime",
  };
  return {
    schemaVersion: "t4-cluster-proof/1",
    source: {
      repository: "usr-bin-roygbiv/t4-code",
      commit: COMMIT,
      woodpecker: {
        repository: "z-peterson/t4-code",
        repositoryId: 71,
        pipelineId: 401,
        pipelineNumber: 99,
        url: "https://woodpecker-ci-dev.tailb18de3.ts.net/repos/71/pipeline/99",
      },
    },
    images: IMAGE_COMPONENTS.map((component) => {
      const repository = `harbor.example.test/t4/${suffixes[component]}`;
      return {
        component,
        repository,
        tag: COMMIT,
        digest: DIGEST,
        reference: `${repository}@${DIGEST}`,
        sbom: fileEvidence(`images/${component}.spdx.json`),
        provenance: { ...fileEvidence(`images/${component}.provenance.json`), mode: "buildkit-content", signatureVerified: false },
        vulnerability: {
          ...fileEvidence(`images/${component}.trivy.json`),
          scanner: "trivy",
          critical: 0,
          high: 0,
        },
      };
    }),
    scenarios: PROOF_SCENARIOS.map((id) => ({
      id,
      status: "passed",
      evidenceType: CONTRACT_SCENARIOS.has(id) ? "contract" : "live",
      observedAt: OBSERVED_AT,
      assertions: [`${id}.observable-contract`],
      evidence: [fileEvidence(`scenarios/${id}.json`)],
    })),
    observations: OBSERVATION_SYSTEMS.map((system, index) => ({
      system,
      observedAt: OBSERVED_AT,
      url: system === "kubernetes" ? null : `https://${OBSERVATION_HOSTS[system]}/`,
      ids: [`${system}-${index + 1}`],
      evidence: fileEvidence(`observations/${system}.json`),
    })),
    artifacts: {
      frames: [
        { ...fileEvidence("frames/omp-app.json"), redacted: true, evidenceType: "live" },
      ],
      screenshots: [
        { ...fileEvidence("screenshots/desktop.png"), redacted: true, evidenceType: "contract", viewport: "desktop" },
        { ...fileEvidence("screenshots/mobile.png"), redacted: true, evidenceType: "contract", viewport: "mobile" },
      ],
    },
  };
}

function liveClusterResponses() {
  const workloadImage = `harbor.tailb18de3.ts.net/linkedin-bot/workload@${DIGEST}`;
  const labels = (component) => ({
    "app.kubernetes.io/name": "t4-cluster",
    "app.kubernetes.io/part-of": "t4-cluster",
    "app.kubernetes.io/component": component,
  });
  const workloadPod = (name, component, container) => ({
    metadata: { name, labels: labels(component) },
    spec: { nodeName: "k3s-worker-01" },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: container, image: workloadImage, imageID: `containerd://${workloadImage}`, ready: true }],
    },
  });
  return {
    deployments: {
      items: [
        {
          metadata: { name: "t4-cluster-controller", generation: 4, labels: labels("controller") },
          spec: {
            replicas: 2,
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } },
          },
          status: { observedGeneration: 4, availableReplicas: 2 },
        },
        {
          metadata: { name: "t4-cluster-server", generation: 6, labels: labels("server") },
          spec: {
            replicas: 3,
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } },
          },
          status: { observedGeneration: 6, availableReplicas: 3 },
        },
      ],
    },
    lease: {
      metadata: { name: "t4-cluster-operator.cluster.t4.dev" },
      spec: { holderIdentity: "t4-cluster-controller-7cbbc8-x7v2k", renewTime: OBSERVED_AT },
    },
    customresourcedefinitions: {
      items: ["t4clusterhosts", "t4workspaces", "t4sessions"].map((plural) => ({
        metadata: { name: `${plural}.cluster.t4.dev` },
        spec: {
          group: "cluster.t4.dev",
          scope: "Namespaced",
          names: { plural },
          versions: [{ name: "v1alpha1", served: true, storage: true }],
        },
      })),
    },
    t4clusterhosts: {
      items: [{ metadata: { name: "development", generation: 2 }, status: { observedGeneration: 2 } }],
    },
    t4workspaces: {
      items: [
        {
          metadata: { name: "proof-workspace", generation: 3 },
          spec: { retentionPolicy: "Retain" },
          status: { observedGeneration: 3, pvcName: "proof-workspace-data", phase: "Ready" },
        },
      ],
    },
    t4sessions: {
      items: [
        {
          metadata: { name: "proof-session", generation: 5 },
          spec: {
            workspaceRef: "proof-workspace",
            ci: { repositoryId: "71", ref: "refs/heads/agent/t4-cluster-operator", commit: COMMIT },
          },
          status: { observedGeneration: 5, phase: "Running", podName: "t4-session-proof-session" },
        },
      ],
    },
    persistentvolumeclaims: {
      items: [
        {
          metadata: {
            name: "proof-workspace-data",
            labels: {
              "app.kubernetes.io/part-of": "t4-cluster",
              "cluster.t4.dev/workspace": "proof-workspace",
            },
          },
          spec: { accessModes: ["ReadWriteMany"], storageClassName: "t4-workspaces-rwx" },
          status: { phase: "Bound", capacity: { storage: "20Gi" } },
        },
      ],
    },
    pods: {
      items: [
        workloadPod("t4-cluster-controller-a", "controller", "controller"),
        workloadPod("t4-cluster-server-a", "server", "server"),
        workloadPod("t4-cluster-server-b", "server", "server"),
        {
          metadata: {
            name: "t4-session-proof-session",
            labels: {
              "app.kubernetes.io/name": "t4-session-runtime",
              "app.kubernetes.io/part-of": "t4-cluster",
              "cluster.t4.dev/session": "t4-session-proof-session",
            },
          },
          spec: { nodeName: "k3s-worker-01" },
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
            containerStatuses: [{ name: "session-runtime", image: workloadImage, imageID: `containerd://${workloadImage}`, ready: true }],
          },
        },
      ],
    },
    services: {
      items: [
        {
          metadata: { name: "t4-cluster-server", labels: labels("server") },
          spec: { ports: [{ name: "websocket", port: 8080 }] },
        },
        {
          metadata: { name: "t4-cluster-metrics", labels: labels("server") },
          spec: { ports: [{ name: "metrics", port: 9090 }] },
        },
      ],
    },
  };
}

test("Woodpecker keeps upstream gates and serializes bounded cluster publication", async () => {
  const pipeline = yaml.load(await readFile(resolve(repoRoot, ".woodpecker.yml"), "utf8"));
  assert.equal(typeof pipeline, "object");
  const steps = pipeline.steps;
  const coreCommands = steps["upstream-core"].commands;
  assert.deepEqual(coreCommands, [
    'export PATH="$PWD/.ci:$PATH"',
    "corepack enable",
    "pnpm check:release && pnpm check:provenance && pnpm lint && pnpm --filter '!@t4-code/flutter' -r typecheck",
    "VP_RUN_CONCURRENCY_LIMIT=1 pnpm --filter '!@t4-code/flutter' -r test",
    "pnpm --filter '!@t4-code/flutter' -r build",
    "pnpm exec playwright install --with-deps chromium",
    "pnpm test:e2e",
    "pnpm test:packaging",
  ]);
  const unfilteredSdkCommand = /(?:^|\s)pnpm(?:\s+-r)?\s+(?:check|typecheck|test|build)(?:\s|$)/u;
  for (const command of coreCommands) {
    assert.doesNotMatch(
      command,
      unfilteredSdkCommand,
      `pipeline 38:64 reproduced unfiltered core workspace traversal as "Failed to find executable flutter": ${command}`,
    );
  }
  assert.ok(steps["legacy-bridge-continuity"].commands.includes("pnpm test:legacy-bridge-continuity"));
  assert.equal(steps["legacy-bridge-continuity"].environment.T4_OMP_SOURCE_DIR, ".continuity/omp");
  assert.ok(
    steps["android-debug"].commands.includes("pnpm --filter @t4-code/mobile check:android:debug"),
  );
  assert.ok(steps["cluster-ci-contracts"].commands.includes("pnpm test:cluster:ci"));
  assert.deepEqual(steps["cluster-operator-tests"].commands, [
    "GOMAXPROCS=1 GOFLAGS=-p=1 go test ./api/... ./controllers/... ./cmd/...",
    "mkdir -p ../../artifacts/cluster-proof",
    "CGO_ENABLED=0 GOMAXPROCS=1 GOFLAGS=-p=1 go test -c ./charttests -o ../../artifacts/cluster-proof/chart-contract.test",
  ]);
  assert.equal(
    steps["cluster-operator-tests"].backend_options.kubernetes.resources.limits.memory,
    "2Gi",
  );
  assert.ok(
    steps["cluster-chart-tests"].commands.includes("helm lint ../../../deploy/charts/t4-cluster"),
  );
  assert.ok(
    steps["cluster-chart-tests"].commands.some((command) => command.endsWith("chart-contract.test")),
  );
  assert.match(steps["cluster-server-tests"].image, /oven\/bun:[^@]+@sha256:[0-9a-f]{64}$/u);
  assert.ok(
    steps["cluster-server-tests"].commands.includes("(cd packages/cluster-server && bun --bun run test)"),
  );
  assert.match(steps["cluster-wire-tests"].image, /library\/node:[^@]+@sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(steps["cluster-wire-tests"].depends_on, ["cluster-server-tests", "bun-runtime"]);
  assert.ok(steps["cluster-wire-tests"].commands.includes('export PATH="$PWD/.ci:$PATH"'));
  assert.ok(
    steps["cluster-wire-tests"].commands.includes(
      "(cd packages/host-wire && bun test test/cluster-operator.test.ts)",
    ),
  );
  assert.ok(
    steps["cluster-wire-tests"].commands.includes(
      "(cd packages/host-service && bun test test/cluster-default-off.test.ts)",
    ),
  );
  assert.equal(
    steps["cluster-wire-tests"].commands.includes("(cd packages/host-service && bun --bun run test)"),
    false,
  );
  assert.equal(JSON.stringify(pipeline).includes("from_secret"), false);
  assert.deepEqual(steps["harbor-auth"].depends_on, ["cluster-chart-tests", "android-debug"]);
  assert.equal(
    steps["harbor-auth"].backend_options.kubernetes.serviceAccountName,
    "woodpecker-dev-verifier",
  );
  assert.deepEqual(steps["build-controller"].depends_on, ["harbor-auth"]);
  assert.deepEqual(steps["live-cluster-observations"].depends_on, ["cleanup-image-registry-auth"]);
  assert.deepEqual(steps["publish-live-proof"].depends_on, ["harbor-auth-live-proof"]);
  assert.deepEqual(steps["image-publication-manifest"].depends_on, ["provenance-session-runtime"]);
  assert.deepEqual(steps["promote-images"].depends_on, ["image-publication-manifest"]);
  assert.deepEqual(steps["publish-image-evidence"].depends_on, ["promote-images"]);
  assert.equal(steps["image-publication-manifest"].environment.HARBOR_REGISTRY, "harbor.tailb18de3.ts.net");
  assert.match(pipeline.clone.git.image, /@sha256:[0-9a-f]{64}$/u);

  const orderedBuilds = ["build-controller", "build-cluster-server", "build-session-runtime"];
  for (const [index, name] of orderedBuilds.entries()) {
    const step = steps[name];
    assert.equal(step.backend_options.kubernetes.serviceAccountName, "woodpecker-ci-untrusted");
    assert.ok(step.backend_options.kubernetes.resources.limits.memory);
    if (index > 0) assert.deepEqual(step.depends_on, [orderedBuilds[index - 1]]);
  }
  assert.match(steps["build-controller"].commands[0], /t4-cluster-operator/u);
  assert.match(steps["build-cluster-server"].commands[0], /t4-cluster-server/u);
  assert.match(steps["build-session-runtime"].commands[0], /t4-session-runtime/u);

  const busyboxEntrypoint = [
    "/busybox/sh",
    "-c",
    'echo "$CI_SCRIPT" | /busybox/base64 -d | /busybox/sh -e',
  ];
  for (const component of ["controller", "cluster-server", "session-runtime"]) {
    const sbomStep = steps[`sbom-${component}`];
    assert.match(sbomStep.image, /anchore\/syft:v1\.33\.0-debug@sha256:[0-9a-f]{64}$/u);
    assert.equal(sbomStep.environment.PATH, "/busybox:/");
    assert.deepEqual(sbomStep.entrypoint, busyboxEntrypoint);
    assert.match(sbomStep.commands[0], /^sh scripts\/cluster-ci\/capture-image-evidence\.sh sbom /u);

    const provenanceStep = steps[`provenance-${component}`];
    assert.match(provenanceStep.image, /projectsigstore\/cosign:v2\.6\.0-dev@sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(provenanceStep.entrypoint, busyboxEntrypoint);
    assert.match(
      provenanceStep.commands[0],
      /^sh scripts\/cluster-ci\/capture-image-evidence\.sh provenance /u,
    );
  }

  for (const [name, step] of Object.entries(steps)) {
    assert.match(step.image, /@sha256:[0-9a-f]{64}$/u, `${name} image must be immutable`);
    if (step.environment?.HARBOR_REGISTRY) {
      assert.equal(step.environment.HARBOR_REGISTRY, "harbor.tailb18de3.ts.net");
    }
    for (const condition of step.when ?? []) {
      if (condition.event === "manual") {
        assert.deepEqual(condition.branch, ["main", "agent/t4-cluster-operator"]);
      }
    }
  }
  assert.deepEqual(steps["cleanup-image-registry-auth"].when[0].status, ["success", "failure"]);
  assert.deepEqual(steps["cleanup-live-registry-auth"].when[0].status, ["success", "failure"]);
  assert.deepEqual(steps["live-frame-proof"].commands, ["node scripts/cluster-ci/capture-redacted-frames.mjs"]);
  assert.equal(steps["live-frame-proof"].environment.T4_CLUSTER_BASE_URL, "https://t4-dev.tailb18de3.ts.net/");
  assert.deepEqual(steps["live-proof-assembly"].depends_on, ["live-frame-proof"]);
  const frameCaptureSource = await readFile(resolve(repoRoot, "scripts/cluster-ci/capture-redacted-frames.mjs"), "utf8");
  assert.doesNotMatch(frameCaptureSource, /client.?secret|deviceId|access.?token/iu);
  for (const capability of ["sessions.read", "ci.trigger", "preview.read", "preview.control", "preview.input"]) {
    assert.match(frameCaptureSource, new RegExp(capability.replace(".", "\\."), "u"));
  }
  assert.match(frameCaptureSource, /\/v1\/ws/u);

  const buildSource = await readFile(resolve(repoRoot, "scripts/cluster-ci/build-image.sh"), "utf8");
  assert.match(buildSource, /platform=linux\/amd64,linux\/arm64/u);
  assert.match(buildSource, /source_context="https:\/\/github\.com\/\$canonical_build_source_repository\.git#\$CI_COMMIT_SHA"/u);
  assert.match(buildSource, /SOURCE_REPOSITORY=https:\/\/github\.com\/\$canonical_build_source_repository/u);
  assert.doesNotMatch(buildSource, /https:\/\/github\.com\/z-peterson\/t4-code/u);
  assert.match(buildSource, /^canonical_build_source_repository=usr-bin-roygbiv\/t4-code$/mu);
  assert.match(buildSource, /^authorized_ci_mirror=z-peterson\/t4-code$/mu);
  assert.equal(buildSource.match(/usr-bin-roygbiv\/t4-code/gu)?.length, 1);
  assert.equal(buildSource.match(/z-peterson\/t4-code/gu)?.length, 1);
  assert.match(buildSource, /quarantine/u);
  assert.match(buildSource, /chmod 1777 "\$artifact_dir"/u);
  assert.match(buildSource, /chmod 0444 "\$metadata" "\$digest_file"/u);

  const sourceArgument = "ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code";
  const sourceLabel = 'org.opencontainers.image.source="${SOURCE_REPOSITORY}"';
  for (const component of IMAGE_COMPONENTS) {
    const dockerfileSource = await readFile(resolve(repoRoot, "cluster/images", component, "Dockerfile"), "utf8");
    const finalStageOffset = dockerfileSource.lastIndexOf("\nFROM ");
    const sourceArgumentOffset = dockerfileSource.indexOf(sourceArgument, finalStageOffset);
    const sourceLabelOffset = dockerfileSource.indexOf(sourceLabel, sourceArgumentOffset);
    assert.ok(finalStageOffset >= 0, `${component} must have a final image stage`);
    assert.ok(sourceArgumentOffset > finalStageOffset, `${component} must declare SOURCE_REPOSITORY in its final stage`);
    assert.ok(sourceLabelOffset > sourceArgumentOffset, `${component} must use SOURCE_REPOSITORY for its OCI source label`);
    assert.equal(dockerfileSource.match(/ARG SOURCE_REPOSITORY=/gu)?.length, 1);
    assert.equal(dockerfileSource.match(/org\.opencontainers\.image\.source=/gu)?.length, 1);
    assert.doesNotMatch(dockerfileSource, /org\.opencontainers\.image\.source="https:\/\//u);
  }

  const promotionSource = await readFile(resolve(repoRoot, "scripts/cluster-ci/promote-images.sh"), "utf8");
  const preflightResolveOffset = promotionSource.indexOf('if resolved=$(oras resolve "$destination" 2>&1); then');
  const differentDigestGuardOffset = promotionSource.indexOf('if [ "$resolved" != "$digest" ]; then', preflightResolveOffset);
  const recursiveCopyOffset = promotionSource.indexOf('oras copy --recursive "$source" "$destination"', differentDigestGuardOffset);
  const verificationResolveOffset = promotionSource.indexOf('resolved=$(oras resolve "$destination")', recursiveCopyOffset);
  assert.ok(
    preflightResolveOffset >= 0 &&
      preflightResolveOffset < differentDigestGuardOffset &&
      differentDigestGuardOffset < recursiveCopyOffset &&
      recursiveCopyOffset < verificationResolveOffset,
    "promotion must resolve and reject an occupied tag before copying, then verify the result",
  );
  const promotionGuard = promotionSource.slice(preflightResolveOffset, recursiveCopyOffset);
  assert.match(promotionGuard, /if \[ "\$resolved" != "\$digest" \]; then[\s\S]*?exit 65\n    fi\n  else/u);
  assert.match(promotionGuard, /"failed to resolve digest: \$CI_COMMIT_SHA: not found"/u);
  assert.doesNotMatch(promotionSource.slice(0, preflightResolveOffset), /oras copy/u);
  const authSource = await readFile(resolve(repoRoot, "scripts/cluster-ci/load-registry-auth.sh"), "utf8");
  assert.match(authSource, /chmod 0711 "\$auth_parent" "\$auth_dir"/u);
  const provenanceSource = await readFile(resolve(repoRoot, "scripts/cluster-ci/capture-image-evidence.sh"), "utf8");
  assert.match(provenanceSource, /cosign verify-attestation/u);
  assert.match(provenanceSource, /cosign download attestation/u);
  assert.match(provenanceSource, /must be configured together/u);
  assert.doesNotMatch(provenanceSource, /INSECURE|plain-http/iu);
  const dockerignore = await readFile(resolve(repoRoot, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\.cluster-ci\/registry-auth$/mu);
  assert.deepEqual(provenanceVerificationMode({}), { mode: "buildkit-content", signatureVerified: false });
  assert.deepEqual(
    provenanceVerificationMode({ T4_COSIGN_CERTIFICATE_IDENTITY: "builder", T4_COSIGN_CERTIFICATE_OIDC_ISSUER: "https://issuer.example" }),
    { mode: "cosign-keyless", signatureVerified: true },
  );
  assert.throws(
    () => provenanceVerificationMode({ T4_COSIGN_CERTIFICATE_IDENTITY: "builder" }),
    /configured together/u,
  );

  for (const script of ["build-image.sh", "capture-image-evidence.sh", "promote-images.sh", "publish-artifact.sh"]) {
    const source = await readFile(resolve(repoRoot, "scripts/cluster-ci", script), "utf8");
    assert.doesNotMatch(source, /HARBOR_(?:USERNAME|PASSWORD)/u);
    assert.match(source, /DOCKER_CONFIG/u);
  }
});

test("registry auth is restricted to the exact HTTPS tailnet Harbor aliases", () => {
  const auth = "dXNlcjpwYXNz";
  const normalized = normalizeRegistryAuth({
    auths: {
      "harbor.tailb18de3.ts.net": { auth },
      "unrelated.example": { auth: "dW53YW50ZWQ6Y3JlZGVudGlhbA==" },
    },
  });
  assert.deepEqual(Object.keys(normalized.auths), HARBOR_REGISTRY_ALIASES);
  assert.ok(Object.values(normalized.auths).every((entry) => entry.auth === auth));
  assert.equal("unrelated.example" in normalized.auths, false);
  assert.throws(() => normalizeRegistryAuth({ auths: {} }), /no bounded registry authentication entry/u);
});

test("proof schema is strict and enumerates every bounded evidence domain", async () => {
  const schema = JSON.parse(
    await readFile(resolve(repoRoot, "scripts/cluster-ci/cluster-proof.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.$defs.scenario.properties.id.enum, PROOF_SCENARIOS);
  assert.deepEqual(schema.$defs.observation.properties.system.enum, OBSERVATION_SYSTEMS);
  assert.deepEqual(schema.$defs.image.properties.component.enum, IMAGE_COMPONENTS);
  assert.equal(schema.$defs.source.properties.repository.const, CANONICAL_BUILD_SOURCE_REPOSITORY);
  assert.equal(
    schema.$defs.source.properties.woodpecker.properties.repository.const,
    AUTHORIZED_CI_MIRROR,
  );
  assert.ok(schema.$defs.source.properties.woodpecker.required.includes("repository"));
  assert.equal(schema.$defs.artifacts.properties.frames.maxItems, 32);
  assert.equal("videos" in schema.$defs.artifacts.properties, false);
});

test("proof validation accepts exact run/image/scenario identity and rejects fabricated gaps", () => {
  const proof = validProof();
  assert.equal(validateProofManifest(proof), proof);

  const missingScenario = structuredClone(proof);
  missingScenario.scenarios.pop();
  assert.throws(() => validateProofManifest(missingScenario), /scenario coverage/u);

  const failedScenario = structuredClone(proof);
  failedScenario.scenarios[0].status = "failed";
  assert.throws(() => validateProofManifest(failedScenario), /must be passed/u);

  const mutableImage = structuredClone(proof);
  mutableImage.images[0].reference = `${mutableImage.images[0].repository}:latest`;
  assert.throws(() => validateProofManifest(mutableImage), /immutable digest/u);

  const unredacted = structuredClone(proof);
  unredacted.artifacts.frames[0].redacted = false;
  assert.throws(() => validateProofManifest(unredacted), /redacted/u);

  const fabricatedLiveScreenshot = structuredClone(proof);
  fabricatedLiveScreenshot.artifacts.screenshots[0].evidenceType = "live";
  assert.throws(() => validateProofManifest(fabricatedLiveScreenshot), /contract evidence/u);

  const fabricatedLiveScenario = structuredClone(proof);
  fabricatedLiveScenario.scenarios.find(({ id }) => id === "desktop-viewport").evidenceType = "live";
  assert.throws(() => validateProofManifest(fabricatedLiveScenario), /must be contract/u);

  const unauthenticatedSignerClaim = structuredClone(proof);
  unauthenticatedSignerClaim.images[0].provenance.mode = "cosign-keyless";
  assert.throws(() => validateProofManifest(unauthenticatedSignerClaim), /signer verification claim/u);

  const extra = structuredClone(proof);
  extra.source.token = "must-not-survive";
  assert.throws(() => validateProofManifest(extra), /unexpected field/u);
});

test("proof source distinguishes the canonical build repository from the authorized CI mirror", () => {
  const proof = validProof();
  assert.equal(proof.source.repository, CANONICAL_BUILD_SOURCE_REPOSITORY);
  assert.equal(proof.source.woodpecker.repository, AUTHORIZED_CI_MIRROR);

  const mirrorAsBuildSource = structuredClone(proof);
  mirrorAsBuildSource.source.repository = AUTHORIZED_CI_MIRROR;
  assert.throws(() => validateProofManifest(mirrorAsBuildSource), /canonical build source/u);

  const buildSourceAsMirror = structuredClone(proof);
  buildSourceAsMirror.source.woodpecker.repository = CANONICAL_BUILD_SOURCE_REPOSITORY;
  assert.throws(() => validateProofManifest(buildSourceAsMirror), /authorized CI mirror/u);
});

test("file evidence is content-addressed instead of trusting a claimed result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t4-cluster-proof-"));
  const absolutePath = join(directory, "observation.json");
  await writeFile(absolutePath, '{"observed":true}\n', "utf8");
  const evidence = await createFileEvidence(absolutePath, {
    artifactRoot: directory,
    artifactPrefix: "artifacts/cluster-proof/observations",
  });
  assert.equal(evidence.path, "artifacts/cluster-proof/observations/observation.json");
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(evidence.sha256, FILE_SHA);
});

test("frame redaction strips authority-sensitive content and bounds retained state", () => {
  const redacted = redactFrame({
    type: "session.state",
    sessionId: "proof-session",
    cursor: 11,
    revision: 7,
    authorization: "Bearer secret",
    auth: "private-auth",
    bearer: "private-bearer",
    apiKey: "private-api-key",
    privateKey: "private-key",
    token: "secret-token",
    prompt: "private prompt",
    transcript: [{ text: "private output" }],
    payload: { cookie: "private-cookie", status: "running" },
  });
  assert.deepEqual(redacted, {
    type: "session.state",
    sessionId: "proof-session",
    cursor: 11,
    revision: 7,
    authorization: "[REDACTED]",
    auth: "[REDACTED]",
    bearer: "[REDACTED]",
    apiKey: "[REDACTED]",
    privateKey: "[REDACTED]",
    token: "[REDACTED]",
    prompt: "[REDACTED]",
    transcript: "[REDACTED]",
    payload: { cookie: "[REDACTED]", status: "running" },
  });
  assert.throws(() => redactFrame({ payload: "x".repeat(70_000) }), /bound/u);
});

test("read-only collection executes only bounded Kubernetes GETs", async () => {
  const responses = liveClusterResponses();
  const calls = [];
  const snapshot = await collectReadOnlyClusterSnapshot({
    namespace: "t4-development",
    run: async (command, args) => {
      calls.push([command, args]);
      assert.equal(command, "kubectl");
      assert.equal(args[0], "get");
      assert.ok(!args.some((arg) => ["apply", "create", "delete", "patch", "replace"].includes(arg)));
      return JSON.stringify(responses[args[1]]);
    },
  });
  assert.equal(calls.length, 9);
  assert.equal(validateClusterSnapshot(snapshot, CLUSTER_VALIDATION), snapshot);
});

test("live snapshot validation rejects stale or loosely matched cluster truth", () => {
  const responses = liveClusterResponses();
  assert.equal(validateClusterSnapshot(responses, CLUSTER_VALIDATION), responses);

  const noLeader = structuredClone(responses);
  noLeader.lease.spec.holderIdentity = "";
  assert.throws(() => validateClusterSnapshot(noLeader, CLUSTER_VALIDATION), /leader Lease/u);

  const staleLeader = structuredClone(responses);
  staleLeader.lease.spec.renewTime = "2026-07-20T12:33:00.000Z";
  assert.throws(() => validateClusterSnapshot(staleLeader, CLUSTER_VALIDATION), /freshly held/u);

  const wrongLeaseName = structuredClone(responses);
  wrongLeaseName.lease.metadata.name = "t4-cluster-controller";
  assert.throws(() => validateClusterSnapshot(wrongLeaseName, CLUSTER_VALIDATION), /t4-cluster-operator\.cluster\.t4\.dev/u);

  const staleGeneration = structuredClone(responses);
  staleGeneration.t4sessions.items[0].status.observedGeneration = 4;
  assert.throws(() => validateClusterSnapshot(staleGeneration, CLUSTER_VALIDATION), /metadata\.generation exactly/u);

  const wrongControllerRollout = structuredClone(responses);
  wrongControllerRollout.deployments.items[0].spec.strategy.rollingUpdate.maxUnavailable = 1;
  assert.throws(() => validateClusterSnapshot(wrongControllerRollout, CLUSTER_VALIDATION), /exact HA rollout/u);

  const legacyPvcField = structuredClone(responses);
  legacyPvcField.t4workspaces.items[0].status.pvcRef = { name: "proof-workspace-data" };
  delete legacyPvcField.t4workspaces.items[0].status.pvcName;
  assert.throws(() => validateClusterSnapshot(legacyPvcField, CLUSTER_VALIDATION), /status\.pvcName/u);

  const wrongStorage = structuredClone(responses);
  wrongStorage.persistentvolumeclaims.items[0].spec.accessModes = ["ReadWriteOnce"];
  assert.throws(() => validateClusterSnapshot(wrongStorage, CLUSTER_VALIDATION), /ReadWriteMany/u);

  const notReady = structuredClone(responses);
  notReady.pods.items[3].status.conditions[0].status = "False";
  assert.throws(() => validateClusterSnapshot(notReady, CLUSTER_VALIDATION), /Running and Ready/u);

  const mutableContainer = structuredClone(responses);
  mutableContainer.pods.items[3].status.containerStatuses[0].imageID = "containerd://mutable:latest";
  assert.throws(() => validateClusterSnapshot(mutableContainer, CLUSTER_VALIDATION), /current digest/u);

  const mismatchedContainerDigest = structuredClone(responses);
  mismatchedContainerDigest.pods.items[3].status.containerStatuses[0].imageID = `containerd://harbor.tailb18de3.ts.net/linkedin-bot/workload@sha256:${"c".repeat(64)}`;
  assert.throws(() => validateClusterSnapshot(mismatchedContainerDigest, CLUSTER_VALIDATION), /declared current digest/u);

  const wrongCiCommit = structuredClone(responses);
  wrongCiCommit.t4sessions.items[0].spec.ci.commit = "f".repeat(40);
  assert.throws(() => validateClusterSnapshot(wrongCiCommit, CLUSTER_VALIDATION), /CI mapping/u);

  const forbiddenPlacement = structuredClone(responses);
  forbiddenPlacement.pods.items[3].spec.nodeName = "k3s-worker-03";
  assert.throws(() => validateClusterSnapshot(forbiddenPlacement, CLUSTER_VALIDATION), /durable session placement/u);

  const wrongSessionLabel = structuredClone(responses);
  wrongSessionLabel.pods.items[3].metadata.labels["cluster.t4.dev/session"] = "proof-session";
  assert.throws(() => validateClusterSnapshot(wrongSessionLabel, CLUSTER_VALIDATION), /label cluster\.t4\.dev\/session/u);

  const wrongPortName = structuredClone(responses);
  wrongPortName.services.items[0].spec.ports[0].name = "omp-app";
  assert.throws(() => validateClusterSnapshot(wrongPortName, CLUSTER_VALIDATION), /exact websocket port/u);

  const wrongMetricsPort = structuredClone(responses);
  wrongMetricsPort.services.items[1].spec.ports[0].port = 8080;
  assert.throws(() => validateClusterSnapshot(wrongMetricsPort, CLUSTER_VALIDATION), /admin metrics port/u);
});

test("SPDX, Trivy, and BuildKit content bind every image identity field", () => {
  const repository = "harbor.tailb18de3.ts.net/linkedin-bot/quarantine/t4-cluster-operator";
  const reference = `${repository}@${DIGEST}`;
  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: reference,
    documentNamespace: `https://anchore.com/syft/image/${DIGEST.slice(7)}`,
    documentDescribes: ["SPDXRef-Image"],
    packages: [{
      SPDXID: "SPDXRef-Image",
      name: "t4-cluster-operator",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:oci/t4-cluster-operator@${DIGEST}?repository_url=${encodeURIComponent(repository)}`,
      }],
    }],
  };
  assert.doesNotThrow(() => verifySpdx(spdx, { repository, digest: DIGEST, reference }));
  assert.throws(() => verifySpdx({ spdxVersion: "SPDX-2.3" }, { repository, digest: DIGEST, reference }), /SPDX document identity/u);
  const wrongSpdxDigest = structuredClone(spdx);
  wrongSpdxDigest.packages[0].externalRefs[0].referenceLocator = "pkg:oci/t4-cluster-operator@sha256:deadbeef";
  assert.throws(() => verifySpdx(wrongSpdxDigest, { repository, digest: DIGEST, reference }), /external reference/u);

  const trivy = {
    ArtifactName: reference,
    ArtifactType: "container_image",
    Metadata: { ImageID: `sha256:${"b".repeat(64)}`, RepoDigests: [reference] },
    Results: [{ Target: "debian", Class: "os-pkgs", Type: "debian", Vulnerabilities: [] }],
  };
  assert.deepEqual(vulnerabilityCounts(trivy, { repository, digest: DIGEST, reference }), { critical: 0, high: 0 });
  assert.throws(
    () => vulnerabilityCounts({ ...trivy, Results: [] }, { repository, digest: DIGEST, reference }),
    /results identity/u,
  );
  assert.throws(
    () => vulnerabilityCounts({ ...trivy, ArtifactName: "wrong" }, { repository, digest: DIGEST, reference }),
    /artifact\/results identity/u,
  );
  const wrongTrivyIndexDigest = structuredClone(trivy);
  wrongTrivyIndexDigest.Metadata.RepoDigests = [`${repository}@sha256:${"c".repeat(64)}`];
  assert.throws(
    () => vulnerabilityCounts(wrongTrivyIndexDigest, { repository, digest: DIGEST, reference }),
    /artifact\/results identity/u,
  );
  const malformedTrivyChildId = structuredClone(trivy);
  malformedTrivyChildId.Metadata.ImageID = "mutable-child";
  assert.throws(
    () => vulnerabilityCounts(malformedTrivyChildId, { repository, digest: DIGEST, reference }),
    /artifact\/results identity/u,
  );

  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://slsa.dev/provenance/v0.2",
    subject: [{ name: repository, digest: { sha256: DIGEST.slice(7) } }],
    predicate: {
      builder: { id: "https://mobyproject.org/buildkit@v1" },
      buildType: "https://mobyproject.org/buildkit@v1",
      invocation: { parameters: { source: "https://github.com/usr-bin-roygbiv/t4-code", commit: COMMIT } },
      materials: [
        { uri: `https://github.com/usr-bin-roygbiv/t4-code.git#${COMMIT}`, digest: { sha1: COMMIT } },
        { uri: `pkg:docker/node@${DIGEST}`, digest: { sha256: DIGEST.slice(7) } },
      ],
    },
  };
  const envelope = (payload) => `${JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
  })}\n`;
  assert.doesNotThrow(() => verifyProvenance(envelope(statement), { repository, digest: DIGEST, commit: COMMIT }));
  const wrongSource = structuredClone(statement);
  wrongSource.predicate.materials[0].uri = `https://github.com/attacker/t4-code.git#${COMMIT}`;
  assert.throws(() => verifyProvenance(envelope(wrongSource), { repository, digest: DIGEST, commit: COMMIT }), /trusted source/u);
  assert.throws(() => verifyProvenance(envelope(statement), { repository, digest: DIGEST, commit: "f".repeat(40) }), /CI commit/u);
});

test("live observability parsers retain only bounded source-safe summaries", () => {
  assert.deepEqual(
    prometheusSample(
      { status: "success", data: { resultType: "vector", result: [{ value: [1_721_480_000, "3"] }] } },
      "t4-cluster-up",
    ),
    { name: "t4-cluster-up", value: 3, sampledAt: "2024-07-20T12:53:20.000Z" },
  );
  assert.throws(
    () => prometheusSample({ status: "success", data: { resultType: "vector", result: [] } }, "missing"),
    /one bounded nonnegative sample/u,
  );
  assert.deepEqual(
    lokiLogSummary({
      status: "success",
      data: {
        resultType: "streams",
        result: [{ stream: { namespace: "t4-development" }, values: [["1721480000000000000", '{"level":"info","event":"reconcile"}']] }],
      },
    }),
    { streamCount: 1, entryCount: 1, errorCount: 0 },
  );
  assert.deepEqual(
    grafanaHealthSummary({ database: "ok", version: "12.4.2", commit: "e".repeat(40) }),
    { database: "ok", version: "12.4.2", commit: "e".repeat(40) },
  );
  assert.throws(
    () => grafanaHealthSummary({ database: "failed", version: "12.4.2", commit: "e".repeat(40) }),
    /unhealthy/u,
  );
});

test("frame proof uses the exact cluster origin and typed Hello capabilities", () => {
  assert.equal(clusterWebSocketUrl("https://t4-dev.tailb18de3.ts.net/").href, "wss://t4-dev.tailb18de3.ts.net/v1/ws");
  assert.throws(() => clusterWebSocketUrl("https://other.tailb18de3.ts.net/"), /credential-free HTTPS origin/u);
  const hello = proofHelloFrame();
  assert.deepEqual(Object.keys(hello.capabilities), ["client"]);
  assert.deepEqual(hello.capabilities.client, [
    "sessions.read",
    "ci.trigger",
    "preview.read",
    "preview.control",
    "preview.input",
  ]);
});

test("default-off proof evaluates rendered resources rather than chart source text", () => {
  assert.deepEqual(
    validateDefaultOffRender([
      { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", metadata: { name: "t4sessions.cluster.t4.dev" } },
    ]),
    { clusterOperatorEnabled: false, workloadCount: 0 },
  );
  assert.throws(
    () =>
      validateDefaultOffRender([
        { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "t4-cluster-server" } },
      ]),
    /default-off render created workload/u,
  );
});
