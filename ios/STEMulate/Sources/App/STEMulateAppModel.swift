import Combine
import Foundation

struct PresentedAppError: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String

    static func == (lhs: PresentedAppError, rhs: PresentedAppError) -> Bool {
        lhs.id == rhs.id
    }
}

@MainActor
final class STEMulateAppModel: ObservableObject {
    @Published var selectedTab: AppTab = .library
    @Published private(set) var jobs: [ProcessingJob] = []
    @Published private(set) var cachedJobIDs: Set<String> = []
    @Published private(set) var isLoadingLibrary = true
    @Published private(set) var preparingJobID: String?
    @Published private(set) var selectedJob: ProcessingJob?
    @Published private(set) var selectedAnalysis: HydratedSongAnalysis?
    @Published private(set) var localDeck: LocalStemDeck?
    @Published private(set) var isImporting = false
    @Published private(set) var uploadProgress: Double?
    @Published private(set) var isSavingMixer = false
    @Published private(set) var saveConfirmation: String?
    @Published var transientStatus: String?
    @Published var presentedError: PresentedAppError?

    let audioEngine = NativeStemAudioEngine()

    private let ownerSession: GoogleOwnerSession
    private let backend: FirebaseBackendService
    private let cache = StemFileCache()
    private let downloader = SignedStemDownloader()
    private var hasStartedLibrary = false

    init(ownerSession: GoogleOwnerSession) {
        self.ownerSession = ownerSession
        backend = FirebaseBackendService(ownerSession: ownerSession)
    }

    var accountEmail: String? {
        switch ownerSession.state {
        case .authorized(_, let email), .unauthorized(_, let email):
            return email
        case .signedOut, .checkingAuthorization:
            return nil
        }
    }

