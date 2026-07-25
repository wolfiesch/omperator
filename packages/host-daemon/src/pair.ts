import { execFile } from "node:child_process";
import { request } from "node:http";
import { homedir } from "node:os";
import { promisify } from "node:util";
import qrcode from "qrcode";
import { profileSocketPath } from "@t4-code/host-service";

const execFileAsync = promisify(execFile);

/**
 * Capabilities requested on every pairing ticket. These match the read/prompt/
 * manage surface the iOS companion needs to drive sessions over the wire.
 */
const PAIR_CAPABILITIES = ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "catalog.read"] as const;

/** Default ticket lifetime (10 minutes), matching the admin endpoint maximum. */
export const DEFAULT_PAIR_TTL_MS = 600_000;

/** Port the iOS companion assumes when building ws://<hint>:8787/v1/ws. */
export const PAIR_PORT = 8787;

const TAILSCALE_TIMEOUT_MS = 5_000;
const TAILSCALE_MAX_BUFFER = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface PairTicket {
  readonly code: string;
  readonly expiresAt: number;
}

export interface HostHintResult {
  /** Bare hostname (no port, no scheme) for the t4-code://pair/<hint>/<code> link. */
  readonly hint: string;
  /** Optional human-facing caveat shown when the hint is a fallback. */
  readonly note?: string;
}

export interface PairArgs {
  readonly socketPath: string;
  readonly ttlMs: number;
}

export interface PairActionDependencies {
  /** Resolve the host hint embedded in the deep link. Defaults to a tailscale probe. */
  readonly resolveHostHint?: () => Promise<HostHintResult>;
  /** POST the pairing ticket. Defaults to the unix-socket implementation. */
  readonly postTicket?: (
    socketPath: string,
    capabilities: readonly string[],
    ttlMs: number,
  ) => Promise<PairTicket>;
  /** Render a terminal QR for the deep link. Defaults to the `qrcode` package. */
  readonly renderQr?: (text: string) => Promise<string>;
  /** Output sink (stdout by default). */
  readonly out?: (text: string) => void;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}

export function parsePairArgs(argv: readonly string[], home = homedir()): PairArgs {
  let socketPath: string | undefined;
  let ttlMs = DEFAULT_PAIR_TTL_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--socket") socketPath = value(argv, index++, flag);
    else if (flag === "--ttl") {
      const raw = value(argv, index++, flag);
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 600_000)
        throw new Error("--ttl must be a positive integer up to 600000");
      ttlMs = parsed;
    } else throw new Error(`unsupported t4-host pair argument: ${flag}`);
  }
  return { socketPath: socketPath ?? profileSocketPath(undefined, undefined, home), ttlMs };
}

async function runTailscale(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("tailscale", [...args], {
    timeout: TAILSCALE_TIMEOUT_MS,
    maxBuffer: TAILSCALE_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Best-effort host hint: prefer the tailscale DNS name, then the IPv4 address,
 * then localhost. Never throws — a missing tailscale just degrades to localhost.
 */
export async function defaultResolveHostHint(): Promise<HostHintResult> {
  try {
    const stdout = await runTailscale(["status", "--json"]);
    const dns = String(JSON.parse(stdout)?.Self?.DNSName ?? "").replace(/\.+$/u, "");
    if (dns && HOSTNAME_PATTERN.test(dns)) return { hint: dns };
  } catch {}
  try {
    const stdout = await runTailscale(["ip", "-4"]);
    const ip = stdout.trim().split(/\s+/u)[0];
    if (ip && HOSTNAME_PATTERN.test(ip)) return { hint: ip };
  } catch {}
  return {
    hint: "localhost",
    note: "tailscale not available — using localhost; pairing only works from this machine",
  };
}

/** POST /admin/pair-ticket over a unix socket using node:http (fetch can't). */
export function postPairTicket(
  socketPath: string,
  capabilities: readonly string[],
  ttlMs: number,
): Promise<PairTicket> {
  const payload = JSON.stringify({ capabilities, ttlMs });
  const { promise, resolve, reject } = Promise.withResolvers<PairTicket>();
  const req = request(
    {
      method: "POST",
      path: "/admin/pair-ticket",
      socketPath,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`pair-ticket request failed (HTTP ${res.statusCode})`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new Error("pair-ticket returned invalid JSON"));
          return;
        }
        const ticket = parsed as { code?: unknown; expiresAt?: unknown };
        if (typeof ticket.code !== "string" || typeof ticket.expiresAt !== "number") {
          reject(new Error("pair-ticket returned an unexpected payload"));
          return;
        }
        resolve({ code: ticket.code, expiresAt: ticket.expiresAt });
      });
    },
  );
  req.on("error", reject);
  req.on("timeout", () => req.destroy(new Error("pair-ticket request timed out")));
  req.end(payload);
  return promise;
}

async function defaultRenderQr(text: string): Promise<string> {
  return qrcode.toString(text, { type: "terminal", small: true });
}

/**
 * Mint a one-time pairing ticket from the running local host and print the
 * 6-digit code, the t4-code://pair/<hostname>/<code> deep link, the expiry,
 * and a terminal QR of the deep link.
 */
export async function runPairAction(
  args: PairArgs,
  dependencies: PairActionDependencies = {},
): Promise<void> {
  const out = dependencies.out ?? ((text: string) => process.stdout.write(text));
  const resolveHostHint = dependencies.resolveHostHint ?? defaultResolveHostHint;
  const postTicket = dependencies.postTicket ?? postPairTicket;
  const renderQr = dependencies.renderQr ?? defaultRenderQr;

  let ticket: PairTicket;
  try {
    ticket = await postTicket(args.socketPath, PAIR_CAPABILITIES, args.ttlMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT/ECONNREFUSED under node; FailedToOpenSocket under bun's node:http.
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "FailedToOpenSocket") {
      throw new Error(
        `no running t4-host found at ${args.socketPath} — start one with t4-host serve`,
      );
    }
    throw error;
  }

  const { hint, note } = await resolveHostHint();
  const deepLink = `t4-code://pair/${hint}/${ticket.code}`;
  const expiryMs = ticket.expiresAt - Date.now();
  const expiryMinutes = Math.max(0, Math.round(expiryMs / 60_000));

  out("\n  Pairing ticket\n\n");
  out("  ┌────────────┐\n");
  out(`  │  ${ticket.code}  │\n`);
  out("  └────────────┘\n\n");
  out(`  Deep link: ${deepLink}\n`);
  out(`  Expires in ~${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}\n`);
  if (note) out(`  Note: ${note}\n`);
  out("\n");
  try {
    const qr = await renderQr(deepLink);
    out(`${qr}\n`);
  } catch {
    out("  (QR rendering unavailable)\n");
  }
}
