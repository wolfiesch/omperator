export type ProviderCommandMode = "control" | "stream";

export interface ProviderCommand {
  readonly endpoint: string;
  readonly profile: string;
  readonly mode: ProviderCommandMode;
}

export interface ByteSource extends AsyncIterable<Uint8Array> {
  cancel(reason?: unknown): void | Promise<void>;
}

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(reason?: unknown): void | Promise<void>;
}

export interface ProviderByteStream {
  readonly readable: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  close(reason?: unknown): Promise<void>;
}

export interface ProviderConnector {
  connect(command: ProviderCommand, signal: AbortSignal): Promise<ProviderByteStream>;
}

export type OmperatorctlErrorCode =
  | "INVALID_COMMAND"
  | "CONNECTOR_NOT_CONFIGURED"
  | "CONNECT_UNAVAILABLE"
  | "TRANSPORT_FAILURE"
  | "ABORTED";

const EXIT_CODES: Readonly<Record<OmperatorctlErrorCode, number>> = {
  INVALID_COMMAND: 64,
  CONNECTOR_NOT_CONFIGURED: 78,
  CONNECT_UNAVAILABLE: 69,
  TRANSPORT_FAILURE: 74,
  ABORTED: 130,
};

const ERROR_MESSAGES: Readonly<Record<OmperatorctlErrorCode, string>> = {
  INVALID_COMMAND: "invalid provider command",
  CONNECTOR_NOT_CONFIGURED: "provider connector is not configured",
  CONNECT_UNAVAILABLE: "provider connection is unavailable",
  TRANSPORT_FAILURE: "provider transport failed",
  ABORTED: "provider command was cancelled",
};

export class OmperatorctlError extends Error {
  readonly code: OmperatorctlErrorCode;
  readonly exitCode: number;

  constructor(code: OmperatorctlErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OmperatorctlError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

function invalidCommand(): never {
  throw new OmperatorctlError("INVALID_COMMAND");
}

export function parseProviderCommand(argv: readonly string[]): ProviderCommand {
  if (
    argv.length !== 6 ||
    argv[0] !== "provider" ||
    argv[1] !== "--endpoint" ||
    argv[3] !== "--profile" ||
    (argv[5] !== "control" && argv[5] !== "stream")
  ) {
    invalidCommand();
  }
  const endpoint = argv[2]!;
  const profile = argv[4]!;
  if (endpoint.length === 0 || profile.length === 0 || endpoint.includes("\0") || profile.includes("\0")) {
    invalidCommand();
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    invalidCommand();
  }
  if (
    parsedEndpoint.protocol !== "https:" ||
    parsedEndpoint.username !== "" ||
    parsedEndpoint.password !== "" ||
    parsedEndpoint.hash !== ""
  ) {
    invalidCommand();
  }

  return { endpoint, profile, mode: argv[5] };
}

export interface RunOmperatorctlOptions {
  readonly argv: readonly string[];
  readonly stdin: ByteSource;
  readonly stdout: ByteSink;
  readonly connector: ProviderConnector;
  readonly signal?: AbortSignal;
}

export interface RunOmperatorctlResult {
  readonly mode: ProviderCommandMode;
}

function abortedError(): OmperatorctlError {
  return new OmperatorctlError("ABORTED");
}

async function settleCleanup(actions: readonly (() => void | Promise<void>)[]): Promise<void> {
  await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
}

async function connect(
  connector: ProviderConnector,
  command: ProviderCommand,
  signal: AbortSignal,
): Promise<ProviderByteStream> {
  if (signal.aborted) throw abortedError();

  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  const pending = connector.connect(command, signal);

  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void pending
        .then(
          (stream) => settleCleanup([() => stream.close(signal.reason)]),
          () => undefined,
        )
        .catch(() => {});
      throw abortedError();
    }
    if (error instanceof OmperatorctlError) throw error;
    throw new OmperatorctlError("CONNECT_UNAVAILABLE");
  } finally {
    removeAbort();
  }
}

export async function runOmperatorctl(options: RunOmperatorctlOptions): Promise<RunOmperatorctlResult> {
  const command = parseProviderCommand(options.argv);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();

  let transport: ProviderByteStream | undefined;
  let cancellationCleanup: Promise<void> | undefined;
  const cancellation = Promise.withResolvers<"aborted">();
  let abortTransport = () => {};
  try {
    transport = await connect(options.connector, command, controller.signal);
    const activeTransport = transport;
    const beginCleanup = () => {
      cancellationCleanup ??= settleCleanup([
        () => activeTransport.close(controller.signal.reason),
        () => options.stdin.cancel(controller.signal.reason),
        () => options.stdout.abort(controller.signal.reason),
      ]);
      return cancellationCleanup;
    };
    abortTransport = () => {
      void beginCleanup();
      cancellation.resolve("aborted");
    };
    controller.signal.addEventListener("abort", abortTransport, { once: true });
    if (controller.signal.aborted) {
      abortTransport();
      await cancellationCleanup;
      throw abortedError();
    }

    const clientToProvider = (async () => {
      for await (const chunk of options.stdin) await activeTransport.write(chunk);
      await activeTransport.end();
    })();
    const providerToClient = (async () => {
      for await (const chunk of activeTransport.readable) await options.stdout.write(chunk);
      await options.stdout.end();
    })();
    const pumps = [clientToProvider, providerToClient] as const;
    const pumpCompletion = Promise.all(pumps);

    let outcome: "complete" | "aborted";
    try {
      outcome = await Promise.race([
        pumpCompletion.then(() => "complete" as const),
        cancellation.promise,
      ]);
    } catch {
      await beginCleanup();
      void Promise.allSettled(pumps);
      if (controller.signal.aborted) throw abortedError();
      throw new OmperatorctlError("TRANSPORT_FAILURE");
    }

    if (outcome === "aborted" || controller.signal.aborted) {
      await beginCleanup();
      void Promise.allSettled(pumps);
      throw abortedError();
    }
    return { mode: command.mode };
  } finally {
    if (controller.signal.aborted && !transport) {
      await settleCleanup([
        () => options.stdin.cancel(controller.signal.reason),
        () => options.stdout.abort(controller.signal.reason),
      ]);
    }
    controller.signal.removeEventListener("abort", abortTransport);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export const CONNECTOR_MODULE_ENV = "OMPERATORCTL_CONNECTOR_MODULE";

export interface OmperatorctlConnectorModule {
  createOmperatorctlConnector(): ProviderConnector | Promise<ProviderConnector>;
}

export async function loadConfiguredConnector(
  environment: Readonly<Record<string, string | undefined>>,
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<ProviderConnector> {
  const specifier = environment[CONNECTOR_MODULE_ENV];
  if (!specifier) throw new OmperatorctlError("CONNECTOR_NOT_CONFIGURED");

  try {
    const loaded = (await importer(specifier)) as Partial<OmperatorctlConnectorModule>;
    if (typeof loaded.createOmperatorctlConnector !== "function") {
      throw new OmperatorctlError("CONNECTOR_NOT_CONFIGURED");
    }
    const connector = await loaded.createOmperatorctlConnector();
    if (!connector || typeof connector.connect !== "function") {
      throw new OmperatorctlError("CONNECTOR_NOT_CONFIGURED");
    }
    return connector;
  } catch (error) {
    if (error instanceof OmperatorctlError) throw error;
    throw new OmperatorctlError("CONNECTOR_NOT_CONFIGURED");
  }
}
