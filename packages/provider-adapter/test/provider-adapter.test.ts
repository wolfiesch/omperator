import { expect, test } from "bun:test";
import type {
  ByteSink,
  ByteSource,
  ProviderByteStream,
  ProviderCommand,
  ProviderConnector,
} from "../src/index.js";
import {
  OmperatorctlError,
  loadConfiguredConnector,
  parseProviderCommand,
  runOmperatorctl,
} from "../src/index.js";

class AsyncBytes implements ByteSource {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  readonly readStarted = Promise.withResolvers<void>();
  #done = false;
  cancelled = false;

  push(value: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  finish(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  cancel(): void {
    this.cancelled = true;
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        this.readStarted.resolve();
        const value = this.#values.shift();
        if (value) return { done: false, value };
        if (this.#done) return { done: true, value: undefined };
        const deferred = Promise.withResolvers<IteratorResult<Uint8Array>>();
        this.#waiters.push(deferred.resolve);
        return deferred.promise;
      },
    };
  }
}

class MemorySink implements ByteSink {
  readonly writes: Uint8Array[] = [];
  readonly endedSignal = Promise.withResolvers<void>();
  ended = false;
  aborted = false;

  async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk);
  }

  async end(): Promise<void> {
    this.ended = true;
    this.endedSignal.resolve();
  }

  abort(): void {
    this.aborted = true;
  }
}

class MemoryTransport implements ProviderByteStream {
  readonly source = new AsyncBytes();
  readonly writes: Uint8Array[] = [];
  readonly endedSignal = Promise.withResolvers<void>();
  ended = false;
  closed = false;

  get readable(): AsyncIterable<Uint8Array> {
    return this.source;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk);
  }

  async end(): Promise<void> {
    this.ended = true;
    this.endedSignal.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.source.finish();
  }
}

const argv = (mode: "control" | "stream") => [
  "provider",
  "--endpoint",
  "https://gateway.example/provider?tenant=alpha",
  "--profile",
  "work-profile",
  mode,
] as const;

function connectedWith(transport: MemoryTransport): ProviderConnector & { calls: ProviderCommand[] } {
  const calls: ProviderCommand[] = [];
  return {
    calls,
    async connect(command) {
      calls.push(command);
      return transport;
    },
  };
}

async function expectCliRejection(
  promise: Promise<unknown>,
  code: OmperatorctlError["code"],
  exitCode: number,
): Promise<OmperatorctlError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OmperatorctlError);
  expect((caught as OmperatorctlError).code).toBe(code);
  expect((caught as OmperatorctlError).exitCode).toBe(exitCode);
  return caught as OmperatorctlError;
}

test("parser accepts only the exact endpoint/profile role shape appended by cmux", () => {
  expect(parseProviderCommand(argv("control"))).toEqual({
    endpoint: "https://gateway.example/provider?tenant=alpha",
    profile: "work-profile",
    mode: "control",
  });
  expect(parseProviderCommand(argv("stream"))).toEqual({
    endpoint: "https://gateway.example/provider?tenant=alpha",
    profile: "work-profile",
    mode: "stream",
  });

  const invalid = [
    [],
    ["provider", "--endpoint", "https://gateway.example", "--profile", "p"],
    ["provider", "--profile", "p", "--endpoint", "https://gateway.example", "control"],
    ["provider", "--endpoint", "https://gateway.example", "--endpoint", "https://other.example", "control"],
    ["provider", "--endpoint", "https://gateway.example", "--profile", "p", "--", "control"],
    ["provider", "--endpoint", "https://gateway.example", "--profile", "p", "unknown"],
    ["provider", "--endpoint", "http://gateway.example", "--profile", "p", "control"],
    ["provider", "--endpoint", "https://user:secret@gateway.example", "--profile", "p", "control"],
    ["provider", "--endpoint", "https://gateway.example/#fragment", "--profile", "p", "control"],
    [...argv("control"), "extra"],
  ];
  for (const candidate of invalid) {
    expect(() => parseProviderCommand(candidate)).toThrow(OmperatorctlError);
  }
});

test("invalid argv is rejected before connector or byte-stream side effects", async () => {
  let connects = 0;
  const input = new AsyncBytes();
  const output = new MemorySink();
  await expectCliRejection(
    runOmperatorctl({
      argv: ["provider", "--endpoint", "https://gateway.example", "--profile", "p", "bad"],
      stdin: input,
      stdout: output,
      connector: { connect: async () => (connects++, new MemoryTransport()) },
    }),
    "INVALID_COMMAND",
    64,
  );
  expect(connects).toBe(0);
  expect(input.cancelled).toBe(false);
  expect(output.writes).toEqual([]);
  expect(output.ended).toBe(false);
});

for (const mode of ["control", "stream"] as const) {
  test(`${mode} relays byte-identical chunks without JSON parsing or translation`, async () => {
    const clientBytes = [
      new TextEncoder().encode('{"not":"complete"'),
      new Uint8Array([0, 255, 10, 123, 125, 10]),
    ];
    const providerBytes = [
      new TextEncoder().encode("not-json\n"),
      new Uint8Array([9, 8, 0, 7, 10]),
    ];
    const input = new AsyncBytes();
    const output = new MemorySink();
    const transport = new MemoryTransport();
    for (const chunk of clientBytes) input.push(chunk);
    input.finish();
    for (const chunk of providerBytes) transport.source.push(chunk);
    transport.source.finish();
    const connector = connectedWith(transport);

    expect(await runOmperatorctl({ argv: argv(mode), stdin: input, stdout: output, connector })).toEqual({ mode });
    expect(connector.calls).toEqual([
      {
        endpoint: "https://gateway.example/provider?tenant=alpha",
        profile: "work-profile",
        mode,
      },
    ]);
    expect(transport.writes).toEqual(clientBytes);
    expect(transport.writes[0]).toBe(clientBytes[0]);
    expect(transport.writes[1]).toBe(clientBytes[1]);
    expect(output.writes).toEqual(providerBytes);
    expect(output.writes[0]).toBe(providerBytes[0]);
    expect(output.writes[1]).toBe(providerBytes[1]);
  });
}

