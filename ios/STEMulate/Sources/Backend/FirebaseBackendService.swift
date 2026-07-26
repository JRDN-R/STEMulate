@preconcurrency import FirebaseCore
@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseFunctions
@preconcurrency import FirebaseStorage
import Foundation
import UniformTypeIdentifiers

private final class FirestoreListenerBox: @unchecked Sendable {
    let listener: ListenerRegistration

    init(_ listener: ListenerRegistration) {
        self.listener = listener
    }
}

@MainActor
final class FirebaseBackendService {
    private let ownerSession: GoogleOwnerSession
    private let firestore: Firestore
    private let functions: Functions
    private let storage: Storage

    init(ownerSession: GoogleOwnerSession) {
        precondition(
            FirebaseApp.app() != nil,
            "Call FirebaseBootstrap.configure() before creating FirebaseBackendService."
        )
        self.ownerSession = ownerSession
        firestore = Firestore.firestore()
        functions = Functions.functions(region: BackendContract.functionsRegion)
        storage = Storage.storage()
    }

    func libraryStream() async throws -> AsyncThrowingStream<[ProcessingJob], Error> {
        let ownerUID = try await ownerSession.authorizedOwnerUID()
        let query = firestore.collection("users")
            .document(ownerUID)
            .collection("jobs")
            .order(by: "createdAt", descending: true)
            .limit(to: BackendContract.maximumLibraryItems)

        return AsyncThrowingStream { continuation in
            let listener = FirestoreListenerBox(query.addSnapshotListener { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot else {
                    continuation.finish(
                        throwing: BackendError.invalidResponse(
                            "The song library returned no snapshot."
                        )
                    )
                    return
                }
                let jobs = snapshot.documents.compactMap { document in
                    try? ProcessingJobDecoder.decode(
                        id: document.documentID,
                        value: document.data(),
                        expectedOwnerUID: ownerUID
                    )
                }
                continuation.yield(jobs)
            })
            continuation.onTermination = { _ in
                listener.listener.remove()
            }
        }
    }

    func jobStream(jobID: String) async throws -> AsyncThrowingStream<ProcessingJob, Error> {
        try validateJobID(jobID)
        let ownerUID = try await ownerSession.authorizedOwnerUID()
        let reference = jobReference(ownerUID: ownerUID, jobID: jobID)

        return AsyncThrowingStream { continuation in
            let listener = FirestoreListenerBox(reference.addSnapshotListener { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot, snapshot.exists, let value = snapshot.data() else {
                    continuation.finish(
                        throwing: BackendError.invalidJob(
                            "The saved song no longer exists."
                        )
                    )
                    return
                }
                do {
                    continuation.yield(try ProcessingJobDecoder.decode(
                        id: snapshot.documentID,
                        value: value,
                        expectedOwnerUID: ownerUID
                    ))
                } catch {
                    continuation.finish(throwing: error)
                }
            })
            continuation.onTermination = { _ in
                listener.listener.remove()
            }
        }
    }

    func loadJob(jobID: String) async throws -> ProcessingJob {
        try validateJobID(jobID)
        let ownerUID = try await ownerSession.authorizedOwnerUID()
        let snapshot = try await jobReference(ownerUID: ownerUID, jobID: jobID)
            .getDocument()
        guard snapshot.exists, let value = snapshot.data() else {
            throw BackendError.invalidJob("The saved song no longer exists.")
        }
        return try ProcessingJobDecoder.decode(
            id: snapshot.documentID,
            value: value,
            expectedOwnerUID: ownerUID
        )
    }

    func waitForCompletedJob(jobID: String) async throws -> ProcessingJob {
        let stream = try await jobStream(jobID: jobID)
        for try await job in stream {
            switch job.status {
            case .completed:
                return job
            case .failed:
                throw BackendError.jobFailed(
                    job.error?.message
                        ?? "The processing service could not process this track."
                )
            case .awaitingUpload, .queued, .processing:
                continue
            }
        }
        throw BackendError.invalidJob("The processing job stopped unexpectedly.")
    }

