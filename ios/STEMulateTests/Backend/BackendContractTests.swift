import XCTest
@testable import STEMulate

final class BackendContractTests: XCTestCase {
    func testCurrentPublicJobSchemaDecodesAndKeepsOwnerBoundary() throws {
        let job = try ProcessingJobDecoder.decode(
            id: "job_123",
            value: [
                "ownerUid": "owner-1",
                "displayName": "Practice Song",
                "sourceType": "remote",
                "sourceProvider": "youtube",
                "status": "completed",
                "stage": "ready",
                "analysis": ["key": "B major", "bpm": 108],
                "outputs": [[
                    "key": "vocals",
                    "storagePath": "users/owner-1/jobs/job_123/outputs/vocals.wav",
                    "contentType": "audio/wav",
                    "sizeBytes": 4_096,
                ]],
                "previewStatus": "ready",
                "createdAt": Date(timeIntervalSince1970: 1_000),
                "updatedAt": Date(timeIntervalSince1970: 2_000),
                "mixerSettings": [
                    "version": 1,
                    "stemIds": ["vocals", "drums", "bass", "other"],
                    "channels": [
                        "vocals": [
                            "volume": 84,
                            "pan": 0,
                            "muted": false,
                            "solo": true,
                        ],
                    ],
                ],
            ],
            expectedOwnerUID: "owner-1"
        )

        XCTAssertEqual(job.displayName, "Practice Song")
        XCTAssertEqual(job.sourceProvider, .youtube)
        XCTAssertEqual(job.status, .completed)
        XCTAssertEqual(job.analysis.key, "B major")
        XCTAssertEqual(job.analysis.bpm, 108)
        XCTAssertEqual(job.outputs.map(\.key), ["vocals"])
        XCTAssertEqual(job.mixerSettings?.channels["vocals"]?.solo, true)
        XCTAssertTrue(job.canOpen)

        XCTAssertThrowsError(try ProcessingJobDecoder.decode(
            id: "job_123",
            value: [
                "ownerUid": "someone-else",
                "status": "completed",
                "outputs": [],
            ],
            expectedOwnerUID: "owner-1"
        ))
    }

    func testMixerSettingsRejectAggregateAndComponentDrumsTogether() {
        let invalid: [String: Any] = [
            "version": 1,
            "stemIds": ["drums", "kick"],
            "channels": [:],
        ]
        XCTAssertNil(ProcessingJobDecoder.decodeMixerSettings(invalid))
    }

    func testReadyPreviewRequiresOneSharedContiguousTimeline() throws {
        let future = Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000
        let windows: [[String: Any]] = [
            [
                "startFrame": 0,
                "frameCount": 1_024,
                "prerollByteStart": 0,
                "byteStart": 8,
                "byteEndExclusive": 100,
            ],
            [
                "startFrame": 1_024,
                "frameCount": 1_024,
                "prerollByteStart": 92,
                "byteStart": 100,
                "byteEndExclusive": 180,
            ],
        ]
        let lookup = try PlaybackResponseDecoder.decodePreviewLookup(
            jobID: "job-1",
            value: [
                "jobId": "job-1",
                "status": "ready",
                "expiresAt": future,
                "manifest": [
                    "version": 1,
                    "codec": "mp4a.40.2",
                    "bitstream": "adts",
                    "sampleRate": 48_000,
                    "packetFrames": 1_024,
                    "durationFrames": 2_048,
                    "stems": [
                        "vocals": [
                            "url": "https://storage.example/vocals.aac?signature=x",
                            "channels": 2,
                            "sizeBytes": 180,
                            "windows": windows,
                        ],
                        "bass": [
                            "url": "https://storage.example/bass.aac?signature=y",
                            "channels": 1,
                            "sizeBytes": 180,
                            "windows": windows,
                        ],
                    ],
                ],
            ]
        )

        guard case .ready(let preview) = lookup else {
            return XCTFail("Expected a ready preview")
        }
        XCTAssertEqual(preview.durationFrames, 2_048)
        XCTAssertEqual(Set(preview.stems.map(\.stemID)), ["vocals", "bass"])
    }

    func testOriginalOutputsIgnoreAnalysisArtifactsForPlayback() throws {
        let future = Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000
        let deck = try PlaybackResponseDecoder.decodeOriginalOutputs(
            jobID: "job-1",
            value: [
                "expiresAt": future,
                "outputs": [
                    [
                        "key": "vocals",
                        "url": "https://storage.example/vocals.wav?signature=x",
                        "contentType": "audio/wav",
                        "sizeBytes": 10_000,
                    ],
                    [
                        "key": "chordmap",
                        "url": "https://storage.example/chordmap.json?signature=y",
                        "contentType": "application/json",
                        "sizeBytes": 500,
                    ],
                ],
            ]
        )
        XCTAssertEqual(deck.assets.map(\.stemID), ["vocals"])
    }

    func testPlaybackPrefersDrumPartsWithoutDoublingCombinedDrums() {
        let completeAssets = [
            SignedPlaybackAsset(
                stemID: "vocals",
                remoteURL: URL(string: "https://storage.example/vocals.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "drums",
                remoteURL: URL(string: "https://storage.example/drums.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "kick",
                remoteURL: URL(string: "https://storage.example/kick.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "snare",
                remoteURL: URL(string: "https://storage.example/snare.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "toms",
                remoteURL: URL(string: "https://storage.example/toms.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "hi_hat",
                remoteURL: URL(string: "https://storage.example/hi_hat.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
            SignedPlaybackAsset(
                stemID: "cymbals",
                remoteURL: URL(string: "https://storage.example/cymbals.aac")!,
                contentType: "audio/aac",
                sizeBytes: 100
            ),
        ]

        XCTAssertEqual(
            PlaybackResponseDecoder.preferredDrumLayout(
                in: completeAssets
            ).map(\.stemID),
            ["vocals", "kick", "snare", "toms", "hi_hat", "cymbals"]
        )

        XCTAssertEqual(
            PlaybackResponseDecoder.preferredDrumLayout(
                in: Array(completeAssets.prefix(4))
            ).map(\.stemID),
            ["vocals", "drums"]
        )
    }
}
