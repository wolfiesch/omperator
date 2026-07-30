import { descriptor, type CommandDescriptorGroup } from "./types.js";

export const PROMPT_MEDIA_COMMAND_DESCRIPTORS: CommandDescriptorGroup = {
  "session.prompt": descriptor("sessions.prompt", "session", "optional", "session", "none"),
  "session.steer": descriptor("sessions.prompt", "session", "optional", "session", "none"),
  "session.followUp": descriptor("sessions.prompt", "session", "optional", "session", "none"),
  "session.ui.respond": descriptor("sessions.prompt", "session", "optional", "session", "none"),
  "session.image.begin": descriptor("sessions.prompt", "session", "none", "none", "none"),
  "session.image.chunk": descriptor("sessions.prompt", "session", "none", "none", "none"),
  "session.image.discard": descriptor("sessions.prompt", "session", "none", "none", "none"),
  "session.image.read": descriptor("sessions.read", "session", "none", "none", "none"),
  "artifact.read": descriptor("sessions.read", "session", "none", "none", "none"),
};
