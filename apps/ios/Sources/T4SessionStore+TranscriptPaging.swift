import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Transcript paging

    func loadEarlier(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        if pagingState[sessionId]?.loading == true { return }
        if pagingState[sessionId]?.hasMore == false { return }

        var state = pagingState[sessionId]
            ?? TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
        state.loading = true
        pagingState[sessionId] = state

        var args: [String: JSONValue] = ["limit": .number(50)]
        if let before = state.nextCursor {
            args["before"] = .string(before)
        }

        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "transcript.page",
                args: args,
                sessionId: sessionId
            ))
            let page = try result.transcriptPageResult()
            let existing = liveEntries[sessionId] ?? []
            let existingIds = Set(existing.map { $0.id })
            let older = page.entries
                .map { TranscriptEntry(from: $0) }
                .filter { !existingIds.contains($0.id) }

            prependingSession = sessionId
            if !older.isEmpty {
                liveEntries[sessionId] = older + existing
            }
            pagingState[sessionId] = TranscriptPaging(
                nextCursor: page.nextCursor,
                hasMore: page.hasMore,
                loading: false
            )
            Task { @MainActor in prependingSession = nil }
        } catch {
            t4log.error("transcript.page failed: \(error)")
            lastError = "\(error)"
            var failed = pagingState[sessionId]
                ?? TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
            failed.loading = false
            pagingState[sessionId] = failed
            Task { @MainActor in prependingSession = nil }
        }
    }
}
