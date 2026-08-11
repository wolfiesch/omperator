import type { BrowserPolicy, Generation, Revision, Runtime, ScopeId, Workspace } from "@t4-code/portable-core";
import type { ResourceDriver } from "./index.ts";

export type ConformanceDeployment = "local" | "single-host" | "kubernetes";

export interface PortableSessionConformanceAdapter {
  prompt(runtime: Runtime, text: string): Promise<{ readonly runtimeId: string; readonly generation: Generation; readonly authorityCount: number }>;
  openBrowser(runtime: Runtime): Promise<{ readonly runtimeId: string; readonly generation: Generation; readonly externallyReachableCdp: boolean }>;
  disconnect(runtime: Runtime): Promise<void>;
  reconnect(runtime: Runtime): Promise<{ readonly runtimeId: string; readonly generation: Generation }>;
}

export interface DriverConformanceFixture {
  readonly deployment: ConformanceDeployment;
  readonly driver: ResourceDriver;
  readonly scopeId: ScopeId;
  readonly sessions: PortableSessionConformanceAdapter;
  readonly browserPolicy?: BrowserPolicy;
  /** Deployment-specific polling is the only lifecycle timing variation. */
  readonly awaitRuntime: (runtimeId: string, desiredState: Runtime["desiredState"], phase: Runtime["phase"]) => Promise<Runtime>;
}

export interface DriverConformanceResult {
  readonly deployment: ConformanceDeployment;
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly initialGeneration: Generation;
  readonly wakeGeneration: Generation;
}

function expectOutcome<T extends { readonly outcome: string }, K extends T["outcome"]>(value: T, outcome: K): Extract<T, { readonly outcome: K }> {
  if (value.outcome !== outcome) throw new Error(`driver conformance expected ${outcome}, received ${value.outcome}`);
  return value as Extract<T, { readonly outcome: K }>;
}

function changedRevision(before: Revision, after: Revision, operation: string): void {
  if (before === after) throw new Error(`${operation} did not advance the opaque revision`);
}

/**
 * Common semantic scenario for LocalDriver, a LocalDriver reached through a
 * single-host front door, and KubernetesDriver. Endpoint, identity, timing,
 * and environment setup live in the fixture; no branch in this harness varies
 * portable resource or session behavior.
 */
