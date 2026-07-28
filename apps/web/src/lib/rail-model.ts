export type RailOrganization = "by-project" | "flat";
export type RailSort = "priority" | "updated" | "manual";
export type RailFilter = "all" | "attention" | "running" | "unread" | "errors";

/**
 * A session is unread when its latest turn completed after the last visit.
 * Never-visited sessions have no baseline and are therefore not unread.
 */
export function isSessionUnread(
  lastVisitedAt: string | undefined,
  latestTurnCompletedAt: string | null,
): boolean {
  if (latestTurnCompletedAt === null) return false;
  const completedMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedMs)) return false;
  if (lastVisitedAt === undefined) return false;
  const visitedMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedMs)) return true;
  return completedMs > visitedMs;
}
