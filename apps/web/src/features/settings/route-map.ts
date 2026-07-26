// Generated from docs/settings-surface/coverage.json by scripts/check-settings-coverage.mjs.
// Do not edit. Run `node scripts/check-settings-coverage.mjs --write` to regenerate.
//
// This is the settings information architecture: the rail's groups and pages,
// the named sections inside each page, and which OMP setting path belongs to
// which section. It replaces deriving sections from the host's `ui.tab`, which
// left every untabbed key in one unlabelled bucket.

export interface SettingsRouteGroup {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

export interface SettingsRouteSection {
  readonly label: string;
  readonly keys: readonly string[];
}

export type SettingsPageTemplate = "form" | "collection" | "action" | "form+collection" | "form+action";

export interface SettingsRoutePage {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly template: SettingsPageTemplate;
  /** Named runtime predicate that must hold for this page to appear in the rail. */
  readonly visibleWhen?: string;
  /** Resource kinds this page edits through `config.resource.*`. */
  readonly collections: readonly string[];
  readonly sections: readonly SettingsRouteSection[];
}

export const SETTINGS_GROUPS: readonly SettingsRouteGroup[] = [
  { id: "agent", label: "Agent", summary: "Which model does the work, how it reasons, and who it delegates to." },
  { id: "tools", label: "Tools", summary: "What the agent is allowed to run, read, and reach." },
  { id: "context", label: "Context", summary: "What the agent knows and what it keeps." },
  { id: "session", label: "Session", summary: "How a run behaves from first prompt to handoff." },
  { id: "interface", label: "Interface", summary: "What you see, hear, and type against." },
  { id: "system", label: "System", summary: "Omperator itself: hosts, profiles, storage, updates." },
];

export const SETTINGS_PAGES: readonly SettingsRoutePage[] = [
  {
    id: "agent/catalog",
    group: "agent",
    label: "Model catalog",
    template: "collection",
    collections: ["modelProvider"],
    sections: [],
  },
  {
    id: "agent/models",
    group: "agent",
    label: "Models",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Roles",
        keys: [
          "cycleOrder",
          "enabledModels",
          "modelProviderOrder",
          "modelRoles",
          "modelRoleStorage",
          "modelTags",
        ],
      },
      {
        label: "Reasoning",
        keys: [
          "defaultThinkingLevel",
          "hideThinkingBlock",
          "omitThinking",
          "proseOnlyThinking",
          "providers.autoThinkingModel",
          "textVerbosity",
          "thinkingBudgets.high",
          "thinkingBudgets.low",
          "thinkingBudgets.max",
          "thinkingBudgets.medium",
          "thinkingBudgets.minimal",
          "thinkingBudgets.xhigh",
        ],
      },
      {
        label: "Sampling",
        keys: [
          "minP",
          "presencePenalty",
          "repetitionPenalty",
          "temperature",
          "tier.advisor",
          "tier.anthropic",
          "tier.google",
          "tier.openai",
          "tier.subagent",
          "topK",
          "topP",
        ],
      },
      {
        label: "Prompt",
        keys: [
          "includeModelInPrompt",
          "includeWorkspaceTree",
          "inlineToolDescriptors",
          "personality",
        ],
      },
    ],
  },
  {
    id: "agent/providers",
    group: "agent",
    label: "Providers",
    template: "form",
    collections: ["credential"],
    sections: [
      {
        label: "Accounts",
        keys: [
          "auth.broker.token",
          "auth.broker.url",
        ],
      },
      {
        label: "Routing",
        keys: [
          "disabledProviders",
          "provider.appendOnlyContext",
          "providers.anthropic.serverSideFallback",
          "providers.antigravityEndpoint",
          "providers.fireworksTier",
          "providers.image",
          "providers.imageOrder",
          "providers.kimiApiFormat",
          "providers.openaiWebsockets",
          "providers.openrouterVariant",
        ],
      },
      {
        label: "Web services",
        keys: [
          "exa.enabled",
          "exa.enableResearcher",
          "exa.enableSearch",
          "exa.enableWebsets",
          "exa.searchDelayMs",
          "fetch.enabled",
          "providers.fetch",
          "providers.webSearch",
          "providers.webSearchExclude",
          "providers.webSearchGeminiModel",
          "providers.webSearchOrder",
          "searxng.basicPassword",
          "searxng.basicUsername",
          "searxng.categories",
          "searxng.endpoint",
          "searxng.engines",
          "searxng.language",
          "searxng.token",
          "web_search.enabled",
        ],
      },
      {
        label: "Local models",
        keys: [
          "providers.memoryModel",
          "providers.tinyModel",
          "providers.tinyModelDevice",
          "providers.tinyModelDtype",
          "providers.unexpectedStopModel",
        ],
      },
      {
        label: "Limits",
        keys: [
          "providers.maxInFlightRequests",
          "providers.ollama-cloud.maxConcurrency",
          "providers.streamFirstEventTimeoutSeconds",
          "providers.streamIdleTimeoutSeconds",
        ],
      },
    ],
  },
  {
    id: "agent/reliability",
    group: "agent",
    label: "Reliability",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Retry",
        keys: [
          "retry.baseDelayMs",
          "retry.enabled",
          "retry.fallbackChains",
          "retry.fallbackRevertPolicy",
          "retry.maxDelayMs",
          "retry.maxRetries",
          "retry.modelFallback",
          "retry.usageAwareFallback",
          "retry.usageReservePct",
          "retry.usageReservePolicy",
        ],
      },
      {
        label: "Recovery",
        keys: [
          "codexResets.autoRedeem",
          "codexResets.keepCredits",
          "codexResets.minBlockedMinutes",
        ],
      },
      {
        label: "Loop guards",
        keys: [
          "model.loopGuard.checkAssistantContent",
          "model.loopGuard.enabled",
          "model.loopGuard.toolCallReminder",
          "model.toolCallLoopGuard.enabled",
          "model.toolCallLoopGuard.exemptTools",
          "model.toolCallLoopGuard.threshold",
        ],
      },
      {
        label: "Prewalk",
        keys: [
          "prewalk.enabled",
        ],
      },
      {
        label: "Advisor",
        keys: [
          "advisor.enabled",
          "advisor.immuneTurns",
          "advisor.subagents",
          "advisor.syncBacklog",
        ],
      },
    ],
  },
  {
    id: "agent/skills",
    group: "agent",
    label: "Skills and commands",
    template: "form+collection",
    collections: ["skill", "command"],
    sections: [
      {
        label: "Skill discovery",
        keys: [
          "skills.customDirectories",
          "skills.enableAgentsProject",
          "skills.enableAgentsUser",
          "skills.enableClaudeProject",
          "skills.enableClaudeUser",
          "skills.enableCodexUser",
          "skills.enabled",
          "skills.enablePiProject",
          "skills.enablePiUser",
          "skills.enableSkillCommands",
          "skills.ignoredSkills",
          "skills.includeSkills",
        ],
      },
      {
        label: "Command discovery",
        keys: [
          "commands.enableClaudeProject",
          "commands.enableClaudeUser",
          "commands.enableOpencodeProject",
          "commands.enableOpencodeUser",
        ],
      },
    ],
  },
  {
    id: "agent/subagents",
    group: "agent",
    label: "Subagents",
    template: "form+collection",
    collections: ["agent"],
    sections: [
      {
        label: "Concurrency",
        keys: [
          "task.agentIdleTtlMs",
          "task.batch",
          "task.eager",
          "task.enableLsp",
          "task.maxConcurrency",
          "task.maxNestedConcurrency",
          "task.maxRecursionDepth",
          "task.maxRuntimeMs",
          "task.nestedEager",
          "task.prewalk",
        ],
      },
      {
        label: "Budgets",
        keys: [
          "task.showResolvedModelBadge",
          "task.softRequestBudget",
          "task.softRequestBudgetNotice",
        ],
      },
      {
        label: "Agent overrides",
        keys: [
          "task.agentModelOverrides",
          "task.agentPrewalk",
          "task.disabledAgents",
        ],
      },
      {
        label: "Isolation",
        keys: [
          "task.isolation.apply",
          "task.isolation.commits",
          "task.isolation.merge",
          "task.isolation.mode",
          "worktree.base",
        ],
      },
    ],
  },
  {
    id: "tools/files",
    group: "tools",
    label: "Files and code",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Editing",
        keys: [
          "edit.blockAutoGenerated",
          "edit.enforceSeenLines",
          "edit.fuzzyMatch",
          "edit.fuzzyThreshold",
          "edit.mode",
          "edit.streamingAbort",
        ],
      },
      {
        label: "Reading",
        keys: [
          "read.defaultLimit",
          "read.renderMarkdown",
          "read.summarize.enabled",
          "read.summarize.minBodyLines",
          "read.summarize.minCommentLines",
          "read.summarize.minTotalLines",
          "read.summarize.prose",
          "read.summarize.unfoldLimit",
          "read.summarize.unfoldUntil",
          "read.toolResultPreview",
          "readLineNumbers",
        ],
      },
      {
        label: "Code intelligence",
        keys: [
          "astEdit.enabled",
          "astGrep.enabled",
          "glob.enabled",
          "grep.contextAfter",
          "grep.contextBefore",
          "grep.enabled",
          "lsp.diagnosticsDeduplicate",
          "lsp.diagnosticsOnEdit",
          "lsp.diagnosticsOnWrite",
          "lsp.enabled",
          "lsp.formatOnWrite",
          "lsp.lazy",
        ],
      },
    ],
  },
  {
    id: "tools/extensions",
    group: "tools",
    label: "MCP and extensions",
    template: "form+collection",
    collections: ["mcpServer", "hook", "customTool"],
    sections: [
      {
        label: "MCP",
        keys: [
          "mcp.enableProjectConfig",
          "mcp.notificationDebounceMs",
          "mcp.notifications",
          "mcp.renderMarkdownResults",
        ],
      },
      {
        label: "Plugins",
        keys: [
          "disabledExtensions",
          "extensions",
          "marketplace.autoUpdate",
        ],
      },
    ],
  },
  {
    id: "tools/output",
    group: "tools",
    label: "Output and devices",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Artifacts and limits",
        keys: [
          "tools.abortOnFabricatedResult",
          "tools.artifactHeadBytes",
          "tools.artifactSpillThreshold",
          "tools.artifactTailBytes",
          "tools.artifactTailLines",
          "tools.format",
          "tools.intentTracing",
          "tools.maxTimeout",
          "tools.outputMaxColumns",
          "tools.xdev",
          "tools.xdevDocs",
          "tools.xdevInlineDevices",
        ],
      },
      {
        label: "Debugging",
        keys: [
          "checkpoint.enabled",
          "debug.enabled",
        ],
      },
    ],
  },
  {
    id: "tools/permissions",
    group: "tools",
    label: "Permissions",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Approval",
        keys: [
          "tools.approval",
          "tools.approvalMode",
        ],
      },
      {
        label: "Bash rules",
        keys: [
          "bash.patterns",
          "bashInterceptor.enabled",
          "bashInterceptor.patterns",
        ],
      },
    ],
  },
  {
    id: "tools/shell",
    group: "tools",
    label: "Shell and runtimes",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Bash",
        keys: [
          "bash.autoBackground.enabled",
          "bash.autoBackground.thresholdMs",
          "bash.direnv",
          "bash.direnvLoadTimeoutMs",
          "bash.enabled",
          "launch.enabled",
          "shellMinimizer.enabled",
          "shellMinimizer.except",
          "shellMinimizer.legacyFilters",
          "shellMinimizer.maxCaptureBytes",
          "shellMinimizer.only",
          "shellMinimizer.settingsPath",
          "shellMinimizer.sourceOutlineLevel",
          "shellPath",
        ],
      },
      {
        label: "Eval",
        keys: [
          "eval.jl",
          "eval.js",
          "eval.py",
          "eval.rb",
          "julia.interpreter",
          "python.interpreter",
          "python.kernelMode",
          "ruby.interpreter",
        ],
      },
    ],
  },
  {
    id: "tools/web",
    group: "tools",
    label: "Web and desktop",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Browser",
        keys: [
          "browser.cmux",
          "browser.enabled",
          "browser.headless",
          "browser.screenshotDir",
        ],
      },
      {
        label: "Computer use",
        keys: [
          "computer.backend",
          "computer.display",
          "computer.enabled",
          "computer.maxHeight",
          "computer.maxWidth",
        ],
      },
      {
        label: "GitHub",
        keys: [
          "github.cache.enabled",
          "github.cache.hardTtlSec",
          "github.cache.softTtlSec",
          "github.enabled",
        ],
      },
      {
        label: "Vault",
        keys: [
          "vault.enabled",
        ],
      },
      {
        label: "Images",
        keys: [
          "generate_image.enabled",
          "images.describeForTextModels",
          "inspect_image.enabled",
        ],
      },
    ],
  },
  {
    id: "context/compaction",
    group: "context",
    label: "Compaction",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Compaction",
        keys: [
          "compaction.autoContinue",
          "compaction.dropUseless",
          "compaction.enabled",
          "compaction.handoffSaveToDisk",
          "compaction.idleEnabled",
          "compaction.idleThresholdTokens",
          "compaction.idleTimeoutSeconds",
          "compaction.keepRecentTokens",
          "compaction.midTurnEnabled",
          "compaction.remoteEnabled",
          "compaction.remoteEndpoint",
          "compaction.remoteStreamingV2Enabled",
          "compaction.reserveTokens",
          "compaction.strategy",
          "compaction.supersedeReads",
          "compaction.thresholdPercent",
          "compaction.thresholdTokens",
          "compaction.v2RetainedMessageBudget",
        ],
      },
      {
        label: "Snapcompact",
        keys: [
          "snapcompact.shape",
          "snapcompact.systemPrompt",
          "snapcompact.toolResults",
        ],
      },
      {
        label: "Overflow",
        keys: [
          "contextPromotion.enabled",
        ],
      },
      {
        label: "Branch summary",
        keys: [
          "branchSummary.enabled",
          "branchSummary.reserveTokens",
        ],
      },
    ],
  },
  {
    id: "context/instructions",
    group: "context",
    label: "Instructions and workspace",
    template: "form+collection",
    collections: ["instruction"],
    sections: [
      {
        label: "Workspace roots",
        keys: [
          "workspace.additionalDirectories",
        ],
      },
    ],
  },
  {
    id: "context/memory",
    group: "context",
    label: "Memory",
    template: "form+collection",
    collections: [],
    sections: [
      {
        label: "Backend",
        keys: [
          "memories.enabled",
          "memories.fallbackTokenLimit",
          "memories.maxRawMemoriesForGlobal",
          "memories.maxRolloutAgeDays",
          "memories.maxRolloutsPerStartup",
          "memories.minRolloutIdleHours",
          "memories.phase1InputTokenLimit",
          "memories.phase2HeartbeatSeconds",
          "memories.phase2LeaseSeconds",
          "memories.phase2RetryDelaySeconds",
          "memories.rolloutPayloadPercent",
          "memories.stage1Concurrency",
          "memories.stage1LeaseSeconds",
          "memories.stage1RetryDelaySeconds",
          "memories.summaryInjectionTokenLimit",
          "memories.threadScanLimit",
          "memory.backend",
        ],
      },
      {
        label: "Auto-learn",
        keys: [
          "autolearn.autoContinue",
          "autolearn.enabled",
          "autolearn.minToolCalls",
        ],
      },
    ],
  },
  {
    id: "context/memory-hindsight",
    group: "context",
    label: "Memory: Hindsight",
    template: "form",
    visibleWhen: "hindsightActive",
    collections: [],
    sections: [
      {
        label: "Connection",
        keys: [
          "hindsight.apiToken",
          "hindsight.apiUrl",
          "hindsight.bankId",
          "hindsight.bankIdPrefix",
          "hindsight.scoping",
        ],
      },
      {
        label: "Recall",
        keys: [
          "hindsight.autoRecall",
          "hindsight.recallBudget",
          "hindsight.recallContextTurns",
          "hindsight.recallMaxQueryChars",
          "hindsight.recallMaxTokens",
          "hindsight.recallTypes",
        ],
      },
      {
        label: "Retain",
        keys: [
          "hindsight.autoRetain",
          "hindsight.bankMission",
          "hindsight.retainContext",
          "hindsight.retainEveryNTurns",
          "hindsight.retainMission",
          "hindsight.retainMode",
          "hindsight.retainOverlapTurns",
        ],
      },
      {
        label: "Mental models",
        keys: [
          "hindsight.mentalModelAutoSeed",
          "hindsight.mentalModelMaxRenderChars",
          "hindsight.mentalModelRefreshIntervalMs",
          "hindsight.mentalModelsEnabled",
        ],
      },
      {
        label: "Timeouts and debug",
        keys: [
          "hindsight.debug",
          "hindsight.recallTimeoutMs",
          "hindsight.reflectTimeoutMs",
          "hindsight.requestTimeoutMs",
          "hindsight.retainTimeoutMs",
        ],
      },
    ],
  },
  {
    id: "context/memory-mnemopi",
    group: "context",
    label: "Memory: Mnemopi",
    template: "form",
    visibleWhen: "mnemopiActive",
    collections: [],
    sections: [
      {
        label: "Storage",
        keys: [
          "mnemopi.bank",
          "mnemopi.dbPath",
          "mnemopi.scoping",
        ],
      },
      {
        label: "Recall",
        keys: [
          "mnemopi.autoRecall",
          "mnemopi.enhancedRecall",
          "mnemopi.injectionTokenLimit",
          "mnemopi.polyphonicRecall",
          "mnemopi.recallContextTurns",
          "mnemopi.recallLimit",
          "mnemopi.recallMaxQueryChars",
        ],
      },
      {
        label: "Retain",
        keys: [
          "mnemopi.autoRetain",
          "mnemopi.proactiveLinking",
          "mnemopi.retainEveryNTurns",
        ],
      },
      {
        label: "Embeddings",
        keys: [
          "mnemopi.embeddingApiKey",
          "mnemopi.embeddingApiUrl",
          "mnemopi.embeddingModel",
          "mnemopi.embeddingVariant",
          "mnemopi.noEmbeddings",
        ],
      },
      {
        label: "LLM",
        keys: [
          "mnemopi.debug",
          "mnemopi.llmApiKey",
          "mnemopi.llmBaseUrl",
          "mnemopi.llmMode",
          "mnemopi.llmModel",
        ],
      },
    ],
  },
  {
    id: "context/rules",
    group: "context",
    label: "Stream rules",
    template: "form+collection",
    collections: ["rule"],
    sections: [
      {
        label: "Behavior",
        keys: [
          "ttsr.builtinRules",
          "ttsr.contextMode",
          "ttsr.disabledRules",
          "ttsr.enabled",
          "ttsr.interruptMode",
          "ttsr.repeatGap",
          "ttsr.repeatMode",
        ],
      },
    ],
  },
  {
    id: "session/behavior",
    group: "session",
    label: "Behavior",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Steering",
        keys: [
          "followUpMode",
          "interruptMode",
          "steeringMode",
        ],
      },
      {
        label: "Editor",
        keys: [
          "autocompleteMaxVisible",
          "doubleEscapeAction",
          "emojiAutocomplete",
          "paste.largeMenuThreshold",
          "treeFilterMode",
        ],
      },
      {
        label: "Todos",
        keys: [
          "tasks.todoClearDelay",
          "todo.eager",
          "todo.enabled",
          "todo.reminders",
          "todo.remindersMax",
        ],
      },
      {
        label: "Background jobs",
        keys: [
          "async.enabled",
          "async.maxJobs",
          "async.pollWaitDuration",
          "irc.timeoutMs",
        ],
      },
      {
        label: "Titles and resume",
        keys: [
          "autoResume",
          "title.refreshOnReplan",
        ],
      },
    ],
  },
  {
    id: "session/modes",
    group: "session",
    label: "Modes",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Plan",
        keys: [
          "plan.defaultOnStartup",
          "plan.enabled",
        ],
      },
      {
        label: "Goal and loop",
        keys: [
          "goal.continuationModes",
          "goal.enabled",
          "goal.statusInFooter",
          "loop.mode",
        ],
      },
      {
        label: "Magic keywords",
        keys: [
          "magicKeywords.enabled",
          "magicKeywords.orchestrate",
          "magicKeywords.ultrathink",
          "magicKeywords.workflow",
        ],
      },
      {
        label: "Detection",
        keys: [
          "features.unexpectedStopDetection",
        ],
      },
    ],
  },
  {
    id: "session/sharing",
    group: "session",
    label: "Sharing and collab",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Share",
        keys: [
          "share.redactSecrets",
          "share.serverUrl",
          "share.store",
        ],
      },
      {
        label: "Collab",
        keys: [
          "collab.displayName",
          "collab.relayUrl",
          "collab.webUrl",
        ],
      },
      {
        label: "Redaction",
        keys: [
          "secrets.enabled",
        ],
      },
    ],
  },
  {
    id: "session/startup",
    group: "session",
    label: "Startup and power",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Startup",
        keys: [
          "collapseChangelog",
          "setupVersion",
          "startup.checkUpdate",
          "startup.quiet",
          "startup.setupWizard",
          "startup.showSplash",
        ],
      },
      {
        label: "Power",
        keys: [
          "power.sleepPrevention",
        ],
      },
      {
        label: "Git",
        keys: [
          "git.enabled",
        ],
      },
    ],
  },
  {
    id: "interface/keyboard",
    group: "interface",
    label: "Keyboard",
    template: "collection",
    collections: ["keybinding"],
    sections: [],
  },
  {
    id: "interface/terminal",
    group: "interface",
    label: "OMP terminal",
    template: "form+collection",
    collections: ["theme"],
    sections: [
      {
        label: "Theme",
        keys: [
          "colorBlindMode",
          "symbolPreset",
          "theme.dark",
          "theme.light",
        ],
      },
      {
        label: "Display",
        keys: [
          "display.cacheMissMarker",
          "display.collapseCompacted",
          "display.shimmer",
          "display.showTokenUsage",
          "display.smoothStreaming",
          "showHardwareCursor",
          "terminal.showImages",
          "terminal.showProgress",
          "tui.hyperlinks",
          "tui.imeSafeCursor",
          "tui.maxInlineImageColumns",
          "tui.maxInlineImageRows",
          "tui.maxInlineImages",
          "tui.renderMermaid",
          "tui.scrollbackRebuild",
          "tui.textSizing",
          "tui.tight",
          "tui.titleState",
        ],
      },
      {
        label: "Images",
        keys: [
          "images.autoResize",
          "images.blockImages",
        ],
      },
      {
        label: "Status line",
        keys: [
          "statusLine.compactThinkingLevel",
          "statusLine.leftSegments",
          "statusLine.preset",
          "statusLine.rightSegments",
          "statusLine.segmentOptions",
          "statusLine.separator",
          "statusLine.sessionAccent",
          "statusLine.showHookStatus",
          "statusLine.transparent",
        ],
      },
    ],
  },
  {
    id: "interface/omperator",
    group: "interface",
    label: "Omperator",
    template: "form",
    collections: [],
    sections: [],
  },
  {
    id: "interface/voice",
    group: "interface",
    label: "Voice and alerts",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Speech output",
        keys: [
          "providers.tts",
          "speech.enabled",
          "speech.enhanced",
          "speech.mode",
          "speech.voice",
          "speechgen.enabled",
          "tts.localModel",
          "tts.localVoice",
        ],
      },
      {
        label: "Dictation",
        keys: [
          "stt.enabled",
          "stt.language",
          "stt.modelName",
          "stt.submitTrigger",
        ],
      },
      {
        label: "Notifications",
        keys: [
          "ask.enabled",
          "ask.notify",
          "ask.timeout",
          "completion.notify",
          "error.notify",
          "recap.enabled",
          "recap.idleSeconds",
        ],
      },
    ],
  },
  {
    id: "system/diagnostics",
    group: "system",
    label: "Diagnostics",
    template: "form+action",
    collections: [],
    sections: [
      {
        label: "Auto QA",
        keys: [
          "dev.autoqa",
          "dev.autoqaConsent",
          "dev.autoqaPush.endpoint",
          "dev.autoqaPush.token",
        ],
      },
    ],
  },
  {
    id: "system/hosts",
    group: "system",
    label: "Hosts and remote",
    template: "form+collection",
    collections: [],
    sections: [
      {
        label: "Remote appserver",
        keys: [
          "appserver.remoteAddress",
          "appserver.remoteMode",
          "appserver.remoteOrigins",
          "appserver.remotePort",
        ],
      },
    ],
  },
  {
    id: "system/profiles",
    group: "system",
    label: "Profiles",
    template: "collection",
    collections: [],
    sections: [],
  },
  {
    id: "system/storage",
    group: "system",
    label: "Storage",
    template: "form",
    collections: [],
    sections: [
      {
        label: "Garbage collection",
        keys: [
          "gc.archive",
          "gc.blobs",
          "gc.coldArchiveAfterDays",
          "gc.retainNewestGlobal",
          "gc.retainNewestPerCwd",
          "gc.wal",
        ],
      },
      {
        label: "Commits",
        keys: [
          "commit.changelogMaxDiffChars",
          "commit.mapReduceEnabled",
          "commit.mapReduceMaxConcurrency",
          "commit.mapReduceMaxFileTokens",
          "commit.mapReduceMinFiles",
          "commit.mapReduceTimeoutMs",
        ],
      },
    ],
  },
  {
    id: "system/updates",
    group: "system",
    label: "Updates",
    template: "action",
    collections: [],
    sections: [],
  },
];

const ROUTE_BY_PATH = new Map<string, { readonly page: SettingsRoutePage; readonly section: SettingsRouteSection }>(
  SETTINGS_PAGES.flatMap((page) => page.sections.flatMap((section) => section.keys.map((key) => [key, { page, section }] as const))),
);

/** The single home of one OMP setting path, or undefined when no section claims it. */
export function routeForSetting(path: string): { readonly page: SettingsRoutePage; readonly section: SettingsRouteSection } | undefined {
  return ROUTE_BY_PATH.get(path);
}

/** Every setting path the manifest accounts for. */
export function routedSettingPaths(): readonly string[] {
  return [...ROUTE_BY_PATH.keys()];
}
