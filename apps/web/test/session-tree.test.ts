import { afterEach, describe, expect, it } from "vite-plus/test";

import { SHELL_FIXTURE } from "../src/fixture/data.ts";
import {
  buildProjectGroups,
  flattenProjectGroups,
  formatRelativeTime,
  listVisibleSessionIds,
  moveIdInManualOrder,
  moveIdToManualIndex,
  sessionPriority,
} from "../src/lib/session-tree.ts";

const realToLocaleLowerCase = String.prototype.toLocaleLowerCase;

afterEach(() => {
  String.prototype.toLocaleLowerCase = realToLocaleLowerCase;
});

describe("fixture invariants", () => {
  it("has unique session ids and resolvable projects/hosts", () => {
    const ids = SHELL_FIXTURE.sessions.map((session) => session.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const session of SHELL_FIXTURE.sessions) {
      const project = SHELL_FIXTURE.projects.find((entry) => entry.id === session.projectId);
      expect(project, session.id).toBeDefined();
      expect(SHELL_FIXTURE.hosts.some((host) => host.id === project?.hostId)).toBe(true);
    }
  });

  it("covers the full visible state contract: working, approval, input, plan, done, error, offline, cached", () => {
    const statuses = new Set(
      SHELL_FIXTURE.sessions.map((session) => session.status).filter((s) => s !== null),
    );
    for (const required of [
      "working",
      "pendingApproval",
      "awaitingInput",
      "planReady",
      "completed",
      "error",
    ]) {
      expect([...statuses], required).toContain(required);
    }
    const freshness = new Set(SHELL_FIXTURE.sessions.map((session) => session.freshness));
    expect([...freshness]).toContain("cached");
    expect([...freshness]).toContain("offline");
  });

  it("seeds exactly one unread session for first boot", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, SHELL_FIXTURE.seedLastVisitedAt);
    const unread = groups.flatMap((group) => group.sessions.filter((row) => row.unread));
    expect(unread.map((row) => row.session.id)).toEqual(["sess-motion"]);
  });
});

