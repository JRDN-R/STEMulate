import Foundation

enum TransportMath {
    static let minimumLoopDuration: TimeInterval = 0.25
    static let minimumPlaybackRate: Float = 0.5
    static let maximumPlaybackRate: Float = 2

    static func clampedPosition(_ position: TimeInterval, duration: TimeInterval) -> TimeInterval {
        guard duration.isFinite, duration > 0, position.isFinite else {
            return 0
        }
        return min(max(position, 0), duration)
    }

    static func normalizedLoop(
        _ loop: StemLoopRange?,
        duration: TimeInterval
    ) -> StemLoopRange? {
        guard let loop, duration.isFinite, duration > 0 else {
            return nil
        }

        let start = clampedPosition(loop.start, duration: duration)
        let end = clampedPosition(loop.end, duration: duration)
        guard end - start >= minimumLoopDuration else {
            return nil
        }

        return StemLoopRange(start: start, end: end)
    }

    static func normalizedRate(_ rate: Float) -> Float {
        guard rate.isFinite else {
            return 1
        }
        return min(max(rate, minimumPlaybackRate), maximumPlaybackRate)
    }

    static func position(
        startingAt start: TimeInterval,
        afterAdvancing mediaSeconds: TimeInterval,
        duration: TimeInterval,
        loop: StemLoopRange?
    ) -> TimeInterval {
        let clampedStart = clampedPosition(start, duration: duration)
        let advance = max(mediaSeconds.isFinite ? mediaSeconds : 0, 0)

        guard let loop = normalizedLoop(loop, duration: duration) else {
            return clampedPosition(clampedStart + advance, duration: duration)
        }

        let loopStart = loop.start
        let loopDuration = loop.duration
        let normalizedStart: TimeInterval

        if clampedStart < loopStart {
            let distanceToLoop = loopStart - clampedStart
            if advance < distanceToLoop {
                return clampedStart + advance
            }
            normalizedStart = loopStart
            return loopStart + (advance - distanceToLoop).truncatingRemainder(dividingBy: loopDuration)
        } else if clampedStart >= loop.end {
            normalizedStart = loopStart
        } else {
            normalizedStart = clampedStart
        }

        return loopStart
            + (normalizedStart - loopStart + advance)
                .truncatingRemainder(dividingBy: loopDuration)
    }

    static func snappedPan(_ pan: Float, detent: Float = 0.05) -> Float {
        let clamped = min(max(pan, -1), 1)
        return abs(clamped) <= abs(detent) ? 0 : clamped
    }

    static func snappedVolume(
        _ volume: Float,
        defaultVolume: Float = StemChannelState.defaultValue.volume,
        detent: Float = 0.03
    ) -> Float {
        let clamped = min(max(volume, 0), 1)
        return abs(clamped - defaultVolume) <= abs(detent) ? defaultVolume : clamped
    }
}