    func startLibrary() async {
        guard !hasStartedLibrary else { return }
        hasStartedLibrary = true
        defer { hasStartedLibrary = false }
        isLoadingLibrary = true

        await refreshCacheStatus()

        var hasReportedConnectionError = false
        while !Task.isCancelled {
            do {
                let stream = try await backend.libraryStream()
                for try await updatedJobs in stream {
                    try Task.checkCancellation()
                    jobs = updatedJobs
                    isLoadingLibrary = false
                    hasReportedConnectionError = false

                    if let selectedID = selectedJob?.id,
                       let freshSelection = updatedJobs.first(
                           where: { $0.id == selectedID }
                       ) {
                        selectedJob = freshSelection
                    }
                }
            } catch {
                if error is CancellationError {
                    return
                }
                isLoadingLibrary = false
                if !hasReportedConnectionError {
                    showError(error, title: "Couldn’t load your library")
                    hasReportedConnectionError = true
                }
            }

            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
            } catch {
                return
            }
        }
    }

    func refreshCacheStatus() async {
        do {
            cachedJobIDs = Set(try await cache.cachedJobIDs())
        } catch {
            showError(error, title: "Couldn’t read downloads")
        }
    }

    @discardableResult
    func importRemote(link: String, rightsConfirmed: Bool) async -> Bool {
        guard !isImporting else { return false }
        let cleanLink = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: cleanLink) else {
            showError(
                BackendError.uploadRejected("Enter a valid YouTube or Spotify link."),
                title: "Check the link"
            )
            return false
        }

        isImporting = true
        transientStatus = "Starting remote import…"
        defer {
            isImporting = false
            transientStatus = nil
        }

        do {
            _ = try await backend.createRemoteImport(
                url: url,
                rightsConfirmed: rightsConfirmed
            )
            selectedTab = .library
            return true
        } catch {
            showError(error, title: "Import couldn’t start")
            return false
        }
    }

    func importLocalFile(_ fileURL: URL) async {
        guard !isImporting else { return }
        isImporting = true
        uploadProgress = 0
        transientStatus = "Uploading \(fileURL.lastPathComponent)…"
        defer {
            isImporting = false
            uploadProgress = nil
            transientStatus = nil
        }

        do {
            _ = try await backend.importLocalFile(
                at: fileURL,
                progress: { [weak self] progress in
                    self?.uploadProgress = progress
                }
            )
            selectedTab = .library
        } catch {
            showError(error, title: "Upload failed")
        }
    }

    func prepare(_ job: ProcessingJob) async {
        guard job.canOpen else {
            showError(BackendError.jobNotReady, title: "Song isn’t ready")
            return
        }
        guard preparingJobID == nil else { return }

        preparingJobID = job.id
        saveConfirmation = nil
        transientStatus = cachedJobIDs.contains(job.id)
            ? "Opening downloaded stems…"
            : "Preparing native audio…"
        defer {
            preparingJobID = nil
            transientStatus = nil
        }

        do {
            if let cachedDeck = try? await cache.loadSong(jobID: job.id) {
                cachedJobIDs.insert(job.id)
                try open(
                    deck: cachedDeck,
                    job: job,
                    analysis: fallbackAnalysis(for: job)
                )
                selectedTab = .mixer

                // Refresh annotations opportunistically. Cached audio remains playable
                // even if the network or an analysis artifact is temporarily unavailable.
                if let resources = try? await backend.loadSongResources(
                    jobID: job.id,
                    previewWaitTimeout: 0
                ) {
                    selectedJob = resources.job
                    selectedAnalysis = resources.analysis
                }
                return
            }

            let resources = try await backend.loadSongResources(jobID: job.id)
            let cachedDeck = try await backend.downloadAndCachePlayback(
                resources,
                downloader: downloader,
                cache: cache
            )

            cachedJobIDs.insert(job.id)
            try open(
                deck: cachedDeck,
                job: resources.job,
                analysis: resources.analysis
            )
            selectedTab = .mixer
        } catch {
            showError(error, title: "Couldn’t prepare this song")
        }
    }

    func offload(_ job: ProcessingJob) async {
        do {
            if selectedJob?.id == job.id {
                audioEngine.unload()
                selectedJob = nil
                selectedAnalysis = nil
                localDeck = nil
                selectedTab = .library
            }
            try await cache.removeSong(jobID: job.id)
            cachedJobIDs.remove(job.id)
        } catch {
            showError(error, title: "Couldn’t offload audio")
        }
    }

    func saveMixerSettings() async {
        guard let job = selectedJob,
              let localDeck = localDeck,
              !isSavingMixer else { return }
        isSavingMixer = true
        saveConfirmation = nil
        transientStatus = "Saving mixer…"
        defer {
            isSavingMixer = false
            transientStatus = nil
        }

        let stemIDs = localDeck.stems.map(\.stemID)
        var channels: [String: MixerChannelSettings] = Dictionary(
            uniqueKeysWithValues: stemIDs.compactMap { stemID in
                guard let state = audioEngine.transportSnapshot.channels[stemID] else {
                    return nil
                }
                let normalized = state.normalized()
                return (
                    stemID,
                    MixerChannelSettings(
                        volume: Int((normalized.volume * 100).rounded()),
                        pan: Int((normalized.pan * 100).rounded()),
                        muted: normalized.isMuted,
                        solo: normalized.isSoloed
                    )
                )
            }
        )
        guard channels.count == stemIDs.count else {
            showError(
                BackendError.invalidResponse("One or more mixer channels are missing."),
                title: "Mixer wasn’t saved"
            )
            return
        }
        channels["metronome"] = MixerChannelSettings(
            volume: 100,
            pan: 0,
            muted: !audioEngine.transportSnapshot.metronomeEnabled,
            solo: false
        )
        let settings = SavedMixerSettings(
            stemIDs: stemIDs,
            channels: channels
        )

        do {
            _ = try await backend.saveMixerSettings(jobID: job.id, settings: settings)
            saveConfirmation = "Saved"
        } catch {
            showError(error, title: "Mixer wasn’t saved")
        }
    }

    func markMixerChanged() {
        saveConfirmation = nil
    }

    func signOut() {
        audioEngine.unload()
        do {
            try ownerSession.signOut()
        } catch {
            showError(error, title: "Couldn’t sign out")
        }
    }

    func showError(_ error: Error, title: String = "Something went wrong") {
        presentedError = PresentedAppError(
            title: title,
            message: error.userFacingMessage
        )
    }

    private func open(
        deck: LocalStemDeck,
        job: ProcessingJob,
        analysis: HydratedSongAnalysis
    ) throws {
        audioEngine.unload()
        try audioEngine.load(
            jobID: job.id,
            title: job.displayName,
            files: deck.stems,
            initialChannels: nativeChannels(from: job.mixerSettings)
        )
        if let click = job.mixerSettings?.channels["metronome"],
           (20 ... 400).contains(analysis.bpm) {
            try audioEngine.setMetronome(
                enabled: !click.muted,
                bpm: analysis.bpm
            )
        }
        localDeck = deck
        selectedJob = job
        selectedAnalysis = analysis
    }

    private func nativeChannels(
        from settings: SavedMixerSettings?
    ) -> [String: StemChannelState] {
        guard let settings else { return [:] }
        return settings.channels.mapValues { channel in
            StemChannelState(
                volume: Float(channel.volume) / 100,
                pan: Float(channel.pan) / 100,
                isMuted: channel.muted,
                isSoloed: channel.solo
            )
            .normalized()
        }
    }

    private func fallbackAnalysis(for job: ProcessingJob) -> HydratedSongAnalysis {
        HydratedSongAnalysis(
            bpm: job.analysis.bpm ?? 0,
            key: job.analysis.key ?? "Unknown",
            beats: [],
            chords: [],
            sections: []
        )
    }
}
