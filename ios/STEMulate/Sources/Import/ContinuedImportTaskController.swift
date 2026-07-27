import BackgroundTasks
import Foundation

@available(iOS 26.0, *)
@MainActor
final class ContinuedImportTaskController {
    static let shared = ContinuedImportTaskController()

    private struct PendingOperation {
        let identifier: String
        let work: @MainActor @Sendable (Progress) async throws -> Void
        let continuation: CheckedContinuation<Void, Error>
    }

    private enum SubmissionError: Error {
        case unavailable
    }

    private var pendingOperation: PendingOperation?

    private var identifierPrefix: String {
        "\(Bundle.main.bundleIdentifier ?? "io.github.jrdn-r.STEMulate").youtubeImport"
    }

    func perform(
        title: String,
        subtitle: String,
        work: @escaping @MainActor @Sendable (Progress) async throws -> Void
    ) async throws {
        do {
            try await submit(title: title, subtitle: subtitle, work: work)
        } catch SubmissionError.unavailable {
            let progress = Progress(totalUnitCount: 1_000)
            try await work(progress)
        }
    }

    private func submit(
        title: String,
        subtitle: String,
        work: @escaping @MainActor @Sendable (Progress) async throws -> Void
    ) async throws {
        guard pendingOperation == nil else {
            throw SubmissionError.unavailable
        }
        let identifier = "\(identifierPrefix).\(UUID().uuidString.lowercased())"
        let isRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: identifier,
            using: nil
        ) { task in
            Task { @MainActor in
                Self.shared.run(task, identifier: identifier)
            }
        }
        guard isRegistered else {
            throw SubmissionError.unavailable
        }

        do {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, Error>) in
                pendingOperation = PendingOperation(
                    identifier: identifier,
                    work: work,
                    continuation: continuation
                )
                let request = BGContinuedProcessingTaskRequest(
                    identifier: identifier,
                    title: title,
                    subtitle: subtitle
                )
                request.strategy = .fail
                do {
                    try BGTaskScheduler.shared.submit(request)
                } catch {
                    pendingOperation = nil
                    continuation.resume(throwing: SubmissionError.unavailable)
                }

                // A successful submit does not guarantee that iOS invokes the
                // handler promptly. Fall back to foreground work instead of
                // leaving the import UI waiting indefinitely.
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    self?.expirePendingOperation(identifier: identifier)
                }
            }
        } catch is SubmissionError {
            throw SubmissionError.unavailable
        }
    }

    private func run(_ rawTask: BGTask, identifier: String) {
        guard let operation = pendingOperation,
              operation.identifier == identifier else {
            rawTask.setTaskCompleted(success: false)
            return
        }
        guard let task = rawTask as? BGContinuedProcessingTask else {
            pendingOperation = nil
            rawTask.setTaskCompleted(success: false)
            operation.continuation.resume(
                throwing: SubmissionError.unavailable
            )
            return
        }
        pendingOperation = nil
        task.progress.totalUnitCount = 1_000
        task.progress.completedUnitCount = 0

        let workTask = Task { @MainActor in
            do {
                try await operation.work(task.progress)
                task.progress.completedUnitCount = task.progress.totalUnitCount
                task.setTaskCompleted(success: true)
                operation.continuation.resume()
            } catch {
                task.setTaskCompleted(success: false)
                operation.continuation.resume(throwing: error)
            }
        }
        task.expirationHandler = {
            workTask.cancel()
        }
    }

    private func expirePendingOperation(identifier: String) {
        guard let operation = pendingOperation,
              operation.identifier == identifier else {
            return
        }
        pendingOperation = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        operation.continuation.resume(throwing: SubmissionError.unavailable)
    }
}
