import { isIP } from "node:net";
import { DEVICE_CAPABILITIES, isCapability, type DeviceCapability } from "@t4-code/protocol";
export const PAIRED_HOST_RECORD_VERSION = 1 as const;
export const REMOTE_PROTOCOL_MIN = 1;
export const REMOTE_PROTOCOL_MAX = 1;

export type RemoteTransport = "direct" | "serve" | "ssh";
export type RemoteCapability = DeviceCapability;

export interface RemoteEndpoint {
  readonly transport: "direct" | "serve";
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

export interface PairedHostRecord {
  readonly version: typeof PAIRED_HOST_RECORD_VERSION;
  readonly targetId: string;
  readonly label: string;
  readonly endpoints: readonly RemoteEndpoint[];
  readonly pinnedEndpointHosts: readonly string[];
  readonly credentialRef: string;
  readonly hostId: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SanitizedPairedHostView {
  readonly targetId: string;
  readonly label: string;
  readonly state: "paired" | "revoked" | "expired";
  readonly hostId: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly updatedAt: number;
}

export interface TargetRegistry {
  get(targetId: string): Promise<PairedHostRecord | null>;
  put(record: PairedHostRecord): Promise<void>;
  delete(targetId: string): Promise<void>;
}

export interface CredentialVault {
  get(credentialRef: string): Promise<string | CredentialEntry | null>;
  set(credentialRef: string, credential: string | CredentialEntry): Promise<void>;
  delete(credentialRef: string): Promise<void>;
}

export interface CredentialEntry {
  readonly token: string;
  readonly expiresAt: string | number;
}

export interface PairingResponse {
  readonly deviceToken: string;
  readonly expiresAt: string;
  readonly hostId: string;
  readonly capabilities: readonly string[];
  readonly protocolVersion: number;
  readonly endpoints: readonly unknown[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PrivilegedPairingConnector {
  pair(input: { readonly code: string; readonly signal?: AbortSignal }): Promise<PairingResponse>;
}

export class RemoteSecurityError extends Error {
  readonly tag = "RemoteSecurityError" as const;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteSecurityError";
    this.code = code;
  }
}

export class TargetNotPairedError extends RemoteSecurityError {
  constructor() { super("target-not-paired", "Remote target is not paired."); this.name = "TargetNotPairedError"; }
}
export class TargetCredentialError extends RemoteSecurityError {
  constructor() { super("credential-unavailable", "Remote target credential is unavailable."); this.name = "TargetCredentialError"; }
}
export class TargetIdentityMismatchError extends RemoteSecurityError {
  constructor() { super("identity-mismatch", "Remote host identity no longer matches its pin."); this.name = "TargetIdentityMismatchError"; }
}
export class TargetCapabilityError extends RemoteSecurityError {
  constructor() { super("capability-missing", "Remote host does not provide the required capability."); this.name = "TargetCapabilityError"; }
}
export class TargetEndpointError extends RemoteSecurityError {
  constructor() { super("endpoint-rejected", "Remote endpoint was rejected by policy."); this.name = "TargetEndpointError"; }
}
export class PairingTransactionError extends RemoteSecurityError {
  constructor() { super("pairing-failed", "Remote pairing could not be completed."); this.name = "PairingTransactionError"; }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > max || hasControlCharacter(result)) return null;
  return result;
}

export function validateTargetId(value: unknown): string {
  const result = boundedString(value, 128);
  if (!result || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw new RemoteSecurityError("invalid-target", "Remote target identifier is invalid.");
  return result;
}

export function validatePairingCode(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6}$/u.test(value)) throw new RemoteSecurityError("invalid-pairing-code", "Pairing code must contain exactly six digits.");
  return value;
}

function isHostname(host: string): boolean {
  if (/^\d+(?:\.\d+){3}$/u.test(host)) return false;
  return host.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu.test(host) && !host.endsWith(".local");
}

function validatePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new TargetEndpointError();
  return value;
}

