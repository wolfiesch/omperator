/// The only protocol version accepted by the pinned app-wire 0.6.1 client.
const String ompAppProtocolVersion = 'omp-app/1';

/// A decoding failure at the application wire boundary.
final class WireFormatException implements FormatException {
  const WireFormatException(this.message, [this.path]);

  @override
  final String message;

  /// Dot/bracket path of the invalid value, when one is available.
  final String? path;

  @override
  int? get offset => null;

  @override
  Object? get source => null;

  @override
  String toString() => path == null
      ? 'WireFormatException: $message'
      : 'WireFormatException at $path: $message';
}

/// A cursor in a session's transcript stream.
///
/// This is deliberately not assignable to [SessionIndexCursor].
final class TranscriptCursor {
  const TranscriptCursor({required this.epoch, required this.seq});

  final String epoch;
  final int seq;

  @override
  bool operator ==(Object other) =>
      other is TranscriptCursor && other.epoch == epoch && other.seq == seq;

  @override
  int get hashCode => Object.hash(epoch, seq);
}

/// A cursor in the host-wide session-index stream.
///
/// Session-index sequence numbers must never be compared with transcript
/// sequence numbers.
final class SessionIndexCursor {
  const SessionIndexCursor({required this.epoch, required this.seq});

  final String epoch;
  final int seq;

  @override
  bool operator ==(Object other) =>
      other is SessionIndexCursor && other.epoch == epoch && other.seq == seq;

  @override
  int get hashCode => Object.hash(epoch, seq);
}

final class ClientIdentity {
  const ClientIdentity({
    required this.name,
    required this.version,
    required this.build,
    required this.platform,
  });

  final String name;
  final String version;
  final String build;
  final String platform;
}

final class DeviceAuthentication {
  const DeviceAuthentication({
    required this.deviceId,
    required this.deviceToken,
  });

  final String deviceId;
  final String deviceToken;
}