describe("buildProjectGroups", () => {
  it("collapses large-inventory defaults while keeping the routed project discoverable", () => {
    const activeSessionId = "sess-pagination";
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, {}, "current", {}, {
      activeSessionId,
      defaultExpanded: false,
    });
    const active = groups.find((group) =>
      group.sessions.some((row) => row.session.id === activeSessionId),
    );
    expect(active?.expanded).toBe(true);
    expect(
      groups
        .filter((group) => group.project.id !== active?.project.id)
        .every((group) => !group.expanded),
    ).toBe(true);

    const explicitlyCollapsed = buildProjectGroups(
      SHELL_FIXTURE,
      { [active!.project.id]: false },
      {},
      "current",
      {},
      { activeSessionId, defaultExpanded: false },
    );
    expect(
      explicitlyCollapsed.find((group) => group.project.id === active?.project.id)?.expanded,
    ).toBe(false);
  });

  it("filters by title, project, runtime state, unread state, and errors", () => {
    const byText = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      SHELL_FIXTURE.seedLastVisitedAt,
      "current",
      {},
      { query: "pagination" },
    );
    expect(byText.map((group) => group.project.id)).toEqual(["proj-notes"]);
    expect(byText[0]?.sessions.map((row) => row.session.id)).toEqual(["sess-pagination"]);

    const running = buildProjectGroups(SHELL_FIXTURE, {}, {}, "current", {}, { filter: "running" });
    expect(running.flatMap((group) => group.sessions.map((row) => row.session.id))).toEqual([
      "sess-stream",
    ]);

    const unread = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      SHELL_FIXTURE.seedLastVisitedAt,
      "current",
      {},
      { filter: "unread" },
    );
    expect(unread.flatMap((group) => group.sessions.map((row) => row.session.id))).toEqual([
      "sess-motion",
    ]);

    const errors = buildProjectGroups(SHELL_FIXTURE, {}, {}, "current", {}, { filter: "errors" });
    expect(errors.flatMap((group) => group.sessions.map((row) => row.session.id))).toEqual([
      "sess-resize",
    ]);
  });

  it("matches uppercase ASCII queries under a Turkish locale", () => {
    // Simulate a Turkish/Azeri locale, where ASCII "I" lowercases to dotless "ı".
    String.prototype.toLocaleLowerCase = function (this: string) {
      return this.replace(/I/g, "ı").toLowerCase();
    };
    expect("PAGINATION".toLocaleLowerCase()).toBe("pagınatıon");

    const byText = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      SHELL_FIXTURE.seedLastVisitedAt,
      "current",
      {},
      { query: "PAGINATION" },
    );
    expect(byText.map((group) => group.project.id)).toEqual(["proj-notes"]);
    expect(byText[0]?.sessions.map((row) => row.session.id)).toEqual(["sess-pagination"]);
  });

  it("sorts priority by the user-facing attention order", () => {
    const groups = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      SHELL_FIXTURE.seedLastVisitedAt,
      "current",
      {},
      { sort: "priority" },
    );
    expect(groups.map((group) => group.project.id)).toEqual(["proj-omp", "proj-t4", "proj-notes"]);
    expect(groups[0]?.sessions.map((row) => row.session.id)).toEqual([
      "sess-settings",
      "sess-stream",
      "sess-bundle",
    ]);
    expect(groups[1]?.sessions.slice(0, 3).map((row) => row.session.id)).toEqual([
      "sess-fixtures",
      "sess-motion",
      "sess-resize",
    ]);
    expect(sessionPriority(groups[0]!.sessions[0]!)).toBe(6);
  });

  it("uses the project id as a stable tiebreaker for identical aliases and timestamps", () => {
    const tied = {
      ...SHELL_FIXTURE,
      sessions: SHELL_FIXTURE.sessions.map((session) => ({
        ...session,
        updatedAt: "2026-07-19T12:00:00Z",
      })),
    };
    const groups = buildProjectGroups(
      tied,
      {},
      {},
      "current",
      {},
      {
        projectAliasById: Object.fromEntries(
          SHELL_FIXTURE.projects.map((project) => [project.id, "Same name"]),
        ),
        sort: "updated",
      },
    );

    expect(groups.map((group) => group.project.id)).toEqual(["proj-notes", "proj-omp", "proj-t4"]);
  });

  it("honors stable manual project, grouped-session, and flat-session order", () => {
    const groups = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      {},
      "current",
      {},
      {
        sort: "manual",
        projectManualOrder: ["proj-notes", "proj-t4", "proj-omp"],
        sessionManualOrderByProjectId: {
          "proj-t4": ["sess-notes", "sess-resize", "sess-motion", "sess-fixtures"],
        },
      },
    );
    expect(groups.map((group) => group.project.id)).toEqual(["proj-notes", "proj-t4", "proj-omp"]);
    expect(groups[1]?.sessions.map((row) => row.session.id)).toEqual([
      "sess-notes",
      "sess-resize",
      "sess-motion",
      "sess-fixtures",
    ]);
    expect(
      flattenProjectGroups(groups, "manual", ["sess-stream", "sess-theme"])
        .slice(0, 2)
        .map((entry) => entry.row.session.id),
    ).toEqual(["sess-stream", "sess-theme"]);
  });

  it("moves visible manual-order entries without losing hidden entries", () => {
    expect(moveIdInManualOrder(["hidden", "b"], ["a", "b", "c"], "b", -1)).toEqual([
      "b",
      "a",
      "c",
      "hidden",
    ]);
    expect(moveIdInManualOrder(["a", "b"], ["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveIdToManualIndex(["hidden", "a", "b"], ["a", "b", "c"], "c", "a")).toEqual([
      "c",
      "a",
      "b",
      "hidden",
    ]);
  });

  it("dismisses an empty Current header without hiding its archived sessions", () => {
    const project = SHELL_FIXTURE.projects[0];
    const session = SHELL_FIXTURE.sessions.find((entry) => entry.projectId === project?.id);
    expect(project).toBeDefined();
    expect(session).toBeDefined();
    if (project === undefined || session === undefined) return;
    const data = {
      ...SHELL_FIXTURE,
      projects: [project],
      sessions: [{ ...session, archivedAt: "2026-07-12T12:00:00Z" }],
    };

    const current = buildProjectGroups(data, {}, {}, "current");
    expect(current).toHaveLength(1);
    expect(current[0]?.project.id).toBe(project.id);
    expect(current[0]?.sessions).toEqual([]);
    expect(current[0]?.groupStatus).toBeNull();
    expect(buildProjectGroups(data, {}, {}, "current", { [project.id]: true })).toEqual([]);

    const archived = buildProjectGroups(data, {}, {}, "archived", { [project.id]: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.sessions.map((row) => row.session.id)).toEqual([session.id]);

    const truncated = buildProjectGroups(
      {
        ...data,
        hosts: data.hosts.map((host) =>
          host.id === project.hostId ? { ...host, sessionInventoryTruncated: true } : host,
        ),
      },
      {},
      {},
      "current",
      { [project.id]: true },
    );
    expect(truncated).toEqual([]);
  });

  it("keeps a hidden project out of Current until the client restores it", () => {
    const project = SHELL_FIXTURE.projects[0];
    const session = SHELL_FIXTURE.sessions.find((entry) => entry.projectId === project?.id);
    expect(project).toBeDefined();
    expect(session).toBeDefined();
    if (project === undefined || session === undefined) return;

    const groups = buildProjectGroups(
      { ...SHELL_FIXTURE, projects: [project], sessions: [session] },
      {},
      {},
      "current",
      { [project.id]: true },
    );
    expect(groups).toEqual([]);
    const restored = buildProjectGroups(
      { ...SHELL_FIXTURE, projects: [project], sessions: [session] },
      {},
      {},
      "current",
      {},
    );
    expect(restored[0]?.sessions.map((row) => row.session.id)).toEqual([session.id]);
    expect(
      buildProjectGroups(
        {
          ...SHELL_FIXTURE,
          projects: [project],
          sessions: [{ ...session, archivedAt: "2026-07-12T12:00:00Z" }],
        },
        {},
        {},
        "current",
        { [project.id]: true },
      ),
    ).toEqual([]);
  });

  it("uses a client alias for display, search, and tie breaking without changing the host name", () => {
    const groups = buildProjectGroups(
      SHELL_FIXTURE,
      {},
      {},
      "current",
      {},
      {
        query: "launchpad",
        projectAliasById: { "proj-t4": "Launchpad" },
      },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.displayName).toBe("Launchpad");
    expect(groups[0]?.project.name).toBe(
      SHELL_FIXTURE.projects.find((project) => project.id === "proj-t4")?.name,
    );
  });

  it("dismisses duplicate display names by stable project id", () => {
    const [first, second] = SHELL_FIXTURE.projects;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const projects = [
      { ...first, name: "workspace" },
      { ...second, name: "workspace" },
    ];
    const sessions = SHELL_FIXTURE.sessions
      .filter((session) => session.projectId === first.id || session.projectId === second.id)
      .map((session) => ({ ...session, archivedAt: "2026-07-12T12:00:00Z" }));

    const groups = buildProjectGroups({ ...SHELL_FIXTURE, projects, sessions }, {}, {}, "current", {
      [first.id]: true,
    });
    expect(groups.map((group) => group.project.id)).toEqual([second.id]);
  });

  it("aggregates the highest-priority child status per project", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, {});
    const omp = groups.find((group) => group.project.id === "proj-omp");
    // pendingApproval outranks working and planReady.
    expect(omp?.groupStatus).toBe("pendingApproval");
    const notesApp = groups.find((group) => group.project.id === "proj-notes");
    expect(notesApp?.groupStatus).toBeNull();
  });

  it("sums pending approvals for the group badge", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, {});
    const omp = groups.find((group) => group.project.id === "proj-omp");
    expect(omp?.pendingApprovals).toBe(2);
  });

  it("projects default to expanded; explicit collapse hides sessions from jumps", () => {
    const collapsed = buildProjectGroups(SHELL_FIXTURE, { "proj-omp": false }, {});
    const visible = listVisibleSessionIds(collapsed);
    expect(visible).not.toContain("sess-stream");
    expect(visible).toContain("sess-fixtures");

    const all = listVisibleSessionIds(buildProjectGroups(SHELL_FIXTURE, {}, {}));
    expect(all[0]).toBe("sess-stream");
    expect(all).toHaveLength(SHELL_FIXTURE.sessions.length);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");
  it("buckets minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-07-11T11:59:40Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-07-11T11:14:00Z", now)).toBe("46m ago");
    expect(formatRelativeTime("2026-07-11T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-10T08:00:00Z", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-07-05T08:00:00Z", now)).toBe("6d ago");
    expect(formatRelativeTime("garbage", now)).toBe("");
  });
});
