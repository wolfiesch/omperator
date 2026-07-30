import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Terminal drawer

    @discardableResult
    func openTerminal(sessionId: String, cols: Int = 80, rows: Int = 24) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let ids = openTerminalIds[sessionId] ?? []
        guard ids.count < 4 else {
            lastError = "Terminal limit reached (4)."
            terminalErrors[sessionId] = "Terminal limit reached (4)."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "term.open",
                args: ["cols": .number(Double(cols)), "rows": .number(Double(rows))],
                sessionId: sessionId))
            let terminalId = try result.termOpenResult()
            openTerminalIds[sessionId, default: []].append(terminalId)
            activeTerminalId[sessionId] = terminalId
            terminalOutput[terminalId] = ""
            terminalErrors.removeValue(forKey: sessionId)
            t4log.notice("term.open \(terminalId, privacy: .public) for \(sessionId, privacy: .public)")
            return terminalId
        } catch {
            t4log.error("term.open failed: \(error)")
            lastError = "\(error)"
            terminalErrors[sessionId] = "\(error)"
            return nil
        }
    }

    func activeTerminal(sessionId: String) -> String? {
        activeTerminalId[sessionId]
    }

    func selectTerminal(sessionId: String, terminalId: String) {
        guard (openTerminalIds[sessionId] ?? []).contains(terminalId) else { return }
        activeTerminalId[sessionId] = terminalId
    }

    func sendTerminalInput(sessionId: String, data: String) async {
        guard let client, let terminalId = activeTerminalId[sessionId] else { return }
        let frame = TerminalInputFrame(
            hostId: hostId,
            sessionId: sessionId,
            terminalId: terminalId,
            data: data
        )
        try? await client.sendFrame(frame)
    }

    func resizeTerminal(sessionId: String, cols: Int, rows: Int) async {
        guard let client, let terminalId = activeTerminalId[sessionId] else { return }
        let frame = TerminalResizeFrame(
            hostId: hostId,
            sessionId: sessionId,
            terminalId: terminalId,
            cols: cols,
            rows: rows
        )
        try? await client.sendFrame(frame)
    }

    func closeTerminal(sessionId: String, reason: String? = nil) async {
        guard let terminalId = activeTerminalId[sessionId] else { return }
        await closeTerminal(terminalId: terminalId, reason: reason)
    }

    func closeTerminal(terminalId: String, reason: String? = nil) async {
        guard let sessionId = openTerminalIds.first(where: { $0.value.contains(terminalId) })?.key else {
            return
        }
        if let client {
            let frame = TerminalCloseFrame(
                hostId: hostId,
                sessionId: sessionId,
                terminalId: terminalId,
                reason: reason
            )
            try? await client.sendFrame(frame)
        }
        removeTerminal(terminalId, sessionId: sessionId)
    }

    private func removeTerminal(_ terminalId: String, sessionId: String) {
        var ids = openTerminalIds[sessionId] ?? []
        guard let removed = ids.firstIndex(where: { $0 == terminalId }) else { return }
        ids.remove(at: removed)
        terminalOutput.removeValue(forKey: terminalId)
        terminalExits.removeValue(forKey: terminalId)
        if ids.isEmpty {
            openTerminalIds.removeValue(forKey: sessionId)
            activeTerminalId.removeValue(forKey: sessionId)
        } else {
            openTerminalIds[sessionId] = ids
            if activeTerminalId[sessionId] == nil || activeTerminalId[sessionId] == terminalId {
                activeTerminalId[sessionId] = ids[min(removed, ids.count - 1)]
            }
        }
    }

    func clearTerminal(sessionId: String) {
        for terminalId in openTerminalIds[sessionId] ?? [] {
            terminalOutput.removeValue(forKey: terminalId)
            terminalExits.removeValue(forKey: terminalId)
        }
        openTerminalIds.removeValue(forKey: sessionId)
        activeTerminalId.removeValue(forKey: sessionId)
        terminalErrors.removeValue(forKey: sessionId)
    }
}
