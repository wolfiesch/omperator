import {
  MAX_RETAINED_AGENT_TRANSCRIPTS,
  MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
  MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_SESSION_EVENT_BYTES,
  MAX_RETAINED_SESSION_EVENTS,
  MAX_RETAINED_SESSION_EVENTS_BYTES,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_RETAINED_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
} from "./transcript-retention.ts";
import {
  MAX_INDEXED_SESSION_REFS,
  MAX_INDEXED_WORKSPACES,
  MAX_RETAINED_FILE_BYTES,
  MAX_RETAINED_FILES,
  MAX_RETAINED_FILES_BYTES,
  MAX_RETAINED_PREVIEW_EVENTS,
  MAX_RETAINED_PREVIEWS,
  MAX_RETAINED_TERMINAL_BYTES,
  MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL,
  MAX_RETAINED_TERMINALS,
  type ProjectionOptions,
} from "./projection-contract.ts";

const DEFAULT_OPTIONS: Required<ProjectionOptions> = {
  maxWarmSessions: 8,
  maxIndexedSessions: MAX_INDEXED_SESSION_REFS,
  maxWorkspaces: MAX_INDEXED_WORKSPACES,
  maxEntries: MAX_RETAINED_TRANSCRIPT_ENTRIES,
  maxTranscriptBytes: MAX_RETAINED_TRANSCRIPT_BYTES,
  maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  maxEvents: MAX_RETAINED_SESSION_EVENTS,
  maxEventsBytes: MAX_RETAINED_SESSION_EVENTS_BYTES,
  maxEventBytes: MAX_RETAINED_SESSION_EVENT_BYTES,
  maxAudit: 256,
  maxAgentTranscripts: MAX_RETAINED_AGENT_TRANSCRIPTS,
  maxAgentTranscriptEntries: MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
  maxAgentTranscriptBytes: MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
  maxTerminals: MAX_RETAINED_TERMINALS,
  maxTerminalBytes: MAX_RETAINED_TERMINAL_BYTES,
  maxTerminalBytesPerTerminal: MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL,
  maxFiles: MAX_RETAINED_FILES,
  maxFilesBytes: MAX_RETAINED_FILES_BYTES,
  maxFileBytes: MAX_RETAINED_FILE_BYTES,
  maxPreviews: MAX_RETAINED_PREVIEWS,
  maxPreviewEvents: MAX_RETAINED_PREVIEW_EVENTS,
};

function positiveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveProjectionOptions(options: ProjectionOptions): Required<ProjectionOptions> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  return {
    ...merged,
    maxTerminals: positiveOption(options.maxTerminals, DEFAULT_OPTIONS.maxTerminals),
    maxTerminalBytes: positiveOption(options.maxTerminalBytes, DEFAULT_OPTIONS.maxTerminalBytes),
    maxTerminalBytesPerTerminal: positiveOption(
      options.maxTerminalBytesPerTerminal,
      DEFAULT_OPTIONS.maxTerminalBytesPerTerminal,
    ),
    maxFiles: positiveOption(options.maxFiles, DEFAULT_OPTIONS.maxFiles),
    maxFilesBytes: positiveOption(options.maxFilesBytes, DEFAULT_OPTIONS.maxFilesBytes),
    maxFileBytes: positiveOption(options.maxFileBytes, DEFAULT_OPTIONS.maxFileBytes),
    maxPreviews: positiveOption(options.maxPreviews, DEFAULT_OPTIONS.maxPreviews),
    maxPreviewEvents: positiveOption(options.maxPreviewEvents, DEFAULT_OPTIONS.maxPreviewEvents),
  };
}
