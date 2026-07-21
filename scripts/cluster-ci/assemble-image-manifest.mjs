import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZED_CI_MIRROR,
  CANONICAL_BUILD_SOURCE_REPOSITORY,
  IMAGE_COMPONENTS,
  createFileEvidence,
  validateImagePublicationManifest,
} from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const artifactDirectory = resolve(repoRoot, "artifacts/cluster-proof/images");
const outputPath = resolve(repoRoot, "artifacts/cluster-proof/image-publication.json");
const CANONICAL_BUILD_SOURCE_URL = `https://github.com/${CANONICAL_BUILD_SOURCE_REPOSITORY}`;
const HARBOR_REGISTRY = "harbor.tailb18de3.ts.net";
const QUARANTINE_PREFIX = "quarantine";
const suffixes = {
  controller: "t4-cluster-operator",
  "cluster-server": "t4-cluster-server",
  "session-runtime": "t4-session-runtime",
};

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function woodpeckerIdentity(environment = process.env) {
  const url = requiredEnvironment("CI_PIPELINE_URL", environment);
  const parsedUrl = new URL(url);
  const match = parsedUrl.pathname.match(/\/repos\/([1-9][0-9]*)\/pipeline\/([1-9][0-9]*)\/?$/u);
  const pipelineNumber = Number(requiredEnvironment("CI_PIPELINE_NUMBER", environment));
  if (
    parsedUrl.origin !== "https://woodpecker-ci-dev.tailb18de3.ts.net" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !match ||
    !Number.isSafeInteger(pipelineNumber) ||
    pipelineNumber <= 0
  ) {
    throw new Error("Woodpecker pipeline URL/number identity is invalid");
  }
  return {
    repositoryId: Number(match[1]),
    pipelineId: Number(match[2]),
    pipelineNumber,
    url,
  };
}

async function json(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return value;
}

function exactImagePurl(locator, repository, digest) {
  if (typeof locator !== "string" || locator.length > 2048) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(locator);
  } catch {
    return false;
  }
  const queryIndex = decoded.indexOf("?");
  const identity = queryIndex === -1 ? decoded : decoded.slice(0, queryIndex);
  if (!identity.startsWith("pkg:oci/") || !identity.endsWith(`@${digest}`)) return false;
  const parameters = new URLSearchParams(queryIndex === -1 ? "" : decoded.slice(queryIndex + 1));
  return parameters.get("repository_url") === repository;
}

export function verifySpdx(sbom, { repository, digest, reference }) {
  if (
    !sbom ||
    typeof sbom !== "object" ||
    sbom.spdxVersion !== "SPDX-2.3" ||
    sbom.dataLicense !== "CC0-1.0" ||
    sbom.SPDXID !== "SPDXRef-DOCUMENT" ||
    sbom.name !== reference ||
    typeof sbom.documentNamespace !== "string" ||
    !sbom.documentNamespace.includes(digest.slice("sha256:".length)) ||
    !Array.isArray(sbom.documentDescribes) ||
    sbom.documentDescribes.length !== 1 ||
    !Array.isArray(sbom.packages) ||
    sbom.packages.length < 1 ||
    sbom.packages.length > 100_000
  ) {
    throw new Error("SPDX document identity is not bound to the scanned image");
  }
  const imagePackage = sbom.packages.find(({ SPDXID }) => SPDXID === sbom.documentDescribes[0]);
  if (
    !imagePackage ||
    typeof imagePackage.name !== "string" ||
    imagePackage.name !== repository.slice(repository.lastIndexOf("/") + 1) ||
    !Array.isArray(imagePackage.externalRefs) ||
    !imagePackage.externalRefs.some(
      (externalRef) =>
        externalRef?.referenceCategory === "PACKAGE-MANAGER" &&
        externalRef?.referenceType === "purl" &&
        exactImagePurl(externalRef.referenceLocator, repository, digest),
    )
  ) {
    throw new Error("SPDX described package/external reference does not bind the image repository and digest");
  }
}

