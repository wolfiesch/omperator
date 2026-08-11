import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";

import {
  AUTHORIZED_CI_MIRROR,
  AUTHORIZED_PROVENANCE_SIGNER,
  CANONICAL_BUILD_SOURCE_REPOSITORY,
  IMAGE_COMPONENTS,
  createFileEvidence,
  validateImagePublicationManifest,
} from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const artifactDirectory = resolve(repoRoot, "artifacts/cluster-proof/images");
const outputPath = resolve(repoRoot, "artifacts/cluster-proof/image-publication.json");
const TRUSTED_ROOT_PATH = resolve(repoRoot, "scripts/cluster-ci/fixtures/sigstore-trusted-root.json");
const TRUSTED_ROOT_SHA256 = "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66";
let trustedRootMaterial;
const CANONICAL_BUILD_SOURCE_URL = `https://github.com/${CANONICAL_BUILD_SOURCE_REPOSITORY}`;
const HARBOR_REGISTRY = "harbor.tailb18de3.ts.net";
const QUARANTINE_PREFIX = "quarantine";
const suffixes = {
  controller: "t4-cluster-operator",
  "cluster-server": "t4-cluster-server",
  "session-runtime": "t4-session-runtime",
  "model-gateway": "t4-model-gateway",
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

export function verifyProvenance(jsonLines, { repository, digest, commit, platform, architecture }) {
  const expectedDigest = digest.slice("sha256:".length);
  const expectedPlatform = platform === undefined && architecture === undefined
    ? undefined
    : `${platform}/${architecture}`;
  if (
    (expectedPlatform !== undefined && platform !== "linux") ||
    (expectedPlatform !== undefined && !["amd64", "arm64"].includes(architecture))
  ) {
    throw new Error("provenance platform/architecture expectation is invalid");
  }
  const lines = jsonLines.split("\n").filter(Boolean);
  if (lines.length < 1 || lines.length > 32) throw new Error("provenance attestation count is invalid");
  const statements = [];
  for (const line of lines) {
    let envelope;
    let statement;
    try {
      envelope = JSON.parse(line);
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        envelope.payloadType !== "application/vnd.in-toto+json" ||
        typeof envelope.payload !== "string" ||
        !Array.isArray(envelope.signatures) ||
        envelope.signatures.length < 1 ||
        envelope.signatures.length > 32 ||
        envelope.signatures.some((signature) =>
          !signature ||
          typeof signature !== "object" ||
          typeof signature.sig !== "string" ||
          signature.sig.length < 1 ||
          signature.sig.length > 8192
        )
      ) {
        throw new Error("invalid envelope");
      }
      const payload = Buffer.from(envelope.payload, "base64");
      if (payload.length < 2 || payload.length > 4 * 1024 * 1024) throw new Error("invalid payload size");
      statement = JSON.parse(payload.toString("utf8"));
    } catch (error) {
      throw new Error("provenance attestation is not valid DSSE JSON", { cause: error });
    }
    statements.push(statement);
  }
  const provenance = statements.find((statement) => {
    const predicate = statement?.predicate;
    const v1 = statement?.predicateType === "https://slsa.dev/provenance/v1";
    const materials = v1
      ? predicate?.buildDefinition?.resolvedDependencies
      : predicate?.materials;
    const sourceMaterial = materials?.find((material) => trustedSourceMaterial(material, commit));
    const baseMaterial = materials?.some(
      (material) =>
        typeof material?.uri === "string" &&
        material.uri.startsWith("pkg:docker/") &&
        /^[0-9a-f]{64}$/u.test(material.digest?.sha256 ?? ""),
    );
    const parameters = predicate?.invocation?.parameters;
    const externalParameters = predicate?.buildDefinition?.externalParameters;
    const declaredPlatforms = [
      parameters?.platform,
      parameters?.frontendAttrs?.platform,
      externalParameters?.platform,
      externalParameters?.frontendAttrs?.platform,
      ...(Array.isArray(parameters?.platforms) ? parameters.platforms : []),
      ...(Array.isArray(externalParameters?.platforms) ? externalParameters.platforms : []),
    ]
      .filter((value) => typeof value === "string")
      .flatMap((value) => value.split(",").map((entry) => entry.trim()));
    const invocationBindsSource = (
      parameters?.commit === commit &&
      parameters?.source === CANONICAL_BUILD_SOURCE_URL
    ) || (
      parameters?.frontendAttrs?.["build-arg:SOURCE_COMMIT"] === commit &&
      parameters?.frontendAttrs?.["build-arg:SOURCE_REPOSITORY"] === CANONICAL_BUILD_SOURCE_URL
    ) || (
      externalParameters?.source?.uri === CANONICAL_BUILD_SOURCE_URL &&
      [externalParameters?.source?.digest?.sha1, externalParameters?.source?.digest?.gitCommit].includes(commit)
    ) || (
      externalParameters?.frontendAttrs?.["build-arg:SOURCE_COMMIT"] === commit &&
      externalParameters?.frontendAttrs?.["build-arg:SOURCE_REPOSITORY"] === CANONICAL_BUILD_SOURCE_URL
    );
    const builderId = v1 ? predicate?.runDetails?.builder?.id : predicate?.builder?.id;
    const buildType = v1 ? predicate?.buildDefinition?.buildType : predicate?.buildType;
    return (
      ["https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"].includes(statement?._type) &&
      ["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"].includes(statement.predicateType) &&
      builderId === "https://mobyproject.org/buildkit@v1" &&
      buildType === "https://mobyproject.org/buildkit@v1" &&
      Array.isArray(materials) &&
      statement.subject?.some(
        (subject) => subject?.name === repository && subject?.digest?.sha256 === expectedDigest,
      ) &&
      sourceMaterial &&
      baseMaterial &&
      invocationBindsSource &&
      (expectedPlatform === undefined || declaredPlatforms.includes(expectedPlatform))
    );
  });
  if (!provenance) {
    throw new Error("BuildKit provenance does not bind subject, trusted source repository, CI commit, build type, materials, and requested platform");
  }
  return provenance;
}

