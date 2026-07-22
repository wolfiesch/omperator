import { describe, expect, test } from "bun:test";
import {
	decodeOmpAuthorityBridgeClientFrame,
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_METHODS,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	parseOmpAuthorityBridgeLine,
} from "../src/omp-authority-bridge-contract.ts";

describe("OMP authority bridge contract", () => {
	test("round-trips strict request, ready, response, and terminal event envelopes", () => {
		const request = {
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "request" as const,
			id: "request-1",
			method: "session.list" as const,
			params: {},
		};
		expect(parseOmpAuthorityBridgeLine(encodeOmpAuthorityBridgeFrame(request), "client")).toEqual(request);
		expect(
			decodeOmpAuthorityBridgeServerFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "ready",
				methods: OMP_AUTHORITY_BRIDGE_METHODS,
				ompVersion: "17.0.5",
				ompBuild: "commit",
			}),
		).toMatchObject({ type: "ready", ompVersion: "17.0.5" });
		expect(
			decodeOmpAuthorityBridgeServerFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id: "request-1",
				ok: true,
				result: { sessions: [] },
			}),
		).toMatchObject({ type: "response", ok: true });
		expect(
			decodeOmpAuthorityBridgeServerFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "event",
				id: "request-1",
				event: "terminal",
				payload: { type: "terminal.output", data: "ok" },
			}),
		).toMatchObject({ type: "event", event: "terminal" });
	});

	test("rejects unknown versions, methods, fields, duplicate ready methods, and oversized values", () => {
		expect(() => decodeOmpAuthorityBridgeClientFrame({
			v: "t4-omp-authority/2",
			type: "cancel",
			id: "request-1",
		})).toThrow("version");
		expect(() => decodeOmpAuthorityBridgeClientFrame({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "request",
			id: "request-1",
			method: "host.deleteEverything",
			params: {},
		})).toThrow("unsupported");
		expect(() => decodeOmpAuthorityBridgeClientFrame({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "cancel",
			id: "request-1",
			extra: true,
		})).toThrow("unknown or missing");
		expect(() => decodeOmpAuthorityBridgeServerFrame({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "ready",
			methods: ["session.list", "session.list"],
			ompVersion: "17.0.5",
			ompBuild: "commit",
		})).toThrow("methods");
		expect(() => decodeOmpAuthorityBridgeClientFrame({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "request",
			id: "request-1",
			method: "session.create",
			params: { cwd: "x".repeat(300_000) },
		})).toThrow("text bounds");
	});

	test("does not accept non-JSON payload values", () => {
		expect(() => decodeOmpAuthorityBridgeClientFrame({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "request",
			id: "request-1",
			method: "session.list",
			params: { invalid: undefined },
		})).toThrow("non-JSON");
	});

	test("accepts a bounded catalog response larger than the client request text budget", () => {
		const item = { kind: "model", description: "x".repeat(420) };
		const catalog = Array.from({ length: 791 }, (_, index) => ({ ...item, id: `model-${index}` }));
		expect(
			decodeOmpAuthorityBridgeServerFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id: "catalog-request",
				ok: true,
				result: { items: catalog },
			}),
		).toMatchObject({ type: "response", ok: true });
		expect(() =>
			decodeOmpAuthorityBridgeServerFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id: "oversized-catalog-request",
				ok: true,
				result: { items: [{ description: "x".repeat(600_000) }] },
			}),
		).toThrow("text bounds");
	});
});
