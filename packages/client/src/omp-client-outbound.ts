import type { OmpClientMessage, OmpProtocolProvider } from "./omp-protocol-provider.ts";

export function encodeOutgoingMessage(
  provider: OmpProtocolProvider,
  message: OmpClientMessage,
): string | undefined {
  try {
    return provider.encodeClientMessage(message);
  } catch {
    return undefined;
  }
}
