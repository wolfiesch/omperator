import type { CatalogItem } from "@t4-code/protocol";

import type { PendingControl } from "./session-controls.ts";

export const UNKNOWN_PROMPT_REASON =
  "The connection dropped before the host answered. Your draft is safe. Check the transcript before resending so you do not send it twice.";

export const CONTROL_REJECTED: Record<PendingControl, string> = {
  model: "The host declined the model change. The session keeps its current model.",
  thinking: "The host declined the thinking change. The session keeps its current level.",
  fast: "The host declined the fast-mode change.",
  mode: "The host declined the mode change. The session keeps its current mode.",
};

export const CONTROL_UNKNOWN =
  "The connection dropped before the host answered. The control shows the host's last confirmed value.";

export function findCancelCommand(items: readonly CatalogItem[]): CatalogItem | undefined {
  return items.find(
    (item) =>
      item.kind === "command" &&
      (String(item.id) === "session.cancel" ||
        item.name === "session.cancel" ||
        item.name === "cancel"),
  );
}
