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

    private func event(_ type: String, _ fields: [String: JSONValue]) -> SessionEvent {
        SessionEvent(type: type, fields: ["type": .string(type)].merging(fields) { _, new in new })
    }
}
