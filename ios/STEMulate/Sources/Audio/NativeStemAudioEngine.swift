import AVFAudio
import AudioToolbox
import Combine
import Darwin
import Foundation

enum NativeAudioEngineError: LocalizedError, Equatable {
    case noStems
    case invalidJobID
    case invalidStemID(String)
    case duplicateStemID(String)
    case missingFile(String)
    case unsupportedFile(String)
    case unreadableFile(String)
    case misalignedStems
    case invalidLoop
    case invalidMetronomeTempo
    case notLoaded
    case audioSession(String)
    case engineStart(String)

    var errorDescription: String? {
        switch self {
        case .noStems:
            return "This song has no playable stems."
        case .invalidJobID:
            return "The song identifier is invalid."
        case .invalidStemID(let stemID):
            return "The stem identifier “\(stemID)” is invalid."
        case .duplicateStemID(let stemID):
            return "The stem “\(stemID)” was supplied more than once."
        case .missingFile(let stemID):
            return "The local \(stemID) file is missing."
        case .unsupportedFile(let stemID):
            return "The local \(stemID) file type is not supported."
        case .unreadableFile(let stemID):
            return "iOS could not decode the local \(stemID) file."
        case .misalignedStems:
            return "These stem files do not have matching timing."
        case .invalidLoop:
            return "The loop must be at least 0.25 seconds long."
        case .invalidMetronomeTempo:
            return "Set the metronome tempo between 20 and 400 BPM."
        case .notLoaded:
            return "Select a downloaded song first."
        case .audioSession(let detail):
            return "The iPhone audio session could not start. \(detail)"
        case .engineStart(let detail):
            return "The native audio engine could not start. \(detail)"
        }
    }
}

@MainActor
final class NativeStemAudioEngine: NSObject, ObservableObject {
    @Published private(set) var transportSnapshot = NativeTransportSnapshot.empty

    private final class StemRuntime {
        let descriptor: LocalStemFile
        let audioFile: AVAudioFile
        let player: AVAudioPlayerNode
        let channelMixer: AVAudioMixerNode
        let duration: TimeInterval
        let inputBus: AVAudioNodeBus

        init(
            descriptor: LocalStemFile,
            audioFile: AVAudioFile,
            player: AVAudioPlayerNode,
            channelMixer: AVAudioMixerNode,
            duration: TimeInterval,
            inputBus: AVAudioNodeBus
        ) {
            self.descriptor = descriptor
            self.audioFile = audioFile
            self.player = player
            self.channelMixer = channelMixer
            self.duration = duration
            self.inputBus = inputBus
        }
    }

    private struct PreparedStem {
        let descriptor: LocalStemFile
        let audioFile: AVAudioFile
        let duration: TimeInterval
        let sampleRate: Double
    }

    private static let schedulingLeadTime: TimeInterval = 0.12
    private static let metronomeInitialHorizon: TimeInterval = 15
    private static let metronomeExtensionInterval: TimeInterval = 5
    private static let metronomeExtensionHorizon: TimeInterval = 15
    private static let maximumAlignmentDifference: TimeInterval = 0.25
    private static let loopQueueDepth = 16

    private let audioSession = AVAudioSession.sharedInstance()

    private var engine = AVAudioEngine()
    private var stemBus = AVAudioMixerNode()
    private var timePitch = AVAudioUnitTimePitch()
    private var masterBus = AVAudioMixerNode()
    private var limiter = NativeStemAudioEngine.makePeakLimiter()
    private var metronomePlayer = AVAudioPlayerNode()
    private var metronomeMixer = AVAudioMixerNode()
    private var metronomeFormat = AVAudioFormat(
        standardFormatWithSampleRate: 48_000,
        channels: 1
    )!
    private var regularClickBuffer: AVAudioPCMBuffer?
    private var accentClickBuffer: AVAudioPCMBuffer?

    private var runtimes: [StemRuntime] = []
    private var runtimeByStemID: [String: StemRuntime] = [:]
    private var referenceStemID: String?
    private var loadedDeck: LocalStemDeck?

    private var playbackState: NativePlaybackState = .idle
    private var deckDuration: TimeInterval = 0
    private var anchorPosition: TimeInterval = 0
    private var playbackRate: Float = 1
    private var loopRange: StemLoopRange?
    private var channelStates: [String: StemChannelState] = [:]

    private var metronomeEnabled = false
    private var metronomeBPM: Double?
    private var metronomeBeatsPerBar = 4
    private var metronomeScheduledThrough: TimeInterval = 0