export async function runDriverConformance(fixture: DriverConformanceFixture): Promise<DriverConformanceResult> {
  const scope = expectOutcome(fixture.driver.getScope(fixture.scopeId), "found").resource;
  if (scope.id !== fixture.scopeId) throw new Error("scope identity changed at the driver boundary");

  const workspaceCreated = expectOutcome(await fixture.driver.createWorkspace({
    scopeId: fixture.scopeId,
    displayName: "portable-conformance",
    capacityBytes: 1_073_741_824,
    retention: "Delete",
  }), "created").resource;
  const workspaceRead = expectOutcome(fixture.driver.getWorkspace(workspaceCreated.id), "found").resource;
  if (workspaceRead.id !== workspaceCreated.id || workspaceRead.scopeId !== fixture.scopeId) throw new Error("workspace public identity changed");

  const runtimeCreated = expectOutcome(await fixture.driver.createRuntime({
    scopeId: fixture.scopeId,
    displayName: "portable-conformance",
    workspaceId: workspaceCreated.id,
    hostProfileId: "portable-conformance",
    desiredState: "Running",
    browserPolicy: fixture.browserPolicy ?? "Allowed",
  }), "created").resource;
  const ready = await fixture.awaitRuntime(runtimeCreated.id, "Running", "Ready");
  if (ready.id !== runtimeCreated.id || ready.workspaceId !== workspaceCreated.id) throw new Error("runtime did not become ready with stable public identity");
  const initialGeneration = ready.generation;

  for (const kind of ["cmux-v10", "omp-app-v1"] as const) {
    const route = expectOutcome(fixture.driver.resolveRuntimeRoute(ready.id, kind, ready.generation), "resolved");
    if (route.generation !== ready.generation || route.route.kind !== kind) throw new Error(`${kind} descriptor changed resource identity`);
  }

  const prompt = await fixture.sessions.prompt(ready, "portable conformance prompt");
  if (prompt.runtimeId !== ready.id || prompt.generation !== ready.generation || prompt.authorityCount !== 1) throw new Error("prompt did not use the one fenced OMP authority");
  const browser = await fixture.sessions.openBrowser(ready);
  if (browser.runtimeId !== ready.id || browser.generation !== ready.generation || browser.externallyReachableCdp) throw new Error("browser session escaped its runtime generation boundary");

  await fixture.sessions.disconnect(ready);
  const reconnected = await fixture.sessions.reconnect(ready);
  if (reconnected.runtimeId !== ready.id || reconnected.generation !== ready.generation) throw new Error("reconnect changed runtime identity or generation");

  const sleepAccepted = expectOutcome(await fixture.driver.setRuntimeDesiredState(ready.id, "Sleeping", ready.revision), "updated").resource;
  changedRevision(ready.revision, sleepAccepted.revision, "sleep");
  const sleeping = await fixture.awaitRuntime(ready.id, "Sleeping", "Sleeping");
  if (sleeping.id !== ready.id) throw new Error("sleep transition changed runtime identity");
  if (fixture.driver.resolveRuntimeRoute(sleeping.id, "omp-app-v1", sleeping.generation).outcome === "resolved") throw new Error("sleep retained a routable writer generation");

  const wakeAccepted = expectOutcome(await fixture.driver.setRuntimeDesiredState(sleeping.id, "Running", sleeping.revision), "updated").resource;
  changedRevision(sleeping.revision, wakeAccepted.revision, "wake");
  const waking = await fixture.awaitRuntime(ready.id, "Running", "Ready");
  if (waking.id !== ready.id || waking.generation === initialGeneration) throw new Error("wake did not publish a fresh ready generation");

  const stopAccepted = expectOutcome(await fixture.driver.setRuntimeDesiredState(waking.id, "Stopped", waking.revision), "updated").resource;
  changedRevision(waking.revision, stopAccepted.revision, "stop");
  const stopped = await fixture.awaitRuntime(ready.id, "Stopped", "Stopped");
  const deleted = expectOutcome(await fixture.driver.deleteRuntime(stopped.id, stopped.revision), "deleted");
  void deleted;
  if (fixture.driver.getRuntime(stopped.id).outcome !== "notFound") throw new Error("deleted runtime remained readable");

  const finalWorkspace = expectOutcome(fixture.driver.getWorkspace(workspaceCreated.id), "found").resource as Workspace;
  if (finalWorkspace.attachmentCount !== 0) throw new Error("runtime deletion did not detach its workspace");
  expectOutcome(await fixture.driver.deleteWorkspace(finalWorkspace.id, finalWorkspace.revision), "deleted");
  if (fixture.driver.getWorkspace(finalWorkspace.id).outcome !== "notFound") throw new Error("deleted workspace remained readable");

  return { deployment: fixture.deployment, workspaceId: workspaceCreated.id, runtimeId: ready.id, initialGeneration, wakeGeneration: waking.generation };
}

export interface CrossDriverConformanceFixtures {
  readonly local: DriverConformanceFixture & { readonly deployment: "local" };
  readonly singleHost: DriverConformanceFixture & { readonly deployment: "single-host" };
  readonly kubernetes: DriverConformanceFixture & { readonly deployment: "kubernetes" };
}

/** Requires all three drivers and runs the exact same scenario for each. */
export async function runCrossDriverConformance(fixtures: CrossDriverConformanceFixtures): Promise<readonly [
  DriverConformanceResult,
  DriverConformanceResult,
  DriverConformanceResult,
]> {
  return await Promise.all([
    runDriverConformance(fixtures.local),
    runDriverConformance(fixtures.singleHost),
    runDriverConformance(fixtures.kubernetes),
  ]);
}
