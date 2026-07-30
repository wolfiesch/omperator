import { Authorizer, authorizationScopeId, createAuthorizationRequestId, isAuthorized, type AuthorizationAction } from "../../cluster-server/src/authorization.ts";
import type { SshRequestIdentity } from "./identity.js";

export type SshGatewayCommand =
  | { readonly kind: "provider"; readonly mode: "control" | "stream" }
  | { readonly kind: "relay"; readonly runtimeId: string }
  | { readonly kind: "attach"; readonly runtimeId: string }
  | { readonly kind: "version" };

export const SSH_GATEWAY_VERSION = "omperator ssh-gateway/1 machine-provider-v1 cmux/10 omp-app/1\n";

export interface SshCommandRegistry {
  readonly provider?: boolean;
  readonly relay?: boolean;
  readonly attach?: boolean;
  readonly version?: boolean;
}

export interface SshCommandAuthorizationContext {
  readonly identity: SshRequestIdentity;
  readonly requestId: string;
  readonly action: AuthorizationAction;
  readonly pty: boolean;
  readonly authorizedScopeIds: readonly string[];
}

export interface SshCommandContext extends SshCommandAuthorizationContext {
  readonly scopeId: string;
}

export interface ByteSource extends AsyncIterable<Uint8Array> {
  cancel(reason?: unknown): void | Promise<void>;
}

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(reason?: unknown): void | Promise<void>;
}

export interface SshCommandChannel {
  readonly readable: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  close(reason?: unknown): void | Promise<void>;
}

export interface SshCommandHandler {
  resolve(
    command: SshGatewayCommand,
    context: SshCommandAuthorizationContext,
    signal: AbortSignal,
  ): Promise<{ readonly scopeId: string } | undefined>;
  open(command: SshGatewayCommand, context: SshCommandContext, signal: AbortSignal): Promise<SshCommandChannel>;
}

export interface ProviderRelayBackend {
  resolveProviderRequest(
    mode: "control" | "stream",
    context: SshCommandAuthorizationContext,
    signal: AbortSignal,
  ): Promise<{ readonly scopeId: string } | undefined>;
  resolveRuntime(
    runtimeId: string,
    context: SshCommandAuthorizationContext,
    signal: AbortSignal,
  ): Promise<{ readonly scopeId: string } | undefined>;
  openProvider(
    mode: "control" | "stream",
    context: SshCommandContext,
    signal: AbortSignal,
  ): Promise<SshCommandChannel>;
  openRelay?(
    runtimeId: string,
    context: SshCommandContext,
    signal: AbortSignal,
  ): Promise<SshCommandChannel>;
}

export function createProviderRelaySshCommandHandler(backend: ProviderRelayBackend): SshCommandHandler {
  return {
    async resolve(command, context, signal) {
      if (command.kind === "provider") return backend.resolveProviderRequest(command.mode, context, signal);
      if ((command.kind === "relay" || command.kind === "attach") && backend.openRelay)
        return backend.resolveRuntime(command.runtimeId, context, signal);
      return undefined;
    },
    async open(command, context, signal) {
      if (command.kind === "provider") return backend.openProvider(command.mode, context, signal);
      if ((command.kind === "relay" || command.kind === "attach") && backend.openRelay)
        return backend.openRelay(command.runtimeId, context, signal);
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    },
  };
}

export type SshGatewayErrorCode = "INVALID_COMMAND" | "IDENTITY_REQUIRED" | "HANDLER_UNAVAILABLE" | "TRANSPORT_FAILURE" | "ABORTED";

const EXIT_CODES: Readonly<Record<SshGatewayErrorCode, number>> = {
  INVALID_COMMAND: 64,
  IDENTITY_REQUIRED: 77,
  HANDLER_UNAVAILABLE: 78,
  TRANSPORT_FAILURE: 74,
  ABORTED: 130,
};

const ERROR_MESSAGES: Readonly<Record<SshGatewayErrorCode, string>> = {
  INVALID_COMMAND: "SSH command is not permitted",
  IDENTITY_REQUIRED: "authenticated SSH identity is required",
  HANDLER_UNAVAILABLE: "SSH gateway handler is unavailable",
  TRANSPORT_FAILURE: "SSH gateway transport failed",
  ABORTED: "SSH gateway command was cancelled",
};

export class SshGatewayError extends Error {
  readonly code: SshGatewayErrorCode;
  readonly exitCode: number;

