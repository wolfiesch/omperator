import { describe, expect, test } from "bun:test";
import type { ByteSink, ByteSource, SshCommandChannel, SshCommandContext, SshGatewayCommand } from "../src/index.ts";
import { createProviderRelaySshCommandHandler, loadSshCommandHandler, parseSshCommand, runSshCommand, SshGatewayError } from "../src/index.ts";
import { Authorizer, type AuthorizationAuditEvent } from "../../cluster-server/src/authorization.ts";
const TEST_IDENTITY = Object.freeze({
  principalId: "id_0123456789abcdefghijklmnop",
  authorizedScopes: Object.freeze([]),
  adapter: Object.freeze({ id: "openssh-expose-auth-info" as const, type: "ssh" as const }),
  policyRevision: "ssh-expose-auth-info-v1" as const,
});

function source(chunks: readonly string[]): ByteSource & { cancelled: boolean } {
  return {
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
    cancel() { this.cancelled = true; },
  };
}

function sink(): ByteSink & { readonly chunks: Uint8Array[]; ended: boolean; aborted: boolean } {
  return {
    chunks: [],
    ended: false,
    aborted: false,
    async write(chunk) { this.chunks.push(chunk); },
    async end() { this.ended = true; },
    abort() { this.aborted = true; },
  };
}

function channel(output: readonly string[]): SshCommandChannel & { readonly input: Uint8Array[]; ended: boolean; closed: boolean; closeCount: number } {
  return {
    input: [],
    ended: false,
    closed: false,
    closeCount: 0,
    readable: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of output) yield Buffer.from(chunk);
      },
    },
    async write(chunk) { this.input.push(chunk); },
    async end() { this.ended = true; },
    close() { this.closed = true; this.closeCount += 1; },
  };
}