    func createRemoteImport(
        url: URL,
        clientRequestID: UUID = UUID(),
        rightsConfirmed: Bool
    ) async throws -> CreatedRemoteJob {
        _ = try await ownerSession.authorizedOwnerUID()
        guard url.scheme?.lowercased() == "https", url.host?.isEmpty == false else {
            throw BackendError.uploadRejected(
                "Enter a valid HTTPS YouTube or Spotify track URL."
            )
        }
        guard rightsConfirmed else {
            throw BackendError.uploadRejected(
                "Confirm that you have permission to process this track."
            )
        }
        let response = try await call(
            "createRemoteProcessingJob",
            data: [
                "url": url.absoluteString,
                "clientRequestId": clientRequestID.uuidString.lowercased(),
                "rightsConfirmed": true,
            ]
        )
        guard let result = FirebaseValue.dictionary(response),
              let jobID = FirebaseValue.string(result["jobId"], maximumLength: 128),
              BackendContract.isValidIdentifier(jobID),
              let providerValue = FirebaseValue.string(
                result["provider"],
                maximumLength: 20
              ),
              let provider = RemoteSourceProvider(rawValue: providerValue) else {
            throw BackendError.invalidResponse("Remote import creation is malformed.")
        }
        return CreatedRemoteJob(jobID: jobID, provider: provider)
    }

    func importLocalFile(
        at fileURL: URL,
        displayName: String? = nil,
        progress: (@MainActor @Sendable (Double) -> Void)? = nil
    ) async throws -> CreatedUploadJob {
        let ownerUID = try await ownerSession.authorizedOwnerUID()
        let accessedSecurityScope = fileURL.startAccessingSecurityScopedResource()
        defer {
            if accessedSecurityScope {
                fileURL.stopAccessingSecurityScopedResource()
            }
        }

        let values = try fileURL.resourceValues(forKeys: [
            .fileSizeKey,
            .isRegularFileKey,
            .nameKey,
        ])
        guard values.isRegularFile == true,
              let size = values.fileSize,
              size > 0 else {
            throw BackendError.uploadRejected("Choose a non-empty audio or video file.")
        }
        let fileName = values.name ?? fileURL.lastPathComponent
        let contentType = try supportedContentType(for: fileURL)
        let cleanDisplayName = displayName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedDisplayName = (cleanDisplayName?.isEmpty == false)
            ? cleanDisplayName!
            : fileURL.deletingPathExtension().lastPathComponent

        let response = try await call(
            "createProcessingJob",
            data: [
                "displayName": String(requestedDisplayName.prefix(120)),
                "fileName": String(fileName.prefix(255)),
                "contentType": contentType,
                "sizeBytes": size,
            ]
        )
        guard let result = FirebaseValue.dictionary(response),
              let jobID = FirebaseValue.string(result["jobId"], maximumLength: 128),
              BackendContract.isValidIdentifier(jobID),
              let inputPath = FirebaseValue.string(
                result["inputPath"],
                maximumLength: 1_024
              ),
              inputPath.hasPrefix("users/\(ownerUID)/jobs/\(jobID)/input/"),
              let maximumInputBytes = FirebaseValue.positiveInteger(
                result["maxInputBytes"]
              ),
              Int64(size) <= maximumInputBytes else {
            throw BackendError.invalidResponse("The private upload slot is malformed.")
        }

        let created = CreatedUploadJob(
            jobID: jobID,
            inputPath: inputPath,
            maximumInputBytes: maximumInputBytes
        )
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        try await uploadFile(
            fileURL,
            to: storage.reference(withPath: inputPath),
            metadata: metadata,
            progress: progress
        )
        return created
    }