final class SavedCursor {
  const SavedCursor({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
}

/// Immutable projection of a session-index item.
final class SessionRef {
  const SessionRef({
    required this.hostId,
    required this.sessionId,
    required this.title,
    required this.revision,
    required this.status,
    required this.updatedAt,
    required this.project,
    required this.raw,
  });

  final String hostId;
  final String sessionId;
  final String title;
  final String revision;
  final String status;
  final String updatedAt;
  final Map<String, Object?> project;
  final Map<String, Object?> raw;
}

/// Immutable durable transcript entry.
final class DurableEntry {
  const DurableEntry({
    required this.id,
    required this.parentId,
    required this.hostId,
    required this.sessionId,
    required this.kind,
    required this.timestamp,
    required this.data,
    required this.raw,
  });

  final String id;
  final String? parentId;
  final String hostId;
  final String sessionId;
  final String kind;
  final String timestamp;
  final Map<String, Object?> data;
  final Map<String, Object?> raw;
}

/// Base type for the modeled omp-app/1 application-frame union.
sealed class WireFrame {
  const WireFrame({required this.raw});

  /// The complete, recursively immutable decoded frame, including additive
  /// fields not understood by this client version.
  final Map<String, Object?> raw;
}

final class WelcomeFrame extends WireFrame {
  const WelcomeFrame({
    required this.hostId,
    required this.resumed,
    required this.selectedProtocol,
    required this.epoch,
    required this.authentication,
    required this.grantedCapabilities,
    required this.grantedFeatures,
    required this.negotiatedLimits,
    required super.raw,
  });

  final String hostId;
  final bool resumed;
  final String selectedProtocol;
  final String epoch;
  final String authentication;
  final List<String> grantedCapabilities;
  final List<String> grantedFeatures;
  final Map<String, Object?> negotiatedLimits;
}

final class SessionsFrame extends WireFrame {
  const SessionsFrame({
    required this.hostId,
    required this.cursor,
    required this.sessions,
    required this.totalCount,
    required this.truncated,
    required super.raw,
  });

  final String? hostId;
  final SessionIndexCursor cursor;
  final List<SessionRef> sessions;
  final int totalCount;
  final bool truncated;
}

/// Typed result payload of host.list and session.list command responses.
final class SessionListResult {
  const SessionListResult({
    required this.cursor,
    required this.sessions,
    required this.totalCount,
    required this.truncated,
    required this.raw,
  });

  final SessionIndexCursor cursor;
  final List<SessionRef> sessions;
  final int totalCount;
  final bool truncated;
  final Map<String, Object?> raw;
}

enum TranscriptSearchRole { user, assistant, summary }

enum TranscriptSearchIndexState { building, ready, stale }

final class TranscriptSearchHighlight {
  const TranscriptSearchHighlight({required this.start, required this.end});

  final int start;
  final int end;
}

final class TranscriptSearchItem {
  const TranscriptSearchItem({
    required this.sessionId,
    required this.projectId,
    required this.sessionTitle,
    required this.anchorId,
    required this.role,
    required this.timestamp,
    required this.snippet,
    required this.highlights,
    this.archivedAt,
  });

  final String sessionId;
  final String projectId;
  final String sessionTitle;
  final String? archivedAt;
  final String anchorId;
  final TranscriptSearchRole role;
  final String timestamp;
  final String snippet;
  final List<TranscriptSearchHighlight> highlights;
}

final class TranscriptSearchIndexStatus {
  const TranscriptSearchIndexStatus({
    required this.state,
    required this.indexedSessions,
    required this.knownSessions,
    required this.generation,
  });

  final TranscriptSearchIndexState state;
  final int indexedSessions;
  final int knownSessions;
  final String generation;
}

final class TranscriptSearchResult {
  const TranscriptSearchResult({
    required this.items,
    required this.incomplete,
    required this.index,
    this.nextCursor,
  });

  final List<TranscriptSearchItem> items;
  final String? nextCursor;
  final bool incomplete;
  final TranscriptSearchIndexStatus index;
}

final class TranscriptPageResult {
  const TranscriptPageResult({
    required this.entries,
    required this.hasMore,
    required this.generation,
    this.nextCursor,
  });

  final List<DurableEntry> entries;
  final String? nextCursor;
  final bool hasMore;
  final String generation;
}

final class TranscriptContextRow {
  const TranscriptContextRow({
    required this.anchorId,
    required this.role,
    required this.timestamp,
    required this.text,
  });

  final String anchorId;
  final TranscriptSearchRole role;
  final String timestamp;
  final String text;
}

final class TranscriptContextResult {
  const TranscriptContextResult({
    required this.anchorId,
    required this.rows,
    required this.anchorIndex,
    required this.hasBefore,
    required this.hasAfter,
    required this.generation,
  });

  final String anchorId;
  final List<TranscriptContextRow> rows;
  final int anchorIndex;
  final bool hasBefore;
  final bool hasAfter;
  final String generation;
}

enum UsageUnit { percent, tokens, requests, usd, minutes, bytes, unknown }

enum UsageStatus { ok, warning, exhausted, unknown }

enum UsageAccountType { apiKey, oauth }

final class UsageWindow {
  const UsageWindow({
    required this.id,
    required this.label,
    this.durationMs,
    this.resetsAt,
  });

  final String id;
  final String label;
  final int? durationMs;
  final int? resetsAt;
}

final class UsageAmount {
  const UsageAmount({
    required this.unit,
    this.used,
    this.limit,
    this.remaining,
    this.usedFraction,
    this.remainingFraction,
  });

  final UsageUnit unit;
  final double? used;
  final double? limit;
  final double? remaining;
  final double? usedFraction;
  final double? remainingFraction;
}

final class UsageScope {
  const UsageScope({
    required this.provider,
    this.accountId,
    this.projectId,
    this.orgId,
    this.modelId,
    this.tier,
    this.windowId,
    this.shared,
  });

  final String provider;
  final String? accountId;
  final String? projectId;
  final String? orgId;
  final String? modelId;
  final String? tier;
  final String? windowId;
  final bool? shared;
}

final class UsageLimit {
  const UsageLimit({
    required this.id,
    required this.label,
    required this.scope,
    required this.amount,
    required this.notes,
    this.window,
    this.status,
  });

  final String id;
  final String label;
  final UsageScope scope;
  final UsageWindow? window;
  final UsageAmount amount;
  final UsageStatus? status;
  final List<String> notes;
}

final class UsageReport {
  const UsageReport({
    required this.provider,
    required this.fetchedAt,
    required this.limits,
    required this.notes,
    required this.metadata,
    this.availableResetCredits,
  });

  final String provider;
  final int fetchedAt;
  final List<UsageLimit> limits;
  final int? availableResetCredits;
  final List<String> notes;
  final Map<String, Object?> metadata;
}

final class UsageAccountWithoutReport {
  const UsageAccountWithoutReport({
    required this.provider,
    required this.type,
    this.email,
    this.accountId,
    this.projectId,
    this.enterpriseUrl,
    this.orgId,
    this.orgName,
  });

  final String provider;
  final UsageAccountType type;
  final String? email;
  final String? accountId;
  final String? projectId;
  final String? enterpriseUrl;
  final String? orgId;
  final String? orgName;
}

final class UsageCapacityWindow {
  const UsageCapacityWindow({
    required this.window,
    required this.accounts,
    required this.usedAccounts,
    required this.remainingAccounts,
    this.durationMs,
  });

  final String window;
  final int? durationMs;
  final int accounts;
  final double usedAccounts;
  final double remainingAccounts;
}

final class UsageReadResult {
  const UsageReadResult({
    required this.generatedAt,
    required this.reports,
    required this.accountsWithoutUsage,
    required this.capacity,
  });

  final int generatedAt;
  final List<UsageReport> reports;
  final List<UsageAccountWithoutReport> accountsWithoutUsage;
  final Map<String, List<UsageCapacityWindow>> capacity;
}

enum BrokerState { local, connected, missingToken, unreachable }

final class BrokerStatusResult {
  const BrokerStatusResult({
    required this.state,
    required this.generation,
    this.endpoint,
  });

  final BrokerState state;
  final int generation;
  final String? endpoint;
}

final class SnapshotFrame extends WireFrame {
  const SnapshotFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.revision,
    required this.entries,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
  final String revision;
  final List<DurableEntry> entries;
}

final class EntryFrame extends WireFrame {
  const EntryFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.revision,
    required this.entry,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
  final String revision;
  final DurableEntry entry;
}

final class EventFrame extends WireFrame {
  const EventFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.event,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;

  /// Raw immutable event payload. Unknown event subtypes are intentionally
  /// accepted as long as their `type` is a valid string.
  final Map<String, Object?> event;
}

final class WireResponseError {
  const WireResponseError({
    required this.code,
    required this.message,
    required this.details,
    required this.raw,
  });

  final String code;
  final String message;
  final Map<String, Object?>? details;
  final Map<String, Object?> raw;
}

final class CatalogResult {
  const CatalogResult({required this.revision, required this.items});

  final String revision;
  final List<CatalogItem> items;
}

final class SettingsResult {
  const SettingsResult({required this.revision, required this.settings});

  final String revision;
  final Map<String, Object?> settings;
}

final class SessionStateModel {
  const SessionStateModel({
    required this.id,
    required this.provider,
    required this.displayName,
    required this.selector,
    required this.role,
  });

  final String id;
  final String provider;
  final String? displayName;
  final String? selector;
  final String? role;
}

final class SessionStateResult {
  const SessionStateResult({
    required this.isStreaming,
    required this.isCompacting,
    required this.isPaused,
    required this.messageCount,
    required this.queuedMessageCount,
    required this.model,
    required this.thinking,
    required this.thinkingLevels,
    required this.thinkingSupported,
    required this.fast,
    required this.fastAvailable,
    required this.fastActive,
  });

  final bool isStreaming;
  final bool isCompacting;
  final bool isPaused;
  final int messageCount;
  final int queuedMessageCount;
  final SessionStateModel? model;
  final String? thinking;
  final List<String>? thinkingLevels;
  final bool? thinkingSupported;
  final bool? fast;
  final bool? fastAvailable;
  final bool? fastActive;
}

final class ResponseFrame extends WireFrame {
  const ResponseFrame({
    required this.requestId,
    required this.commandId,
    required this.hostId,
    required this.sessionId,
    required this.command,
    required this.ok,
    required this.result,
    required this.error,
    required super.raw,
  });

  final String requestId;
  final String? commandId;
  final String hostId;
  final String? sessionId;
  final String? command;
  final bool ok;
  final Object? result;
  final WireResponseError? error;

  /// Typed command products decoded at the wire boundary.
  SessionListResult? get sessionListResult =>
      result is SessionListResult ? result as SessionListResult : null;

  CatalogResult? get catalogResult =>
      result is CatalogResult ? result as CatalogResult : null;

  SettingsResult? get settingsResult =>
      result is SettingsResult ? result as SettingsResult : null;

  TranscriptSearchResult? get transcriptSearchResult =>
      result is TranscriptSearchResult
      ? result as TranscriptSearchResult
      : null;

  TranscriptContextResult? get transcriptContextResult =>
      result is TranscriptContextResult
      ? result as TranscriptContextResult
      : null;

  TranscriptPageResult? get transcriptPageResult =>
      result is TranscriptPageResult ? result as TranscriptPageResult : null;

  SessionStateResult? get sessionStateResult =>
      result is SessionStateResult ? result as SessionStateResult : null;

  UsageReadResult? get usageReadResult =>
      result is UsageReadResult ? result as UsageReadResult : null;

  BrokerStatusResult? get brokerStatusResult =>
      result is BrokerStatusResult ? result as BrokerStatusResult : null;
}

final class ErrorFrame extends WireFrame {
  const ErrorFrame({
    required this.code,
    required this.message,
    required this.requestId,
    required this.details,
    required super.raw,
  });

  final String code;
  final String message;
  final String? requestId;
  final Map<String, Object?>? details;
}

final class GapFrame extends WireFrame {
  const GapFrame({
    required this.hostId,
    required this.sessionId,
    required this.from,
    required this.to,
    required this.reason,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor from;
  final TranscriptCursor to;
  final String reason;
}

final class PingFrame extends WireFrame {
  const PingFrame({
    required this.nonce,
    required this.timestamp,
    required super.raw,
  });

  final String nonce;
  final String timestamp;
}

final class PongFrame extends WireFrame {
  const PongFrame({
    required this.nonce,
    required this.timestamp,
    required super.raw,
  });

  final String nonce;
  final String timestamp;
}

/// A server request for an explicit command authorization decision.
final class ConfirmationFrame extends WireFrame {
  const ConfirmationFrame({
    required this.confirmationId,
    required this.commandId,
    required this.hostId,
    required this.sessionId,
    required this.commandHash,
    required this.revision,
    required this.expiresAt,
    required this.summary,
    required this.preview,
    required super.raw,
  });

  final String confirmationId;
  final String commandId;
  final String hostId;
  final String? sessionId;
  final String commandHash;
  final String revision;
  final String expiresAt;
  final String summary;
  final String? preview;
}

/// Legacy aggregate agent frame retained by the pinned package union.
final class AgentFrame extends WireFrame {
  const AgentFrame({
    required this.hostId,
    required this.sessionId,
    required this.agentId,
    required this.state,
    required this.progress,
    required this.detail,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String agentId;
  final String state;
  final double? progress;
  final Map<String, Object?>? detail;
}

/// Legacy aggregate terminal frame retained by the pinned package union.
final class TerminalFrame extends WireFrame {
  const TerminalFrame({
    required this.hostId,
    required this.sessionId,
    required this.terminalId,
    required this.stream,
    required this.data,
    required this.exitCode,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String terminalId;
  final String stream;
  final String? data;
  final int? exitCode;
}

/// Legacy aggregate file frame retained by the pinned package union.
final class FilesFrame extends WireFrame {
  const FilesFrame({
    required this.hostId,
    required this.sessionId,
    required this.path,
    required this.content,
    required this.truncated,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String path;
  final String? content;
  final bool? truncated;
}

final class ReviewFrame extends WireFrame {
  const ReviewFrame({
    required this.hostId,
    required this.sessionId,
    required this.reviewId,
    required this.status,
    required this.path,
    required this.findings,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String reviewId;
  final String status;
  final String? path;
  final List<Map<String, Object?>> findings;
}

final class AuditFrame extends WireFrame {
  const AuditFrame({
    required this.hostId,
    required this.sessionId,
    required this.action,
    required this.actor,
    required this.timestamp,
    required this.detail,
    required super.raw,
  });

  final String hostId;
  final String? sessionId;
  final String action;
  final String actor;
  final String timestamp;
  final Map<String, Object?>? detail;
}

/// A successful pairing response. Pairing IDs are never confirmation IDs.
final class PairOkFrame extends WireFrame {
  const PairOkFrame({
    required this.requestId,
    required this.pairingId,
    required this.deviceId,
    required this.deviceName,
    required this.platform,
    required this.requestedCapabilities,
    required this.grantedCapabilities,
    required this.deviceToken,
    required this.expiresAt,
    required super.raw,
  });

  final String requestId;
  final String pairingId;
  final String deviceId;
  final String deviceName;
  final String platform;
  final List<String> requestedCapabilities;
  final List<String> grantedCapabilities;
  final String deviceToken;
  final String expiresAt;
}

final class PairErrorFrame extends WireFrame {
  const PairErrorFrame({
    required this.code,
    required this.message,
    required this.requestId,
    required super.raw,
  });

  final String code;
  final String message;
  final String? requestId;
}

final class ByeFrame extends WireFrame {
  const ByeFrame({
    required this.code,
    required this.reason,
    required this.retryable,
    required super.raw,
  });

  final String code;
  final String reason;
  final bool retryable;
}

sealed class WatchFrame extends WireFrame {
  const WatchFrame({
    required this.frameType,
    required this.hostId,
    required this.revision,
    required super.raw,
  });

  final String frameType;
  final String hostId;
  final String revision;
}

final class HostWatchFrame extends WatchFrame {
  const HostWatchFrame({
    required this.watchId,
    required this.cursor,
    required this.state,
    required super.hostId,
    required super.revision,
    required super.raw,
  }) : super(frameType: 'host.watch');

  final String watchId;
  final SessionIndexCursor cursor;
  final String state;
}

final class SessionWatchFrame extends WatchFrame {
  const SessionWatchFrame({
    required this.watchId,
    required this.sessionId,
    required this.cursor,
    required this.state,
    required super.hostId,
    required super.revision,
    required super.raw,
  }) : super(frameType: 'session.watch');

  final String watchId;
  final String sessionId;
  final TranscriptCursor cursor;
  final String state;
}

final class SessionStateFrame extends WatchFrame {
  const SessionStateFrame({
    required this.sessionId,
    required this.cursor,
    required this.state,
    required super.hostId,
    required super.revision,
    required super.raw,
  }) : super(frameType: 'session.state');

  final String sessionId;
  final TranscriptCursor cursor;
  final String state;
}

final class SessionDeltaFrame extends WatchFrame {
  const SessionDeltaFrame({
    required this.sessionId,
    required this.cursor,
    required this.upsert,
    required this.remove,
    required super.hostId,
    required super.revision,
    required super.raw,
  }) : super(frameType: 'session.delta');

  final String sessionId;
  final TranscriptCursor cursor;
  final SessionRef? upsert;
  final String? remove;
}

/// One of the controller or prompt lease server frames.
final class LeaseFrame extends WireFrame {
  const LeaseFrame({
    required this.frameType,
    required this.hostId,
    required this.sessionId,
    required this.leaseId,
    required this.cursor,
    required this.kind,
    required this.state,
    required this.owner,
    required this.expiresAt,
    required this.revision,
    required super.raw,
  });

  final String frameType;
  final String hostId;
  final String sessionId;
  final String leaseId;
  final TranscriptCursor cursor;
  final String kind;
  final String state;
  final String owner;
  final String expiresAt;
  final String? revision;
}

/// One of the five negotiated agent.* server frames.
final class AgentAdditiveFrame extends WireFrame {
  const AgentAdditiveFrame({
    required this.frameType,
    required this.hostId,
    required this.sessionId,
    required this.agentId,
    required this.cursor,
    required this.revision,
    required this.state,
    required this.lifecycle,
    required this.progress,
    required this.event,
    required this.detail,
    required this.data,
    required this.entries,
    required super.raw,
  });

  final String frameType;
  final String hostId;
  final String sessionId;
  final String agentId;
  final TranscriptCursor cursor;
  final String revision;
  final String? state;
  final String? lifecycle;
  final double? progress;
  final String? event;
  final Map<String, Object?>? detail;
  final Map<String, Object?>? data;
  final List<DurableEntry>? entries;
}

final class TerminalOutputFrame extends WireFrame {
  const TerminalOutputFrame({
    required this.hostId,
    required this.sessionId,
    required this.terminalId,
    required this.cursor,
    required this.stream,
    required this.data,
    required this.encoding,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String terminalId;
  final TranscriptCursor cursor;
  final String stream;
  final String data;
  final String? encoding;
}

final class TerminalExitFrame extends WireFrame {
  const TerminalExitFrame({
    required this.hostId,
    required this.sessionId,
    required this.terminalId,
    required this.cursor,
    required this.exitCode,
    required this.signal,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final String terminalId;
  final TranscriptCursor cursor;
  final int exitCode;
  final String? signal;
}

final class FileListEntry {
  const FileListEntry({
    required this.path,
    required this.kind,
    required this.size,
    required this.revision,
    required this.raw,
  });

  final String path;
  final String kind;
  final int? size;
  final String? revision;
  final Map<String, Object?> raw;
}

/// One of files.list, files.read, files.write, files.patch, or files.diff.
final class FilesAdditiveFrame extends WireFrame {
  const FilesAdditiveFrame({
    required this.frameType,
    required this.hostId,
    required this.sessionId,
    required this.path,
    required this.entries,
    required this.content,
    required this.encoding,
    required this.patch,
    required this.diff,
    required this.cursor,
    required this.revision,
    required this.fromRevision,
    required this.toRevision,
    required super.raw,
  });

  final String frameType;
  final String hostId;
  final String sessionId;
  final String path;
  final List<FileListEntry>? entries;
  final String? content;
  final String? encoding;
  final String? patch;
  final String? diff;
  final TranscriptCursor? cursor;
  final String? revision;
  final String? fromRevision;
  final String? toRevision;
}

final class AuditEvent {
  const AuditEvent({
    required this.eventId,
    required this.hostId,
    required this.sessionId,
    required this.action,
    required this.actor,
    required this.timestamp,
    required this.detail,
    required this.raw,
  });

  final String eventId;
  final String hostId;
  final String? sessionId;
  final String action;
  final String actor;
  final String timestamp;
  final Map<String, Object?>? detail;
  final Map<String, Object?> raw;
}

final class AuditTailFrame extends WireFrame {
  const AuditTailFrame({
    required this.hostId,
    required this.cursor,
    required this.events,
    required super.raw,
  });

  final String hostId;
  final TranscriptCursor cursor;
  final List<AuditEvent> events;
}

final class AuditEventFrame extends WireFrame {
  const AuditEventFrame({
    required this.hostId,
    required this.cursor,
    required this.event,
    required super.raw,
  });

  final String hostId;
  final TranscriptCursor cursor;
  final AuditEvent event;
}

final class CatalogItem {
  const CatalogItem({
    required this.id,
    required this.kind,
    required this.name,
    required this.description,
    required this.capabilities,
    required this.supported,
    required this.reason,
    required this.metadata,
    required this.raw,
  });

  final String id;
  final String kind;
  final String name;
  final String? description;
  final List<String>? capabilities;
  final bool? supported;
  final String? reason;
  final Map<String, Object?>? metadata;
  final Map<String, Object?> raw;
}

final class CatalogFrame extends WireFrame {
  const CatalogFrame({
    required this.hostId,
    required this.revision,
    required this.items,
    required super.raw,
  });

  final String hostId;
  final String revision;
  final List<CatalogItem> items;
}

final class SettingsFrame extends WireFrame {
  const SettingsFrame({
    required this.hostId,
    required this.revision,
    required this.settings,
    required super.raw,
  });

  final String hostId;
  final String revision;
  final Map<String, Object?> settings;
}

final class PreviewSnapshot {
  const PreviewSnapshot({
    required this.previewId,
    required this.state,
    required this.url,
    required this.revision,
    required this.cursor,
    required this.title,
    required this.canGoBack,
    required this.canGoForward,
    required this.viewport,
    required this.capture,
    required this.authority,
    required this.availableActions,
  });

  final String previewId;
  final String state;
  final String url;
  final String revision;
  final TranscriptCursor cursor;
  final String? title;
  final bool? canGoBack;
  final bool? canGoForward;
  final Map<String, Object?>? viewport;
  final Map<String, Object?>? capture;
  final Map<String, Object?>? authority;
  final List<String>? availableActions;
}

/// One of the five preview.* frames in AdditiveServerFrame.
final class PreviewFrame extends WireFrame {
  const PreviewFrame({
    required this.frameType,
    required this.hostId,
    required this.sessionId,
    required this.snapshot,
    required this.previewId,
    required this.cursor,
    required this.revision,
    required this.code,
    required this.message,
    required this.error,
    required super.raw,
  });

  final String frameType;
  final String hostId;
  final String sessionId;
  final PreviewSnapshot? snapshot;
  final String previewId;
  final TranscriptCursor cursor;
  final String revision;
  final String? code;
  final String? message;
  final String? error;
}
