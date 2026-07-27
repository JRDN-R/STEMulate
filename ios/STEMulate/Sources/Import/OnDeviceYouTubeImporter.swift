import AVFoundation
import Foundation
import YouTubeKit

struct StagedYouTubeAudio: Sendable {
    let localURL: URL
    let displayName: String
    let videoID: String

    func remove() {
        try? FileManager.default.removeItem(at: localURL)
    }
}

enum OnDeviceYouTubeImportError: LocalizedError, Sendable {
    case noM4AStream
    case untrustedMediaURL
    case downloadRejected
    case verificationRequired
    case sourceTooLarge
    case invalidAudio
    case resolverFailed(String)

    var errorDescription: String? {
        switch self {
        case .noM4AStream:
            return "This video does not offer a compatible M4A audio stream."
        case .untrustedMediaURL:
            return "YouTube returned an untrusted media address, so the download was blocked."
        case .downloadRejected:
            return "YouTube did not return a downloadable audio file."
        case .verificationRequired:
            return "YouTube would not authorize this audio stream on the iPhone. "
                + "Try another public video or update STEMulate’s YouTube resolver."
        case .sourceTooLarge:
            return "This audio is larger than the 500 MiB import limit."
        case .invalidAudio:
            return "The downloaded file is not valid playable audio."
        case .resolverFailed(let detail):
            return "The YouTube link could not be resolved on this iPhone. \(detail)"
        }
    }
}

