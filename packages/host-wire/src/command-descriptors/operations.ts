import { descriptor, type CommandDescriptorGroup } from "./types.js";

export const OPERATION_COMMAND_DESCRIPTORS: CommandDescriptorGroup = {
  "files.read": descriptor("files.read", "session", "optional", "authority", "none"),
  "files.write": descriptor("files.write", "session", "required", "authority", "challenge"),
  "files.patch": descriptor("files.write", "session", "required", "authority", "challenge"),
  "files.list": descriptor("files.list", "session", "optional", "authority", "none"),
  "files.search": descriptor("files.list", "session", "optional", "authority", "none"),
  "files.diff": descriptor("files.diff", "session", "optional", "authority", "none"),
  "review.read": descriptor("files.read", "session", "optional", "authority", "none"),
  "review.apply": descriptor("files.write", "session", "required", "authority", "challenge"),
  "agent.cancel": descriptor("agents.control", "session", "optional", "session", "challenge"),
  "bash.run": descriptor("bash.run", "session", "optional", "session", "challenge"),
  "term.open": descriptor("term.open", "session", "optional", "session", "challenge"),
};
