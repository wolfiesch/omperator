#!/usr/bin/env bun
import type { ByteSink, ByteSource } from "./index.js";
import {
  OmperatorctlError,
  loadConfiguredConnector,
  parseProviderCommand,
  runOmperatorctl,
} from "./index.js";

const argv = process.argv.slice(2);
const cancellation = new AbortController();
const onSignal = () => cancellation.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

const stdin: ByteSource = {
  [Symbol.asyncIterator]() {
    return process.stdin[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  },
  cancel(reason) {
    process.stdin.destroy(reason instanceof Error ? reason : undefined);
  },
};

const stdout: ByteSink = {
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  },
  end() {
    return new Promise<void>((resolve) => process.stdout.end(resolve));
  },
  abort(reason) {
    process.stdout.destroy(reason instanceof Error ? reason : undefined);
  },
};

try {
  // Validate the complete direct-command shape before importing connector code.
  parseProviderCommand(argv);
  const connector = await loadConfiguredConnector(process.env);
  await runOmperatorctl({ argv, stdin, stdout, connector, signal: cancellation.signal });
} catch (error) {
  const cliError = error instanceof OmperatorctlError ? error : new OmperatorctlError("TRANSPORT_FAILURE");
  process.stderr.write(`${cliError.code}: ${cliError.message}\n`);
  process.exitCode = cliError.exitCode;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