actor OnDeviceYouTubeImporter {
    static let maximumSourceBytes: Int64 = 500 * 1_024 * 1_024

    func download(
        _ videoLink: YouTubeVideoLink,
        progress: (@MainActor @Sendable (Double) -> Void)? = nil
    ) async throws -> StagedYouTubeAudio {
        try cleanupAbandonedDownloads()
        await report(progress, 0.02)

        let stagingDirectory = try stagingDirectory()
        let destination = stagingDirectory
            .appendingPathComponent(
                "\(UUID().uuidString.lowercased())-\(videoLink.videoID)",
                isDirectory: false
            )
            .appendingPathExtension("m4a")
        var shouldRemoveDestination = true
        defer {
            if shouldRemoveDestination {
                try? FileManager.default.removeItem(at: destination)
            }
        }

        var title = "YouTube \(videoLink.videoID)"
        var downloadCompleted = false
        for attempt in 0 ..< 2 {
            try Task.checkCancellation()
            await report(progress, attempt == 0 ? 0.03 : 0.53)

            let video = YouTube(url: videoLink.canonicalURL, methods: [.local])
            let streams: [YouTubeKit.Stream]
            do {
                streams = try await withTimeout(seconds: 45) {
                    try await SendableYouTube(video).value.streams
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as OnDeviceYouTubeImportError {
                throw error
            } catch {
                throw OnDeviceYouTubeImportError.resolverFailed(
                    error.userFacingMessage
                )
            }

            guard let stream = streams
                .filterAudioOnly()
                .filter({ $0.fileExtension == .m4a && $0.isNativelyPlayable })
                .highestAudioBitrateStream() else {
                throw OnDeviceYouTubeImportError.noM4AStream
            }
            guard YouTubeMediaURLPolicy.isTrusted(stream.url) else {
                throw OnDeviceYouTubeImportError.untrustedMediaURL
            }

            if attempt == 0 {
                let metadata = try? await video.metadata
                let cleanTitle = metadata?.title
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !cleanTitle.isEmpty {
                    title = cleanTitle
                }
            }

            // YouTube can return an immediate 403 while it prepares an ad/preroll
            // decision for a newly resolved stream. yt-dlp applies the same delay.
            await report(progress, attempt == 0 ? 0.08 : 0.56)
            try await Task.sleep(nanoseconds: 6_000_000_000)
            try Task.checkCancellation()

            var request = URLRequest(url: stream.url)
            request.timeoutInterval = 60
            request.setValue(
                "audio/mp4,audio/*;q=0.9,*/*;q=0.1",
                forHTTPHeaderField: "Accept"
            )

            let transferStart = attempt == 0 ? 0.08 : 0.56
            let transferSpan = attempt == 0 ? 0.44 : 0.34
            let transfer = YouTubeAudioDownloadTransfer(
                destination: destination,
                maximumBytes: Self.maximumSourceBytes,
                progress: { fraction in
                    Task { @MainActor in
                        progress?(transferStart + (transferSpan * fraction))
                    }
                }
            )
            let response = try await transfer.start(request)
            if response.statusCode == 403 {
                try? FileManager.default.removeItem(at: destination)
                if attempt == 0 {
                    continue
                }
                throw OnDeviceYouTubeImportError.verificationRequired
            }
            guard (200 ... 299).contains(response.statusCode),
                  YouTubeMediaURLPolicy.isTrusted(response.url) else {
                throw OnDeviceYouTubeImportError.downloadRejected
            }
            if response.expectedContentLength > Self.maximumSourceBytes {
                throw OnDeviceYouTubeImportError.sourceTooLarge
            }
            let mimeType = response.mimeType?.lowercased()
            guard mimeType == "audio/mp4"
                    || mimeType == "video/mp4"
                    || mimeType == "application/octet-stream" else {
                throw OnDeviceYouTubeImportError.downloadRejected
            }
            downloadCompleted = true
            break
        }
        guard downloadCompleted else {
            throw OnDeviceYouTubeImportError.verificationRequired
        }

        let values = try destination.resourceValues(forKeys: [
            .fileSizeKey,
            .isRegularFileKey,
        ])
        guard values.isRegularFile == true,
              let size = values.fileSize,
              size > 0 else {
            throw OnDeviceYouTubeImportError.downloadRejected
        }
        guard Int64(size) <= Self.maximumSourceBytes else {
            throw OnDeviceYouTubeImportError.sourceTooLarge
        }

        await report(progress, 0.93)
        try await validateAudio(at: destination)
        try Task.checkCancellation()
        await report(progress, 1)

        shouldRemoveDestination = false
        return StagedYouTubeAudio(
            localURL: destination,
            displayName: String(title.prefix(120)),
            videoID: videoLink.videoID
        )
    }

    private func withTimeout<Value: Sendable>(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        let state = AsyncTimeoutState<Value>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Value, Error>) in
                state.setContinuation(continuation)
                let operationTask = Task {
                    do {
                        state.finish(.success(try await operation()))
                    } catch {
                        state.finish(.failure(error))
                    }
                }
                let timeoutTask = Task {
                    do {
                        try await Task.sleep(
                            nanoseconds: UInt64(seconds * 1_000_000_000)
                        )
                        state.finish(.failure(
                            OnDeviceYouTubeImportError.resolverFailed(
                                "The resolver timed out. Try again on a stable connection."
                            )
                        ))
                    } catch {
                        // The operation completed first.
                    }
                }
                state.installTasks([operationTask, timeoutTask])
            }
        } onCancel: {
            state.finish(.failure(CancellationError()))
        }
    }

    private func validateAudio(at url: URL) async throws {
        let asset = AVURLAsset(url: url)
        do {
            let tracks = try await asset.loadTracks(withMediaType: .audio)
            let duration = try await asset.load(.duration).seconds
            guard !tracks.isEmpty, duration.isFinite, duration > 0 else {
                throw OnDeviceYouTubeImportError.invalidAudio
            }
        } catch let error as OnDeviceYouTubeImportError {
            throw error
        } catch {
            throw OnDeviceYouTubeImportError.invalidAudio
        }
    }

    private func stagingDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("STEMulate", isDirectory: true)
            .appendingPathComponent("YouTubeImports", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func cleanupAbandonedDownloads() throws {
        let directory = try stagingDirectory()
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )
        for file in files {
            let modified = try? file.resourceValues(
                forKeys: [.contentModificationDateKey]
            ).contentModificationDate
            if modified == nil || modified! < cutoff {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func report(
        _ progress: (@MainActor @Sendable (Double) -> Void)?,
        _ value: Double
    ) async {
        await progress?(min(max(value, 0), 1))
    }
}

private struct SendableYouTube: @unchecked Sendable {
    let value: YouTube

    init(_ value: YouTube) {
        self.value = value
    }
}

private final class AsyncTimeoutState<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var pendingResult: Result<Value, Error>?
    private var tasks: [Task<Void, Never>] = []
    private var isFinished = false

    func setContinuation(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result = pendingResult {
            pendingResult = nil
            lock.unlock()
            continuation.resume(with: result)
        } else {
            self.continuation = continuation
            lock.unlock()
        }
    }

    func installTasks(_ tasks: [Task<Void, Never>]) {
        lock.lock()
        if isFinished {
            lock.unlock()
            tasks.forEach { $0.cancel() }
        } else {
            self.tasks = tasks
            lock.unlock()
        }
    }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let continuation = continuation
        self.continuation = nil
        if continuation == nil {
            pendingResult = result
        }
        let tasks = tasks
        self.tasks = []
        lock.unlock()

        tasks.forEach { $0.cancel() }
        continuation?.resume(with: result)
    }
}

