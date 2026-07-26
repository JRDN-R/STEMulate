import Foundation

enum BackendContract {
    static let functionsRegion = "us-central1"
    static let maximumLibraryItems = 100
    static let maximumJobIdentifierLength = 128
    static let playbackLinkRefreshLeeway: TimeInterval = 10 * 60

    static let audioStemIDs: Set<String> = [
        "vocals",
        "drums",
        "kick",
        "snare",
        "toms",
        "hi_hat",
        "cymbals",
        "bass",
        "guitars",
        "piano",
        "keys",
        "strings",
        "wind",
        "other",
    ]

    static let mixerStemIDs = audioStemIDs.union(["metronome"])
    static let drumPartStemIDs: Set<String> = [
        "kick",
        "snare",
        "toms",
        "hi_hat",
        "cymbals",
    ]

    static func isValidIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maximumJobIdentifierLength else {
            return false
        }
        return value.unicodeScalars.allSatisfy { scalar in
            (48 ... 57).contains(scalar.value)
                || (65 ... 90).contains(scalar.value)
                || (97 ... 122).contains(scalar.value)
                || scalar.value == 95
                || scalar.value == 45
        }
    }
}

enum BackendError: LocalizedError, Equatable, Sendable {
    case notConfigured
    case authenticationRequired
    case ownerAuthorizationRequired
    case invalidIdentifier
    case invalidResponse(String)
    case invalidJob(String)
    case jobNotReady
    case jobFailed(String)
    case previewUnavailable(String)
    case uploadRejected(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "The private backend is not configured."
        case .authenticationRequired:
            return "Sign in before using your song library."
        case .ownerAuthorizationRequired:
            return "This Google account has not been authorized for STEMulate."
        case .invalidIdentifier:
            return "The saved song identifier is invalid."
        case .invalidResponse(let detail):
            return "The backend returned invalid data. \(detail)"
        case .invalidJob(let detail):
            return detail
        case .jobNotReady:
            return "This song is still processing."
        case .jobFailed(let message):
            return message
        case .previewUnavailable(let message):
            return message
        case .uploadRejected(let message):
            return message
        }
    }
}

enum ProcessingJobStatus: String, Sendable {
    case awaitingUpload = "awaiting_upload"
    case queued
    case processing
    case completed
    case failed
}

enum ProcessingPreviewStatus: String, Sendable {
    case unavailable
    case queued
    case processing
    case retrying
    case awaitingFinalize = "awaiting_finalize"
    case ready
    case failed
}

enum RemoteSourceProvider: String, Sendable {
    case youtube
    case spotify
}

struct ProcessingError: Equatable, Sendable {
    let code: String?
    let message: String
}

struct ProcessingOutput: Equatable, Sendable {
    let key: String
    let storagePath: String
    let contentType: String?
    let sizeBytes: Int64?
}

struct JobAnalysisSummary: Equatable, Sendable {
    let key: String?
    let bpm: Double?
}

struct MixerChannelSettings: Equatable, Sendable {
    var volume: Int
    var pan: Int
    var muted: Bool
    var solo: Bool

    var callableValue: [String: Any] {
        [
            "volume": volume,
            "pan": pan,
            "muted": muted,
            "solo": solo,
        ]
    }
}

struct SavedMixerSettings: Equatable, Sendable {
    static let version = 1

    var stemIDs: [String]
    var channels: [String: MixerChannelSettings]

    var callableValue: [String: Any] {
        [
            "version": Self.version,
            "stemIds": stemIDs,
            "channels": channels.mapValues(\.callableValue),
        ]
    }
}

struct ProcessingJob: Identifiable, Equatable, Sendable {
    let id: String
    let ownerUID: String
    let displayName: String
    let sourceFileName: String?
    let sourceType: String
    let sourceProvider: RemoteSourceProvider?
    let status: ProcessingJobStatus
    let stage: String
    let analysis: JobAnalysisSummary
    let outputs: [ProcessingOutput]
    let mixerSettings: SavedMixerSettings?
    let previewStatus: ProcessingPreviewStatus
    let createdAt: Date?
    let updatedAt: Date?
    let error: ProcessingError?

    var canOpen: Bool {
        status == .completed && !outputs.isEmpty
    }
}

struct CreatedUploadJob: Equatable, Sendable {
    let jobID: String
    let inputPath: String
    let maximumInputBytes: Int64
}

struct CreatedRemoteJob: Equatable, Sendable {
    let jobID: String
    let provider: RemoteSourceProvider
}

struct SignedPlaybackAsset: Equatable, Sendable {
    let stemID: String
    let remoteURL: URL
    let contentType: String?
    let sizeBytes: Int64?
}

struct SignedOutputArtifact: Equatable, Sendable {
    let key: String
    let remoteURL: URL
    let contentType: String?
    let sizeBytes: Int64?
}

struct SignedOutputBundle: Equatable, Sendable {
    let jobID: String
    let expiresAt: Date
    let outputs: [SignedOutputArtifact]
}

enum SignedPlaybackDeckFormat: Equatable, Sendable {
    case aacADTS(sampleRate: Int, packetFrames: Int, durationFrames: Int64)
    case originalOutputs
}

struct SignedPlaybackDeck: Equatable, Sendable {
    let jobID: String
    let expiresAt: Date
    let format: SignedPlaybackDeckFormat
    let assets: [SignedPlaybackAsset]
}

struct StemDownloadRequest: Equatable, Sendable {
    let jobID: String
    let stemID: String
    let remoteURL: URL
    let expectedByteCount: Int64?
    let contentType: String?
}

protocol StemDownloadSink: Sendable {
    /// Materializes a signed, short-lived URL into a durable local cache entry.
    func materialize(_ request: StemDownloadRequest) async throws -> URL
}

struct CachedPlaybackAsset: Equatable, Sendable {
    let stemID: String
    let localURL: URL
    let contentType: String?
}

struct CachedPlaybackDeck: Equatable, Sendable {
    let jobID: String
    let format: SignedPlaybackDeckFormat
    let assets: [CachedPlaybackAsset]
}

struct PreviewWindow: Equatable, Sendable {
    let startFrame: Int64
    let frameCount: Int64
    let prerollByteStart: Int64
    let byteStart: Int64
    let byteEndExclusive: Int64
}

struct PreviewStem: Equatable, Sendable {
    let stemID: String
    let url: URL
    let channels: Int
    let sizeBytes: Int64
    let windows: [PreviewWindow]
}

struct ReadyPreview: Equatable, Sendable {
    let jobID: String
    let expiresAt: Date
    let sampleRate: Int
    let packetFrames: Int
    let durationFrames: Int64
    let stems: [PreviewStem]
}

enum PreviewLookup: Equatable, Sendable {
    case pending(ProcessingPreviewStatus, ProcessingError?)
    case ready(ReadyPreview)
}

struct BeatAnnotation: Equatable, Sendable {
    let time: TimeInterval
    let beat: Int
}

struct ChordAnnotation: Equatable, Sendable {
    let chord: String
    let start: TimeInterval
    let end: TimeInterval
}

struct SectionAnnotation: Equatable, Sendable {
    let label: String
    let start: TimeInterval
    let end: TimeInterval
}

struct HydratedSongAnalysis: Equatable, Sendable {
    let bpm: Double
    let key: String
    let beats: [BeatAnnotation]
    let chords: [ChordAnnotation]
    let sections: [SectionAnnotation]
}

struct LoadedSongResources: Equatable, Sendable {
    let job: ProcessingJob
    let playback: SignedPlaybackDeck
    let analysis: HydratedSongAnalysis
}
