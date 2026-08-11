#!/usr/bin/env bun
import { Authorizer } from "../../cluster-server/src/authorization.ts";
import type { ByteSink, ByteSource } from "./index.js";
import { loadSshCommandHandler, parseSshCommand, runSshCommand, SshGatewayError } from "./index.js";
import { authenticatedSshIdentity } from "./identity.js";


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
    return new Promise<void>((resolve, reject) => process.stdout.write(chunk, error => error ? reject(error) : resolve()));
  },
  end() {
    return new Promise<void>(resolve => process.stdout.end(resolve));
  },
  abort(reason) {
    process.stdout.destroy(reason instanceof Error ? reason : undefined);
  },
};

try {
  const originalCommand = process.env.SSH_ORIGINAL_COMMAND;
  const pty = process.env.SSH_TTY !== undefined;
  const registry = {
    provider: process.env.T4_SSH_GATEWAY_ENABLE_PROVIDER === "1",
    relay: process.env.T4_SSH_GATEWAY_ENABLE_RELAY === "1",
    attach: process.env.T4_SSH_GATEWAY_ENABLE_ATTACH === "1",
    version: process.env.T4_SSH_GATEWAY_ENABLE_VERSION === "1",
  };
  const command = parseSshCommand(originalCommand, pty, registry);
  const identity = await authenticatedSshIdentity(process.env.SSH_USER_AUTH);
  const authorizer = new Authorizer(event => { process.stderr.write(`${JSON.stringify(event)}\n`); });
  const handler = command.kind === "version" ? undefined : await loadSshCommandHandler(process.env);
  await runSshCommand({
    originalCommand,
    identity,
    pty,
    stdin,
    stdout,
    ...(handler ? { handler } : {}),
    authorizer,
    registry,
    signal: cancellation.signal,
  });
} catch (error) {
  const failure = error instanceof SshGatewayError ? error : new SshGatewayError("TRANSPORT_FAILURE");
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.exitCode = failure.exitCode;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