export function vulnerabilityCounts(report, { repository, digest, reference }) {
  if (
    !report ||
    typeof report !== "object" ||
    report.ArtifactName !== reference ||
    report.ArtifactType !== "container_image" ||
    !report.Metadata ||
    !Array.isArray(report.Metadata.RepoDigests) ||
    !report.Metadata.RepoDigests.includes(`${repository}@${digest}`) ||
    typeof report.Metadata.ImageID !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.Metadata.ImageID) ||
    !Array.isArray(report.Results) ||
    report.Results.length < 1 ||
    report.Results.length > 4096
  ) {
    throw new Error("Trivy report artifact/results identity is malformed or unbound");
  }
  const counts = { critical: 0, high: 0 };
  for (const result of report.Results) {
    if (
      typeof result?.Target !== "string" ||
      result.Target.length < 1 ||
      result.Target.length > 2048 ||
      typeof result.Class !== "string" ||
      typeof result.Type !== "string" ||
      (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities))
    ) {
      throw new Error("Trivy result entry is malformed");
    }
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability?.Severity === "CRITICAL") counts.critical += 1;
      else if (vulnerability?.Severity === "HIGH") counts.high += 1;
    }
  }
  if (counts.critical !== 0 || counts.high !== 0) {
    throw new Error(`Trivy found ${counts.critical} critical and ${counts.high} high vulnerabilities`);
  }
  return counts;
}

function boundedStrings(value, depth = 0, output = []) {
  if (depth > 12 || output.length > 4096) throw new Error("provenance exceeded its structural bound");
  if (typeof value === "string") {
    if (value.length > 4096) throw new Error("provenance string exceeded its bound");
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => boundedStrings(item, depth + 1, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => boundedStrings(item, depth + 1, output));
  }
  return output;
}

function trustedSourceMaterial(material, commit) {
  if (!material || typeof material !== "object" || typeof material.uri !== "string") return false;
  let source;
  try {
    source = new URL(material.uri.replace(/^git\+/u, ""));
  } catch {
    return false;
  }
  return (
    source.protocol === "https:" &&
    source.hostname === "github.com" &&
    source.pathname === `/${CANONICAL_BUILD_SOURCE_REPOSITORY}.git` &&
    source.hash === `#${commit}` &&
    material.digest?.sha1 === commit
  );
}

export function verifyProvenance(jsonLines, { repository, digest, commit }) {
  const expectedDigest = digest.slice("sha256:".length);
  const lines = jsonLines.split("\n").filter(Boolean);
  if (lines.length < 1 || lines.length > 32) throw new Error("provenance attestation count is invalid");
  const statements = [];
  for (const line of lines) {
    let envelope;
    let statement;
    try {
      envelope = JSON.parse(line);
      statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    } catch (error) {
      throw new Error("provenance attestation is not valid DSSE JSON", { cause: error });
    }
    if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
      throw new Error("provenance attestation is not an in-toto envelope");
    }
    statements.push(statement);
  }
  const provenance = statements.find((statement) => {
    const predicate = statement?.predicate;
    const sourceMaterial = predicate?.materials?.find((material) => trustedSourceMaterial(material, commit));
    const baseMaterial = predicate?.materials?.some(
      (material) =>
        typeof material?.uri === "string" &&
        material.uri.startsWith("pkg:docker/") &&
        /^[0-9a-f]{64}$/u.test(material.digest?.sha256 ?? ""),
    );
    const invocationStrings = boundedStrings(predicate?.invocation?.parameters ?? {});
    return (
      statement?._type === "https://in-toto.io/Statement/v0.1" &&
      typeof statement.predicateType === "string" &&
      predicate?.builder?.id === "https://mobyproject.org/buildkit@v1" &&
      statement.predicateType.startsWith("https://slsa.dev/provenance/") &&
      predicate?.buildType === "https://mobyproject.org/buildkit@v1" &&
      statement.subject?.some(
        (subject) => subject?.name === repository && subject?.digest?.sha256 === expectedDigest,
      ) &&
      sourceMaterial &&
      baseMaterial &&
      invocationStrings.includes(commit) &&
      invocationStrings.includes(CANONICAL_BUILD_SOURCE_URL)
    );
  });
  if (!provenance) {
    throw new Error("BuildKit provenance does not bind subject, trusted source repository, CI commit, and materials");
  }
}

