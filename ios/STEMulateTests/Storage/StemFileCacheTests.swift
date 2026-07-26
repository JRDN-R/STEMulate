import AVFAudio
import XCTest
@testable import STEMulate

final class StemFileCacheTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: temporaryDirectory,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let temporaryDirectory {
            try? FileManager.default.removeItem(at: temporaryDirectory)
        }
        temporaryDirectory = nil
    }

    func testCachesDeckAsIndependentDiskFiles() async throws {
        let sourceDirectory = temporaryDirectory
            .appendingPathComponent("source", isDirectory: true)
        let cacheDirectory = temporaryDirectory
            .appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(
            at: sourceDirectory,
            withIntermediateDirectories: true
        )

        let vocals = sourceDirectory.appendingPathComponent("vocals.wav")
        let drums = sourceDirectory.appendingPathComponent("drums.wav")
        try makeWaveFile(at: vocals)
        try makeWaveFile(at: drums)

        let cache = StemFileCache(rootDirectory: cacheDirectory)
        let deck = try await cache.cacheSong(
            jobID: "job-123",
            title: "Test Song",
            stems: [
                CachedStemInput(stemID: "vocals", sourceURL: vocals),
                CachedStemInput(stemID: "drums", sourceURL: drums),
            ]
        )

        XCTAssertEqual(deck.jobID, "job-123")
        XCTAssertEqual(deck.stems.map(\.stemID), ["vocals", "drums"])
        XCTAssertTrue(deck.stems.allSatisfy {
            FileManager.default.fileExists(atPath: $0.fileURL.path)
        })
        XCTAssertTrue(deck.stems.allSatisfy {
            $0.fileURL.deletingLastPathComponent() != sourceDirectory
        })

        try FileManager.default.removeItem(at: sourceDirectory)
        let reloaded = try await cache.loadSong(jobID: "job-123")
        XCTAssertEqual(reloaded.stems.map(\.stemID), ["vocals", "drums"])
        XCTAssertTrue(reloaded.stems.allSatisfy {
            FileManager.default.fileExists(atPath: $0.fileURL.path)
        })
    }

    func testRejectsDuplicateStemIdentifiers() async throws {
        let source = temporaryDirectory.appendingPathComponent("stem.wav")
        try makeWaveFile(at: source)
        let cache = StemFileCache(
            rootDirectory: temporaryDirectory.appendingPathComponent("cache")
        )

        do {
            _ = try await cache.cacheSong(
                jobID: "job-123",
                title: "Test Song",
                stems: [
                    CachedStemInput(stemID: "vocals", sourceURL: source),
                    CachedStemInput(stemID: "vocals", sourceURL: source),
                ]
            )
            XCTFail("Expected duplicate stem rejection")
        } catch {
            XCTAssertEqual(
                error as? StemFileCacheError,
                .duplicateStemID("vocals")
            )
        }
    }

    func testRejectsUnsupportedExtensionBeforePlayback() async throws {
        let source = temporaryDirectory.appendingPathComponent("stem.ogg")
        try Data([0, 1, 2, 3]).write(to: source)
        let cache = StemFileCache(
            rootDirectory: temporaryDirectory.appendingPathComponent("cache")
        )

        do {
            _ = try await cache.cacheSong(
                jobID: "job-123",
                title: "Test Song",
                stems: [
                    CachedStemInput(
                        stemID: "vocals",
                        sourceURL: source,
                        contentType: "audio/ogg"
                    ),
                ]
            )
            XCTFail("Expected unsupported file rejection")
        } catch {
            XCTAssertEqual(
                error as? StemFileCacheError,
                .unsupportedAudioType("vocals")
            )
        }
    }

    private func makeWaveFile(at url: URL) throws {
        let format = AVAudioFormat(
            standardFormatWithSampleRate: 44_100,
            channels: 1
        )!
        let file = try AVAudioFile(
            forWriting: url,
            settings: format.settings
        )
        let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: 4_410
        )!
        buffer.frameLength = 4_410
        try file.write(from: buffer)
    }
}
