import Foundation

enum SignedStemDownloadError: LocalizedError, Equatable, Sendable {
    case invalidRequest
    case requestFailed(Int)
    case declaredSizeMismatch
    case fileTooLarge
    case emptyFile

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            return "A playback download request was invalid."
        case .requestFailed(let status):
            return "A playback file could not be downloaded (HTTP \(status))."
        case .declaredSizeMismatch:
            return "A downloaded stem did not match its expected size."
        case .fileTooLarge:
            return "A downloaded stem exceeded the device safety limit."
        case .emptyFile:
            return "A downloaded stem was empty."
        }
    }
}

/// Downloads signed playback URLs to disk without retaining the audio in RAM.
/// `StemFileCache` subsequently validates and installs these staging files.
actor SignedStemDownloader: StemDownloadSink {
    private static let maximumStemBytes: Int64 = 512 * 1_024 * 1_024

    private let session: URLSession
    private let fileManager: FileManager
    private let stagingRoot: URL

    init(
        session: URLSession = .shared,
        fileManager: FileManager = .default,
        stagingRoot: URL? = nil
    ) {
        self.session = session
        self.fileManager = fileManager
        self.stagingRoot = stagingRoot
            ?? fileManager.temporaryDirectory.appendingPathComponent(
                "STEMulateIncoming",
                isDirectory: true
            )
    }

    func materialize(_ request: StemDownloadRequest) async throws -> URL {
        guard BackendContract.isValidIdentifier(request.jobID),
              BackendContract.audioStemIDs.contains(request.stemID),
              request.remoteURL.scheme?.lowercased() == "https",
              request.remoteURL.host?.isEmpty == false,
              (request.expectedByteCount ?? 1) > 0,
              (request.expectedByteCount ?? 1) <= Self.maximumStemBytes else {
            throw SignedStemDownloadError.invalidRequest
        }

        var urlRequest = URLRequest(url: request.remoteURL)
        urlRequest.httpMethod = "GET"
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.timeoutInterval = 20 * 60

        let (temporaryURL, response) = try await session.download(for: urlRequest)
        guard let http = response as? HTTPURLResponse,
              (200 ... 299).contains(http.statusCode) else {
            throw SignedStemDownloadError.requestFailed(
                (response as? HTTPURLResponse)?.statusCode ?? 0
            )
        }
        if response.expectedContentLength > Self.maximumStemBytes {
            throw SignedStemDownloadError.fileTooLarge
        }

        let values = try temporaryURL.resourceValues(forKeys: [.fileSizeKey])
        guard let fileSize = values.fileSize, fileSize > 0 else {
            throw SignedStemDownloadError.emptyFile
        }
        let actualBytes = Int64(fileSize)
        guard actualBytes <= Self.maximumStemBytes else {
            throw SignedStemDownloadError.fileTooLarge
        }
        if let expected = request.expectedByteCount, actualBytes != expected {
            throw SignedStemDownloadError.declaredSizeMismatch
        }

        try fileManager.createDirectory(
            at: stagingRoot,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let destinationDirectory = stagingRoot.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true
        )
        try fileManager.createDirectory(
            at: destinationDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let destination = destinationDirectory.appendingPathComponent(
            "\(request.stemID).\(fileExtension(for: request))",
            isDirectory: false
        )
        try fileManager.moveItem(at: temporaryURL, to: destination)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: destination.path
        )
        return destination
    }

    func discardStagedFiles(_ urls: [URL]) {
        let allowedRoot = stagingRoot.standardizedFileURL.path
        for url in urls {
            let directory = url.deletingLastPathComponent().standardizedFileURL
            guard directory.path.hasPrefix("\(allowedRoot)/") else { continue }
            try? fileManager.removeItem(at: directory)
        }
    }

    private func fileExtension(for request: StemDownloadRequest) -> String {
        switch request.contentType?
            .split(separator: ";", maxSplits: 1)
            .first?
            .lowercased() {
        case "audio/aac", "audio/aacp", "audio/x-aac":
            return "aac"
        case "audio/mp4", "audio/m4a", "audio/x-m4a":
            return "m4a"
        case "audio/mpeg", "audio/mp3":
            return "mp3"
        case "audio/wav", "audio/wave", "audio/x-wav":
            return "wav"
        case "audio/aiff", "audio/x-aiff":
            return "aiff"
        case "audio/flac", "audio/x-flac":
            return "flac"
        default:
            let remoteExtension = request.remoteURL.pathExtension.lowercased()
            return remoteExtension.range(of: "^[a-z0-9]{1,8}$", options: .regularExpression)
                == nil
                ? "audio"
                : remoteExtension
        }
    }
}

extension FirebaseBackendService {
    func downloadAndCachePlayback(
        _ resources: LoadedSongResources,
        downloader: SignedStemDownloader = SignedStemDownloader(),
        cache: StemFileCache
    ) async throws -> LocalStemDeck {
        var stagedAssets: [CachedPlaybackAsset] = []
        do {
            // A bounded sequential transfer avoids saturating the phone with
            // fourteen simultaneous files and lets every partial download be
            // removed deterministically if a later stem fails.
            for asset in resources.playback.assets {
                let localURL = try await downloader.materialize(
                    StemDownloadRequest(
                        jobID: resources.playback.jobID,
                        stemID: asset.stemID,
                        remoteURL: asset.remoteURL,
                        expectedByteCount: asset.sizeBytes,
                        contentType: asset.contentType
                    )
                )
                stagedAssets.append(
                    CachedPlaybackAsset(
                        stemID: asset.stemID,
                        localURL: localURL,
                        contentType: asset.contentType
                    )
                )
            }

            let deck = try await cache.cacheSong(
                jobID: resources.job.id,
                title: resources.job.displayName,
                stems: stagedAssets.map {
                    CachedStemInput(
                        stemID: $0.stemID,
                        sourceURL: $0.localURL,
                        contentType: $0.contentType
                    )
                }
            )
            await downloader.discardStagedFiles(stagedAssets.map(\.localURL))
            return deck
        } catch {
            await downloader.discardStagedFiles(stagedAssets.map(\.localURL))
            throw error
        }
    }
}
