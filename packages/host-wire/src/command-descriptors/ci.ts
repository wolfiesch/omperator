import { descriptor, type CommandDescriptorGroup } from "./types.js";

export const CI_COMMAND_DESCRIPTORS: CommandDescriptorGroup = {
  "ci.run": descriptor("ci.trigger", "session", "required", "session", "none"),
};
