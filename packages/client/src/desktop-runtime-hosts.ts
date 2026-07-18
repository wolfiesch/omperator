import type { DesktopTarget } from "@t4-code/protocol/desktop-ipc";

import {
  hostMetadata,
  mapValue,
  targetCopy,
  type DesktopHostMetadata,
  type DesktopRuntimeSnapshot,
  type DesktopWelcomePayload,
} from "./desktop-runtime-contracts.ts";

type HostSnapshot = Pick<
  DesktopRuntimeSnapshot,
  "connections" | "hosts" | "targetHosts" | "targets"
>;

export type WelcomeReconciliation =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly epochChanged: boolean;
      readonly hosts: ReadonlyMap<string, DesktopHostMetadata>;
      readonly targetHosts: ReadonlyMap<string, string>;
    };

export interface TargetHostReconciliation {
  readonly connections: ReadonlyMap<string, DesktopTarget["state"]>;
  readonly hosts: ReadonlyMap<string, DesktopHostMetadata>;
  readonly removedTargetIds: readonly string[];
  readonly targetHosts: ReadonlyMap<string, string>;
  readonly targets: ReadonlyMap<string, DesktopTarget>;
}

/** Owns welcome metadata that must survive while duplicate target bindings are reconciled. */
export class DesktopRuntimeHostState {
  private readonly metadataByTarget = new Map<string, DesktopHostMetadata>();

  metadataForTarget(targetId: string): DesktopHostMetadata | undefined {
    return this.metadataByTarget.get(targetId);
  }

  acceptWelcome(
    targetId: string,
    frame: DesktopWelcomePayload,
    targetHosts: ReadonlyMap<string, string>,
    hosts: ReadonlyMap<string, DesktopHostMetadata>,
    connections: ReadonlyMap<string, DesktopTarget["state"]> = new Map(),
  ): WelcomeReconciliation {
    const hostIdValue = String(frame.hostId);
    const previous = targetHosts.get(targetId);
    if (previous !== undefined && previous !== hostIdValue) return { accepted: false };

    const previousMetadata = this.metadataByTarget.get(targetId);
    const metadata = hostMetadata(targetId, frame);
    this.metadataByTarget.set(targetId, metadata);
    const nextTargetHosts = new Map(targetHosts).set(targetId, hostIdValue);
    const representative = this.metadataForHost(hostIdValue, nextTargetHosts, connections);
    const nextHosts = new Map(hosts);
    nextHosts.set(hostIdValue, representative ?? metadata);
    return {
      accepted: true,
      epochChanged: previousMetadata !== undefined && previousMetadata.epoch !== frame.epoch,
      targetHosts: mapValue(nextTargetHosts),
      hosts: mapValue(nextHosts),
    };
  }

  reconcileTargets(
    current: HostSnapshot,
    targets: readonly DesktopTarget[],
    trackedTargetIds: Iterable<string>,
  ): TargetHostReconciliation {
    const nextTargets = new Map<string, DesktopTarget>();
    const nextConnections = new Map<string, DesktopTarget["state"]>();
    for (const target of targets) {
      const copy = targetCopy(target);
      nextTargets.set(copy.targetId, copy);
      nextConnections.set(copy.targetId, copy.state);
    }
    const removedTargetIds = new Set<string>();
    for (const targetId of current.targets.keys()) {
      if (!nextTargets.has(targetId)) removedTargetIds.add(targetId);
    }
    for (const targetId of current.connections.keys()) {
      if (!nextTargets.has(targetId)) removedTargetIds.add(targetId);
    }
    for (const targetId of current.targetHosts.keys()) {
      if (!nextTargets.has(targetId)) removedTargetIds.add(targetId);
    }
    for (const metadata of current.hosts.values()) {
      if (!nextTargets.has(metadata.targetId)) removedTargetIds.add(metadata.targetId);
    }
    for (const targetId of trackedTargetIds) {
      if (!nextTargets.has(targetId)) removedTargetIds.add(targetId);
    }

    const targetHosts = new Map(current.targetHosts);
    for (const targetId of targetHosts.keys()) {
      if (!nextTargets.has(targetId)) targetHosts.delete(targetId);
    }
    for (const targetId of removedTargetIds) this.metadataByTarget.delete(targetId);

    const hosts = new Map<string, DesktopHostMetadata>();
    for (const hostIdValue of new Set(targetHosts.values())) {
      const currentMetadata = current.hosts.get(hostIdValue);
      if (
        currentMetadata !== undefined &&
        nextTargets.has(currentMetadata.targetId) &&
        targetHosts.get(currentMetadata.targetId) === hostIdValue &&
        nextConnections.get(currentMetadata.targetId) === "connected"
      ) {
        hosts.set(hostIdValue, currentMetadata);
        continue;
      }
      const replacement = this.metadataForHost(hostIdValue, targetHosts, nextConnections);
      if (replacement !== undefined) hosts.set(hostIdValue, replacement);
    }

    return {
      targets: mapValue(nextTargets),
      connections: mapValue(nextConnections),
      removedTargetIds: Object.freeze([...removedTargetIds]),
      targetHosts: mapValue(targetHosts),
      hosts: mapValue(hosts),
    };
  }

  private metadataForHost(
    hostIdValue: string,
    targetHosts: ReadonlyMap<string, string>,
    connections: ReadonlyMap<string, DesktopTarget["state"]>,
  ): DesktopHostMetadata | undefined {
    let offline: DesktopHostMetadata | undefined;
    for (const [targetId, boundHostId] of targetHosts) {
      if (boundHostId !== hostIdValue) continue;
      const metadata = this.metadataByTarget.get(targetId);
      if (metadata === undefined) continue;
      if (connections.get(targetId) === "connected") return metadata;
      offline ??= metadata;
    }
    return offline;
  }
}
