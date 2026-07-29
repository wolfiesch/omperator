import Testing
@testable import HostWire

struct LiveTranscriptTests {
    @Test func assistantBufferRevealsWholeGraphemesAndCatchesUp() {
        var buffer = StreamingAssistantBuffer()
        buffer.receive(text: "A👨‍👩‍👧‍👦B", reasoning: "💭")

        buffer.advance(maxCatchUpFrames: 100)
        #expect(buffer.text == "A")
        #expect(buffer.reasoning == "💭")

        buffer.advance(maxCatchUpFrames: 100)
        #expect(buffer.text == "A👨‍👩‍👧‍👦")
        buffer.advance(maxCatchUpFrames: 100)
        #expect(buffer.text == "A👨‍👩‍👧‍👦B")
        #expect(buffer.isCaughtUp)
    }

    @Test func assistantBufferAppliesCorrectionsWithoutAnimatingInvalidText() {
        var buffer = StreamingAssistantBuffer(text: "old")
        buffer.receive(text: "new", reasoning: "")
        #expect(buffer.text == "new")
        #expect(buffer.isCaughtUp)
    }

    @Test func assistantBufferHandlesBurstyMarkdownCodeAndEmoji() {
        var buffer = StreamingAssistantBuffer()
        buffer.receive(text: "# Result\n", reasoning: "Checking…")
        buffer.advance(maxCatchUpFrames: 12)
        buffer.receive(
            text: "# Result\n\n👨‍👩‍👧‍👦 café\n```swift\nprint(\"✅\")\n```",
            reasoning: "Checking… done"
        )

        var frames: [String] = [buffer.text]
        while buffer.advance(maxCatchUpFrames: 12) {
            frames.append(buffer.text)
        }
        frames.append(buffer.text)

        #expect(buffer.text == "# Result\n\n👨‍👩‍👧‍👦 café\n```swift\nprint(\"✅\")\n```")
        #expect(buffer.reasoning == "Checking… done")
        #expect(frames.count > 2)
        for (before, after) in zip(frames, frames.dropFirst()) {
            #expect(after.hasPrefix(before))
        }
    }

    @Test func toolProjectionFollowsGenerationExecutionAndSettlement() {
        var projection = LiveToolProjection()
        projection.apply(event("tool.input.update", [
            "callId": .string("call-1"),
            "tool": .string("bash"),
            "input": .string("{\"cmd\":\"pn"),
        ]))
        projection.apply(event("tool.input.update", [
            "callId": .string("call-1"),
            "tool": .string("bash"),
            "input": .string("{\"cmd\":\"pnpm test\"}"),
        ]))

        #expect(projection.calls.first?.input.isEmpty == true)
        #expect(projection.calls.first?.phase == .generating)
        while projection.advance() {}
        #expect(projection.calls.first?.input == "{\"cmd\":\"pnpm test\"}")

        projection.apply(event("tool.start", [
            "callId": .string("call-1"),
            "tool": .string("bash"),
            "title": .string("Run tests"),
            "args": .object(["cmd": .string("pnpm test")]),
        ]))
        projection.apply(event("tool.progress", [
            "callId": .string("call-1"),
            "note": .string("working"),
        ]))
        projection.apply(event("tool.result", [
            "callId": .string("call-1"),
            "ok": .bool(true),
            "result": .object(["status": .string("passed")]),
        ]))

        let call = projection.calls.first
        #expect(call?.title == "Run tests")
        #expect(call?.input.contains("pnpm test") == true)
        #expect(call?.progress == "working")
        #expect(call?.result.contains("passed") == true)
        #expect(call?.phase == .succeeded)

        projection.remove(callId: "call-1")
        #expect(projection.calls.isEmpty)
    }

    @Test func toolStartDoesNotJumpPastPendingArgumentFrames() {
        var projection = LiveToolProjection()
        projection.apply(event("tool.input.update", [
            "callId": .string("call-1"),
            "tool": .string("bash"),
            "input": .string("{\"cmd\":\"p"),
        ]))
        projection.advance()
        let partial = projection.calls.first?.input

        projection.apply(event("tool.start", [
            "callId": .string("call-1"),
            "tool": .string("bash"),
            "args": .object(["cmd": .string("pnpm verify:affected")]),
        ]))

        #expect(projection.calls.first?.input == partial)
        #expect(projection.isCaughtUp == false)
        while projection.advance() {}
        #expect(projection.calls.first?.input.contains("pnpm verify:affected") == true)
    }

