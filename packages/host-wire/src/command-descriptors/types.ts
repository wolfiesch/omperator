import type { DeviceCapability } from "../capabilities.js";

export type RevisionOwner = "none" | "session" | "authority";

export interface CommandDescriptor {
  capability: DeviceCapability;
  scope: "host" | "session";
  revision: "none" | "optional" | "required";
  revisionOwner: RevisionOwner;
  confirmation: "none" | "challenge";
  desktopCatalog?: true;
}

export type CommandDescriptorGroup = Readonly<Record<string, CommandDescriptor>>;

export function descriptor(
  capability: DeviceCapability,
  scope: CommandDescriptor["scope"],
  revision: CommandDescriptor["revision"],
  revisionOwner: RevisionOwner,
  confirmation: CommandDescriptor["confirmation"],
  desktopCatalog = false,
): CommandDescriptor {
  return {
    capability,
    scope,
    revision,
    revisionOwner,
    confirmation,
    ...(desktopCatalog ? { desktopCatalog: true as const } : {}),
  };
}

export function mergeCommandDescriptorGroups(
  groups: readonly CommandDescriptorGroup[],
): Readonly<Record<string, CommandDescriptor>> {
  const merged: Record<string, CommandDescriptor> = {};
  for (const group of groups) {
    for (const [command, value] of Object.entries(group)) {
      if (Object.hasOwn(merged, command))
        throw new Error(`duplicate command descriptor: ${command}`);
      merged[command] = value;
    }
  }
  return Object.freeze(merged);
}