test("client EOF half-closes provider input and waits for provider EOF", async () => {
  const input = new AsyncBytes();
  const output = new MemorySink();
  const transport = new MemoryTransport();
  input.push(new Uint8Array([1, 2, 3]));
  input.finish();
  let settled = false;
  const running = runOmperatorctl({ argv: argv("control"), stdin: input, stdout: output, connector: connectedWith(transport) });
  void running.finally(() => {
    settled = true;
  });

  await transport.endedSignal.promise;
  expect(transport.ended).toBe(true);
  expect(settled).toBe(false);
  transport.source.push(new Uint8Array([4, 5, 6]));
  transport.source.finish();
  await running;
  expect(output.writes).toEqual([new Uint8Array([4, 5, 6])]);
});

test("provider EOF half-closes stdout and waits for client EOF", async () => {
  const input = new AsyncBytes();
  const output = new MemorySink();
  const transport = new MemoryTransport();
  transport.source.finish();
  let settled = false;
  const running = runOmperatorctl({ argv: argv("stream"), stdin: input, stdout: output, connector: connectedWith(transport) });
  void running.finally(() => {
    settled = true;
  });

  await output.endedSignal.promise;
  expect(output.ended).toBe(true);
  expect(settled).toBe(false);
  input.push(new Uint8Array([7, 8, 9]));
  input.finish();
  await running;
  expect(transport.writes).toEqual([new Uint8Array([7, 8, 9])]);
  expect(transport.ended).toBe(true);
});

test("abort closes transport and both local byte directions", async () => {
  const input = new AsyncBytes();
  const output = new MemorySink();
  const transport = new MemoryTransport();
  const controller = new AbortController();
  const running = runOmperatorctl({
    argv: argv("stream"),
    stdin: input,
    stdout: output,
    connector: connectedWith(transport),
    signal: controller.signal,
  });

  await input.readStarted.promise;
  controller.abort(new Error("sensitive cancellation detail"));
  await expectCliRejection(running, "ABORTED", 130);
  expect(transport.closed).toBe(true);
  expect(input.cancelled).toBe(true);
  expect(output.aborted).toBe(true);
});

test("abort awaits rejecting cleanup without leaking raw rejections", async () => {
  const secret = "credential-bearing cleanup failure";
  const input = new AsyncBytes();
  const output = new MemorySink();
  const transport = new MemoryTransport();
  const controller = new AbortController();
  const cleanupCalls: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  input.cancel = () => {
    cleanupCalls.push("stdin");
    input.finish();
    throw new Error(secret);
  };
  output.abort = () => {
    cleanupCalls.push("stdout");
    return Promise.reject(new Error(secret));
  };
  transport.close = async () => {
    cleanupCalls.push("transport");
    throw new Error(secret);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const running = runOmperatorctl({
      argv: argv("stream"),
      stdin: input,
      stdout: output,
      connector: connectedWith(transport),
      signal: controller.signal,
    });
    await input.readStarted.promise;
    controller.abort(new Error(secret));
    const error = await expectCliRejection(running, "ABORTED", 130);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error.message).not.toContain(secret);
    expect(cleanupCalls.sort()).toEqual(["stdin", "stdout", "transport"]);
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("abort during connect safely closes a late stream whose close rejects", async () => {
  const secret = "late connector credential failure";
  const input = new AsyncBytes();
  const output = new MemorySink();
  const transport = new MemoryTransport();
  const controller = new AbortController();
  const pending = Promise.withResolvers<ProviderByteStream>();
  const connectStarted = Promise.withResolvers<void>();
  const closeCalled = Promise.withResolvers<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  transport.close = async () => {
    closeCalled.resolve();
    throw new Error(secret);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const running = runOmperatorctl({
      argv: argv("control"),
      stdin: input,
      stdout: output,
      connector: {
        connect: () => {
          connectStarted.resolve();
          return pending.promise;
        },
      },
      signal: controller.signal,
    });
    await connectStarted.promise;
    controller.abort(new Error(secret));
    const error = await expectCliRejection(running, "ABORTED", 130);
    pending.resolve(transport);
    await closeCalled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error.message).not.toContain(secret);
    expect(input.cancelled).toBe(true);
    expect(output.aborted).toBe(true);
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("connector loading fails closed and exposes one explicit injection port", async () => {
  await expectCliRejection(loadConfiguredConnector({}), "CONNECTOR_NOT_CONFIGURED", 78);
  const connector: ProviderConnector = { connect: async () => new MemoryTransport() };
  expect(
    await loadConfiguredConnector(
      { OMPERATORCTL_CONNECTOR_MODULE: "configured-provider" },
      async (specifier) => {
        expect(specifier).toBe("configured-provider");
        return { createOmperatorctlConnector: () => connector };
      },
    ),
  ).toBe(connector);
});

test("connector failures become sanitized typed errors", async () => {
  const secret = "https://secret.example/token-value";
  const error = await expectCliRejection(
    runOmperatorctl({
      argv: argv("control"),
      stdin: new AsyncBytes(),
      stdout: new MemorySink(),
      connector: { connect: async () => Promise.reject(new Error(secret)) },
    }),
    "CONNECT_UNAVAILABLE",
    69,
  );
  expect(error.message).not.toContain(secret);
});
