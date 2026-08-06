import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Terminal drawer

    @discardableResult
    func openTerminal(sessionId: String, cols: Int = 80, rows: Int = 24) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode {
                // Offline captures: a finished local session, pre-rendered.
                let terminalId = "demo-terminal"
                openTerminalIds[sessionId] = [terminalId]
                activeTerminalId[sessionId] = terminalId
                terminalOutput[terminalId] = Self.sampleTerminalSession
                terminalErrors.removeValue(forKey: sessionId)
                return terminalId
            }
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

// MARK: - Demo terminal (offline captures)

extension T4SessionStore {
    /// A finished local shell session for the demo terminal drawer: recent
    /// git history plus the anchor test run, ANSI-colored like a real PTY.
    static var sampleTerminalSession: String {
        let g = "\u{1B}[32m"   // green
        let b = "\u{1B}[1m"    // bold
        let d = "\u{1B}[2m"    // dim
        let r = "\u{1B}[0m"    // reset
        return """
        \(b)alexis@studio-mac\(r) \(d)~/dev/omperator/apps/linux\(r) $ git log --oneline -5
        3f66c11 feat: add portable agent platform v1 (#101)
        61aa28c fix(host): harden working-tree diffs and binary relocation (#102)
        f18b234 fix(ios): stabilize streaming proof fixture (#100)
        534a4ed revert: reconcile main after #97 (#99)
        236fa1e T4 Code everywhere: native iOS, native macOS, and a real terminal client (#97)
        \(b)alexis@studio-mac\(r) \(d)~/dev/omperator/apps/linux\(r) $ swift test --filter AnchorTests
        Test Suite 'AnchorTests' started at 2026-08-05 09:16:12
        \(g)✔\(r) opensPinnedToBottom (0.412s)
        \(g)✔\(r) anchorReleasesOnScrollUp (0.377s)
        \(g)✔\(r) anchorReengagesNearBottom (0.388s)
        \(g)✔ Test run with 3 tests passed\(r) after 1.177s
        \(b)alexis@studio-mac\(r) \(d)~/dev/omperator/apps/linux\(r) $ 

        """
    }
}