export function validateRemoteEndpoint(input: unknown, expectedHosts?: readonly string[]): RemoteEndpoint {
  if (!input || typeof input !== "object") throw new TargetEndpointError();
  const raw = input as { transport?: unknown; url?: unknown; host?: unknown; port?: unknown };
  if (raw.transport !== "direct" && raw.transport !== "serve") throw new TargetEndpointError();
  if (typeof raw.url !== "string" || typeof raw.host !== "string") throw new TargetEndpointError();
  let url: URL;
  try { url = new URL(raw.url); } catch { throw new TargetEndpointError(); }
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TargetEndpointError();
  const isPlainIp = isIP(host) !== 0;
  const isPinnedHost = expectedHosts?.some((value) => typeof value === "string" && value.trim().toLowerCase() === host) ?? false;
  if (!isPlainIp && !isHostname(host)) throw new TargetEndpointError();
  if (raw.transport === "direct" && url.protocol !== "ws:") throw new TargetEndpointError();
  if (raw.transport === "serve" && url.protocol !== "wss:") throw new TargetEndpointError();
  if (raw.host.trim().toLowerCase() !== host) throw new TargetEndpointError();
  if (expectedHosts?.length && !isPinnedHost) throw new TargetEndpointError();
  const defaultPort = url.protocol === "wss:" ? 443 : 80;
  const urlPort = url.port ? Number(url.port) : defaultPort;
  const port = validatePort(raw.port ?? urlPort);
  if (raw.port !== undefined && port !== urlPort) throw new TargetEndpointError();
  const normalized = new URL(`${url.protocol}//${host}`);
  normalized.port = String(port);
  normalized.pathname = "/";
  return { transport: raw.transport, url: normalized.toString(), host, port };
}

function normalizeCapabilities(values: readonly string[]): readonly RemoteCapability[] {
  const valid = values.map((value) => boundedString(value, 96)).filter((value): value is DeviceCapability => value !== null && isCapability(value) && DEVICE_CAPABILITIES.includes(value));
  return [...new Set(valid)].sort((left, right) => left.localeCompare(right));
}
export function hasRequiredCapabilities(actual: readonly string[], required: readonly string[] = ["sessions.read"]): boolean {
  const available = new Set<string>(normalizeCapabilities(actual));
  return required.every((value) => available.has(value));
}

function sanitizeMetadata(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const safeKey = boundedString(key, 64);
    const safeValue = boundedString(raw, 256);
    if (safeKey && safeValue && !/token|secret|credential|password|url|endpoint/iu.test(safeKey)) result[safeKey] = safeValue;
  }
  return result;
}

export function sanitizePairedHostRecord(record: PairedHostRecord, state: SanitizedPairedHostView["state"] = "paired"): SanitizedPairedHostView {
  return { targetId: record.targetId, label: record.label, state, hostId: record.hostId, capabilities: record.capabilities, updatedAt: record.updatedAt };
}

export function sanitizeRemoteError(error: unknown): { readonly tag: string; readonly code: string; readonly message: string } {
  if (error instanceof RemoteSecurityError) return { tag: error.tag, code: error.code, message: error.message };
  return { tag: "RemoteSecurityError", code: "remote-failure", message: "Remote operation failed." };
}

function parseExpiry(value: string | number): number {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TargetCredentialError();
  return timestamp;
}

function credentialToken(value: string | CredentialEntry | null): { token: string; expiresAt: number } {
  if (typeof value === "string") throw new TargetCredentialError();
  if (!value || typeof value.token !== "string" || !value.token) throw new TargetCredentialError();
  return { token: value.token, expiresAt: parseExpiry(value.expiresAt) };
}

function validateIdentity(response: PairingResponse, now: number): void {
  if (!Array.isArray(response.capabilities) || !Array.isArray(response.endpoints)) throw new PairingTransactionError();
  const expiry = Date.parse(response.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 366 * 24 * 60 * 60 * 1000) throw new TargetCredentialError();
  if (!boundedString(response.deviceToken, 4096) || !boundedString(response.hostId, 256)) throw new PairingTransactionError();
  if (!Number.isInteger(response.protocolVersion) || response.protocolVersion < REMOTE_PROTOCOL_MIN || response.protocolVersion > REMOTE_PROTOCOL_MAX) throw new TargetCapabilityError();
  if (!hasRequiredCapabilities(response.capabilities)) throw new TargetCapabilityError();
}