    private var schedulingGeneration = 0
    private var scheduledStartHostTime: UInt64?
    private var displayTimer: Timer?
    private var metronomeTimer: Timer?
    private var resumeAfterInterruption = false
    private var isRebuildingGraph = false

    override init() {
        super.init()
        configureCoreGraph(sampleRate: 48_000)
        installAudioNotifications()
        publishSnapshot()
    }

    func load(
        jobID: String,
        title: String,
        files: [LocalStemFile],
        initialChannels: [String: StemChannelState] = [:]
    ) throws {
        try load(
            deck: LocalStemDeck(jobID: jobID, title: title, stems: files),
            initialChannels: initialChannels
        )
    }

    func load(
        deck: LocalStemDeck,
        initialChannels: [String: StemChannelState] = [:]
    ) throws {
        do {
            let preparedStems = try prepare(deck: deck)
            try install(
                deck: deck,
                preparedStems: preparedStems,
                initialChannels: initialChannels
            )
        } catch {
            publishFailure(error)
            throw error
        }
    }

    func play() throws {
        guard loadedDeck != nil, !runtimes.isEmpty else {
            throw NativeAudioEngineError.notLoaded
        }
        guard playbackState != .playing else {
            return
        }

        if anchorPosition >= deckDuration - 0.001 {
            anchorPosition = loopRange?.start ?? 0
        }

        do {
            try scheduleAndStart(at: normalizedPlaybackStart(anchorPosition))
        } catch {
            publishFailure(error)
            throw error
        }
    }

    func pause() {
        guard playbackState == .playing else {
            return
        }
        pauseInternal(resultingState: .paused)
    }

    func seek(to position: TimeInterval) throws {
        guard loadedDeck != nil else {
            throw NativeAudioEngineError.notLoaded
        }

        let wasPlaying = playbackState == .playing
        if wasPlaying {
            stopScheduledNodes(capturingPosition: false)
        }

        anchorPosition = TransportMath.clampedPosition(position, duration: deckDuration)
        if playbackState == .ended {
            playbackState = .paused
        }

        if wasPlaying {
            do {
                try scheduleAndStart(at: normalizedPlaybackStart(anchorPosition))
            } catch {
                publishFailure(error)
                throw error
            }
        } else {
            publishSnapshot()
        }
    }

    func setPlaybackRate(_ rate: Float) throws {
        let normalizedRate = TransportMath.normalizedRate(rate)
        let wasPlaying = playbackState == .playing
        let position = currentPosition()

        if wasPlaying {
            stopScheduledNodes(capturingPosition: false)
        }

        playbackRate = normalizedRate
        timePitch.rate = normalizedRate
        anchorPosition = position

        if wasPlaying {
            do {
                try scheduleAndStart(at: normalizedPlaybackStart(position))
            } catch {
                publishFailure(error)
                throw error
            }
        } else {
            publishSnapshot()
        }
    }

    func setLoop(_ loop: StemLoopRange?) throws {
        let normalized = TransportMath.normalizedLoop(loop, duration: deckDuration)
        if loop != nil, normalized == nil {
            throw NativeAudioEngineError.invalidLoop
        }

        let wasPlaying = playbackState == .playing
        let position = currentPosition()
        if wasPlaying {
            stopScheduledNodes(capturingPosition: false)
        }

        loopRange = normalized
        anchorPosition = normalizedPlaybackStart(position)

        if wasPlaying {
            do {
                try scheduleAndStart(at: anchorPosition)
            } catch {
                publishFailure(error)
                throw error
            }
        } else {
            publishSnapshot()
        }
    }

    func setVolume(_ volume: Float, for stemID: String) {
        updateChannel(stemID) { state in
            state.volume = min(max(volume, 0), 1)
        }
    }

    func setPan(_ pan: Float, for stemID: String) {
        updateChannel(stemID) { state in
            state.pan = min(max(pan, -1), 1)
        }
    }

    func setMuted(_ muted: Bool, for stemID: String) {
        updateChannel(stemID) { state in
            state.isMuted = muted
        }
    }

    func setSoloed(_ soloed: Bool, for stemID: String) {
        updateChannel(stemID) { state in
            state.isSoloed = soloed
        }
    }

    func setChannelState(_ state: StemChannelState, for stemID: String) {
        guard channelStates[stemID] != nil else {
            return
        }
        channelStates[stemID] = state.normalized()
        applyChannelStates()
        publishSnapshot()
    }