describe("SSH forced command contract", () => {
  test("accepts only exact commands with their required PTY mode", () => {
    expect(parseSshCommand("cmux provider control", false, { provider: true })).toEqual({ kind: "provider", mode: "control" });
    expect(parseSshCommand("cmux provider stream", false, { provider: true })).toEqual({ kind: "provider", mode: "stream" });
    expect(parseSshCommand("cmux-tui relay --session runtime_01JZ", false, { relay: true })).toEqual({ kind: "relay", runtimeId: "runtime_01JZ" });
    expect(parseSshCommand("omperator attach runtime_01JZ", true, { attach: true })).toEqual({ kind: "attach", runtimeId: "runtime_01JZ" });
    expect(parseSshCommand("omperator version", false, { version: true })).toEqual({ kind: "version" });
  });

  test.each([
    ["cmux provider control", false],
    ["cmux-tui relay --session runtime_01JZ", false],
    ["omperator attach runtime_01JZ", true],
    ["omperator version", false],
  ] as const)("denies optional command %# until explicitly registered", (command, pty) => {
    expect(() => parseSshCommand(command, pty)).toThrow(SshGatewayError);
  });

  test.each([
    [undefined, false],
    ["", false],
    ["sh", true],
    ["cmux provider control; id", false],
    ["cmux  provider control", false],
    ["cmux provider control", true],
    ["cmux provider stream --extra", false],
    ["cmux-tui relay --session ../state", false],
    ["cmux-tui relay --socket /run/cmux.sock", false],
    ["omperator attach runtime_01JZ", false],
    ["omperator version", true],
    ["sftp", false],
  ] as const)("rejects command %#", (command, pty) => {
    expect(() => parseSshCommand(command, pty)).toThrow(SshGatewayError);
  });

  test("maps provider and direct relay commands to server-owned backend selectors", async () => {
    const calls: Array<{ selector: string; principalId: string }> = [];
    const provider = channel([]);
    const relay = channel([]);
    const handler = createProviderRelaySshCommandHandler({
      async resolveProviderRequest(mode, context) {
        calls.push({ selector: `resolve-provider:${mode}`, principalId: context.identity.principalId });
        return { scopeId: "scope_test" };
      },
      async resolveRuntime(runtimeId, context) {
        calls.push({ selector: `resolve-runtime:${runtimeId}`, principalId: context.identity.principalId });
        return { scopeId: "scope_test" };
      },
      async openProvider(mode, context) {
        calls.push({ selector: `provider:${mode}`, principalId: context.identity.principalId });
        return provider;
      },
      async openRelay(runtimeId, context) {
        calls.push({ selector: `runtime:${runtimeId}`, principalId: context.identity.principalId });
        return relay;
      },
    });
    const authorizationContext = {
      identity: TEST_IDENTITY,
      requestId: "00000000-0000-4000-8000-000000000000",
      action: "runtime.connect.cmux" as const,
      pty: false,
      authorizedScopeIds: Object.freeze(["scope_test"]),
    };
    const context: SshCommandContext = { ...authorizationContext, scopeId: "scope_test" };
    expect(await handler.resolve({ kind: "provider", mode: "control" }, authorizationContext, new AbortController().signal)).toEqual({ scopeId: "scope_test" });
    expect(await handler.open({ kind: "provider", mode: "control" }, context, new AbortController().signal)).toBe(provider);
    expect(await handler.resolve({ kind: "relay", runtimeId: "runtime_01JZ" }, authorizationContext, new AbortController().signal)).toEqual({ scopeId: "scope_test" });
    expect(await handler.open({ kind: "relay", runtimeId: "runtime_01JZ" }, context, new AbortController().signal)).toBe(relay);
    expect(calls).toEqual([
      { selector: "resolve-provider:control", principalId: TEST_IDENTITY.principalId },
      { selector: "provider:control", principalId: TEST_IDENTITY.principalId },
      { selector: "resolve-runtime:runtime_01JZ", principalId: TEST_IDENTITY.principalId },
      { selector: "runtime:runtime_01JZ", principalId: TEST_IDENTITY.principalId },
    ]);
  });

  test("relays bytes without interpreting provider or cmux frames", async () => {
    const stdin = source(["{not-json}\n", "\u0000\ufffd"]);
    const stdout = sink();
    const transport = channel(["first\n", "second\u0000"]);
    const opened: Array<{ command: SshGatewayCommand; context: SshCommandContext }> = [];
    const result = await runSshCommand({
      originalCommand: "cmux provider stream",
      identity: TEST_IDENTITY,
      pty: false,
      registry: { provider: true },
      stdin,
      stdout,
      handler: {
        async resolve(_command, context) { return { scopeId: context.authorizedScopeIds[0]! }; },
        async open(command, context) {
          opened.push({ command, context });
          return transport;
        },
      },
    });
    expect(result).toEqual({ kind: "provider", mode: "stream" });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.command).toEqual(result);
    expect(opened[0]?.context).toMatchObject({ identity: TEST_IDENTITY, action: "runtime.connect.cmux", pty: false });
    expect(Buffer.concat(transport.input).equals(Buffer.concat([Buffer.from("{not-json}\n"), Buffer.from("\u0000\ufffd")]))).toBe(true);
    expect(Buffer.concat(stdout.chunks).equals(Buffer.concat([Buffer.from("first\n"), Buffer.from("second\u0000")]))).toBe(true);
    expect(transport.ended).toBe(true);
    expect(stdout.ended).toBe(true);
    expect(transport.closed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  test("closes an aborted backend channel exactly once", async () => {
    const opened = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    let closeCount = 0;
    const transport: SshCommandChannel = {
      readable: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await blocked.promise;
              return { done: true, value: undefined };
            },
          };
        },
      },
      async write() {},
      async end() {},
      close() { closeCount += 1; blocked.resolve(); },
    };
    const cancellation = new AbortController();
    const running = runSshCommand({
      originalCommand: "cmux provider control",
      identity: TEST_IDENTITY,
      pty: false,
      registry: { provider: true },
      stdin: source([]),
      stdout: sink(),
      handler: {
        async resolve(_command, context) { return { scopeId: context.authorizedScopeIds[0]! }; },
        async open() {
          opened.resolve();
          return transport;
        },
      },
      signal: cancellation.signal,
    });
    await opened.promise;
    cancellation.abort();
    await expect(running).rejects.toMatchObject({ code: "ABORTED" });
    expect(closeCount).toBe(1);
  });

  test("reports bounded protocol versions without loading a backend handler", async () => {
    const stdout = sink();
    const result = await runSshCommand({
      originalCommand: "omperator version",
      identity: TEST_IDENTITY,
      pty: false,
      stdin: source([]),
      stdout,
      registry: { version: true },
    });
    expect(result).toEqual({ kind: "version" });
    expect(Buffer.concat(stdout.chunks).toString()).toBe("omperator ssh-gateway/1 machine-provider-v1 cmux/10 omp-app/1\n");
    expect(stdout.ended).toBe(true);
  });

  test("rejects invalid identity before opening the handler", async () => {
    let opened = false;
    await expect(runSshCommand({
      originalCommand: "cmux provider control",
      identity: { ...TEST_IDENTITY, principalId: " client-controlled\n" },
      pty: false,
      registry: { provider: true },
      stdin: source([]),
      stdout: sink(),
      handler: { async resolve() { return { scopeId: "personal" }; }, async open() { opened = true; return channel([]); } },
    })).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
    expect(opened).toBe(false);
  });

  test("denies unauthorized operational commands before opening the backend", async () => {
    let opened = false;
    const reader = {
      ...TEST_IDENTITY,
      authorizedScopes: Object.freeze([{ scopeId: "personal", roles: Object.freeze(["reader"]) }]),
    };
    await expect(runSshCommand({
      originalCommand: "cmux provider control",
      identity: reader,
      pty: false,
      registry: { provider: true },
      stdin: source([]),
      stdout: sink(),
      handler: { async resolve() { opened = true; return { scopeId: "personal" }; }, async open() { opened = true; return channel([]); } },
    })).rejects.toMatchObject({ code: "HANDLER_UNAVAILABLE" });
    expect(opened).toBe(false);
  });

  test("rejects unresolved and foreign runtime ownership before opening a handler channel", async () => {
    const sharedIdentity = {
      ...TEST_IDENTITY,
      authorizedScopes: Object.freeze([{ scopeId: "scope_shared", roles: Object.freeze(["admin"]) }]),
    };
    for (const resolved of [undefined, { scopeId: "scope_foreign" }]) {
      let opened = false;
      const events: AuthorizationAuditEvent[] = [];
      const authorizer = new Authorizer(event => { events.push(event); });
      await expect(runSshCommand({
        originalCommand: "cmux-tui relay --session runtime_01JZ",
        identity: sharedIdentity,
        pty: false,
        registry: { relay: true },
        stdin: source([]),
        stdout: sink(),
        authorizer,
        handler: {
          async resolve() { return resolved; },
          async open() { opened = true; return channel([]); },
        },
      })).rejects.toMatchObject({ code: "HANDLER_UNAVAILABLE" });
      expect(opened).toBe(false);
      await Promise.resolve();
      expect(events.at(-1)?.result).toBe(resolved ? "deny" : "error");
    }
  });

  test("retains authoritative provider resolution for every control and stream request", async () => {
    const sharedIdentity = {
      ...TEST_IDENTITY,
      authorizedScopes: Object.freeze([{ scopeId: "scope_shared", roles: Object.freeze(["admin"]) }]),
    };
    const resolvedModes: string[] = [];
    const openedModes: string[] = [];
    const handler = createProviderRelaySshCommandHandler({
      async resolveProviderRequest(mode, context) {
        resolvedModes.push(mode);
        return context.authorizedScopeIds.includes("scope_shared") ? { scopeId: "scope_shared" } : undefined;
      },
      async resolveRuntime() { return undefined; },
      async openProvider(mode) {
        openedModes.push(mode);
        return channel([]);
      },
    });
    for (const mode of ["control", "stream"] as const) {
      await runSshCommand({
        originalCommand: `cmux provider ${mode}`,
        identity: sharedIdentity,
        pty: false,
        registry: { provider: true },
        stdin: source([]),
        stdout: sink(),
        handler,
      });
    }
    expect(resolvedModes).toEqual(["control", "stream"]);
    expect(openedModes).toEqual(["control", "stream"]);
  });

  test("loads only an explicit handler module and sanitizes loader failures", async () => {
    await expect(loadSshCommandHandler({})).rejects.toMatchObject({ code: "HANDLER_UNAVAILABLE" });
    const handler = { async resolve() { return { scopeId: "personal" }; }, async open() { return channel([]); } };
    expect(await loadSshCommandHandler(
      { T4_SSH_GATEWAY_HANDLER_MODULE: "fixture" },
      async () => ({ createSshCommandHandler: () => handler }),
    )).toBe(handler);
    await expect(loadSshCommandHandler(
      { T4_SSH_GATEWAY_HANDLER_MODULE: "fixture" },
      async () => { throw new Error("private endpoint"); },
    )).rejects.toEqual(new SshGatewayError("HANDLER_UNAVAILABLE"));
    let imported = false;
    for (const specifier of ["../private-handler", "file:///opt/t4/%2e%2e/private-handler", "fixture token", "https://example.test/handler.js"]) {
      await expect(loadSshCommandHandler(
        { T4_SSH_GATEWAY_HANDLER_MODULE: specifier },
        async () => { imported = true; return {}; },
      )).rejects.toEqual(new SshGatewayError("HANDLER_UNAVAILABLE"));
    }
    expect(imported).toBe(false);
  });
});
