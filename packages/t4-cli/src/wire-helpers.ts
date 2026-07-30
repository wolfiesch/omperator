import type { Cursor, ServerFrame } from "@t4-code/protocol";

export interface SavedCursor {
  readonly hostId: string;
  readonly sessionId: string;
  readonly cursor: Cursor;
}

export function savedCursorFromFrame(frame: ServerFrame): SavedCursor | undefined {
  const cursor = "cursor" in frame ? (frame.cursor as Partial<Cursor> | undefined) : undefined;
  if (
    "sessionId" in frame &&
    cursor !== undefined &&
    typeof cursor.epoch === "string" &&
    typeof cursor.seq === "number" &&
    typeof frame.sessionId === "string" &&
    "hostId" in frame &&
    typeof frame.hostId === "string"
  )
    return { hostId: frame.hostId, sessionId: frame.sessionId, cursor: cursor as Cursor };
  return undefined;
}

export function sessionCreateArgs(projectId: string): { readonly projectId: string } {
  if (projectId.length === 0) throw new Error("projectId is required");
  return { projectId };
}

export function serverRelativeFilePath(entry: { readonly path: string }): string {
  return entry.path;
}

export function negotiatedFeature(
  local: boolean,
  granted: ReadonlySet<string>,
  feature: string,
): boolean {
  return local || granted.has(feature);
}
