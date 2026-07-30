import { describe, expect, test } from "vite-plus/test";
import {
	AUTHORIZATION_ACTIONS,
	AUTHORIZATION_ROLE_ACTIONS,
	Authorizer,
	authorizationScopeId,
	isAuthorized,
	type AuthorizationAuditEvent,
	type AuthorizationIdentity,
	type AuthorizationRole,
} from "../src/authorization.ts";

const PRINCIPAL_ID = "id_0123456789abcdefghijklmnop";

function identity(grants: AuthorizationIdentity["authorizedScopes"]): AuthorizationIdentity {
	return Object.freeze({ principalId: PRINCIPAL_ID, authorizedScopes: Object.freeze(grants), policyRevision: "policy-v1" });
}

describe("central authorization policy", () => {
	test("preserves no-grant personal owner compatibility without granting foreign scopes", () => {
		const legacy = identity([]);
		const personal = authorizationScopeId(legacy, "personal");
		for (const action of AUTHORIZATION_ACTIONS) expect(isAuthorized(legacy, personal, action)).toBe(true);
		for (const action of AUTHORIZATION_ACTIONS) expect(isAuthorized(legacy, "scope_foreign", action)).toBe(false);
	});

	test.each(Object.keys(AUTHORIZATION_ROLE_ACTIONS) as AuthorizationRole[])("enforces the frozen %s matrix", role => {
		const subject = identity([{ scopeId: "scope_shared", roles: [role] }]);
		const expected = new Set(AUTHORIZATION_ROLE_ACTIONS[role]);
		for (const action of AUTHORIZATION_ACTIONS)
			expect(isAuthorized(subject, "scope_shared", action), action).toBe(expected.has(action));
	});

	test("maps personal aliases to the derived personal scope and exact public IDs literally", () => {
		const subject = identity([
			{ scopeId: "personal", roles: ["reader"] },
			{ scopeId: "scope_shared", roles: ["writer"] },
		]);
		const personal = authorizationScopeId(subject, "personal");
		expect(isAuthorized(subject, personal, "workspace.read")).toBe(true);
		expect(isAuthorized(subject, personal, "workspace.create")).toBe(false);
		expect(isAuthorized(subject, "scope_shared", "workspace.create")).toBe(true);
		expect(isAuthorized(subject, "personal", "workspace.read")).toBe(false);
	});

	test("emits only the bounded audit schema and contains sink failures", async () => {
		const events: AuthorizationAuditEvent[] = [];
		const subject = identity([{ scopeId: "personal", roles: ["reader"] }]);
		const scopeId = authorizationScopeId(subject, "personal");
		const authorizer = new Authorizer(event => { events.push(event); });
		expect(authorizer.decide({
			identity: subject,
			scopeId,
			action: "workspace.read",
			gateway: "rest",
			resourceId: "private/path?token=secret",
		}).allowed).toBe(true);
		await Promise.resolve();
		expect(Object.keys(events[0]!).sort()).toEqual([
			"action", "gateway", "policyRevision", "principalId", "requestId", "resourceId", "result", "scopeId", "timestamp",
		].sort());
		expect(events[0]).toMatchObject({
			principalId: PRINCIPAL_ID,
			scopeId,
			action: "workspace.read",
			resourceId: "absent",
			result: "allow",
			policyRevision: "policy-v1",
			gateway: "rest",
		});
		const encoded = JSON.stringify(events[0]);
		for (const forbidden of ["private", "path", "token", "secret", "header", "credential", "exception"])
			expect(encoded).not.toContain(forbidden);

		const rejecting = new Authorizer(() => Promise.reject(new Error("must remain contained")));
		expect(rejecting.decide({ identity: subject, scopeId, action: "workspace.read", gateway: "rest" }).allowed).toBe(true);
		await Promise.resolve();
		const throwing = new Authorizer(() => { throw new Error("must remain contained"); });
		expect(throwing.decide({ identity: subject, scopeId, action: "workspace.read", gateway: "rest" }).allowed).toBe(true);
		await Promise.resolve();
	});

	test("queues audit delivery off the decision path and prioritizes denies on overflow", async () => {
		const events: AuthorizationAuditEvent[] = [];
		const subject = identity([{ scopeId: "personal", roles: ["reader"] }]);
		const scopeId = authorizationScopeId(subject, "personal");
		const authorizer = new Authorizer(event => { events.push(event); }, 2);
		authorizer.decide({ identity: subject, scopeId, action: "workspace.read", gateway: "rest" });
		authorizer.decide({ identity: subject, scopeId, action: "runtime.read", gateway: "rest" });
		authorizer.decide({ identity: subject, scopeId, action: "runtime.delete", gateway: "rest" });
		expect(events).toEqual([]);
		await Promise.resolve();
		expect(events).toHaveLength(2);
		expect(events.some(event => event.result === "deny" && event.action === "runtime.delete")).toBe(true);
	});
});
