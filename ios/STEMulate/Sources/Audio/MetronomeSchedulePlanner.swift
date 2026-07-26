import Foundation

struct MetronomeEvent: Equatable, Sendable {
    let outputOffset: TimeInterval
    let beatIndex: Int
    let isAccent: Bool
}

enum MetronomeSchedulePlanner {
    static func events(
        startingAt mediaStart: TimeInterval,
        duration: TimeInterval,
        loop: StemLoopRange?,
        playbackRate: Float,
        bpm: Double,
        beatsPerBar: Int,
        outputRange: Range<TimeInterval>
    ) -> [MetronomeEvent] {
        guard duration > 0,
              bpm.isFinite,
              bpm > 0,
              outputRange.lowerBound.isFinite,
              outputRange.upperBound.isFinite,
              outputRange.upperBound > outputRange.lowerBound
        else {
            return []
        }

        let rate = TimeInterval(TransportMath.normalizedRate(playbackRate))
        let beatDuration = 60 / bpm
        let barLength = max(beatsPerBar, 1)
        let normalizedLoop = TransportMath.normalizedLoop(loop, duration: duration)
        let lowerAdvance = outputRange.lowerBound * rate
        let traversalStart = TransportMath.position(
            startingAt: mediaStart,
            afterAdvancing: lowerAdvance,
            duration: duration,
            loop: normalizedLoop
        )
        var remainingMediaDistance = (outputRange.upperBound - outputRange.lowerBound) * rate
        var traversedMediaDistance: TimeInterval = 0
        var cursor = traversalStart
        var includeSegmentStart = outputRange.lowerBound == 0
            || normalizedLoop.map {
                abs(traversalStart - $0.start) < 0.000_001
            } == true
        var result: [MetronomeEvent] = []

        while remainingMediaDistance > 0.000_001 {
            let segmentEnd: TimeInterval
            let wrapsAtSegmentEnd: Bool

            if let normalizedLoop {
                if cursor >= normalizedLoop.end {
                    cursor = normalizedLoop.start
                    includeSegmentStart = true
                }
                segmentEnd = normalizedLoop.end
                wrapsAtSegmentEnd = remainingMediaDistance >= segmentEnd - cursor
            } else {
                segmentEnd = duration
                wrapsAtSegmentEnd = false
            }

            let available = max(segmentEnd - cursor, 0)
            guard available > 0.000_001 else {
                if let normalizedLoop {
                    cursor = normalizedLoop.start
                    includeSegmentStart = true
                    continue
                }
                break
            }

            let distance = min(available, remainingMediaDistance)
            let audibleEnd = cursor + distance
            appendBeats(
                from: cursor,
                to: audibleEnd,
                includeStart: includeSegmentStart,
                includeEnd: !wrapsAtSegmentEnd,
                beatDuration: beatDuration,
                barLength: barLength,
                baseOutputOffset: outputRange.lowerBound,
                traversedMediaDistance: traversedMediaDistance,
                rate: rate,
                into: &result
            )

            remainingMediaDistance -= distance
            traversedMediaDistance += distance

            if remainingMediaDistance <= 0.000_001 {
                break
            }

            guard let normalizedLoop else {
                break
            }
            cursor = normalizedLoop.start
            includeSegmentStart = true
        }

        return result
    }

    private static func appendBeats(
        from start: TimeInterval,
        to end: TimeInterval,
        includeStart: Bool,
        includeEnd: Bool,
        beatDuration: TimeInterval,
        barLength: Int,
        baseOutputOffset: TimeInterval,
        traversedMediaDistance: TimeInterval,
        rate: TimeInterval,
        into result: inout [MetronomeEvent]
    ) {
        let epsilon = 0.000_001
        var beatIndex = Int(ceil((start - epsilon) / beatDuration))
        var beatTime = TimeInterval(beatIndex) * beatDuration

        if !includeStart, beatTime <= start + epsilon {
            beatIndex += 1
            beatTime = TimeInterval(beatIndex) * beatDuration
        }

        while beatTime < end - epsilon || (includeEnd && beatTime <= end + epsilon) {
            guard beatTime >= start - epsilon else {
                beatIndex += 1
                beatTime = TimeInterval(beatIndex) * beatDuration
                continue
            }

            let mediaOffset = traversedMediaDistance + max(beatTime - start, 0)
            result.append(
                MetronomeEvent(
                    outputOffset: baseOutputOffset + mediaOffset / rate,
                    beatIndex: beatIndex,
                    isAccent: beatIndex.isMultiple(of: barLength)
                )
            )
            beatIndex += 1
            beatTime = TimeInterval(beatIndex) * beatDuration
        }
    }
}
