import { createHash } from "node:crypto";
import type { ScopeAdmissionPolicy } from "@t4-code/portable-core";
import type { AdmissionRetirementLedger, ScopeAdmissionLedger, ScopeAdmissionOutcome } from "@t4-code/portable-control-store";
import { RestMutationError, type RestMutationResult, type RestRuntimeCreateInput, type RestRuntimePatchInput, type RestWorkspaceCreateInput } from "./kubernetes-client.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";

export class ScopeAdmissionError extends Error {
	readonly decision: Extract<ScopeAdmissionOutcome, { readonly outcome: "denied" }>;
	constructor(decision: Extract<ScopeAdmissionOutcome, { readonly outcome: "denied" }>) {
		super(`scope admission denied: ${decision.reason}`);
		this.name = "ScopeAdmissionError";
		this.decision = decision;
	}
}

type AdmissionDemand = {
	readonly transition: "create" | "activate" | "enableBrowser";
	readonly workspaceCapacityBytes?: number;
	readonly active?: boolean;
	readonly browserRequested?: boolean;
};

export interface ScopeAdmissionAuthorityOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly ledger: ScopeAdmissionLedger & AdmissionRetirementLedger;
	readonly policy: ScopeAdmissionPolicy;
}

export class ScopeAdmissionAuthority {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #ledger: ScopeAdmissionLedger & AdmissionRetirementLedger;
	readonly #policy: ScopeAdmissionPolicy;
	constructor(options: ScopeAdmissionAuthorityOptions) {
		this.#projection = options.projection;
		this.#ledger = options.ledger;
		this.#policy = options.policy;
	}