  constructor(code: SshGatewayErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SshGatewayError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function invalid(): never {
  throw new SshGatewayError("INVALID_COMMAND");
}

export function parseSshCommand(originalCommand: string | undefined, pty: boolean, registry: SshCommandRegistry = {}): SshGatewayCommand {
  if (!originalCommand || originalCommand.length > 256 || originalCommand !== originalCommand.trim() || /[^\x20-\x7e]/u.test(originalCommand)) invalid();
  const fields = originalCommand.split(" ");
  if (fields.some(field => field.length === 0)) invalid();

  if (registry.provider && fields.length === 3 && fields[0] === "cmux" && fields[1] === "provider" && (fields[2] === "control" || fields[2] === "stream")) {
    if (pty) invalid();
    return { kind: "provider", mode: fields[2] };
  }
  if (registry.relay && fields.length === 4 && fields[0] === "cmux-tui" && fields[1] === "relay" && fields[2] === "--session" && RUNTIME_ID.test(fields[3]!)) {
    if (pty) invalid();
    return { kind: "relay", runtimeId: fields[3]! };
  }
  if (registry.attach && fields.length === 3 && fields[0] === "omperator" && fields[1] === "attach" && RUNTIME_ID.test(fields[2]!)) {
    if (!pty) invalid();
    return { kind: "attach", runtimeId: fields[2]! };
  }
  if (registry.version && fields.length === 2 && fields[0] === "omperator" && fields[1] === "version") {
    if (pty) invalid();
    return { kind: "version" };
  }
  invalid();
}
export function sshCommandAction(command: SshGatewayCommand): AuthorizationAction | undefined {
  if (command.kind === "provider" || command.kind === "relay") return "runtime.connect.cmux";
  if (command.kind === "attach") return "runtime.connect.omp-app";
  return undefined;
}

function validPrincipalId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() && !/\p{Cc}/u.test(value);
}

async function settle(actions: readonly (() => void | Promise<void>)[]): Promise<void> {
  await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
}

export interface RunSshCommandOptions {
  readonly originalCommand: string | undefined;
  readonly identity: SshRequestIdentity;
  readonly pty: boolean;
  readonly stdin: ByteSource;
  readonly stdout: ByteSink;
  readonly handler?: SshCommandHandler;
  readonly registry?: SshCommandRegistry;
  readonly authorizer?: Authorizer;
  readonly signal?: AbortSignal;
}

export async function runSshCommand(options: RunSshCommandOptions): Promise<SshGatewayCommand> {
  if (!validPrincipalId(options.identity.principalId)) throw new SshGatewayError("IDENTITY_REQUIRED");
  const command = parseSshCommand(options.originalCommand, options.pty, options.registry);
  if (command.kind === "version") {
    await options.stdout.write(Buffer.from(SSH_GATEWAY_VERSION));
    await options.stdout.end();
    return command;
  }
  const action = sshCommandAction(command);
  if (!action) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  const requestId = createAuthorizationRequestId();
  const authorizer = options.authorizer ?? new Authorizer();
  const handler = options.handler;
  if (!handler) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  const candidateScopeIds = options.identity.authorizedScopes.length === 0
    ? [authorizationScopeId(options.identity, "personal")]
    : [...new Set(options.identity.authorizedScopes.map(grant => authorizationScopeId(options.identity, grant.scopeId)))];
  const resourceId = "runtimeId" in command ? command.runtimeId : undefined;
  const scopeCandidates = candidateScopeIds.filter(scopeId => isAuthorized(options.identity, scopeId, action));
  if (scopeCandidates.length === 0) {
    for (const scopeId of candidateScopeIds)
      authorizer.decide({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...(resourceId ? { resourceId } : {}) });
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const authorizationContext: SshCommandAuthorizationContext = {
    identity: options.identity,
    requestId,
    action,
    pty: options.pty,
    authorizedScopeIds: Object.freeze(scopeCandidates),
  };
  const auditResourceError = (scopeId: string): void =>
    authorizer.error({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...(resourceId ? { resourceId } : {}) });
  let scopeId: string;
  let channel: SshCommandChannel | undefined;
  try {
    if (controller.signal.aborted) throw new SshGatewayError("ABORTED");
    let resolved: { readonly scopeId: string } | undefined;
    try {
      resolved = await handler.resolve(command, authorizationContext, controller.signal);
    } catch (error) {
      auditResourceError(scopeCandidates[0]!);
      if (controller.signal.aborted) throw new SshGatewayError("ABORTED");
      if (error instanceof SshGatewayError) throw error;
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    }
    scopeId = resolved ? authorizationScopeId(options.identity, resolved.scopeId) : "";
    if (!scopeCandidates.includes(scopeId)) {
      if (scopeId) {
        authorizer.decide({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...(resourceId ? { resourceId } : {}) });
      } else {
        auditResourceError(scopeCandidates[0]!);
      }
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    }
    if (!authorizer.decide({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...(resourceId ? { resourceId } : {}) }).allowed)
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    try {
      channel = await handler.open(command, { ...authorizationContext, scopeId }, controller.signal);
    } catch (error) {
      authorizer.error({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...("runtimeId" in command ? { resourceId: command.runtimeId } : {}) });
      if (controller.signal.aborted) throw new SshGatewayError("ABORTED");
      if (error instanceof SshGatewayError) throw error;
      throw new SshGatewayError("TRANSPORT_FAILURE");
    }
    const active = channel;
    let closePromise: Promise<void> | undefined;
    const closeActive = (reason?: unknown): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => active.close(reason));
      return closePromise;
    };
    const cancelled = Promise.withResolvers<never>();
    const cancel = () => cancelled.reject(new SshGatewayError("ABORTED"));
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (controller.signal.aborted) cancel();
    const clientToGateway = (async () => {
      for await (const chunk of options.stdin) await active.write(chunk);
      await active.end();
    })();
    const gatewayToClient = (async () => {
      for await (const chunk of active.readable) await options.stdout.write(chunk);
      await options.stdout.end();
    })();
    try {
      await Promise.race([Promise.all([clientToGateway, gatewayToClient]), cancelled.promise]);
      await closeActive();
    } catch (error) {
      authorizer.error({ identity: options.identity, scopeId, action, gateway: "ssh", requestId, ...("runtimeId" in command ? { resourceId: command.runtimeId } : {}) });
      await settle([
        () => closeActive(error),
        () => options.stdin.cancel(error),
        () => options.stdout.abort(error),
      ]);
      void Promise.allSettled([clientToGateway, gatewayToClient]);
      if (controller.signal.aborted) throw new SshGatewayError("ABORTED");
      if (error instanceof SshGatewayError) throw error;
      throw new SshGatewayError("TRANSPORT_FAILURE");
    } finally {
      controller.signal.removeEventListener("abort", cancel);
    }
    return command;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export const HANDLER_MODULE_ENV = "T4_SSH_GATEWAY_HANDLER_MODULE";

export interface SshGatewayHandlerModule {
  createSshCommandHandler(): SshCommandHandler | Promise<SshCommandHandler>;
}

function validHandlerModuleSpecifier(value: string): boolean {
  if (value.length < 1 || value.length > 512 || value !== value.trim() || /[\s\p{Cc}\\]/u.test(value)) return false;
  if (value.startsWith("/")) return !value.split("/").some(segment => segment === "." || segment === "..");
  if (value.startsWith("file:///")) {
    try {
      if (value.slice("file://".length).split("/").some(segment => {
        let decoded: string;
        try { decoded = decodeURIComponent(segment); } catch { return true; }
        return decoded === "." || decoded === "..";
      })) return false;
      const url = new URL(value);
      return url.protocol === "file:" && !url.hostname && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }
  return /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(value);
}

export async function loadSshCommandHandler(
  environment: Readonly<Record<string, string | undefined>>,
  importer: (specifier: string) => Promise<unknown> = specifier => import(specifier),
): Promise<SshCommandHandler> {
  const specifier = environment[HANDLER_MODULE_ENV];
  if (!specifier || !validHandlerModuleSpecifier(specifier)) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  try {
    const loaded = await importer(specifier) as Partial<SshGatewayHandlerModule>;
    if (typeof loaded.createSshCommandHandler !== "function") throw new SshGatewayError("HANDLER_UNAVAILABLE");
    const handler = await loaded.createSshCommandHandler();
    if (!handler || typeof handler.resolve !== "function" || typeof handler.open !== "function") throw new SshGatewayError("HANDLER_UNAVAILABLE");
    return handler;
  } catch (error) {
    if (error instanceof SshGatewayError) throw error;
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  }
}

export { authenticatedSshIdentity, authenticatedSshPrincipal, type SshAuthorizedIdentityScope, type SshRequestIdentity } from "./identity.js";