export function provenanceVerificationMode(environment = process.env) {
  const identity = environment.T4_COSIGN_CERTIFICATE_IDENTITY?.trim() ?? "";
  const issuer = environment.T4_COSIGN_CERTIFICATE_OIDC_ISSUER?.trim() ?? "";
  if (Boolean(identity) !== Boolean(issuer)) {
    throw new Error("cosign certificate identity and OIDC issuer must be configured together");
  }
  return identity ? { mode: "cosign-keyless", signatureVerified: true } : { mode: "buildkit-content", signatureVerified: false };
}

function validateProvenanceVerification(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "mode,signatureVerified" ||
    value.mode !== expected.mode ||
    value.signatureVerified !== expected.signatureVerified
  ) {
    throw new Error("provenance signer verification record is missing or not truthful");
  }
  return value;
}

async function imageEntry(component, commit, registry, project, expectedVerification) {
  const digest = (await readFile(resolve(artifactDirectory, `${component}.digest`), "utf8")).trim();
  const repository = `${registry}/${project}/${suffixes[component]}`;
  const evidenceRepository = `${registry}/${project}/${QUARANTINE_PREFIX}/${suffixes[component]}`;
  const evidenceReference = `${evidenceRepository}@${digest}`;
  const sbomPath = resolve(artifactDirectory, `${component}.spdx.json`);
  const provenancePath = resolve(artifactDirectory, `${component}.provenance.jsonl`);
  const provenanceVerificationPath = resolve(artifactDirectory, `${component}.provenance-verification.json`);
  const vulnerabilityPath = resolve(artifactDirectory, `${component}.trivy.json`);
  verifySpdx(await json(sbomPath, `${component} SBOM`), {
    repository: evidenceRepository,
    digest,
    reference: evidenceReference,
  });
  verifyProvenance(await readFile(provenancePath, "utf8"), {
    repository: evidenceRepository,
    digest,
    commit,
  });
  const verification = validateProvenanceVerification(
    await json(provenanceVerificationPath, `${component} provenance verification`),
    expectedVerification,
  );
  const counts = vulnerabilityCounts(await json(vulnerabilityPath, `${component} vulnerability report`), {
    repository: evidenceRepository,
    digest,
    reference: evidenceReference,
  });
  return {
    component,
    repository,
    tag: commit,
    digest,
    reference: `${repository}@${digest}`,
    sbom: await createFileEvidence(sbomPath, { artifactRoot: repoRoot }),
    provenance: { ...(await createFileEvidence(provenancePath, { artifactRoot: repoRoot })), ...verification },
    vulnerability: {
      ...(await createFileEvidence(vulnerabilityPath, { artifactRoot: repoRoot })),
      scanner: "trivy",
      ...counts,
    },
  };
}

export async function assembleImagePublicationManifest(environment = process.env) {
  const commit = requiredEnvironment("CI_COMMIT_SHA", environment);
  const ciRepository = requiredEnvironment("CI_REPO", environment);
  const registry = requiredEnvironment("HARBOR_REGISTRY", environment).replace(/\/$/u, "");
  const project = requiredEnvironment("HARBOR_PROJECT", environment).replace(/^\/+|\/+$/gu, "");
  if (ciRepository !== AUTHORIZED_CI_MIRROR) throw new Error("CI_REPO is not the authorized CI mirror");
  if (registry !== HARBOR_REGISTRY) throw new Error("HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host");
  const provenanceVerification = provenanceVerificationMode(environment);
  const manifest = {
    schemaVersion: "t4-cluster-images/1",
    source: {
      repository: CANONICAL_BUILD_SOURCE_REPOSITORY,
      commit,
      woodpecker: { repository: ciRepository, ...woodpeckerIdentity(environment) },
    },
    images: await Promise.all(
      IMAGE_COMPONENTS.map((component) => imageEntry(component, commit, registry, project, provenanceVerification)),
    ),
  };
  return validateImagePublicationManifest(manifest);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const manifest = await assembleImagePublicationManifest();
  await mkdir(resolve(repoRoot, "artifacts/cluster-proof"), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  console.log(`Wrote ${outputPath}`);
}
