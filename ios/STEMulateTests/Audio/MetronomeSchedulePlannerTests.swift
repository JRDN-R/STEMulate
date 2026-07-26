import XCTest
@testable import STEMulate

final class MetronomeSchedulePlannerTests: XCTestCase {
    func testPlansClicksAgainstMediaTimeline() {
        let events = MetronomeSchedulePlanner.events(
            startingAt: 0,
            duration: 30,
            loop: nil,
            playbackRate: 1,
            bpm: 120,
            beatsPerBar: 4,
            outputRange: 0..<2
        )

        XCTAssertEqual(events.map(\.outputOffset), [0, 0.5, 1, 1.5, 2])
        XCTAssertEqual(events.map(\.isAccent), [true, false, false, false, true])
    }

    func testPlaybackRateChangesRealTimeClickSpacing() {
        let events = MetronomeSchedulePlanner.events(
            startingAt: 0,
            duration: 30,
            loop: nil,
            playbackRate: 2,
            bpm: 120,
            beatsPerBar: 4,
            outputRange: 0..<1
        )

        XCTAssertEqual(events.map(\.outputOffset), [0, 0.25, 0.5, 0.75, 1])
    }

    func testPlannerIncludesPreLoopBeatsThenWraps() {
        let events = MetronomeSchedulePlanner.events(
            startingAt: 0,
            duration: 30,
            loop: StemLoopRange(start: 2, end: 4),
            playbackRate: 1,
            bpm: 60,
            beatsPerBar: 4,
            outputRange: 0..<6
        )

        XCTAssertEqual(events.map(\.outputOffset), [0, 1, 2, 3, 4, 5])
        XCTAssertEqual(events.map(\.beatIndex), [0, 1, 2, 3, 2, 3])
    }

    func testAdjacentSchedulingWindowsDoNotDuplicateOrdinaryBoundary() {
        let first = MetronomeSchedulePlanner.events(
            startingAt: 0,
            duration: 30,
            loop: nil,
            playbackRate: 1,
            bpm: 60,
            beatsPerBar: 4,
            outputRange: 0..<2
        )
        let second = MetronomeSchedulePlanner.events(
            startingAt: 0,
            duration: 30,
            loop: nil,
            playbackRate: 1,
            bpm: 60,
            beatsPerBar: 4,
            outputRange: 2..<4
        )

        XCTAssertEqual(first.map(\.outputOffset), [0, 1, 2])
        XCTAssertEqual(second.map(\.outputOffset), [3, 4])
    }
}
