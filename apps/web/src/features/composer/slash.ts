// Slash-command catalog and ranked search. Ranking tiers (exact / prefix /
// boundary / includes / fuzzy-subsequence) adapted from T3 Code
// packages/shared/src/searchRanking.ts and apps/web/src/components/chat/
// composerSlashCommandSearch.ts (MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb). OMP changes: fixture-fed
// catalog with aliases, argument hints, and capability-gated disabled
// reasons instead of provider commands.
import type { CatalogItem } from "@t4-code/protocol";
import { scoreQueryMatch } from "./match.ts";

export interface SlashCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** Argument hint rendered after the name, e.g. "<path>". */
  readonly argsHint: string;
  /** Present when the command cannot run right now; shown, not hidden. */
  readonly disabledReason: string | null;
  /** Inserted into the composer on accept (name + trailing space or args). */
  readonly insert: string;
}

export interface SlashCatalogContext {
  readonly link: "live" | "cached" | "offline";
  readonly turnActive: boolean;
  /**
   * View-wide read-only policy (observer/reconciling); gates every command
   * with an honest reason while the palette stays visible. Cached/offline
   * reasons still win.
   */
  readonly readOnlyReason?: string | null;
}

/**
 * Build the slash palette from a live CatalogFrame's command items. Names,
 * descriptions, aliases (`metadata.aliases`), inline hints
 * (`metadata.inlineHint`), and support verdicts all come from the runtime;
 * a command whose required capabilities were not granted stays visible with
 * an honest reason instead of pretending to work.
 */
export function slashCommandsFromCatalog(
  items: readonly CatalogItem[],
  context: SlashCatalogContext,
  granted: readonly string[],
): SlashCommand[] {
  const offlineReason =
    context.link === "cached"
      ? "Unavailable on a cached copy"
      : context.link === "offline"
        ? "Unavailable while the host is unreachable"
        : null;
  const commands: SlashCommand[] = [];
  for (const item of items) {
    if (item.kind !== "command") continue;
    const bareName = item.name.replace(/^\/+/, "");
    const name = `/${bareName}`;
    const metadata = item.metadata ?? {};
    const rawAliases = Array.isArray(metadata.aliases) ? metadata.aliases : [];
    const aliases = rawAliases
      .filter((alias): alias is string => typeof alias === "string" && alias !== "")
      .map((alias) => `/${alias.replace(/^\/+/, "")}`);
    const argsHint = typeof metadata.inlineHint === "string" ? metadata.inlineHint : "";
    const missingCapability = (item.capabilities ?? []).find(
      (capability) => !granted.includes(capability),
    );
    const disabledReason =
      offlineReason ??
      context.readOnlyReason ??
      (item.supported === false
        ? (item.reason ?? "Not available on this host")
        : missingCapability !== undefined
          ? missingCapability === "terminal.io"
            ? "Needs terminal access on this host"
            : "Not granted on this host"
          : context.turnActive && bareName === "compact"
            ? "Wait for the turn to finish"
            : context.turnActive && bareName === "retry"
              ? "A turn is already running"
              : null);
    commands.push({
      name,
      aliases,
      description: item.description ?? "",
      argsHint,
      disabledReason,
      insert: `${name} `,
    });
  }
  return commands;
}

/**
 * The catalog the fixture runtime advertises. The real bridge replaces this
 * with the schema-fed command list from OMP; the shape stays identical.
 */
export function buildSlashCatalog(context: SlashCatalogContext): SlashCommand[] {
  const offline = context.link !== "live";
  const offlineReason = offline
    ? context.link === "cached"
      ? "Unavailable on a cached copy"
      : "Unavailable while the host is unreachable"
    : null;
  return [
    {
      name: "/compact",
      aliases: ["/compress"],
      description: "Fold older context into a summary",
      argsHint: "",
      disabledReason: offlineReason ?? (context.turnActive ? "Wait for the turn to finish" : null),
      insert: "/compact ",
    },
    {
      name: "/context",
      aliases: ["/usage"],
      description: "Show what is using the context window",
      argsHint: "",
      disabledReason: offlineReason,
      insert: "/context ",
    },
    {
      name: "/model",
      aliases: [],
      description: "Switch the session model",
      argsHint: "<name>",
      disabledReason: offlineReason,
      insert: "/model ",
    },
    {
      name: "/plan",
      aliases: ["/think"],
      description: "Ask for a plan before any work starts",
      argsHint: "<goal>",
      disabledReason: offlineReason,
      insert: "/plan ",
    },
    {
      name: "/retry",
      aliases: ["/again"],
      description: "Retry the last failed turn",
      argsHint: "",
      disabledReason: offlineReason ?? (context.turnActive ? "A turn is already running" : null),
      insert: "/retry ",
    },
    {
      name: "/review",
      aliases: ["/diff"],
      description: "Review the working tree changes",
      argsHint: "[path]",
      disabledReason: offlineReason,
      insert: "/review ",
    },
    {
      name: "/terminal",
      aliases: ["/term", "/sh"],
      description: "Open a terminal in the session project",
      argsHint: "",
      disabledReason: offlineReason ?? "Needs terminal access on this host",
      insert: "/terminal ",
    },
    {
      name: "/title",
      aliases: ["/rename"],
      description: "Rename this session",
      argsHint: "<title>",
      disabledReason: offlineReason,
      insert: "/title ",
    },
  ];
}

// ---------------------------------------------------------------------------
// Ranked search (scoring tiers live in ./match.ts)
// ---------------------------------------------------------------------------

function scoreCommand(command: SlashCommand, query: string): number | null {
  const names = [command.name, ...command.aliases].map((name) =>
    name.replace(/^\/+/, "").toLowerCase(),
  );
  let best: number | null = null;
  for (const name of names) {
    const score = scoreQueryMatch(name, query, {
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
    });
    if (score !== null && (best === null || score < best)) best = score;
  }
  const descriptionScore = scoreQueryMatch(command.description.toLowerCase(), query, {
    exactBase: 20,
    prefixBase: 22,
    boundaryBase: 24,
    includesBase: 26,
  });
  if (descriptionScore !== null && (best === null || descriptionScore < best)) {
    best = descriptionScore;
  }
  return best;
}

/** Rank the catalog for a query ("" keeps catalog order). Stable and pure. */
export function searchSlashCommands(
  commands: readonly SlashCommand[],
  rawQuery: string,
): SlashCommand[] {
  const query = rawQuery.trim().replace(/^\/+/, "").toLowerCase();
  if (query === "") return [...commands];
  const ranked: { command: SlashCommand; score: number }[] = [];
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score !== null) ranked.push({ command, score });
  }
  ranked.sort(
    (left, right) =>
      left.score - right.score || left.command.name.localeCompare(right.command.name),
  );
  return ranked.map((entry) => entry.command);
}

/**
 * The active slash query, when the caret sits inside a leading slash token
 * ("/mo" → "mo"). Null when the menu should be closed.
 */
export function activeSlashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const head = text.slice(0, caret);
  if (!/^\/[\w-]*$/.test(head)) return null;
  return head.slice(1);
}
