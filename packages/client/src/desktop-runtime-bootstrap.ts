import { CLUSTER_OPERATOR_FEATURE, decodeSessionListResult } from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import { DesktopRuntimeError } from "./desktop-runtime-contracts.ts";
import type { DesktopWelcomePayload } from "./desktop-runtime-contracts.ts";

export type DesktopBootstrapCommand = (
  intent: CommandRequest["intent"],
) => CommandResult | undefined | PromiseLike<CommandResult | undefined>;
export type DesktopBootstrapErrorCode = "transport" | "protocol";
export type DesktopBootstrapErrorReporter = (error: unknown, code: DesktopBootstrapErrorCode) => void;

export interface DesktopHostBootstrapOptions {
  readonly targetId: string;
  readonly frame: DesktopWelcomePayload;
  readonly clusterOperatorEnabled?: boolean;
  readonly issue: DesktopBootstrapCommand;
  readonly onError?: DesktopBootstrapErrorReporter;
  readonly onSessionList?: (result: CommandResult) => void;
}

export async function bootstrapDesktopHost(options: DesktopHostBootstrapOptions): Promise<void> {
  const { frame, issue, onError = () => undefined } = options;
  const capability = (name: string): boolean => frame.grantedCapabilities.includes(name);
  const feature = (name: string): boolean => frame.grantedFeatures.includes(name);
  const host = frame.hostId;
  const issueSafely = async (intent: CommandRequest["intent"]): Promise<CommandResult | undefined> => {
    try {
      return await issue(intent);
    } catch (error) {
      onError(error, error instanceof DesktopRuntimeError && error.code === "protocol" ? "protocol" : "transport");
      return undefined;
    }
  };

  let sessionList: CommandResult | undefined;
  if (capability("sessions.read")) {
    sessionList = await issueSafely({ hostId: host, command: "session.list", args: {} });
    if (sessionList?.accepted === true) {
      try {
        const decoded = decodeSessionListResult(sessionList.result);
        options.onSessionList?.(sessionList);
        if (feature("host.watch")) {
          await issueSafely({ hostId: host, command: "host.watch", args: { cursor: decoded.cursor } });
        }
      } catch (error) {
        onError(error, "protocol");
      }
    }
  }
  if (
    options.clusterOperatorEnabled === true &&
    capability("sessions.read") &&
    feature(CLUSTER_OPERATOR_FEATURE)
  ) {
    await issueSafely({ hostId: host, command: "workspace.list", args: {} });
  }
  if (capability("catalog.read") && feature("catalog.metadata")) {
    await issueSafely({ hostId: host, command: "catalog.get", args: {} });
  }
  if (capability("config.read") && feature("settings.metadata")) {
    await issueSafely({ hostId: host, command: "settings.read", args: {} });
  }
}
