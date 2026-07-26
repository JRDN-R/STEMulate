import AVFAudio
import CryptoKit
import Foundation

enum StemFileCacheError: LocalizedError, Equatable {
    case invalidJobID
    case invalidStemID(String)
    case duplicateStemID(String)
    case missingSourceFile(String)
    case emptySourceFile(String)
    case unsupportedAudioType(String)
    case unreadableAudio(String)
    case emptyDeck
    case missingManifest
    case corruptedManifest

    var errorDescription: String? {
        switch self {
        case .invalidJobID:
            return "The song identifier is invalid."
        case .invalidStemID(let stemID):
            return "The stem identifier “\(stemID)” is invalid."
        case .duplicateStemID(let stemID):
            return "The stem “\(stemID)” was supplied more than once."
        case .missingSourceFile(let stemID):
            return "The downloaded \(stemID) file is missing."
        case .emptySourceFile(let stemID):
            return "The downloaded \(stemID) file is empty."
        case .unsupportedAudioType(let stemID):
            return "The \(stemID) file is not a supported audio type."
        case .unreadableAudio(let stemID):
            return "The \(stemID) file could not be decoded by iOS."
        case .emptyDeck:
            return "No playable stems were supplied."
        case .missingManifest:
            return "This downloaded song is incomplete."
        case .corruptedManifest:
            return "This downloaded song has invalid cache metadata."
        }
    }
}