    func setMetronome(
        enabled: Bool,
        bpm: Double?,
        beatsPerBar: Int = 4
    ) throws {
        if enabled {
            guard let bpm, bpm.isFinite, (20...400).contains(bpm) else {
                throw NativeAudioEngineError.invalidMetronomeTempo
            }
        }

        let wasPlaying = playbackState == .playing
        let position = currentPosition()
        if wasPlaying {
            stopScheduledNodes(capturingPosition: false)
        }

        metronomeEnabled = enabled
        metronomeBPM = bpm
        metronomeBeatsPerBar = min(max(beatsPerBar, 1), 12)
        applyMetronomeGainStaging()
        anchorPosition = position

        if wasPlaying {
            do {
                try scheduleAndStart(at: normalizedPlaybackStart(position))
            } catch {
                publishFailure(error)
                throw error
            }
        } else {
            publishSnapshot()
        }
    }

    func unload() {
        displayTimer?.invalidate()
        displayTimer = nil
        metronomeTimer?.invalidate()
        metronomeTimer = nil
        stopScheduledNodes(capturingPosition: false)
        engine.stop()
        detachStemNodes()

        loadedDeck = nil
        referenceStemID = nil
        deckDuration = 0
        anchorPosition = 0
        playbackRate = 1
        loopRange = nil
        channelStates = [:]
        metronomeEnabled = false
        metronomeBPM = nil
        playbackState = .idle
        timePitch.rate = 1
        transportSnapshot = .empty
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func prepare(deck: LocalStemDeck) throws -> [PreparedStem] {
        guard StemFileCache.isValidIdentifier(deck.jobID) else {
            throw NativeAudioEngineError.invalidJobID
        }
        guard !deck.stems.isEmpty else {
            throw NativeAudioEngineError.noStems
        }

        var seenStemIDs = Set<String>()
        let preparedStems = try deck.stems.map { descriptor -> PreparedStem in
            guard StemFileCache.isValidIdentifier(descriptor.stemID) else {
                throw NativeAudioEngineError.invalidStemID(descriptor.stemID)
            }
            guard seenStemIDs.insert(descriptor.stemID).inserted else {
                throw NativeAudioEngineError.duplicateStemID(descriptor.stemID)
            }
            guard descriptor.fileURL.isFileURL,
                  FileManager.default.fileExists(atPath: descriptor.fileURL.path)
            else {
                throw NativeAudioEngineError.missingFile(descriptor.stemID)
            }
            guard StemAudioContainer.detect(
                fileURL: descriptor.fileURL,
                contentType: descriptor.contentType
            ) != nil else {
                throw NativeAudioEngineError.unsupportedFile(descriptor.stemID)
            }

            do {
                let audioFile = try AVAudioFile(forReading: descriptor.fileURL)
                let format = audioFile.processingFormat
                let duration = TimeInterval(audioFile.length) / format.sampleRate
                guard audioFile.length > 0,
                      format.sampleRate > 0,
                      format.channelCount > 0,
                      duration.isFinite,
                      duration > 0
                else {
                    throw NativeAudioEngineError.unreadableFile(descriptor.stemID)
                }
                return PreparedStem(
                    descriptor: descriptor,
                    audioFile: audioFile,
                    duration: duration,
                    sampleRate: format.sampleRate
                )
            } catch let error as NativeAudioEngineError {
                throw error
            } catch {
                throw NativeAudioEngineError.unreadableFile(descriptor.stemID)
            }
        }

        guard let first = preparedStems.first else {
            throw NativeAudioEngineError.noStems
        }

        let shortestDuration = preparedStems.map(\.duration).min() ?? 0
        let longestDuration = preparedStems.map(\.duration).max() ?? 0
        let alignmentTolerance = max(
            Self.maximumAlignmentDifference,
            longestDuration * 0.002
        )
        let sampleRatesMatch = preparedStems.allSatisfy {
            abs($0.sampleRate - first.sampleRate) < 0.1
        }
        guard sampleRatesMatch,
              longestDuration - shortestDuration <= alignmentTolerance
        else {
            throw NativeAudioEngineError.misalignedStems
        }

        return preparedStems
    }

    private func install(
        deck: LocalStemDeck,
        preparedStems: [PreparedStem],
        initialChannels: [String: StemChannelState]
    ) throws {
        let previousRebuildingState = isRebuildingGraph
        isRebuildingGraph = true
        defer { isRebuildingGraph = previousRebuildingState }

        displayTimer?.invalidate()
        displayTimer = nil
        metronomeTimer?.invalidate()
        metronomeTimer = nil
        stopScheduledNodes(capturingPosition: false)
        engine.stop()
        detachStemNodes()

        var installedRuntimes: [StemRuntime] = []
        for (index, prepared) in preparedStems.enumerated() {
            let player = AVAudioPlayerNode()
            let channelMixer = AVAudioMixerNode()
            engine.attach(player)
            engine.attach(channelMixer)
            engine.connect(
                player,
                to: channelMixer,
                format: prepared.audioFile.processingFormat
            )
            engine.connect(
                channelMixer,
                to: stemBus,
                fromBus: 0,
                toBus: AVAudioNodeBus(index),
                format: nil
            )

            installedRuntimes.append(
                StemRuntime(
                    descriptor: prepared.descriptor,
                    audioFile: prepared.audioFile,
                    player: player,
                    channelMixer: channelMixer,
                    duration: prepared.duration,
                    inputBus: AVAudioNodeBus(index)
                )
            )
        }

        runtimes = installedRuntimes
        runtimeByStemID = Dictionary(
            uniqueKeysWithValues: installedRuntimes.map {
                ($0.descriptor.stemID, $0)
            }
        )
        referenceStemID = installedRuntimes.first?.descriptor.stemID
        loadedDeck = deck
        deckDuration = installedRuntimes.map(\.duration).min() ?? 0
        anchorPosition = 0
        playbackState = .ready
        playbackRate = 1
        loopRange = nil
        timePitch.rate = 1
        metronomeEnabled = false
        metronomeBPM = nil
        metronomeBeatsPerBar = 4
        channelStates = Dictionary(
            uniqueKeysWithValues: installedRuntimes.map { runtime in
                let state = initialChannels[runtime.descriptor.stemID]
                    ?? StemChannelState.defaultValue
                return (runtime.descriptor.stemID, state.normalized())
            }
        )
        applyChannelStates()
        applyMetronomeGainStaging()
        engine.prepare()
        publishSnapshot()
    }

    private func configureCoreGraph(sampleRate: Double) {
        let safeSampleRate = sampleRate > 0 ? sampleRate : 48_000
        metronomeFormat = AVAudioFormat(
            standardFormatWithSampleRate: safeSampleRate,
            channels: 1
        )!

        engine.attach(stemBus)
        engine.attach(timePitch)
        engine.attach(masterBus)
        engine.attach(limiter)
        engine.attach(metronomePlayer)
        engine.attach(metronomeMixer)

        engine.connect(stemBus, to: timePitch, format: nil)
        engine.connect(
            timePitch,
            to: masterBus,
            fromBus: 0,
            toBus: 0,
            format: nil
        )
        engine.connect(
            metronomePlayer,
            to: metronomeMixer,
            format: metronomeFormat
        )
        engine.connect(
            metronomeMixer,
            to: masterBus,
            fromBus: 0,
            toBus: 1,
            format: nil
        )
        engine.connect(masterBus, to: limiter, format: nil)
        engine.connect(limiter, to: engine.mainMixerNode, format: nil)

        timePitch.rate = playbackRate
        timePitch.pitch = 0
        timePitch.overlap = 8

        metronomeMixer.outputVolume = 1
        applyMetronomeGainStaging()
        regularClickBuffer = makeClickBuffer(
            frequency: 1_150,
            peak: 0.82,
            sampleRate: safeSampleRate
        )
        accentClickBuffer = makeClickBuffer(
            frequency: 1_700,
            peak: 0.98,
            sampleRate: safeSampleRate
        )
    }

    private func scheduleAndStart(at requestedPosition: TimeInterval) throws {
        try configureAndActivateAudioSession()

        if !engine.isRunning {
            engine.prepare()
            do {
                try engine.start()
            } catch {
                throw NativeAudioEngineError.engineStart(error.localizedDescription)
            }
        }

        stopScheduledNodes(capturingPosition: false)
        timePitch.rate = playbackRate
        applyMetronomeGainStaging()
        anchorPosition = normalizedPlaybackStart(requestedPosition)
        schedulingGeneration += 1
        let generation = schedulingGeneration

        for runtime in runtimes {
            try scheduleStem(runtime, generation: generation)
        }

        let startHostTime = mach_absolute_time()
            + AVAudioTime.hostTime(forSeconds: Self.schedulingLeadTime)
        let commonStartTime = AVAudioTime(hostTime: startHostTime)
        scheduledStartHostTime = startHostTime

        if metronomeEnabled, metronomeBPM != nil {
            metronomeScheduledThrough = 0
            scheduleMetronome(until: Self.metronomeInitialHorizon)
            metronomePlayer.play(at: commonStartTime)
            startMetronomeTimer()
        }

        for runtime in runtimes {
            runtime.player.play(at: commonStartTime)
        }

        playbackState = .playing
        startDisplayTimer()
        publishSnapshot()
    }

    private func scheduleStem(
        _ runtime: StemRuntime,
        generation: Int
    ) throws {
        let position = normalizedPlaybackStart(anchorPosition)

        if let loopRange {
            let firstStart = max(position, 0)
            let firstEnd = loopRange.end
            try scheduleLoopSegment(
                runtime,
                start: firstStart,
                end: firstEnd,
                generation: generation
            )
            // Completion callbacks hop off the real-time audio thread before
            // touching MainActor state. Keep several complete cycles queued so
            // even a short loop cannot underrun during a busy UI frame.
            for _ in 0..<Self.loopQueueDepth {
                try scheduleLoopSegment(
                    runtime,
                    start: loopRange.start,
                    end: loopRange.end,
                    generation: generation
                )
            }
            return
        }

        let isReference = runtime.descriptor.stemID == referenceStemID
        try scheduleFiniteSegment(
            runtime,
            start: position,
            end: deckDuration,
            generation: generation,
            signalsEnd: isReference
        )
    }

    private func scheduleFiniteSegment(
        _ runtime: StemRuntime,
        start: TimeInterval,
        end: TimeInterval,
        generation: Int,
        signalsEnd: Bool
    ) throws {
        let segment = try audioSegment(runtime: runtime, start: start, end: end)

        if signalsEnd {
            runtime.player.scheduleSegment(
                runtime.audioFile,
                startingFrame: segment.startFrame,
                frameCount: segment.frameCount,
                at: nil,
                completionCallbackType: .dataPlayedBack
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.finishPlaybackIfCurrent(generation: generation)
                }
            }
        } else {
            runtime.player.scheduleSegment(
                runtime.audioFile,
                startingFrame: segment.startFrame,
                frameCount: segment.frameCount,
                at: nil,
                completionHandler: nil
            )
        }
    }

