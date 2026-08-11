import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { createInternalProviderRelayBackend, createProviderAssertion, openWebSocketChannel } from "../src/provider-backend.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "nodebuffer";
  terminated = 0;
  terminate(): void { this.terminated++; this.readyState = WebSocket.CLOSED; }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  send(_chunk: Uint8Array, _options: object, callback: (error?: Error) => void): void { callback(); }
}

describe("provider backend WebSocket bounds", () => {
  it("terminates a connecting socket when the bounded timeout expires", async () => {
    const socket = new FakeSocket();
    let expire = (): void => { throw new Error("timeout was not scheduled"); };
    const opening = openWebSocketChannel("ws://provider.test/internal/provider/control", "assertion", new AbortController().signal, {
      connectTimeoutMilliseconds: 10,
      webSocketFactory: () => socket as unknown as WebSocket,
      scheduleConnectTimeout: callback => { expire = callback; return () => undefined; },
    });
    expire();
    await expect(opening).rejects.toThrow();
    expect(socket.terminated).toBe(1);
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });

  it("fails closed when queued inbound bytes exceed the high-water mark", async () => {
    const socket = new FakeSocket();
    const opening = openWebSocketChannel("ws://provider.test/internal/provider/control", "assertion", new AbortController().signal, {
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
    const channel = await opening;
    socket.emit("message", Buffer.alloc(700_000));
    socket.emit("message", Buffer.alloc(400_000));
    expect(socket.terminated).toBe(1);
    const iterator = channel.readable[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.byteLength).toBe(700_000);
    expect((await iterator.next()).done).toBe(true);
  });
  it("signs the exact active kid, audience, and mode purpose", () => {
    const assertion = createProviderAssertion({
      principalId: "principal",
      scopeId: "scope",
      requestId: "request",
      audience: "cluster.default.svc:8080/internal/provider",
      purpose: "provider.stream",
    }, { kid: "rotation-2", secret: Buffer.alloc(32, 7) }, 100, "abcdefghijklmnopqrstuvwx");
    const payload = JSON.parse(Buffer.from(assertion.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({ kid: "rotation-2", aud: "cluster.default.svc:8080/internal/provider", purpose: "provider.stream", exp: 120 });
  });
  it("reloads the active key from a projected keyring for every provider connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssh-provider-keyring-"));
    const keyringPath = join(root, "keyring.json");
    const openedAssertions: string[] = [];
    const writeKeyring = (kid: string, fill: number): void => {
      writeFileSync(keyringPath, JSON.stringify({
        revision: kid === "rotation-2" ? 2 : 1,
        activeKid: kid,
        keys: [{ kid, secret: Buffer.alloc(32, fill).toString("base64url") }],
      }));
    };
    const backend = createInternalProviderRelayBackend({
      endpoint: "ws://cluster.default.svc:8080/internal/provider",
      keyringPath,
      openChannel: async (_endpoint, assertion) => {
        openedAssertions.push(assertion);
        return {
          readable: { async *[Symbol.asyncIterator]() {} },
          write: async () => undefined,
          end: async () => undefined,
          close: async () => undefined,
        };
      },
    });
    const context = {
      identity: {
        principalId: "principal",
        authorizedScopes: [{ scopeId: "scope", roles: ["member"] }],
        adapter: { id: "openssh-expose-auth-info" as const, type: "ssh" as const },
        policyRevision: "ssh-expose-auth-info-v1" as const,
      },
      requestId: "request",
      action: "runtime.connect.cmux" as const,
      pty: false,
      authorizedScopeIds: ["scope"],
      scopeId: "scope",
    };
    try {
      writeKeyring("rotation-1", 7);
      await backend.openProvider("control", context, new AbortController().signal);
      writeKeyring("rotation-2", 8);
      await backend.openProvider("stream", context, new AbortController().signal);
      expect(openedAssertions.map(value => JSON.parse(Buffer.from(value.split(".")[0]!, "base64url").toString("utf8")))).toEqual([
        expect.objectContaining({ kid: "rotation-1", purpose: "provider.control" }),
        expect.objectContaining({ kid: "rotation-2", purpose: "provider.stream" }),
      ]);
      writeKeyring("rotation-1", 7);
      await expect(backend.openProvider("control", context, new AbortController().signal)).rejects.toThrow();
      writeFileSync(keyringPath, "x".repeat(16_385));
      await expect(backend.openProvider("control", context, new AbortController().signal)).rejects.toThrow();
      expect(openedAssertions).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