function exactIdentityPolicy(identityType, identity) {
  const anchored = `^(?:${identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")})$`;
  if (identityType === "uri") return { certificateIdentityURI: anchored };
  if (identityType === "email") return { certificateIdentityEmail: anchored };
  throw new Error("cosign certificate identity type must be uri or email");
}
function assertAuthorizedSignerPolicy(policy) {
  if (
    policy.certificateIdentity !== AUTHORIZED_PROVENANCE_SIGNER.certificateIdentity ||
    policy.certificateIdentityType !== AUTHORIZED_PROVENANCE_SIGNER.certificateIdentityType ||
    policy.certificateIssuer !== AUTHORIZED_PROVENANCE_SIGNER.certificateIssuer
  ) {
    throw new Error("signed provenance signer is not authorized");
  }
}


function parseJsonLines(source, label) {
  const lines = source.split("\n").filter((line) => line.length > 0);
  if (lines.length < 1 || lines.length > 32) throw new Error(`${label} count is invalid`);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} is not valid JSON lines`, { cause: error });
    }
  });
}

function sameEnvelope(left, right) {
  return left?.payloadType === right?.payloadType &&
    left?.payload === right?.payload &&
    Array.isArray(left?.signatures) &&
    Array.isArray(right?.signatures) &&
    JSON.stringify(left.signatures) === JSON.stringify(right.signatures);
}

async function verifyBundleWithPinnedRoot(bundle, options) {
  if (trustedRootMaterial === undefined) {
    const source = await readFile(TRUSTED_ROOT_PATH);
    if (createHash("sha256").update(source).digest("hex") !== TRUSTED_ROOT_SHA256) {
      throw new Error("pinned Sigstore trusted root does not match its reviewed digest");
    }
    trustedRootMaterial = toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(source.toString("utf8"))));
  }
  const verifier = new Verifier(trustedRootMaterial, {
    ctlogThreshold: options.ctLogThreshold,
    tlogThreshold: options.tlogThreshold,
  });
  verifier.verify(toSignedEntity(bundleFromJSON(bundle)), {
    subjectAlternativeName: options.certificateIdentityURI ?? options.certificateIdentityEmail,
    extensions: { issuer: options.certificateIssuer },
  });
}

export async function verifySignedProvenance(
  provenanceSource,
  bundleSource,
  { certificateIdentity, certificateIdentityType, certificateIssuer },
  verifyBundle = verifyBundleWithPinnedRoot,
) {
  const envelopes = parseJsonLines(provenanceSource, "provenance DSSE envelope");
  const bundles = parseJsonLines(bundleSource, "Sigstore bundle");
  if (
    bundles.length !== envelopes.length ||
    bundles.some((bundle, index) =>
      bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
      !sameEnvelope(bundle.dsseEnvelope, envelopes[index])
    )
  ) {
    throw new Error("Sigstore bundles do not contain the exact retained DSSE envelopes");
  }
  const options = {
    ...exactIdentityPolicy(certificateIdentityType, certificateIdentity),
    certificateIssuer,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  };
  for (const bundle of bundles) await verifyBundle(bundle, options);
  return envelopes;
}

export async function verifyAuthorizedSignedProvenance(
  provenanceSource,
  bundleSource,
  declaredPolicy,
  verifyBundle,
) {
  assertAuthorizedSignerPolicy(declaredPolicy);
  return await verifySignedProvenance(
    provenanceSource,
    bundleSource,
    AUTHORIZED_PROVENANCE_SIGNER,
    verifyBundle,
  );
}

export function provenanceVerificationMode(environment = process.env) {
  const certificateIdentity = environment.T4_COSIGN_CERTIFICATE_IDENTITY?.trim() ?? "";
  const certificateIssuer = environment.T4_COSIGN_CERTIFICATE_OIDC_ISSUER?.trim() ?? "";
  const certificateIdentityType = environment.T4_COSIGN_CERTIFICATE_IDENTITY_TYPE?.trim() ?? "";
  if (Boolean(certificateIdentity) !== Boolean(certificateIssuer)) {
    throw new Error("cosign certificate identity and OIDC issuer must be configured together");
  }
  if (!certificateIdentity) {
    if (certificateIdentityType) throw new Error("cosign certificate identity type requires an identity");
    return { mode: "buildkit-content" };
  }
  if (!["uri", "email"].includes(certificateIdentityType)) {
    throw new Error("T4_COSIGN_CERTIFICATE_IDENTITY_TYPE must be uri or email");
  }
  assertAuthorizedSignerPolicy({ certificateIdentity, certificateIdentityType, certificateIssuer });
  return {
    mode: "cosign-keyless",
    certificateIdentity,
    certificateIdentityType,
    certificateIssuer,
  };
}

function validateProvenanceVerification(value, expected) {
  const publicExpected = expected.mode === "cosign-keyless"
    ? {
        mode: expected.mode,
        certificateIdentity: expected.certificateIdentity,
        certificateIdentityType: expected.certificateIdentityType,
        certificateIssuer: expected.certificateIssuer,
      }
    : { mode: expected.mode };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(publicExpected).sort()) ||
    Object.entries(publicExpected).some(([key, expectedValue]) => value[key] !== expectedValue)
  ) {
    throw new Error("provenance signer policy record is missing or does not match the configured policy");
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
  const provenanceBundlePath = resolve(artifactDirectory, `${component}.provenance.sigstore.jsonl`);
  const provenanceVerificationPath = resolve(artifactDirectory, `${component}.provenance-verification.json`);
  const vulnerabilityPath = resolve(artifactDirectory, `${component}.trivy.json`);
  verifySpdx(await json(sbomPath, `${component} SBOM`), {
    repository: evidenceRepository,
    digest,
    reference: evidenceReference,
  });
  const provenanceSource = await readFile(provenancePath, "utf8");
  const verification = validateProvenanceVerification(
    await json(provenanceVerificationPath, `${component} provenance verification`),
    expectedVerification,
  );
  let bundleEvidence;
  if (verification.mode === "cosign-keyless") {
    const bundleSource = await readFile(provenanceBundlePath, "utf8");
    await verifyAuthorizedSignedProvenance(provenanceSource, bundleSource, expectedVerification);
    bundleEvidence = {
      ...(await createFileEvidence(provenanceBundlePath, { artifactRoot: repoRoot })),
      bytes: Buffer.byteLength(bundleSource),
    };
  }
  for (const architecture of ["amd64", "arm64"]) {
    verifyProvenance(provenanceSource, {
      repository: evidenceRepository,
      digest,
      commit,
      platform: "linux",
      architecture,
    });
  }
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
    provenance: {
      ...(await createFileEvidence(provenancePath, { artifactRoot: repoRoot })),
      ...verification,
      ...(bundleEvidence === undefined ? {} : { bundle: bundleEvidence }),
    },
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