actor StemFileCache {
    private struct Manifest: Codable, Sendable {
        struct Stem: Codable, Sendable {
            let stemID: String
            let displayName: String
            let fileName: String
            let contentType: String?
            let byteCount: Int64
            let container: StemAudioContainer
        }

        let version: Int
        let jobID: String
        let title: String
        let createdAt: Date
        var lastAccessedAt: Date
        let stems: [Stem]
    }

    private static let manifestFileName = "manifest.json"
    private static let manifestVersion = 1

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(rootDirectory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager

        if let rootDirectory {
            self.rootDirectory = rootDirectory
        } else {
            let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.rootDirectory = applicationSupport
                .appendingPathComponent("STEMulate", isDirectory: true)
                .appendingPathComponent("DownloadedAudio", isDirectory: true)
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    func cacheSong(
        jobID: String,
        title: String,
        stems: [CachedStemInput]
    ) throws -> LocalStemDeck {
        guard Self.isValidIdentifier(jobID) else {
            throw StemFileCacheError.invalidJobID
        }
        guard !stems.isEmpty else {
            throw StemFileCacheError.emptyDeck
        }

        var seenStemIDs = Set<String>()
        for stem in stems {
            guard Self.isValidIdentifier(stem.stemID) else {
                throw StemFileCacheError.invalidStemID(stem.stemID)
            }
            guard seenStemIDs.insert(stem.stemID).inserted else {
                throw StemFileCacheError.duplicateStemID(stem.stemID)
            }
        }

        try prepareRootDirectory()

        let stagingDirectory = rootDirectory
            .appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: true
        )

        do {
            let manifestStems = try stems.map { input in
                try copyAndValidate(input, into: stagingDirectory)
            }
            let now = Date()
            let manifest = Manifest(
                version: Self.manifestVersion,
                jobID: jobID,
                title: title,
                createdAt: now,
                lastAccessedAt: now,
                stems: manifestStems
            )
            try writeManifest(manifest, to: stagingDirectory)
            try protect(directory: stagingDirectory)
            try installStagedDirectory(stagingDirectory, for: jobID)
            return try deck(from: manifest, directory: directory(for: jobID))
        } catch {
            try? fileManager.removeItem(at: stagingDirectory)
            throw error
        }
    }

    func loadSong(jobID: String) throws -> LocalStemDeck {
        guard Self.isValidIdentifier(jobID) else {
            throw StemFileCacheError.invalidJobID
        }

        let directory = directory(for: jobID)
        var manifest = try readManifest(from: directory)
        manifest.lastAccessedAt = Date()
        try writeManifest(manifest, to: directory)
        return try deck(from: manifest, directory: directory)
    }

    func cachedJobIDs() throws -> [String] {
        guard fileManager.fileExists(atPath: rootDirectory.path) else {
            return []
        }

        return try fileManager
            .contentsOfDirectory(
                at: rootDirectory,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            .compactMap { directory -> (String, Date)? in
                guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                      let manifest = try? readManifest(from: directory)
                else {
                    return nil
                }
                return (manifest.jobID, manifest.lastAccessedAt)
            }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }

    func removeSong(jobID: String) throws {
        guard Self.isValidIdentifier(jobID) else {
            throw StemFileCacheError.invalidJobID
        }

        let target = directory(for: jobID)
        guard fileManager.fileExists(atPath: target.path) else {
            return
        }
        try fileManager.removeItem(at: target)
    }

    @discardableResult
    func trim(
        toMaximumBytes maximumBytes: Int64,
        preservingJobIDs: Set<String> = []
    ) throws -> Int64 {
        guard maximumBytes >= 0,
              fileManager.fileExists(atPath: rootDirectory.path)
        else {
            return 0
        }

        let candidates = try fileManager
            .contentsOfDirectory(
                at: rootDirectory,
                includingPropertiesForKeys: [.isDirectoryKey, .totalFileAllocatedSizeKey],
                options: [.skipsHiddenFiles]
            )
            .compactMap { directory -> (url: URL, manifest: Manifest, bytes: Int64)? in
                guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                      let manifest = try? readManifest(from: directory)
                else {
                    return nil
                }
                return (
                    directory,
                    manifest,
                    (try? allocatedSize(of: directory)) ?? 0
                )
            }

        var totalBytes = candidates.reduce(Int64(0)) { $0 + $1.bytes }
        let removable = candidates
            .filter { !preservingJobIDs.contains($0.manifest.jobID) }
            .sorted { $0.manifest.lastAccessedAt < $1.manifest.lastAccessedAt }

        for candidate in removable where totalBytes > maximumBytes {
            try fileManager.removeItem(at: candidate.url)
            totalBytes -= candidate.bytes
        }

        return max(totalBytes, 0)
    }

    static func isValidIdentifier(_ identifier: String) -> Bool {
        guard !identifier.isEmpty, identifier.count <= 128 else {
            return false
        }

        return identifier.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar)
                || scalar == "_"
                || scalar == "-"
        }
    }

    static func directoryName(for jobID: String) -> String {
        SHA256
            .hash(data: Data(jobID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func prepareRootDirectory() throws {
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true
        )
        try protect(directory: rootDirectory)
    }

    private func copyAndValidate(
        _ input: CachedStemInput,
        into stagingDirectory: URL
    ) throws -> Manifest.Stem {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(
            atPath: input.sourceURL.path,
            isDirectory: &isDirectory
        ), !isDirectory.boolValue else {
            throw StemFileCacheError.missingSourceFile(input.stemID)
        }

        let sourceValues = try input.sourceURL.resourceValues(forKeys: [.fileSizeKey])
        guard let sourceByteCount = sourceValues.fileSize, sourceByteCount > 0 else {
            throw StemFileCacheError.emptySourceFile(input.stemID)
        }

        guard let container = StemAudioContainer.detect(
            fileURL: input.sourceURL,
            contentType: input.contentType
        ) else {
            throw StemFileCacheError.unsupportedAudioType(input.stemID)
        }

        let fileName = "\(input.stemID).\(container.preferredFileExtension)"
        let destination = stagingDirectory.appendingPathComponent(
            fileName,
            isDirectory: false
        )
        try fileManager.copyItem(at: input.sourceURL, to: destination)

        do {
            let audioFile = try AVAudioFile(forReading: destination)
            guard audioFile.length > 0,
                  audioFile.processingFormat.sampleRate > 0,
                  audioFile.processingFormat.channelCount > 0
            else {
                throw StemFileCacheError.unreadableAudio(input.stemID)
            }
        } catch let error as StemFileCacheError {
            throw error
        } catch {
            throw StemFileCacheError.unreadableAudio(input.stemID)
        }

        let copiedValues = try destination.resourceValues(forKeys: [.fileSizeKey])
        guard let copiedByteCount = copiedValues.fileSize, copiedByteCount > 0 else {
            throw StemFileCacheError.emptySourceFile(input.stemID)
        }

        return Manifest.Stem(
            stemID: input.stemID,
            displayName: input.displayName,
            fileName: fileName,
            contentType: input.contentType,
            byteCount: Int64(copiedByteCount),
            container: container
        )
    }

    private func installStagedDirectory(_ stagingDirectory: URL, for jobID: String) throws {
        let target = directory(for: jobID)
        guard fileManager.fileExists(atPath: target.path) else {
            try fileManager.moveItem(at: stagingDirectory, to: target)
            return
        }

        let backup = rootDirectory
            .appendingPathComponent(".backup-\(UUID().uuidString)", isDirectory: true)
        try fileManager.moveItem(at: target, to: backup)

        do {
            try fileManager.moveItem(at: stagingDirectory, to: target)
            try fileManager.removeItem(at: backup)
        } catch {
            if fileManager.fileExists(atPath: target.path) {
                try? fileManager.removeItem(at: target)
            }
            try? fileManager.moveItem(at: backup, to: target)
            throw error
        }
    }

    private func writeManifest(_ manifest: Manifest, to directory: URL) throws {
        let data = try encoder.encode(manifest)
        try data.write(
            to: directory.appendingPathComponent(Self.manifestFileName),
            options: .atomic
        )
    }

    private func readManifest(from directory: URL) throws -> Manifest {
        let manifestURL = directory.appendingPathComponent(Self.manifestFileName)
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw StemFileCacheError.missingManifest
        }

        do {
            let manifest = try decoder.decode(
                Manifest.self,
                from: Data(contentsOf: manifestURL)
            )
            guard manifest.version == Self.manifestVersion,
                  Self.isValidIdentifier(manifest.jobID),
                  !manifest.stems.isEmpty
            else {
                throw StemFileCacheError.corruptedManifest
            }
            return manifest
        } catch let error as StemFileCacheError {
            throw error
        } catch {
            throw StemFileCacheError.corruptedManifest
        }
    }

    private func deck(from manifest: Manifest, directory: URL) throws -> LocalStemDeck {
        var seenStemIDs = Set<String>()
        let stems = try manifest.stems.map { stem -> LocalStemFile in
            guard Self.isValidIdentifier(stem.stemID),
                  seenStemIDs.insert(stem.stemID).inserted,
                  !stem.fileName.contains("/"),
                  !stem.fileName.contains("\\")
            else {
                throw StemFileCacheError.corruptedManifest
            }

            let fileURL = directory.appendingPathComponent(stem.fileName)
            guard fileManager.fileExists(atPath: fileURL.path) else {
                throw StemFileCacheError.missingSourceFile(stem.stemID)
            }

            return LocalStemFile(
                stemID: stem.stemID,
                displayName: stem.displayName,
                fileURL: fileURL,
                contentType: stem.contentType
            )
        }

        return LocalStemDeck(
            jobID: manifest.jobID,
            title: manifest.title,
            stems: stems
        )
    }

    private func directory(for jobID: String) -> URL {
        rootDirectory.appendingPathComponent(
            Self.directoryName(for: jobID),
            isDirectory: true
        )
    }

    private func protect(directory: URL) throws {
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableDirectory = directory
        try mutableDirectory.setResourceValues(resourceValues)

        try? fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
    }

    private func allocatedSize(of directory: URL) throws -> Int64 {
        guard let enumerator = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            return 0
        }

        var result: Int64 = 0
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(
                forKeys: [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
            )
            result += Int64(values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? 0)
        }
        return result
    }
}