    func renameSong(jobID: String, displayName: String) async throws -> String {
        try validateJobID(jobID)
        _ = try await ownerSession.authorizedOwnerUID()
        let cleanName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty,
              cleanName.count <= 120,
              cleanName.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw BackendError.uploadRejected("Use a title between 1 and 120 characters.")
        }
        let response = try await call(
            "renameProcessingJob",
            data: ["jobId": jobID, "displayName": cleanName]
        )
        guard let result = FirebaseValue.dictionary(response),
              FirebaseValue.string(result["jobId"], maximumLength: 128) == jobID,
              FirebaseValue.string(result["displayName"], maximumLength: 120)
                == cleanName else {
            throw BackendError.invalidResponse("The saved title was not confirmed.")
        }
        return cleanName
    }

    func saveMixerSettings(
        jobID: String,
        settings: SavedMixerSettings
    ) async throws -> SavedMixerSettings {
        try validateJobID(jobID)
        _ = try await ownerSession.authorizedOwnerUID()
        guard let normalized = ProcessingJobDecoder.decodeMixerSettings(
            settings.callableValue
        ) else {
            throw BackendError.invalidResponse("The mixer settings are invalid.")
        }
        let response = try await call(
            "saveProcessingJobMixerSettings",
            data: ["jobId": jobID, "mixerSettings": normalized.callableValue]
        )
        guard let result = FirebaseValue.dictionary(response),
              FirebaseValue.string(result["jobId"], maximumLength: 128) == jobID,
              let saved = ProcessingJobDecoder.decodeMixerSettings(
                result["mixerSettings"]
              ),
              saved == normalized else {
            throw BackendError.invalidResponse(
                "The saved mixer settings were not confirmed."
            )
        }
        return saved
    }

    func loadSongResources(
        jobID: String,
        previewWaitTimeout: TimeInterval = 180
    ) async throws -> LoadedSongResources {
        let job = try await loadJob(jobID: jobID)
        switch job.status {
        case .failed:
            throw BackendError.jobFailed(
                job.error?.message ?? "The processing service could not process this track."
            )
        case .completed:
            break
        case .awaitingUpload, .queued, .processing:
            throw BackendError.jobNotReady
        }

        let signedOutputs = try await getSignedOutputBundle(jobID: jobID)
        async let analysis = bestEffortAnalysis(
            job: job,
            outputs: signedOutputs
        )
        let playback = try await preferredPlaybackDeck(
            jobID: jobID,
            originalOutputs: signedOutputs,
            previewWaitTimeout: previewWaitTimeout
        )
        return try await LoadedSongResources(
            job: job,
            playback: playback,
            analysis: analysis
        )
    }

    func refreshPlaybackDeck(
        jobID: String,
        previewWaitTimeout: TimeInterval = 15
    ) async throws -> SignedPlaybackDeck {
        try validateJobID(jobID)
        _ = try await ownerSession.authorizedOwnerUID()
        let signedOutputs = try await getSignedOutputBundle(jobID: jobID)
        return try await preferredPlaybackDeck(
            jobID: jobID,
            originalOutputs: signedOutputs,
            previewWaitTimeout: previewWaitTimeout
        )
    }

    func cachePlaybackDeck(
        _ deck: SignedPlaybackDeck,
        using sink: any StemDownloadSink
    ) async throws -> CachedPlaybackDeck {
        let cachedAssets = try await withThrowingTaskGroup(
            of: (Int, CachedPlaybackAsset).self
        ) { group in
            for (index, asset) in deck.assets.enumerated() {
                group.addTask {
                    let localURL = try await sink.materialize(StemDownloadRequest(
                        jobID: deck.jobID,
                        stemID: asset.stemID,
                        remoteURL: asset.remoteURL,
                        expectedByteCount: asset.sizeBytes,
                        contentType: asset.contentType
                    ))
                    guard localURL.isFileURL else {
                        throw BackendError.invalidResponse(
                            "The audio cache returned a non-local file."
                        )
                    }
                    return (index, CachedPlaybackAsset(
                        stemID: asset.stemID,
                        localURL: localURL,
                        contentType: asset.contentType
                    ))
                }
            }
            var results: [(Int, CachedPlaybackAsset)] = []
            for try await result in group {
                results.append(result)
            }
            return results.sorted { $0.0 < $1.0 }.map(\.1)
        }
        return CachedPlaybackDeck(
            jobID: deck.jobID,
            format: deck.format,
            assets: cachedAssets
        )
    }

    private func getSignedOutputBundle(jobID: String) async throws -> SignedOutputBundle {
        let response = try await call(
            "getProcessingOutputs",
            data: ["jobId": jobID]
        )
        return try PlaybackResponseDecoder.decodeSignedOutputBundle(
            jobID: jobID,
            value: response
        )
    }

    private func bestEffortAnalysis(
        job: ProcessingJob,
        outputs: SignedOutputBundle
    ) async throws -> HydratedSongAnalysis {
        do {
            return try await AnalysisHydrator.hydrate(
                job: job,
                outputs: outputs
            )
        } catch {
            if error is CancellationError {
                throw error
            }
            // Audio remains useful when a nonessential annotation artifact is
            // temporarily unavailable or malformed.
            return HydratedSongAnalysis(
                bpm: job.analysis.bpm ?? 0,
                key: job.analysis.key ?? "Unknown",
                beats: [],
                chords: [],
                sections: []
            )
        }
    }

    private func preferredPlaybackDeck(
        jobID: String,
        originalOutputs: SignedOutputBundle,
        previewWaitTimeout: TimeInterval
    ) async throws -> SignedPlaybackDeck {
        do {
            if let preview = try await loadReadyPreview(
                jobID: jobID,
                waitTimeout: previewWaitTimeout
            ) {
                return SignedPlaybackDeck(
                    jobID: jobID,
                    expiresAt: preview.expiresAt,
                    format: .aacADTS(
                        sampleRate: preview.sampleRate,
                        packetFrames: preview.packetFrames,
                        durationFrames: preview.durationFrames
                    ),
                    assets: PlaybackResponseDecoder.preferredDrumLayout(
                        in: preview.stems.map {
                            SignedPlaybackAsset(
                                stemID: $0.stemID,
                                remoteURL: $0.url,
                                contentType: "audio/aac",
                                sizeBytes: $0.sizeBytes
                            )
                        }
                    )
                )
            }
        } catch {
            if error is CancellationError {
                throw error
            }
            // The original private outputs remain a valid native playback path.
        }
        return try PlaybackResponseDecoder.originalPlaybackDeck(from: originalOutputs)
    }

    private func loadReadyPreview(
        jobID: String,
        waitTimeout: TimeInterval
    ) async throws -> ReadyPreview? {
        var lookup = try await getPreview(jobID: jobID)
        if case .ready(let preview) = lookup {
            return preview
        }
        if case .pending(let status, _) = lookup,
           status == .unavailable || status == .failed {
            _ = try await call(
                "requestProcessingPreview",
                data: ["jobId": jobID]
            )
        }
        guard waitTimeout > 0 else { return nil }

        let deadline = Date().addingTimeInterval(waitTimeout)
        var delay: UInt64 = 1_000_000_000
        while Date() < deadline {
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: delay)
            lookup = try await getPreview(jobID: jobID)
            switch lookup {
            case .ready(let preview):
                return preview
            case .pending(let status, _):
                if status == .failed {
                    return nil
                }
            }
            delay = min(delay + 1_000_000_000, 5_000_000_000)
        }
        return nil
    }

    private func getPreview(jobID: String) async throws -> PreviewLookup {
        let response = try await call(
            "getProcessingPreview",
            data: ["jobId": jobID]
        )
        return try PlaybackResponseDecoder.decodePreviewLookup(
            jobID: jobID,
            value: response
        )
    }

    private func call(_ name: String, data: [String: Any]) async throws -> Any {
        let result = try await functions.httpsCallable(name).call(data)
        return result.data
    }

    private func validateJobID(_ jobID: String) throws {
        guard BackendContract.isValidIdentifier(jobID) else {
            throw BackendError.invalidIdentifier
        }
    }

    private func jobReference(ownerUID: String, jobID: String) -> DocumentReference {
        firestore.collection("users")
            .document(ownerUID)
            .collection("jobs")
            .document(jobID)
    }

    private func supportedContentType(for url: URL) throws -> String {
        let fallbackByExtension: [String: String] = [
            "aac": "audio/aac",
            "aif": "audio/aiff",
            "aiff": "audio/aiff",
            "flac": "audio/flac",
            "m4a": "audio/mp4",
            "mp3": "audio/mpeg",
            "ogg": "audio/ogg",
            "opus": "audio/ogg",
            "wav": "audio/wav",
            "m4v": "video/x-m4v",
            "mov": "video/quicktime",
            "mp4": "video/mp4",
        ]
        let fileExtension = url.pathExtension.lowercased()
        let type = UTType(filenameExtension: fileExtension)?.preferredMIMEType
            ?? fallbackByExtension[fileExtension]
        guard let type, type.hasPrefix("audio/") || type.hasPrefix("video/") else {
            throw BackendError.uploadRejected("Choose a supported audio or video file.")
        }
        return type
    }

    private func uploadFile(
        _ fileURL: URL,
        to reference: StorageReference,
        metadata: StorageMetadata,
        progress: (@MainActor @Sendable (Double) -> Void)?
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            let task = reference.putFile(from: fileURL, metadata: metadata) { _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            if let progress {
                task.observe(.progress) { snapshot in
                    let completed = snapshot.progress?.fractionCompleted ?? 0
                    Task { @MainActor in
                        progress(min(max(completed, 0), 1))
                    }
                }
            }
        }
    }
}
