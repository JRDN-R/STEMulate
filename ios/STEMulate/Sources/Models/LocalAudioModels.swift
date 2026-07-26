import Foundation

struct LocalStemFile: Identifiable, Codable, Equatable, Sendable {
    let stemID: String
    let displayName: String
    let fileURL: URL
    let contentType: String?

    var id: String { stemID }
}

struct LocalStemDeck: Codable, Equatable, Sendable {
    let jobID: String
    let title: String
    let stems: [LocalStemFile]
}

struct CachedStemInput: Equatable, Sendable {
    let stemID: String
    let displayName: String
    let sourceURL: URL
    let contentType: String?

    init(
        stemID: String,
        displayName: String? = nil,
        sourceURL: URL,
        contentType: String? = nil
    ) {
        self.stemID = stemID
        self.displayName = displayName ?? StemDisplayName.label(for: stemID)
        self.sourceURL = sourceURL
        self.contentType = contentType
    }
}

enum StemDisplayName {
    private static let knownLabels = [
        "vocals": "Vocals",
        "drums": "Drums",
        "kick": "Kick",
        "snare": "Snare",
        "toms": "Toms",
        "hi_hat": "Hi-Hat",
        "cymbals": "Cymbals",
        "bass": "Bass",
        "guitars": "Guitars",
        "piano": "Piano",
        "keys": "Keys",
        "strings": "Strings",
        "wind": "Wind",
        "other": "Other",
    ]

    static func label(for stemID: String) -> String {
        if let knownLabel = knownLabels[stemID.lowercased()] {
            return knownLabel
        }

        return stemID
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
}

enum StemAudioContainer: String, Codable, CaseIterable, Sendable {
    case aacADTS
    case mpeg4Audio
    case wave
    case coreAudio
    case aiff
    case mp3
    case flac

    var preferredFileExtension: String {
        switch self {
        case .aacADTS:
            return "aac"
        case .mpeg4Audio:
            return "m4a"
        case .wave:
            return "wav"
        case .coreAudio:
            return "caf"
        case .aiff:
            return "aiff"
        case .mp3:
            return "mp3"
        case .flac:
            return "flac"
        }
    }

    static func detect(fileURL: URL, contentType: String?) -> StemAudioContainer? {
        let normalizedContentType = contentType?
            .split(separator: ";", maxSplits: 1)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch normalizedContentType {
        case "audio/aac", "audio/aacp", "audio/x-aac":
            return .aacADTS
        case "audio/mp4", "audio/m4a", "audio/x-m4a":
            return .mpeg4Audio
        case "audio/wav", "audio/wave", "audio/x-wav":
            return .wave
        case "audio/x-caf":
            return .coreAudio
        case "audio/aiff", "audio/x-aiff":
            return .aiff
        case "audio/mpeg", "audio/mp3":
            return .mp3
        case "audio/flac", "audio/x-flac":
            return .flac
        default:
            break
        }

        switch fileURL.pathExtension.lowercased() {
        case "aac":
            return .aacADTS
        case "m4a", "mp4":
            return .mpeg4Audio
        case "wav", "wave":
            return .wave
        case "caf":
            return .coreAudio
        case "aif", "aiff":
            return .aiff
        case "mp3":
            return .mp3
        case "flac":
            return .flac
        default:
            return nil
        }
    }
}

struct StemChannelState: Codable, Equatable, Sendable {
    var volume: Float
    var pan: Float
    var isMuted: Bool
    var isSoloed: Bool

    static let defaultValue = StemChannelState(
        volume: 0.8,
        pan: 0,
        isMuted: false,
        isSoloed: false
    )

    func normalized() -> StemChannelState {
        StemChannelState(
            volume: min(max(volume, 0), 1),
            pan: min(max(pan, -1), 1),
            isMuted: isMuted,
            isSoloed: isSoloed
        )
    }
}

struct StemLoopRange: Codable, Equatable, Sendable {
    let start: TimeInterval
    let end: TimeInterval

    var duration: TimeInterval { end - start }
}

enum NativePlaybackState: String, Codable, Equatable, Sendable {
    case idle
    case ready
    case playing
    case paused
    case ended
    case interrupted
    case failed
}

struct NativeTransportSnapshot: Equatable, Sendable {
    var jobID: String?
    var title: String?
    var state: NativePlaybackState
    var position: TimeInterval
    var duration: TimeInterval
    var playbackRate: Float
    var loop: StemLoopRange?
    var channels: [String: StemChannelState]
    var metronomeEnabled: Bool
    var metronomeBPM: Double?
    var errorMessage: String?

    static let empty = NativeTransportSnapshot(
        jobID: nil,
        title: nil,
        state: .idle,
        position: 0,
        duration: 0,
        playbackRate: 1,
        loop: nil,
        channels: [:],
        metronomeEnabled: false,
        metronomeBPM: nil,
        errorMessage: nil
    )
}
