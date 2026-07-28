import { CI_COMMAND_DESCRIPTORS } from "./ci.js";
import { OPERATION_COMMAND_DESCRIPTORS } from "./operations.js";
import { PREVIEW_COMMAND_DESCRIPTORS } from "./preview.js";
import { PROMPT_MEDIA_COMMAND_DESCRIPTORS } from "./prompt-media.js";
import { RUNTIME_WORKSPACE_COMMAND_DESCRIPTORS } from "./runtime-workspace.js";
import { SESSION_COMMAND_DESCRIPTORS } from "./sessions.js";
import { mergeCommandDescriptorGroups } from "./types.js";

export type { CommandDescriptor, RevisionOwner } from "./types.js";

export const COMMAND_DESCRIPTORS = mergeCommandDescriptorGroups([
  RUNTIME_WORKSPACE_COMMAND_DESCRIPTORS,
  SESSION_COMMAND_DESCRIPTORS,
  PROMPT_MEDIA_COMMAND_DESCRIPTORS,
  OPERATION_COMMAND_DESCRIPTORS,
  PREVIEW_COMMAND_DESCRIPTORS,
  CI_COMMAND_DESCRIPTORS,
]);
