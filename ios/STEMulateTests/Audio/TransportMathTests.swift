import XCTest
@testable import STEMulate

final class TransportMathTests: XCTestCase {
    func testClampsPositionAndPlaybackRate() {
        XCTAssertEqual(TransportMath.clampedPosition(-4, duration: 90), 0)
        XCTAssertEqual(TransportMath.clampedPosition(120, duration: 90), 90)
        XCTAssertEqual(TransportMath.normalizedRate(0.1), 0.5)
        XCTAssertEqual(TransportMath.normalizedRate(3), 2)
    }

    func testPlaybackBeforeLoopContinuesIntoLoop() {
        let loop = StemLoopRange(start: 10, end: 20)

        XCTAssertEqual(
            TransportMath.position(
                startingAt: 4,
                afterAdvancing: 3,
                duration: 60,
                loop: loop
            ),
            7,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            TransportMath.position(
                startingAt: 4,
                afterAdvancing: 18,
                duration: 60,
                loop: loop
            ),
            12,
            accuracy: 0.000_001
        )
    }

    func testPlaybackWrapsInsideLoop() {
        let loop = StemLoopRange(start: 10, end: 20)

        XCTAssertEqual(
            TransportMath.position(
                startingAt: 18,
                afterAdvancing: 5,
                duration: 60,
                loop: loop
            ),
            13,
            accuracy: 0.000_001
        )
    }

    func testInvalidLoopIsRejected() {
        XCTAssertNil(
            TransportMath.normalizedLoop(
                StemLoopRange(start: 2, end: 2.1),
                duration: 30
            )
        )
        XCTAssertEqual(
            TransportMath.normalizedLoop(
                StemLoopRange(start: -1, end: 8),
                duration: 30
            ),
            StemLoopRange(start: 0, end: 8)
        )
    }

    func testMixerDetentsSnapGently() {
        XCTAssertEqual(TransportMath.snappedPan(0.04), 0)
        XCTAssertEqual(TransportMath.snappedPan(0.08), 0.08)
        XCTAssertEqual(TransportMath.snappedVolume(0.78), 0.8)
        XCTAssertEqual(TransportMath.snappedVolume(0.72), 0.72)
    }
}

