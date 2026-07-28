import {
  type CommandFrame,
  decodeCursor,
  decodeSessionPromptArguments,
  utf8ByteLength,
} from "@t4-code/host-wire";

export const ARCHIVED_SESSION_COMMANDS = new Set([
  "session.attach",
  "session.archive",
  "session.restore",
  "session.delete",
  "session.image.read",
  "artifact.read",
  "files.read",
  "files.list",
  "files.diff",
  "review.read",
  "transcript.context",
  "transcript.page",
]);

export const SESSION_LIFECYCLE_COMMANDS = new Set([
  "session.close",
  "session.release",
  "session.reclaim",
  "session.archive",
  "session.restore",
  "session.delete",
]);

export const IMAGE_UPLOAD_COMMANDS = new Set([
  "session.image.begin",
  "session.image.chunk",
  "session.image.discard",
]);

export const DIRECT_SESSION_RPC_COMMANDS: ReadonlySet<string> = new Set([
  "session.retry",
  "session.pause",
  "session.resume",
  "session.compact",
  "session.rename",
  "session.model.set",
  "session.thinking.set",
  "session.fast.set",
]);

export const SESSION_CANCEL_COMMAND = "session.cancel";
export const AGENT_CANCEL_COMMAND = "agent.cancel";

export const OBSERVER_READ_COMMANDS = new Set([
  "session.attach",
  // Reads the source transcript and writes a different file, so an observed or
  // unverified session may still be forked while its writer keeps ownership.
  "session.fork",
  "session.image.read",
  "artifact.read",
  "files.read",
  "files.list",
  "files.diff",
  "review.read",
  "preview.state",
  "preview.capture",
  "preview.capture.read",
  "preview.policy.check",
  "transcript.context",
  "transcript.page",
]);

export function commandArgumentError(command: CommandFrame): string | undefined {
  const args = command.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object";
  const keys = Object.keys(args);
  if (command.command === "session.prompt") {
    try {
      decodeSessionPromptArguments(args);
      return undefined;
    } catch {
      return "prompt arguments are invalid";
    }
  }
  if (command.command === "session.attach") {
    if (keys.length === 0) return undefined;
    if (keys.length === 1 && keys[0] === "cursor") {
      try {
        decodeCursor(args.cursor);
        return undefined;
      } catch {
        return "attach cursor is invalid";
      }
    }
    return "attach accepts only an optional cursor";
  }
  // A copy may need a working directory of its own when the source's recorded
  // project directory no longer exists.
  if (command.command === "session.fork") {
    if (keys.some((key) => key !== "cwd")) return "fork arguments are invalid";
    if (args.cwd !== undefined) {
      if (typeof args.cwd !== "string" || args.cwd.length === 0 || utf8ByteLength(args.cwd) > 4096)
        return "fork cwd must be a bounded non-empty UTF-8 string";
      // eslint-disable-next-line no-control-regex -- reject control characters in a filesystem path.
      if (/[\u0000-\u001F\u007F]/.test(args.cwd))
        return "fork cwd must not contain control characters";
    }
  }
  if (command.command === "session.create") {
    if (
      keys.some((key) => !["projectId", "title", "runtimeId", "workspaceInstanceId"].includes(key))
    )
      return "create arguments are invalid";
    if (
      typeof args.projectId !== "string" ||
      args.projectId.length === 0 ||
      utf8ByteLength(args.projectId) > 256
    )
      return "create projectId must be a bounded non-empty UTF-8 string";
    if (
      args.title !== undefined &&
      (typeof args.title !== "string" ||
        args.title.length === 0 ||
        utf8ByteLength(args.title) > 512)
    )
      return "create title must be a bounded non-empty UTF-8 string";
    for (const [key, limit] of [
      ["runtimeId", 64],
      ["workspaceInstanceId", 128],
    ] as const)
      if (
        args[key] !== undefined &&
        (typeof args[key] !== "string" ||
          args[key].length === 0 ||
          utf8ByteLength(args[key]) > limit)
      )
        return `create ${key} must be a bounded non-empty UTF-8 string`;
    if ((args.runtimeId === undefined) !== (args.workspaceInstanceId === undefined))
      return "create runtimeId and workspaceInstanceId must be provided together";
    return undefined;
  }
  // Operation argument shapes are validated by decodeCommand and the typed
  // authority. Host/session list remain explicitly empty for compatibility
  // with their legacy broad argument decoders.
  if (command.command !== "host.list" && command.command !== "session.list") return undefined;
  if (keys.length !== 0) return "command does not accept args";
  return undefined;
}
