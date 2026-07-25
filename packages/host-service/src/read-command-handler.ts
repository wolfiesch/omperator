import {
  decodeCommandArguments,
  decodeUsageReadResult,
  type CommandFrame,
  type HostId,
  type ResultFrame,
  type SessionImageReadArguments,
  type TranscriptContextArguments,
  type TranscriptPageArguments,
  type TranscriptPageResult,
  type TranscriptSearchArguments,
  type UsageReadResult,
} from "@t4-code/host-wire";
import { AgentTranscriptProjection } from "./agent-transcript-projection.ts";
import { ArtifactReadError, ArtifactReader } from "./artifact-reader.ts";
import { SessionProjection } from "./projection.ts";
import { TranscriptImageError, TranscriptImageReader } from "./transcript-image-reader.ts";
import { TranscriptPageError } from "./transcript-page-reader.ts";
import type {
  AppserverTranscriptSearchAuthority,
  AppserverUsageAuthority,
  CommandOutcome,
  SessionDiscovery,
  SessionRecord,
} from "./types.ts";

export type ReadCommandName =
  | "transcript.page"
  | "transcript.search"
  | "transcript.context"
  | "usage.read"
  | "session.image.read"
  | "artifact.read";

export type ReadCommandFrame = CommandFrame & { command: ReadCommandName };

type ResponseFactory = (
  command: CommandFrame,
  ok: boolean,
  result?: unknown,
  error?: { code: string; message: string; details?: Record<string, unknown> },
) => ResultFrame;

export interface ReadCommandExecutionContext {
  readonly hostId: HostId;
  readonly response: ResponseFactory;
  readonly discovery: SessionDiscovery;
  readonly transcriptSearch?: AppserverTranscriptSearchAuthority;
  readonly usageAuthority?: AppserverUsageAuthority;
  readonly usageReadTimeoutMs: number;
  readonly transcriptImages?: TranscriptImageReader;
  readonly artifacts: ArtifactReader;
  readonly record: () => SessionRecord | undefined;
  readonly projection?: SessionProjection;
  readonly agentTranscript: () => AgentTranscriptProjection | undefined;
  readonly attached: () => boolean;
  readonly agentTranscriptEnabled: () => boolean;
}

export function isReadCommand(command: CommandFrame): command is ReadCommandFrame {
  return (
    command.command === "transcript.page" ||
    command.command === "transcript.search" ||
    command.command === "transcript.context" ||
    command.command === "usage.read" ||
    command.command === "session.image.read" ||
    command.command === "artifact.read"
  );
}

async function raceAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("operation aborted");
  const gate = Promise.withResolvers<T>();
  const onAbort = (): void => gate.reject(new Error("operation aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  operation.then(gate.resolve, gate.reject);
  try {
    return await gate.promise;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function executeReadCommand(
  context: ReadCommandExecutionContext,
  command: ReadCommandFrame,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  switch (command.command) {
    case "transcript.page": {
      if (!context.discovery.page)
        return {
          frame: context.response(command, false, undefined, {
            code: "unsupported",
            message: "transcript paging is unavailable",
          }),
        };
      const args = decodeCommandArguments(
        command.command,
        command.args,
      ) as unknown as TranscriptPageArguments;
      const record = context.record();
      if (!record) throw new TranscriptPageError("transcript_page_unavailable");
      const authorityResult = await context.discovery.page(record, args);
      const result: TranscriptPageResult = {
        ...authorityResult,
        entries: authorityResult.entries.map((entry) => ({
          ...entry,
          hostId: context.hostId,
          sessionId: command.sessionId!,
        })),
      };
      return { frame: context.response(command, true, result) };
    }
    case "transcript.search": {
      if (!context.transcriptSearch)
        return {
          frame: context.response(command, false, undefined, {
            code: "unsupported",
            message: "transcript search is unavailable",
          }),
        };
      const args = decodeCommandArguments(
        command.command,
        command.args,
      ) as unknown as TranscriptSearchArguments;
      const result = await context.transcriptSearch.search(args, signal);
      return { frame: context.response(command, true, result) };
    }
    case "transcript.context": {
      if (!context.transcriptSearch)
        return {
          frame: context.response(command, false, undefined, {
            code: "unsupported",
            message: "transcript context is unavailable",
          }),
        };
      const args = decodeCommandArguments(
        command.command,
        command.args,
      ) as unknown as TranscriptContextArguments;
      const result = await context.transcriptSearch.context(command.sessionId!, args, signal);
      return { frame: context.response(command, true, result) };
    }
    case "usage.read": {
      if (!context.usageAuthority)
        return {
          frame: context.response(command, false, undefined, {
            code: "unsupported",
            message: "usage reading is unavailable",
          }),
        };
      const timeoutSignal = AbortSignal.timeout(context.usageReadTimeoutMs);
      const usageSignal = AbortSignal.any([signal, timeoutSignal]);
      try {
        const result: UsageReadResult = decodeUsageReadResult(
          await raceAbortSignal(context.usageAuthority.read(usageSignal), usageSignal),
        );
        return { frame: context.response(command, true, result) };
      } catch {
        const code = signal.aborted
          ? "aborted"
          : timeoutSignal.aborted
            ? "timeout"
            : "usage_unavailable";
        return {
          frame: context.response(command, false, undefined, {
            code,
            message: code === "timeout" ? "usage read timed out" : "usage read failed",
          }),
        };
      }
    }
    case "session.image.read": {
      if (!context.attached())
        throw new TranscriptImageError(
          "session_not_attached",
          "session must be attached before reading images",
        );
      if (!context.transcriptImages)
        throw new TranscriptImageError(
          "image_not_found",
          "transcript image reading is unavailable",
        );
      const args = decodeCommandArguments(
        command.command,
        command.args,
      ) as unknown as SessionImageReadArguments;
      let metadata = context.projection!.transcriptImage(args.entryId, args.sha256);
      if (!metadata && context.agentTranscriptEnabled())
        metadata = context.agentTranscript()?.transcriptImage(args.entryId, args.sha256);
      if (!metadata)
        throw new TranscriptImageError(
          "image_not_found",
          "transcript entry does not contain the requested image",
        );
      const result = await context.transcriptImages.read(
        metadata.sha256,
        metadata.mimeType,
        args.offset,
        signal,
      );
      return { frame: context.response(command, true, result) };
    }
    case "artifact.read": {
      if (!context.attached())
        throw new ArtifactReadError(
          "session_not_attached",
          "session must be attached before reading artifacts",
        );
      const args = decodeCommandArguments(command.command, command.args) as {
        artifactId: string;
        offset: number;
      };
      let descriptor = context.projection!.artifact(args.artifactId);
      if (!descriptor && context.agentTranscriptEnabled())
        descriptor = context.agentTranscript()?.artifact(args.artifactId);
      if (!descriptor)
        throw new ArtifactReadError(
          "artifact_not_found",
          "artifact is not projected for this session",
        );
      const record = context.record();
      if (!record?.path.endsWith(".jsonl"))
        throw new ArtifactReadError("artifact_not_found", "artifact session is unavailable");
      const result = await context.artifacts.read(
        record.path.slice(0, -".jsonl".length),
        descriptor,
        args.offset,
        signal,
      );
      return { frame: context.response(command, true, result) };
    }
  }
}