	async createWorkspace(scopeId: string, ownerPrincipal: string, resourceKey: string, input: RestWorkspaceCreateInput, operation: () => Promise<RestMutationResult>): Promise<RestMutationResult> {
		return await this.#admit(scopeId, ownerPrincipal, "workspace", resourceKey, [{ transition: "create", workspaceCapacityBytes: input.capacityBytes }], false, operation);
	}
	async createRuntime(scopeId: string, ownerPrincipal: string, resourceKey: string, input: RestRuntimeCreateInput, operation: () => Promise<RestMutationResult>): Promise<RestMutationResult> {
		return await this.#admit(scopeId, ownerPrincipal, "runtime", resourceKey, [{
			transition: "create",
			active: input.desiredState === "Running",
			browserRequested: input.browserPolicy === "Allowed",
		}], false, operation);
	}
	async wakeRuntime(scopeId: string, ownerPrincipal: string, resourceKey: string, operation: () => Promise<RestMutationResult>): Promise<RestMutationResult> {
		const current = this.#projection.restProjection(ownerPrincipal).runtimes.find(item => item.id === resourceKey);
		return current?.desiredState === "Running"
			? await operation()
			: await this.#admit(scopeId, ownerPrincipal, "runtime", resourceKey, [{ transition: "activate", active: true }], true, operation);
	}
	async patchRuntime(scopeId: string, ownerPrincipal: string, resourceKey: string, input: RestRuntimePatchInput, operation: () => Promise<RestMutationResult>): Promise<RestMutationResult> {
		const current = this.#projection.restProjection(ownerPrincipal).runtimes.find(item => item.id === resourceKey);
		const demands: AdmissionDemand[] = [];
		if (input.desiredState === "Running" && current?.desiredState !== "Running") demands.push({ transition: "activate", active: true });
		if (input.browserPolicy === "Allowed") demands.push({ transition: "enableBrowser", browserRequested: true });
		return demands.length === 0 ? await operation() : await this.#admit(scopeId, ownerPrincipal, "runtime", resourceKey, demands, true, operation);
	}
	async beginDeletion(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string): Promise<void> {
		try {
			await this.#ledger.beginAdmissionRetirement({ scopeId, resourceKind, resourceKey });
		} catch {
			throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 });
		}
	}
	async resumeDeletion(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string): Promise<boolean> {
		try {
			const intent = await this.#ledger.getAdmissionRetirement({ scopeId, resourceKind, resourceKey });
			if (!intent) return false;
			if (intent.state === "pending") await this.#finishDeletion(scopeId, resourceKind, resourceKey);
			return true;
		} catch (error) {
			if (error instanceof ScopeAdmissionError) throw error;
			throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 });
		}
	}
	async finishDeletion(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string): Promise<void> {
		await this.#finishDeletion(scopeId, resourceKind, resourceKey);
	}
	async #finishDeletion(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string): Promise<void> {
		await this.#retire(scopeId, resourceKind, resourceKey, resourceKind === "workspace" ? ["create"] : ["create", "activate", "enableBrowser"]);
		try {
			const outcome = await this.#ledger.completeAdmissionRetirement({ scopeId, resourceKind, resourceKey });
			if (outcome === "notFound") throw new Error("admission retirement intent disappeared");
		} catch {
			throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 });
		}
	}
	async retireWorkspace(scopeId: string, resourceKey: string): Promise<void> {
		await this.#retire(scopeId, "workspace", resourceKey, ["create"]);
	}
	async retireRuntime(scopeId: string, resourceKey: string, transitions: readonly ("create" | "activate" | "enableBrowser")[]): Promise<void> {
		await this.#retire(scopeId, "runtime", resourceKey, transitions);
	}
	async #retire(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string, transitions: readonly ("create" | "activate" | "enableBrowser")[]): Promise<void> {
		try {
			for (const transition of transitions)
				await this.#ledger.reconcileAdmissionAbsence({ scopeId, resourceKind, resourceKey, transition });
		} catch {
			throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 });
		}
	}
	async #admit(
		scopeId: string,
		ownerPrincipal: string,
		resourceKind: "workspace" | "runtime",
		resourceKey: string,
		demands: readonly AdmissionDemand[],
		commitAccepted: boolean,
		operation: () => Promise<RestMutationResult>,
	): Promise<RestMutationResult> {
		const snapshot = this.#projection.restProjection(ownerPrincipal);
		const activeRuntimes = snapshot.runtimes.filter(item => item.desiredState === "Running" && item.phase !== "Deleting" && item.phase !== "Failed").length;
		const workspaceCapacityBytes = snapshot.workspaces.reduce((sum, item) =>
			sum > Number.MAX_SAFE_INTEGER - item.capacityBytes ? Number.MAX_SAFE_INTEGER : sum + item.capacityBytes, 0);
		const demandResources = this.#policy.runtimeResources;
		const product = (value: number): number => value !== 0 && activeRuntimes > Math.floor(Number.MAX_SAFE_INTEGER / value) ? Number.MAX_SAFE_INTEGER : value * activeRuntimes;
		const admitted: string[] = [];
		for (const demand of demands) {
			let decision: ScopeAdmissionOutcome;
			try {
				decision = await this.#ledger.reserveAdmission({
					scopeId,
					resourceKey,
					resourceKind,
					...demand,
					policy: this.#policy,
					usage: {
						activeRuntimes,
						retainedRuntimes: snapshot.runtimes.length,
						workspaceCapacityBytes,
						cpuMillis: product(demandResources.cpuMillis),
						memoryBytes: product(demandResources.memoryBytes),
						gpuUnits: product(demandResources.gpuUnits),
						observedResourceDigests: [
							...snapshot.workspaces.map(item => createHash("sha256").update(`${scopeId}\0workspace\0${item.id}\0create`).digest("hex")),
							...snapshot.runtimes.map(item => createHash("sha256").update(`${scopeId}\0runtime\0${item.id}\0create`).digest("hex")),
							...snapshot.runtimes.filter(item => item.desiredState === "Running").map(item => createHash("sha256").update(`${scopeId}\0runtime\0${item.id}\0activate`).digest("hex")),
							...snapshot.runtimes.filter(item => this.#projection.portableRuntimeObservation(ownerPrincipal, item.id)?.browserPolicy === "Allowed").map(item => createHash("sha256").update(`${scopeId}\0runtime\0${item.id}\0enableBrowser`).digest("hex")),
						],
					},
				});
			} catch {
				decision = { outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 };
			}
			if (decision.outcome === "denied") {
				await Promise.all(admitted.map(token => this.#ledger.releaseAdmission(token)));
				throw new ScopeAdmissionError(decision);
			}
			admitted.push(decision.reservationToken);
		}
		let backendInvoked = false;
		try {
			backendInvoked = true;
			const result = await operation();
			if (!commitAccepted && !result.created) {
				await Promise.all(admitted.map(token => this.#ledger.releaseAdmission(token)));
				return result;
			}
			for (const token of admitted) {
				if (await this.#ledger.commitAdmission(token) !== "committed")
					throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 });
			}
			return result;
		} catch (error) {
			if (!backendInvoked || error instanceof RestMutationError)
				await Promise.all(admitted.map(token => this.#ledger.releaseAdmission(token)));
			else
				await Promise.all(admitted.map(token => this.#ledger.commitAdmission(token)));
			throw error;
		}
	}
}
