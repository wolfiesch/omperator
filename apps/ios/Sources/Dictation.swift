//  Dictation.swift
//  On-device speech-to-text for the composer. Live partial results stream into
//  the draft as you talk; tap the mic again to stop. Microphone only — the
//  simulator has none, so this is a device feature.

import Foundation
import Speech
import AVFoundation

@MainActor
final class Dictation: ObservableObject {
    @Published private(set) var recording = false

    /// Called on the main actor with the latest transcript as it grows.
    var onText: ((String) -> Void)?

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle() { recording ? stop() : start() }

    func start() {
        guard !recording else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { return }
            Task { @MainActor in self.begin() }
        }
    }

    private func begin() {
        guard let recognizer, recognizer.isAvailable else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch { return }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch { teardown(); return }

        recording = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                Task { @MainActor in self.onText?(text) }
            }
            if error != nil || (result?.isFinal ?? false) {
                Task { @MainActor in self.stop() }
            }
        }
    }

    func stop() {
        guard recording else { return }
        teardown()
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func teardown() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }
}