    @Test func largeToolArgumentsStayBoundedAndFinishWithoutDuplicates() {
        var projection = LiveToolProjection()
        let large = String(repeating: "x", count: 70_000)
        let update = event("tool.input.update", [
            "callId": .string("call-large"),
            "tool": .string("write"),
            "input": .string(large),
        ])
        projection.apply(update)
        projection.apply(update)
        while projection.advance() {}

        #expect(projection.calls.count == 1)
        #expect(projection.calls.first?.input.count == 65_536)
        #expect(projection.calls.first?.input.hasPrefix("…") == true)
        #expect(projection.isCaughtUp)

        projection.apply(event("tool.result", [
            "callId": .string("call-large"),
            "ok": .bool(true),
            "result": .string(large),
        ]))
        #expect(projection.calls.first?.result.count == 65_536)
        #expect(projection.calls.first?.result.hasPrefix("…") == true)
    }

    @Test func liveTurnPreservesThinkingTextAndToolBlockOrder() {
        var timeline = LiveTurnTimeline()
        timeline.apply(block(entryId: "assistant-1", index: 2, kind: "tool-input",
                             content: "{\"content\":\"hello\"}", callId: "call-1", tool: "write"))
        timeline.apply(block(entryId: "assistant-1", index: 0, kind: "thinking",
                             content: "Checking"))
        timeline.apply(block(entryId: "assistant-1", index: 1, kind: "text",
                             content: "I will update it."))

        #expect(timeline.blocks.map(\.kind) == [.thinking, .text, .toolInput])
        #expect(timeline.blocks.map(\.blockIndex) == [0, 1, 2])
    }

    @Test func liveTurnRevealsWholeGraphemesAndDoesNotDuplicateSnapshots() {
        var timeline = LiveTurnTimeline()
        let update = block(entryId: "assistant-1", index: 0, kind: "text",
                           content: "A👨‍👩‍👧‍👦B")
        timeline.apply(update)
        timeline.apply(update)

        #expect(timeline.blocks.count == 1)
        timeline.advance(maxCatchUpFrames: 100)
        #expect(timeline.blocks[0].content == "A")
        timeline.advance(maxCatchUpFrames: 100)
        #expect(timeline.blocks[0].content == "A👨‍👩‍👧‍👦")
        timeline.advance(maxCatchUpFrames: 100)
        #expect(timeline.blocks[0].content == "A👨‍👩‍👧‍👦B")
        #expect(timeline.isCaughtUp)
    }

    @Test func liveWritePreviewGrowsBeforeArgumentsFormValidJSON() {
        var timeline = LiveTurnTimeline()
        timeline.apply(block(
            entryId: "assistant-1",
            index: 0,
            kind: "tool-input",
            content: "{\"path\":\"notes.md\",\"content\":\"Hello\\nwor",
            callId: "call-write",
            tool: "write"
        ))
        while timeline.advance(maxCatchUpFrames: 100) {}

        #expect(timeline.blocks[0].previewText == "Hello\nwor")

        timeline.apply(block(
            entryId: "assistant-1",
            index: 0,
            kind: "tool-input",
            content: "{\"path\":\"notes.md\",\"content\":\"Hello\\nworld\"}",
            callId: "call-write",
            tool: "write"
        ))
        while timeline.advance(maxCatchUpFrames: 100) {}
        #expect(timeline.blocks[0].previewText == "Hello\nworld")
    }

    @Test func liveTurnKeepsMultipleToolCallsAndStartDoesNotSnapInput() {
        var timeline = LiveTurnTimeline()
        timeline.apply(block(entryId: "assistant-1", index: 0, kind: "tool-input",
                             content: "{\"content\":\"first\"}", callId: "call-1", tool: "write"))
        timeline.apply(block(entryId: "assistant-1", index: 1, kind: "tool-input",
                             content: "{\"content\":\"second\"}", callId: "call-2", tool: "write"))
        timeline.advance(maxCatchUpFrames: 100)
        let partial = timeline.blocks[0].content

        #expect(timeline.blocks.count == 2)
        let applied = timeline.applyToolLifecycle(event("tool.start", [
            "callId": .string("call-1"),
            "tool": .string("write"),
            "title": .string("Write notes.md"),
            "args": .object(["content": .string("first")]),
        ]))
        #expect(applied)
        #expect(timeline.blocks[0].content == partial)
        #expect(timeline.blocks[0].phase == .running)
        #expect(timeline.blocks[0].title == "Write notes.md")
        #expect(timeline.blocks[1].toolCallId == "call-2")
    }

    private func block(
        entryId: String,
        index: Int,
        kind: String,
        content: String,
        callId: String? = nil,
        tool: String? = nil
    ) -> SessionEvent {
        var fields: [String: JSONValue] = [
            "entryId": .string(entryId),
            "blockIndex": .number(Double(index)),
            "blockKind": .string(kind),
            "content": .string(content),
        ]
        if let callId { fields["callId"] = .string(callId) }
        if let tool { fields["tool"] = .string(tool) }
        return event("assistant.block.update", fields)
    }

    private func event(_ type: String, _ fields: [String: JSONValue]) -> SessionEvent {
        SessionEvent(type: type, fields: ["type": .string(type)].merging(fields) { _, new in new })
    }
}
