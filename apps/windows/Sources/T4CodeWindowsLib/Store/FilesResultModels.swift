//  FilesResultModels.swift
//  Wire result models for files.search / files.diff, shared by the store
//  (T4SessionStore+Files.swift) and the search pane. Extracted from
//  T4SearchPane.swift so the Linux client (which ports views separately) can
//  compile the store layer without the SwiftUI pane.

import Foundation
import HostWire

/// One files.search match (host-wire/src/project-file-search.ts
/// `ProjectFileSearchMatch`). The wire shape carries only `path`.
struct FilesSearchMatch: Identifiable, Equatable {
    let path: String
    var id: String { path }
}

/// files.search result body: `{ matches: [{path}], truncated }`.
struct FilesSearchResult: Equatable {
    let matches: [FilesSearchMatch]
    let truncated: Bool
}

/// One row of a turn review snapshot's `changes` array
/// (host-wire/src/files-review.ts `TurnFileChange`).
struct TurnFileChange: Identifiable, Equatable {
    let path: String
    let status: String   // added|modified|deleted|renamed|copied|untracked
    let kind: String     // text|binary|huge|missing
    let additions: Int
    let deletions: Int
    var id: String { path }
}

/// files.diff result. `patchText` is the unified diff (from the `{diff}`
/// shape, or read from the turn snapshot's patch artifact). `changes` is the
/// turn review snapshot's change list (empty for the `{diff}` shape).
struct FilesDiffResult: Equatable {
    let patchText: String?
    let changes: [TurnFileChange]
}
