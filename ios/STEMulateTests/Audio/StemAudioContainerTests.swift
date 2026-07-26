import XCTest
@testable import STEMulate

final class StemAudioContainerTests: XCTestCase {
    func testDetectsPreviewAndFallbackFormats() {
        XCTAssertEqual(
            StemAudioContainer.detect(
                fileURL: URL(fileURLWithPath: "/tmp/stem.bin"),
                contentType: "audio/aac; charset=binary"
            ),
            .aacADTS
        )
        XCTAssertEqual(
            StemAudioContainer.detect(
                fileURL: URL(fileURLWithPath: "/tmp/stem.wav"),
                contentType: nil
            ),
            .wave
        )
        XCTAssertEqual(
            StemAudioContainer.detect(
                fileURL: URL(fileURLWithPath: "/tmp/stem.flac"),
                contentType: nil
            ),
            .flac
        )
    }

    func testRejectsFormatsAVAudioFileDoesNotReliablyDecode() {
        XCTAssertNil(
            StemAudioContainer.detect(
                fileURL: URL(fileURLWithPath: "/tmp/stem.ogg"),
                contentType: "audio/ogg"
            )
        )
        XCTAssertNil(
            StemAudioContainer.detect(
                fileURL: URL(fileURLWithPath: "/tmp/stem.opus"),
                contentType: "audio/opus"
            )
        )
    }
}

