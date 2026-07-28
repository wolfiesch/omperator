import type { CommandFrame, HostId, ResultFrame } from "@t4-code/host-wire";

export function appserverResponse(
  hostId: HostId,
  command: CommandFrame,
  ok: boolean,
  result?: unknown,
  error?: { code: string; message: string; details?: Record<string, unknown> },
): ResultFrame {
  return {
    v: "omp-app/1",
    type: "response",
    requestId: command.requestId,
    commandId: command.commandId,
    command: command.command,
    hostId,
    sessionId: command.sessionId,
    ok,
    ...(ok ? { result } : { error }),
  } as ResultFrame;
}