private final class YouTubeAudioDownloadTransfer:
    NSObject,
    URLSessionDownloadDelegate,
    URLSessionTaskDelegate,
    @unchecked Sendable
{
    private let destination: URL
    private let maximumBytes: Int64
    private let progress: @Sendable (Double) -> Void
    private let lock = NSLock()
    private let delegateQueue: OperationQueue

    private var continuation: CheckedContinuation<HTTPURLResponse, Error>?
    private var task: URLSessionDownloadTask?
    private var moveError: Error?
    private var movedFile = false
    private var completed = false
    private var cancelled = false

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.allowsCellularAccess = true
        return URLSession(
            configuration: configuration,
            delegate: self,
            delegateQueue: delegateQueue
        )
    }()

    init(
        destination: URL,
        maximumBytes: Int64,
        progress: @escaping @Sendable (Double) -> Void
    ) {
        self.destination = destination
        self.maximumBytes = maximumBytes
        self.progress = progress
        delegateQueue = OperationQueue()
        delegateQueue.name = "STEMulate.YouTubeAudioDownload"
        delegateQueue.maxConcurrentOperationCount = 1
        super.init()
    }

    func start(_ request: URLRequest) async throws -> HTTPURLResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<HTTPURLResponse, Error>) in
                lock.lock()
                self.continuation = continuation
                let task = session.downloadTask(with: request)
                self.task = task
                let wasCancelled = cancelled
                lock.unlock()

                if wasCancelled {
                    task.cancel()
                } else {
                    task.resume()
                }
            }
        } onCancel: {
            self.cancel()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesWritten > maximumBytes {
            lock.lock()
            moveError = OnDeviceYouTubeImportError.sourceTooLarge
            lock.unlock()
            downloadTask.cancel()
            return
        }
        guard totalBytesExpectedToWrite > 0 else { return }
        progress(
            min(max(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite), 0), 1)
        )
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        do {
            try FileManager.default.moveItem(at: location, to: destination)
            lock.lock()
            movedFile = true
            lock.unlock()
        } catch {
            lock.lock()
            moveError = error
            lock.unlock()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard YouTubeMediaURLPolicy.isTrusted(request.url) else {
            lock.lock()
            moveError = OnDeviceYouTubeImportError.untrustedMediaURL
            lock.unlock()
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        let storedError = moveError
        let fileWasMoved = movedFile
        lock.unlock()

        if let storedError {
            finish(.failure(storedError))
        } else if let error {
            if (error as NSError).code == NSURLErrorCancelled {
                finish(.failure(CancellationError()))
            } else {
                finish(.failure(error))
            }
        } else if !fileWasMoved {
            finish(.failure(OnDeviceYouTubeImportError.downloadRejected))
        } else if let response = task.response as? HTTPURLResponse {
            finish(.success(response))
        } else {
            finish(.failure(OnDeviceYouTubeImportError.downloadRejected))
        }
    }

    private func cancel() {
        lock.lock()
        cancelled = true
        let task = task
        lock.unlock()
        task?.cancel()
    }

    private func finish(_ result: Result<HTTPURLResponse, Error>) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        let continuation = continuation
        self.continuation = nil
        lock.unlock()

        session.finishTasksAndInvalidate()
        continuation?.resume(with: result)
    }
}
