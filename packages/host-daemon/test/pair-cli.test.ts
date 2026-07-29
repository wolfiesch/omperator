import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { parsePairArgs, runPairAction, postPairTicket } from "../src/pair.ts";

function startPairServer(
  socketPath: string,
  response: { code: string; expiresAt: number },
): Promise<Server> {
  const { promise, resolve, reject } = Promise.withResolvers<Server>();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/admin/pair-ticket") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { capabilities?: unknown; ttlMs?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      if (
        !Array.isArray(body.capabilities) ||
        typeof body.ttlMs !== "number"
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad request"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...response,
        transport: {
          scheme: "wss",
          port: 9443,
          path: "/v1/ws",
          tlsFingerprint: "a".repeat(64),
        },
      }));
    });
  });
  server.on("error", reject);
  server.listen(socketPath, () => resolve(server));
  return promise;
}

function pairingPayload(output: string): Record<string, unknown> {
  const link = /t4-code:\/\/pair\/([A-Za-z0-9_-]+)/u.exec(output)?.[1];
  if (!link) throw new Error("pairing deep link missing");
  return JSON.parse(Buffer.from(link, "base64url").toString("utf8"));
}

describe("t4-host pair", () => {
  test("parses pair args with defaults", () => {
    const args = parsePairArgs([], "/home/test");
    expect(args.ttlMs).toBe(600_000);
    expect(args.socketPath).toMatch(/appserver\.sock$/u);
  });

  test("parses --socket and --ttl", () => {
    const args = parsePairArgs(
      ["--socket", "/tmp/x.sock", "--ttl", "120000"],
      "/home/test",
    );
    expect(args).toEqual({ socketPath: "/tmp/x.sock", ttlMs: 120_000 });
  });

  test("rejects invalid ttl and unknown flags", () => {
    expect(() => parsePairArgs(["--ttl", "0"], "/home/test")).toThrow("--ttl");
    expect(() => parsePairArgs(["--ttl", "700000"], "/home/test")).toThrow("--ttl");
    expect(() => parsePairArgs(["--ttl", "abc"], "/home/test")).toThrow("--ttl");
    expect(() => parsePairArgs(["--bogus"], "/home/test")).toThrow("unsupported");
    expect(() => parsePairArgs(["--socket"], "/home/test")).toThrow("requires a value");
  });

  test("mints a ticket over a unix socket and prints the code plus deep link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t4-pair-"));
    const socketPath = join(dir, "pair.sock");
    const expiresAt = Date.now() + 600_000;
    const server = await startPairServer(socketPath, { code: "654321", expiresAt });
    const captured: string[] = [];
    try {
      await runPairAction(
        { socketPath, ttlMs: 600_000 },
        {
          resolveHostHint: async () => ({ hint: "macbookpro.example.ts.net" }),
          renderQr: async () => "[qr-stub]",
          out: (text) => {
            captured.push(text);
          },
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
    const output = captured.join("");
    expect(output).toContain("654321");
    expect(output).toContain("t4-code://pair/");
    expect(pairingPayload(output)).toEqual({
      version: 1,
      hostHint: "macbookpro.example.ts.net",
      endpoint: "wss://macbookpro.example.ts.net:9443/v1/ws",
      code: "654321",
      tlsFingerprint: "a".repeat(64),
    });
    expect(output).toContain("[qr-stub]");
    expect(output).toContain("Expires in");
  });

  test("postPairTicket sends capabilities and ttlMs to the admin endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t4-pair-post-"));
    const socketPath = join(dir, "pair.sock");
    let capturedBody: { capabilities?: unknown; ttlMs?: unknown } | undefined;
    const { promise, resolve, reject } = Promise.withResolvers<Server>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          code: "112233",
          expiresAt: Date.now() + 60_000,
          transport: { scheme: "ws", port: 8787, path: "/v1/ws" },
        }));
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
    try {
      await promise;
      const ticket = await postPairTicket(socketPath, ["sessions.read"], 30_000);
      expect(ticket.code).toBe("112233");
      expect(capturedBody).toMatchObject({
        capabilities: ["sessions.read"],
        ttlMs: 30_000,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a friendly error when the socket is missing", async () => {
    await expect(
      runPairAction(
        { socketPath: join(tmpdir(), "definitely-missing-t4-pair.sock"), ttlMs: 600_000 },
        {
          resolveHostHint: async () => ({ hint: "localhost" }),
          renderQr: async () => "",
        },
      ),
    ).rejects.toThrow("no running t4-host found");
  });

  test("surfaces HTTP failure status from the admin endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t4-pair-http-"));
    const socketPath = join(dir, "pair.sock");
    const { promise, resolve, reject } = Promise.withResolvers<Server>();
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" }).end('{"error":"draining"}');
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
    try {
      await promise;
      await expect(
        runPairAction(
          { socketPath, ttlMs: 600_000 },
          {
            resolveHostHint: async () => ({ hint: "localhost" }),
            renderQr: async () => "",
          },
        ),
      ).rejects.toThrow("HTTP 503");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to localhost hint with a note when tailscale is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t4-pair-fallback-"));
    const socketPath = join(dir, "pair.sock");
    const server = await startPairServer(socketPath, {
      code: "999888",
      expiresAt: Date.now() + 600_000,
    });
    const captured: string[] = [];
    try {
      await runPairAction(
        { socketPath, ttlMs: 600_000 },
        {
          // Simulate the default tailscale lookup failing by returning the fallback.
          resolveHostHint: async () => ({
            hint: "localhost",
            note: "tailscale not available — using localhost; pairing only works from this machine",
          }),
          renderQr: async () => "[qr]",
          out: (text) => {
            captured.push(text);
          },
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
    const output = captured.join("");
    expect(pairingPayload(output)).toMatchObject({
      hostHint: "localhost",
      endpoint: "wss://localhost:9443/v1/ws",
      code: "999888",
    });
    expect(output).toContain("tailscale not available");
  });
});
