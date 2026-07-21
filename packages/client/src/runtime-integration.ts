/**
 * Product-facing runtime vocabulary.
 *
 * This boundary sits above OMP's wire protocol. OMP remains the complete,
 * first-party runtime; a future integration describes only the T4 features it
 * can actually support.
 */

import { CI_TRIGGER_CAPABILITY, CLUSTER_OPERATOR_FEATURE } from "@t4-code/protocol";

export const DEFAULT_CLUSTER_OPERATOR_ENABLED = false as const;

/**
 * Cluster operation is a local product opt-in, not an automatic consequence
 * of a new wire version. Keep the caller's stable array when no filtering is
 * needed and never synthesize a feature the endpoint did not publish.
 */
export function clusterOperatorRequestedFeatures(
  features: readonly string[],
  enabled: boolean = DEFAULT_CLUSTER_OPERATOR_ENABLED,
): readonly string[] {
  const contains = features.includes(CLUSTER_OPERATOR_FEATURE);
  if (enabled || !contains) return features;
  return Object.freeze(features.filter((feature) => feature !== CLUSTER_OPERATOR_FEATURE));
}

export function clusterOperatorRequestedCapabilities(
  capabilities: readonly string[],
  enabled: boolean = DEFAULT_CLUSTER_OPERATOR_ENABLED,
): readonly string[] {
  const contains = capabilities.includes(CI_TRIGGER_CAPABILITY);
  if (enabled || !contains) return capabilities;
  return Object.freeze(
    capabilities.filter((capability) => capability !== CI_TRIGGER_CAPABILITY),
  );
}
export const OMP_RUNTIME_KIND = "omp" as const;

/** Additions to this union are deliberate product decisions, not wire changes. */
export type RuntimeKind = typeof OMP_RUNTIME_KIND | (string & {});

export type RuntimeIntegrationLevel = "first-party" | "integrated" | "observed";

export interface RuntimeIntegrationDescriptor {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly level: RuntimeIntegrationLevel;
}

export const OMP_RUNTIME_INTEGRATION: RuntimeIntegrationDescriptor = Object.freeze({
  kind: OMP_RUNTIME_KIND,
  displayName: "OMP",
  level: "first-party",
});

export const T4_RUNTIME_FEATURES = Object.freeze({
  sessionInventory: "session.inventory",
  sessionCreate: "session.create",
  sessionPrompt: "session.prompt",
  sessionCancel: "session.cancel",
  transcriptReplay: "transcript.replay",
  approvals: "approvals",
  agentTree: "agent.tree",
  files: "files",
  terminal: "terminal",
  browser: "browser",
  settings: "settings",
  usage: "usage",
  handoff: "handoff",
} as const);

export type KnownRuntimeFeature =
  (typeof T4_RUNTIME_FEATURES)[keyof typeof T4_RUNTIME_FEATURES];
export type RuntimeFeature = KnownRuntimeFeature | (string & {});

export type RuntimeFeatureSupport =
  | { readonly status: "available" }
  | { readonly status: "read-only"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type RuntimeFeatureMap = Readonly<
  Partial<Record<RuntimeFeature, RuntimeFeatureSupport>>
>;

export interface RuntimeIdentity {
  readonly runtimeKind: RuntimeKind;
  readonly targetId: string;
  readonly hostId?: string;
  readonly sessionId?: string;
}

function identityPart(value: string, name: string): string {
  if (value.length === 0) throw new Error(`runtime identity ${name} cannot be empty`);
  return `${value.length}:${value}`;
}

/**
 * Collision-safe key for caches, routes, notifications, and cross-runtime
 * search results. Length prefixes keep embedded separators unambiguous.
 */
export function runtimeIdentityKey(identity: RuntimeIdentity): string {
  const parts = [
    identityPart(identity.runtimeKind, "kind"),
    identityPart(identity.targetId, "targetId"),
  ];
  if (identity.hostId !== undefined) parts.push(identityPart(identity.hostId, "hostId"));
  if (identity.sessionId !== undefined) {
    if (identity.hostId === undefined) {
      throw new Error("runtime identity sessionId requires hostId");
    }
    parts.push(identityPart(identity.sessionId, "sessionId"));
  }
  return parts.join("|");
}

export function availableRuntimeFeature(): RuntimeFeatureSupport {
  return Object.freeze({ status: "available" });
}

export function unavailableRuntimeFeature(
  reason: string,
  status: "read-only" | "unavailable" = "unavailable",
): RuntimeFeatureSupport {
  if (reason.trim().length === 0) throw new Error("unsupported runtime feature requires a reason");
  return Object.freeze({ status, reason });
}