    private func scheduleLoopSegment(
        _ runtime: StemRuntime,
        start: TimeInterval,
        end: TimeInterval,
        generation: Int
    ) throws {
        let segment = try audioSegment(runtime: runtime, start: start, end: end)
        let stemID = runtime.descriptor.stemID

        runtime.player.scheduleSegment(
            runtime.audioFile,
            startingFrame: segment.startFrame,
            frameCount: segment.frameCount,
            at: nil,
            completionCallbackType: .dataConsumed
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refillLoop(for: stemID, generation: generation)
            }
        }
    }

    private func refillLoop(for stemID: String, generation: Int) {
        guard generation == schedulingGeneration,
              playbackState == .playing,
              let loopRange,
              let runtime = runtimeByStemID[stemID]
        else {
            return
        }

        do {
            try scheduleLoopSegment(
                runtime,
                start: loopRange.start,
                end: loopRange.end,
                generation: generation
            )
        } catch {
            publishFailure(error)
        }
    }

    private func audioSegment(
        runtime: StemRuntime,
        start: TimeInterval,
        end: TimeInterval
    ) throws -> (startFrame: AVAudioFramePosition, frameCount: AVAudioFrameCount) {
        let sampleRate = runtime.audioFile.processingFormat.sampleRate
        let clampedStart = min(max(start, 0), deckDuration)
        let clampedEnd = min(max(end, clampedStart), deckDuration)
        let startFrame = min(
            AVAudioFramePosition((clampedStart * sampleRate).rounded()),
            runtime.audioFile.length
        )
        let endFrame = min(
            AVAudioFramePosition((clampedEnd * sampleRate).rounded()),
            runtime.audioFile.length
        )
        let frameCount64 = max(endFrame - startFrame, 0)

        guard frameCount64 > 0,
              frameCount64 <= AVAudioFramePosition(AVAudioFrameCount.max)
        else {
            throw NativeAudioEngineError.unreadableFile(runtime.descriptor.stemID)
        }

        return (startFrame, AVAudioFrameCount(frameCount64))
    }

    private func scheduleMetronome(until outputOffset: TimeInterval) {
        guard metronomeEnabled,
              let bpm = metronomeBPM,
              outputOffset > metronomeScheduledThrough,
              let regularClickBuffer,
              let accentClickBuffer
        else {
            return
        }

        let events = MetronomeSchedulePlanner.events(
            startingAt: anchorPosition,
            duration: deckDuration,
            loop: loopRange,
            playbackRate: playbackRate,
            bpm: bpm,
            beatsPerBar: metronomeBeatsPerBar,
            outputRange: metronomeScheduledThrough..<outputOffset
        )

        for event in events {
            let sampleTime = AVAudioFramePosition(
                (event.outputOffset * metronomeFormat.sampleRate).rounded()
            )
            metronomePlayer.scheduleBuffer(
                event.isAccent ? accentClickBuffer : regularClickBuffer,
                at: AVAudioTime(
                    sampleTime: sampleTime,
                    atRate: metronomeFormat.sampleRate
                ),
                options: [],
                completionHandler: nil
            )
        }
        metronomeScheduledThrough = outputOffset
    }

    private func startMetronomeTimer() {
        metronomeTimer?.invalidate()
        metronomeTimer = Timer.scheduledTimer(
            withTimeInterval: Self.metronomeExtensionInterval,
            repeats: true
        ) { [weak self] timer in
            guard self != nil else {
                timer.invalidate()
                return
            }
            Task { @MainActor [weak self] in
                guard let self, self.playbackState == .playing else {
                    return
                }
                self.scheduleMetronome(
                    until: self.metronomeScheduledThrough
                        + Self.metronomeExtensionHorizon
                )
            }
        }
        if let metronomeTimer {
            RunLoop.main.add(metronomeTimer, forMode: .common)
        }
    }

    private func startDisplayTimer() {
        displayTimer?.invalidate()
        displayTimer = Timer.scheduledTimer(
            withTimeInterval: 1.0 / 30.0,
            repeats: true
        ) { [weak self] timer in
            guard self != nil else {
                timer.invalidate()
                return
            }
            Task { @MainActor [weak self] in
                self?.publishSnapshot()
            }
        }
        if let displayTimer {
            RunLoop.main.add(displayTimer, forMode: .common)
        }
    }

    private func currentPosition() -> TimeInterval {
        guard playbackState == .playing else {
            return TransportMath.clampedPosition(anchorPosition, duration: deckDuration)
        }

        if let referenceStemID,
           let runtime = runtimeByStemID[referenceStemID],
           let renderTime = runtime.player.lastRenderTime,
           let playerTime = runtime.player.playerTime(forNodeTime: renderTime),
           playerTime.sampleRate > 0
        {
            let mediaAdvance = TimeInterval(playerTime.sampleTime) / playerTime.sampleRate
            return TransportMath.position(
                startingAt: anchorPosition,
                afterAdvancing: max(mediaAdvance, 0),
                duration: deckDuration,
                loop: loopRange
            )
        }

        guard let scheduledStartHostTime else {
            return anchorPosition
        }

        let now = mach_absolute_time()
        guard now > scheduledStartHostTime else {
            return anchorPosition
        }
        let outputSeconds = AVAudioTime.seconds(
            forHostTime: now - scheduledStartHostTime
        )
        return TransportMath.position(
            startingAt: anchorPosition,
            afterAdvancing: outputSeconds * TimeInterval(playbackRate),
            duration: deckDuration,
            loop: loopRange
        )
    }

    private func normalizedPlaybackStart(_ position: TimeInterval) -> TimeInterval {
        TransportMath.position(
            startingAt: position,
            afterAdvancing: 0,
            duration: deckDuration,
            loop: loopRange
        )
    }

    private func pauseInternal(resultingState: NativePlaybackState) {
        anchorPosition = currentPosition()
        stopScheduledNodes(capturingPosition: false)
        playbackState = resultingState
        publishSnapshot()
    }

    private func stopScheduledNodes(capturingPosition: Bool) {
        if capturingPosition {
            anchorPosition = currentPosition()
        }

        schedulingGeneration += 1
        scheduledStartHostTime = nil
        for runtime in runtimes {
            runtime.player.stop()
            runtime.player.reset()
        }
        metronomePlayer.stop()
        metronomePlayer.reset()
        timePitch.reset()
        limiter.reset()
        metronomeScheduledThrough = 0
        displayTimer?.invalidate()
        displayTimer = nil
        metronomeTimer?.invalidate()
        metronomeTimer = nil
    }

    private func finishPlaybackIfCurrent(generation: Int) {
        guard generation == schedulingGeneration,
              playbackState == .playing,
              loopRange == nil
        else {
            return
        }

        stopScheduledNodes(capturingPosition: false)
        anchorPosition = deckDuration
        playbackState = .ended
        publishSnapshot()
    }

    private func updateChannel(
        _ stemID: String,
        change: (inout StemChannelState) -> Void
    ) {
        guard var state = channelStates[stemID] else {
            return
        }
        change(&state)
        channelStates[stemID] = state.normalized()
        applyChannelStates()
        publishSnapshot()
    }

    private func applyChannelStates() {
        let hasSolo = channelStates.values.contains(where: \.isSoloed)

        for runtime in runtimes {
            guard let state = channelStates[runtime.descriptor.stemID] else {
                continue
            }
            let isAudible = !state.isMuted && (!hasSolo || state.isSoloed)
            runtime.channelMixer.outputVolume = isAudible ? state.volume : 0
            runtime.channelMixer.pan = state.pan
        }
    }

    private func applyMetronomeGainStaging() {
        // A dense deck can contain more than a dozen active stems. Lowering the
        // music bus while the click is enabled keeps the click clearly audible
        // without driving either signal past the shared master limiter.
        stemBus.outputVolume = metronomeEnabled ? 0.68 : 1
        metronomeMixer.outputVolume = 1
    }

    private func configureAndActivateAudioSession() throws {
        do {
            try audioSession.setCategory(
                .playback,
                mode: .default,
                options: [.allowAirPlay, .allowBluetoothA2DP]
            )
            try audioSession.setPreferredSampleRate(48_000)
            try audioSession.setPreferredIOBufferDuration(0.01)
            try audioSession.setActive(true)
        } catch {
            throw NativeAudioEngineError.audioSession(error.localizedDescription)
        }
    }

    private func detachStemNodes() {
        for runtime in runtimes {
            runtime.player.stop()
            engine.disconnectNodeOutput(runtime.player)
            engine.disconnectNodeOutput(runtime.channelMixer)
            engine.detach(runtime.player)
            engine.detach(runtime.channelMixer)
        }
        runtimes = []
        runtimeByStemID = [:]
    }

    private func replaceCoreGraph(sampleRate: Double) {
        engine.stop()
        engine = AVAudioEngine()
        stemBus = AVAudioMixerNode()
        timePitch = AVAudioUnitTimePitch()
        masterBus = AVAudioMixerNode()
        limiter = Self.makePeakLimiter()
        metronomePlayer = AVAudioPlayerNode()
        metronomeMixer = AVAudioMixerNode()
        runtimes = []
        runtimeByStemID = [:]
        configureCoreGraph(sampleRate: sampleRate)
    }

    private func recoverAudioGraph() {
        guard !isRebuildingGraph,
              let deck = loadedDeck
        else {
            return
        }

        isRebuildingGraph = true
        defer { isRebuildingGraph = false }

        let shouldResume = playbackState == .playing
        let position = currentPosition()
        let savedChannels = channelStates
        let savedRate = playbackRate
        let savedLoop = loopRange
        let savedMetronomeEnabled = metronomeEnabled
        let savedBPM = metronomeBPM
        let savedBeatsPerBar = metronomeBeatsPerBar

        do {
            stopScheduledNodes(capturingPosition: false)
            let sampleRate = audioSession.sampleRate > 0
                ? audioSession.sampleRate
                : 48_000
            replaceCoreGraph(sampleRate: sampleRate)
            let prepared = try prepare(deck: deck)
            try install(
                deck: deck,
                preparedStems: prepared,
                initialChannels: savedChannels
            )
            playbackRate = savedRate
            timePitch.rate = savedRate
            loopRange = savedLoop
            metronomeEnabled = savedMetronomeEnabled
            metronomeBPM = savedBPM
            metronomeBeatsPerBar = savedBeatsPerBar
            applyMetronomeGainStaging()
            anchorPosition = TransportMath.clampedPosition(
                position,
                duration: deckDuration
            )
            playbackState = .paused

            if shouldResume {
                try scheduleAndStart(at: normalizedPlaybackStart(anchorPosition))
            } else {
                publishSnapshot()
            }
        } catch {
            publishFailure(error)
        }
    }

    private func makeClickBuffer(
        frequency: Double,
        peak: Float,
        sampleRate: Double
    ) -> AVAudioPCMBuffer {
        let frameCapacity = AVAudioFrameCount(sampleRate * 0.035)
        let buffer = AVAudioPCMBuffer(
            pcmFormat: metronomeFormat,
            frameCapacity: frameCapacity
        )!
        buffer.frameLength = frameCapacity

        let channel = buffer.floatChannelData![0]
        for frame in 0..<Int(frameCapacity) {
            let time = Double(frame) / sampleRate
            let attack = min(time / 0.0015, 1)
            let decay = exp(-time * 95)
            let fundamental = sin(2 * .pi * frequency * time)
            let overtone = 0.32 * sin(2 * .pi * frequency * 2.07 * time)
            channel[frame] = peak * Float(
                attack * decay * (fundamental + overtone) / 1.32
            )
        }
        return buffer
    }

    private static func makePeakLimiter() -> AVAudioUnitEffect {
        AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect,
            componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        ))
    }

    private func publishSnapshot() {
        transportSnapshot = NativeTransportSnapshot(
            jobID: loadedDeck?.jobID,
            title: loadedDeck?.title,
            state: playbackState,
            position: currentPosition(),
            duration: deckDuration,
            playbackRate: playbackRate,
            loop: loopRange,
            channels: channelStates,
            metronomeEnabled: metronomeEnabled,
            metronomeBPM: metronomeBPM,
            errorMessage: playbackState == .failed
                ? transportSnapshot.errorMessage
                : nil
        )
    }

    private func publishFailure(_ error: Error) {
        stopScheduledNodes(capturingPosition: playbackState == .playing)
        playbackState = .failed
        transportSnapshot = NativeTransportSnapshot(
            jobID: loadedDeck?.jobID,
            title: loadedDeck?.title,
            state: .failed,
            position: anchorPosition,
            duration: deckDuration,
            playbackRate: playbackRate,
            loop: loopRange,
            channels: channelStates,
            metronomeEnabled: metronomeEnabled,
            metronomeBPM: metronomeBPM,
            errorMessage: error.localizedDescription
        )
    }

    private func installAudioNotifications() {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(receiveInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: audioSession
        )
        center.addObserver(
            self,
            selector: #selector(receiveRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: audioSession
        )
        center.addObserver(
            self,
            selector: #selector(receiveMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: audioSession
        )
        center.addObserver(
            self,
            selector: #selector(receiveEngineConfigurationChange(_:)),
            name: .AVAudioEngineConfigurationChange,
            object: nil
        )
    }

    @objc nonisolated private func receiveInterruption(_ notification: Notification) {
        let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
        Task { @MainActor [weak self] in
            self?.handleInterruption(typeValue: typeValue, optionsValue: optionsValue)
        }
    }

    @objc nonisolated private func receiveRouteChange(_ notification: Notification) {
        let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        Task { @MainActor [weak self] in
            self?.handleRouteChange(reasonValue: reasonValue)
        }
    }

    @objc nonisolated private func receiveMediaServicesReset(_ notification: Notification) {
        Task { @MainActor [weak self] in
            self?.recoverAudioGraph()
        }
    }

    @objc nonisolated private func receiveEngineConfigurationChange(
        _ notification: Notification
    ) {
        Task { @MainActor [weak self] in
            self?.recoverAudioGraph()
        }
    }

    private func handleInterruption(typeValue: UInt?, optionsValue: UInt?) {
        guard let typeValue,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else {
            return
        }

        switch type {
        case .began:
            resumeAfterInterruption = playbackState == .playing
            if resumeAfterInterruption {
                pauseInternal(resultingState: .interrupted)
            }
        case .ended:
            let options = AVAudioSession.InterruptionOptions(
                rawValue: optionsValue ?? 0
            )
            let shouldResume = resumeAfterInterruption
                && options.contains(.shouldResume)
            resumeAfterInterruption = false

            if shouldResume {
                do {
                    try play()
                } catch {
                    publishFailure(error)
                }
            } else if playbackState == .interrupted {
                playbackState = .paused
                publishSnapshot()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(reasonValue: UInt?) {
        guard let reasonValue,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
        else {
            return
        }

        if reason == .oldDeviceUnavailable, playbackState == .playing {
            pauseInternal(resultingState: .paused)
            return
        }

        if reason == .newDeviceAvailable || reason == .routeConfigurationChange {
            recoverAudioGraph()
        }
    }
}