export async function pairRemoteHost(input: {
  readonly targetId: string;
  readonly label: string;
  readonly code: string;
  readonly connector: PrivilegedPairingConnector;
  readonly registry: TargetRegistry;
  readonly vault: CredentialVault;
  readonly expectedEndpointHosts: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly now?: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly record: PairedHostRecord; readonly view: SanitizedPairedHostView }> {
  const targetId = validateTargetId(input.targetId);
  const label = boundedString(input.label, 128);
  if (!label || !input.expectedEndpointHosts.length) throw new PairingTransactionError();
  const code = validatePairingCode(input.code);
  const now = input.now ?? Date.now();
  let response: PairingResponse;
  try { response = await input.connector.pair({ code, ...(input.signal === undefined ? {} : { signal: input.signal }) }); } catch { throw new PairingTransactionError(); }
  validateIdentity(response, now);
  if (!hasRequiredCapabilities(response.capabilities, input.requiredCapabilities ?? ["sessions.read"])) throw new TargetCapabilityError();
  const pinnedEndpointHosts = [...new Set(input.expectedEndpointHosts.map((host) => boundedString(host, 253)?.toLowerCase()).filter((host): host is string => host !== null))];
  if (!pinnedEndpointHosts.length || pinnedEndpointHosts.some((host) => isIP(host) === 0 && !isHostname(host))) throw new TargetEndpointError();
  const endpoints = response.endpoints.map((endpoint) => validateRemoteEndpoint(endpoint, pinnedEndpointHosts));
  if (!endpoints.length) throw new TargetEndpointError();
  const credentialRef = `remote/${targetId}`;
  const record: PairedHostRecord = {
    version: PAIRED_HOST_RECORD_VERSION,
    targetId, label, endpoints, pinnedEndpointHosts, credentialRef,
    hostId: response.hostId,
    capabilities: normalizeCapabilities(response.capabilities), metadata: sanitizeMetadata(response.metadata), createdAt: now, updatedAt: now,
  };
  try { await input.vault.set(credentialRef, { token: response.deviceToken, expiresAt: response.expiresAt }); } catch { throw new PairingTransactionError(); }
  try { await input.registry.put(record); } catch {
    try { await input.vault.delete(credentialRef); } catch { /* best effort rollback */ }
    throw new PairingTransactionError();
  }
  return { record, view: sanitizePairedHostRecord(record) };
}
export interface RemoteRevokeConnector {
  revoke(input: { readonly targetId: string; readonly hostId: string; readonly signal?: AbortSignal }): Promise<void>;
}

export async function revokeRemoteHost(input: { readonly targetId: string; readonly registry: TargetRegistry; readonly vault: CredentialVault; readonly connector: RemoteRevokeConnector; readonly signal?: AbortSignal }): Promise<void> {
  const targetId = validateTargetId(input.targetId);
  const record = await input.registry.get(targetId);
  if (!record) return;
  try { await input.connector.revoke({ targetId, hostId: record.hostId, ...(input.signal === undefined ? {} : { signal: input.signal }) }); } catch { throw new PairingTransactionError(); }
  try { await input.vault.delete(record.credentialRef); await input.registry.delete(targetId); } catch { throw new PairingTransactionError(); }
}

export async function forgetRemoteHost(input: { readonly targetId: string; readonly registry: TargetRegistry; readonly vault: CredentialVault }): Promise<void> {
  const targetId = validateTargetId(input.targetId);
  const record = await input.registry.get(targetId);
  if (!record) return;
  await input.vault.delete(record.credentialRef);
  await input.registry.delete(targetId);
}

export interface EndpointProbeResult {
  readonly ok: boolean;
  readonly protocolVersion: number;
  readonly hostId: string;
  readonly host?: string;
}
export interface EndpointProbe {
  probe(endpoint: RemoteEndpoint, signal: AbortSignal): Promise<EndpointProbeResult>;
}
async function boundedProbe(probe: EndpointProbe, endpoint: RemoteEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<EndpointProbeResult | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
  });
  const parentAbort = signal ? new Promise<null>((resolve) => {
    abort = () => { controller.abort(); resolve(null); };
    signal.addEventListener("abort", abort, { once: true });
  }) : null;
  try {
    const attempt = probe.probe(endpoint, controller.signal).catch(() => null);
    return await Promise.race(parentAbort ? [attempt, timeout, parentAbort] : [attempt, timeout]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
export async function selectRemoteEndpoint(input: { readonly record: PairedHostRecord; readonly probe: EndpointProbe; readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<{ readonly endpoint: RemoteEndpoint; readonly probe: EndpointProbeResult }> {
  for (const storedEndpoint of [...input.record.endpoints].sort((left, right) => Number(right.transport === "direct") - Number(left.transport === "direct") || left.url.localeCompare(right.url))) {
    let endpoint: RemoteEndpoint;
    try { endpoint = validateRemoteEndpoint(storedEndpoint, input.record.pinnedEndpointHosts); } catch { continue; }
    const result = await boundedProbe(input.probe, endpoint, input.timeoutMs ?? 2_500, input.signal);
    if (!result || !result.ok || !Number.isInteger(result.protocolVersion) || result.protocolVersion < REMOTE_PROTOCOL_MIN || result.protocolVersion > REMOTE_PROTOCOL_MAX) continue;
    if (result.host && result.host.toLowerCase() !== endpoint.host) throw new TargetIdentityMismatchError();
    if (result.hostId !== input.record.hostId) throw new TargetIdentityMismatchError();
    return { endpoint, probe: result };
  }
  throw new TargetEndpointError();
}
export interface RemoteConnectionPlan {
  readonly targetId: string;
  readonly endpoint: RemoteEndpoint;
  readonly authorization: { readonly header: "Authorization"; readonly value: string };
  readonly transport: "direct" | "serve";
}

export async function createRemoteConnectionPlan(input: { readonly targetId: string; readonly registry: TargetRegistry; readonly vault: CredentialVault; readonly probe: EndpointProbe; readonly timeoutMs?: number; readonly requiredCapabilities?: readonly string[]; readonly now?: number; readonly signal?: AbortSignal }): Promise<RemoteConnectionPlan> {
  const targetId = validateTargetId(input.targetId);
  const record = await input.registry.get(targetId);
  if (!record || record.version !== PAIRED_HOST_RECORD_VERSION) throw new TargetNotPairedError();
  if (!hasRequiredCapabilities(record.capabilities, input.requiredCapabilities ?? ["sessions.read"])) throw new TargetCapabilityError();
  const stored = credentialToken(await input.vault.get(record.credentialRef));
  const now = input.now ?? Date.now();
  if (stored.expiresAt <= now) throw new TargetCredentialError();
  const selected = await selectRemoteEndpoint({ record, probe: input.probe, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
  return { targetId, endpoint: selected.endpoint, authorization: { header: "Authorization", value: `Bearer ${stored.token}` }, transport: selected.endpoint.transport };
}

export function sanitizeConnectionPlan(plan: RemoteConnectionPlan): { readonly targetId: string; readonly transport: "direct" | "serve"; readonly state: "ready" } {
  return { targetId: plan.targetId, transport: plan.transport, state: "ready" };
}
export type PairedHost = PairedHostRecord;
export type SanitizedTargetRecord = SanitizedPairedHostView;
export type PairedHostRegistry = TargetRegistry;
export type CredentialStore = CredentialVault;
export type PairingConnector = PrivilegedPairingConnector;
export const validateEndpoint = validateRemoteEndpoint;
export const sanitizeRecord = sanitizePairedHostRecord;
export const pairHost = pairRemoteHost;
export const revokeHost = revokeRemoteHost;
export const selectEndpoint = selectRemoteEndpoint;
export const createConnectionPlan = createRemoteConnectionPlan;
export const sanitizePlan = sanitizeConnectionPlan;
