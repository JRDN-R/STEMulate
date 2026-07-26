import Foundation
@preconcurrency import FirebaseFirestore

enum FirebaseValue {
    static func dictionary(_ value: Any?) -> [String: Any]? {
        if let value = value as? [String: Any] {
            return value
        }
        if let value = value as? NSDictionary {
            var result: [String: Any] = [:]
            for (rawKey, rawValue) in value {
                guard let key = rawKey as? String else { return nil }
                result[key] = rawValue
            }
            return result
        }
        return nil
    }

    static func array(_ value: Any?) -> [Any]? {
        if let value = value as? [Any] {
            return value
        }
        return (value as? NSArray)?.map { $0 }
    }

    static func string(
        _ value: Any?,
        maximumLength: Int = 1_024,
        allowEmpty: Bool = false
    ) -> String? {
        guard let value = value as? String else { return nil }
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.count <= maximumLength, allowEmpty || !result.isEmpty else {
            return nil
        }
        return result
    }

    static func bool(_ value: Any?) -> Bool? {
        value as? Bool
    }

    static func double(_ value: Any?) -> Double? {
        if value is Bool { return nil }
        let number: Double?
        if let value = value as? Double {
            number = value
        } else if let value = value as? NSNumber {
            number = value.doubleValue
        } else if let value = value as? String {
            number = Double(value)
        } else {
            number = nil
        }
        guard let number, number.isFinite else { return nil }
        return number
    }

    static func integer(_ value: Any?) -> Int64? {
        guard let number = double(value),
              number.rounded(.towardZero) == number,
              number >= Double(Int64.min),
              number < Double(Int64.max) else {
            return nil
        }
        return Int64(number)
    }

    static func positiveInteger(_ value: Any?) -> Int64? {
        guard let value = integer(value), value > 0 else { return nil }
        return value
    }

    static func date(_ value: Any?) -> Date? {
        if let value = value as? Timestamp {
            return value.dateValue()
        }
        if let value = value as? Date {
            return value
        }
        guard let milliseconds = double(value), milliseconds > 0 else {
            return nil
        }
        return Date(timeIntervalSince1970: milliseconds / 1_000)
    }

    static func httpsURL(_ value: Any?) -> URL? {
        guard let raw = string(value, maximumLength: 8_192),
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              let url = components.url else {
            return nil
        }
        return url
    }
}

enum ProcessingJobDecoder {
    static func decode(
        id: String,
        value: [String: Any],
        expectedOwnerUID: String
    ) throws -> ProcessingJob {
        guard BackendContract.isValidIdentifier(id) else {
            throw BackendError.invalidIdentifier
        }
        guard BackendContract.isValidIdentifier(expectedOwnerUID) else {
            throw BackendError.authenticationRequired
        }
        guard FirebaseValue.string(value["ownerUid"], maximumLength: 128) == expectedOwnerUID else {
            throw BackendError.invalidJob("A saved song has an invalid owner.")
        }

        let status = FirebaseValue.string(value["status"], maximumLength: 40)
            .flatMap(ProcessingJobStatus.init(rawValue:))
            ?? .processing
        let sourceFileName = FirebaseValue.string(value["sourceFileName"], maximumLength: 255)
        let explicitName = FirebaseValue.string(value["displayName"], maximumLength: 120)
        let fileNameWithoutExtension = sourceFileName.map {
            URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent
        }
        let displayName = explicitName ?? fileNameWithoutExtension ?? "Untitled track"
        let sourceProvider = FirebaseValue.string(value["sourceProvider"], maximumLength: 20)
            .flatMap(RemoteSourceProvider.init(rawValue:))
        let sourceType = FirebaseValue.string(value["sourceType"], maximumLength: 20)
            ?? (sourceProvider == nil ? "upload" : "remote")

        let rawAnalysis = FirebaseValue.dictionary(value["analysis"]) ?? [:]
        let rawBPM = FirebaseValue.double(rawAnalysis["bpm"] ?? rawAnalysis["tempo"])
        let bpm = rawBPM.flatMap { $0 > 0 && $0 <= 1_000 ? $0 : nil }
        let key = FirebaseValue.string(
            rawAnalysis["key"] ?? rawAnalysis["rootKey"] ?? rawAnalysis["root_key"],
            maximumLength: 40
        )

        let outputs = (FirebaseValue.array(value["outputs"]) ?? []).compactMap {
            decodeOutput($0)
        }
        let rawError = FirebaseValue.dictionary(value["error"])
        let error = rawError.flatMap(decodeProcessingError)
        let previewStatus = FirebaseValue.string(value["previewStatus"], maximumLength: 40)
            .flatMap(ProcessingPreviewStatus.init(rawValue:))
            ?? .unavailable

        return ProcessingJob(
            id: id,
            ownerUID: expectedOwnerUID,
            displayName: displayName,
            sourceFileName: sourceFileName,
            sourceType: sourceType,
            sourceProvider: sourceProvider,
            status: status,
            stage: FirebaseValue.string(value["stage"], maximumLength: 80)
                ?? status.rawValue,
            analysis: JobAnalysisSummary(key: key, bpm: bpm),
            outputs: outputs,
            mixerSettings: decodeMixerSettings(value["mixerSettings"]),
            previewStatus: previewStatus,
            createdAt: FirebaseValue.date(value["createdAt"]),
            updatedAt: FirebaseValue.date(value["updatedAt"]),
            error: error
        )
    }

    static func decodeMixerSettings(_ value: Any?) -> SavedMixerSettings? {
        guard let root = FirebaseValue.dictionary(value),
              FirebaseValue.integer(root["version"]) == Int64(SavedMixerSettings.version),
              let rawStemIDs = FirebaseValue.array(root["stemIds"]),
              !rawStemIDs.isEmpty,
              rawStemIDs.count <= BackendContract.audioStemIDs.count else {
            return nil
        }

        var seen = Set<String>()
        var stemIDs: [String] = []
        for rawID in rawStemIDs {
            guard let stemID = FirebaseValue.string(rawID, maximumLength: 40),
                  BackendContract.audioStemIDs.contains(stemID),
                  seen.insert(stemID).inserted else {
                return nil
            }
            stemIDs.append(stemID)
        }
        if seen.contains("drums"), !seen.isDisjoint(with: BackendContract.drumPartStemIDs) {
            return nil
        }

        guard let rawChannels = FirebaseValue.dictionary(root["channels"]),
              rawChannels.keys.allSatisfy(BackendContract.mixerStemIDs.contains) else {
            return nil
        }
        var channels: [String: MixerChannelSettings] = [:]
        for (stemID, rawChannel) in rawChannels {
            guard let channel = decodeMixerChannel(rawChannel) else {
                return nil
            }
            channels[stemID] = channel
        }
        return SavedMixerSettings(stemIDs: stemIDs, channels: channels)
    }

    private static func decodeOutput(_ value: Any) -> ProcessingOutput? {
        guard let raw = FirebaseValue.dictionary(value),
              let key = FirebaseValue.string(raw["key"], maximumLength: 120),
              let storagePath = FirebaseValue.string(raw["storagePath"], maximumLength: 1_024),
              !storagePath.contains("..") else {
            return nil
        }
        let sizeBytes = FirebaseValue.positiveInteger(raw["sizeBytes"])
        return ProcessingOutput(
            key: key,
            storagePath: storagePath,
            contentType: FirebaseValue.string(raw["contentType"], maximumLength: 120),
            sizeBytes: sizeBytes
        )
    }

    private static func decodeProcessingError(_ raw: [String: Any]) -> ProcessingError? {
        guard var message = FirebaseValue.string(raw["message"], maximumLength: 500) else {
            return nil
        }
        if message.range(of: "music.ai", options: .caseInsensitive) != nil {
            message = "The processing service could not process this track."
        }
        return ProcessingError(
            code: FirebaseValue.string(raw["code"], maximumLength: 120),
            message: message
        )
    }

    private static func decodeMixerChannel(_ value: Any) -> MixerChannelSettings? {
        guard let raw = FirebaseValue.dictionary(value),
              let volume = FirebaseValue.integer(raw["volume"]),
              let pan = FirebaseValue.integer(raw["pan"]),
              (0 ... 100).contains(volume),
              (-100 ... 100).contains(pan),
              let muted = FirebaseValue.bool(raw["muted"]),
              let solo = FirebaseValue.bool(raw["solo"]) else {
            return nil
        }
        return MixerChannelSettings(
            volume: Int(volume),
            pan: Int(pan),
            muted: muted,
            solo: solo
        )
    }
}

enum PlaybackResponseDecoder {
    static func decodeSignedOutputBundle(
        jobID: String,
        value: Any
    ) throws -> SignedOutputBundle {
        guard let root = FirebaseValue.dictionary(value),
              let expiresAt = FirebaseValue.date(root["expiresAt"]),
              expiresAt > Date(),
              let rawOutputs = FirebaseValue.array(root["outputs"]),
              rawOutputs.count <= 64 else {
            throw BackendError.invalidResponse("Playback links are malformed.")
        }
        let outputs = rawOutputs.compactMap { rawOutput -> SignedOutputArtifact? in
            guard let output = FirebaseValue.dictionary(rawOutput),
                  let key = FirebaseValue.string(output["key"], maximumLength: 120),
                  let url = FirebaseValue.httpsURL(output["url"]) else {
                return nil
            }
            return SignedOutputArtifact(
                key: key,
                remoteURL: url,
                contentType: FirebaseValue.string(output["contentType"], maximumLength: 120),
                sizeBytes: FirebaseValue.positiveInteger(output["sizeBytes"])
            )
        }
        guard outputs.count == rawOutputs.count else {
            throw BackendError.invalidResponse("A playback output is malformed.")
        }
        return SignedOutputBundle(
            jobID: jobID,
            expiresAt: expiresAt,
            outputs: outputs
        )
    }

    static func decodeOriginalOutputs(
        jobID: String,
        value: Any
    ) throws -> SignedPlaybackDeck {
        let bundle = try decodeSignedOutputBundle(jobID: jobID, value: value)
        return try originalPlaybackDeck(from: bundle)
    }

    static func originalPlaybackDeck(
        from bundle: SignedOutputBundle
    ) throws -> SignedPlaybackDeck {
        var usedStemIDs = Set<String>()
        let discoveredAssets = bundle.outputs.compactMap {
            output -> SignedPlaybackAsset? in
            guard let stemID = audioStemID(fromOutputKey: output.key),
                  usedStemIDs.insert(stemID).inserted,
                  isAudioContent(output.contentType, url: output.remoteURL) else {
                return nil
            }
            return SignedPlaybackAsset(
                stemID: stemID,
                remoteURL: output.remoteURL,
                contentType: output.contentType,
                sizeBytes: output.sizeBytes
            )
        }
        let assets = preferredDrumLayout(in: discoveredAssets)
        guard !assets.isEmpty else {
            throw BackendError.invalidResponse("No supported audio stems were returned.")
        }
        return SignedPlaybackDeck(
            jobID: bundle.jobID,
            expiresAt: bundle.expiresAt,
            format: .originalOutputs,
            assets: assets
        )
    }

    /// Avoids playing a combined drums track on top of its component stems.
    /// A complete separated kit is the more useful native practice layout.
    /// If only a partial kit is returned, keep the aggregate drums track so the
    /// rest of the instrument is not lost.
    static func preferredDrumLayout(
        in assets: [SignedPlaybackAsset]
    ) -> [SignedPlaybackAsset] {
        let availableIDs = Set(assets.map(\.stemID))
        let hasCombinedDrums = availableIDs.contains("drums")
        let hasCompleteDrumParts = BackendContract.drumPartStemIDs.isSubset(
            of: availableIDs
        )

        if hasCompleteDrumParts {
            return assets.filter { $0.stemID != "drums" }
        }
        if hasCombinedDrums {
            return assets.filter {
                !BackendContract.drumPartStemIDs.contains($0.stemID)
            }
        }
        return assets
    }

    static func decodePreviewLookup(
        jobID: String,
        value: Any
    ) throws -> PreviewLookup {
        guard let root = FirebaseValue.dictionary(value),
              FirebaseValue.string(root["jobId"], maximumLength: 128) == jobID,
              let rawStatus = FirebaseValue.string(root["status"], maximumLength: 40),
              let status = ProcessingPreviewStatus(rawValue: rawStatus) else {
            throw BackendError.invalidResponse("Preview status is malformed.")
        }
        let error = FirebaseValue.dictionary(root["error"]).flatMap { raw -> ProcessingError? in
            guard let message = FirebaseValue.string(raw["message"], maximumLength: 500) else {
                return nil
            }
            return ProcessingError(
                code: FirebaseValue.string(raw["code"], maximumLength: 120),
                message: message
            )
        }
        guard status == .ready else {
            return .pending(status, error)
        }

        guard let expiresAt = FirebaseValue.date(root["expiresAt"]),
              expiresAt > Date(),
              let manifest = FirebaseValue.dictionary(root["manifest"]),
              FirebaseValue.integer(manifest["version"]) == 1,
              FirebaseValue.string(manifest["codec"], maximumLength: 40) == "mp4a.40.2",
              FirebaseValue.string(manifest["bitstream"], maximumLength: 40) == "adts",
              FirebaseValue.integer(manifest["sampleRate"]) == 48_000,
              FirebaseValue.integer(manifest["packetFrames"]) == 1_024,
              let durationFrames = FirebaseValue.positiveInteger(manifest["durationFrames"]),
              durationFrames % 1_024 == 0,
              durationFrames <= Int64(20 * 60 * 48_000 + 1_024),
              let rawStems = FirebaseValue.dictionary(manifest["stems"]),
              !rawStems.isEmpty,
              rawStems.count <= BackendContract.audioStemIDs.count,
              rawStems.keys.allSatisfy(BackendContract.audioStemIDs.contains) else {
            throw BackendError.invalidResponse("The preview manifest is malformed.")
        }

        var stems: [PreviewStem] = []
        var referenceTimeline: [(Int64, Int64)]?
        for stemID in BackendContract.audioStemIDs.sorted() {
            guard let rawStemValue = rawStems[stemID] else { continue }
            let stem = try decodePreviewStem(
                stemID: stemID,
                value: rawStemValue,
                durationFrames: durationFrames
            )
            let timeline = stem.windows.map { ($0.startFrame, $0.frameCount) }
            if let referenceTimeline {
                guard timeline.count == referenceTimeline.count,
                      zip(timeline, referenceTimeline).allSatisfy({
                          $0.0.0 == $0.1.0 && $0.0.1 == $0.1.1
                      }) else {
                    throw BackendError.invalidResponse(
                        "Preview stems do not share one playback timeline."
                    )
                }
            } else {
                referenceTimeline = timeline
            }
            stems.append(stem)
        }
        guard !stems.isEmpty else {
            throw BackendError.invalidResponse("The preview contains no supported stems.")
        }
        return .ready(ReadyPreview(
            jobID: jobID,
            expiresAt: expiresAt,
            sampleRate: 48_000,
            packetFrames: 1_024,
            durationFrames: durationFrames,
            stems: stems
        ))
    }

    private static func decodePreviewStem(
        stemID: String,
        value: Any,
        durationFrames: Int64
    ) throws -> PreviewStem {
        guard let raw = FirebaseValue.dictionary(value),
              let url = FirebaseValue.httpsURL(raw["url"]),
              let channels = FirebaseValue.integer(raw["channels"]),
              (1 ... 2).contains(channels),
              let sizeBytes = FirebaseValue.positiveInteger(raw["sizeBytes"]),
              sizeBytes <= 67_108_864,
              let rawWindows = FirebaseValue.array(raw["windows"]),
              !rawWindows.isEmpty,
              rawWindows.count <= 4_096 else {
            throw BackendError.invalidResponse("A preview stem is malformed.")
        }

        var nextFrame: Int64 = 0
        var previousByteEnd: Int64?
        var windows: [PreviewWindow] = []
        for (index, rawWindow) in rawWindows.enumerated() {
            guard let window = FirebaseValue.dictionary(rawWindow),
                  let startFrame = FirebaseValue.integer(window["startFrame"]),
                  let frameCount = FirebaseValue.positiveInteger(window["frameCount"]),
                  let prerollByteStart = FirebaseValue.integer(window["prerollByteStart"]),
                  let byteStart = FirebaseValue.integer(window["byteStart"]),
                  let byteEndExclusive = FirebaseValue.positiveInteger(
                    window["byteEndExclusive"]
                  ),
                  startFrame == nextFrame,
                  startFrame % 1_024 == 0,
                  frameCount % 1_024 == 0,
                  prerollByteStart >= 0,
                  byteStart > prerollByteStart,
                  byteStart - prerollByteStart >= 7,
                  byteStart - prerollByteStart <= 8_191,
                  index != 0 || prerollByteStart == 0,
                  previousByteEnd == nil || byteStart == previousByteEnd,
                  byteEndExclusive > byteStart,
                  byteEndExclusive <= sizeBytes else {
                throw BackendError.invalidResponse("Preview byte windows are malformed.")
            }
            nextFrame += frameCount
            previousByteEnd = byteEndExclusive
            windows.append(PreviewWindow(
                startFrame: startFrame,
                frameCount: frameCount,
                prerollByteStart: prerollByteStart,
                byteStart: byteStart,
                byteEndExclusive: byteEndExclusive
            ))
        }
        guard nextFrame == durationFrames, previousByteEnd == sizeBytes else {
            throw BackendError.invalidResponse("A preview stem is incomplete.")
        }
        return PreviewStem(
            stemID: stemID,
            url: url,
            channels: Int(channels),
            sizeBytes: sizeBytes,
            windows: windows
        )
    }

    static func audioStemID(fromOutputKey key: String) -> String? {
        let tokens = key
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
        let tokenSet = Set(tokens)
        let normalizedKey = tokens.joined(separator: "_")
        let aliases: [(String, Set<String>)] = [
            ("kick", ["kick", "kicks", "kickdrum"]),
            ("snare", ["snare", "snares", "snaredrum"]),
            ("toms", ["tom", "toms"]),
            ("hi_hat", ["hi_hat", "hihat", "hihats"]),
            ("cymbals", ["cymbal", "cymbals"]),
            ("vocals", ["vocal", "vocals", "voice", "voices"]),
            ("drums", ["drum", "drums", "percussion"]),
            ("bass", ["bass"]),
            ("guitars", ["guitar", "guitars"]),
            ("piano", ["piano"]),
            ("keys", ["key", "keys", "keyboard", "keyboards"]),
            ("strings", ["string", "strings"]),
            ("wind", ["wind", "winds", "woodwind", "woodwinds", "brass"]),
            ("other", ["other", "instrumental", "instruments", "accompaniment"]),
        ]
        for (stemID, candidates) in aliases {
            if !tokenSet.isDisjoint(with: candidates)
                || candidates.contains(where: { alias in
                    normalizedKey == alias
                        || normalizedKey.contains("_\(alias)_")
                        || normalizedKey.hasPrefix("\(alias)_")
                        || normalizedKey.hasSuffix("_\(alias)")
                }) {
                return stemID
            }
        }
        return BackendContract.audioStemIDs.contains(key.lowercased())
            ? key.lowercased()
            : nil
    }

    private static func isAudioContent(_ contentType: String?, url: URL) -> Bool {
        if let contentType {
            return contentType.lowercased().hasPrefix("audio/")
        }
        let supportedExtensions: Set<String> = [
            "aac", "aif", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav",
        ]
        return supportedExtensions.contains(url.pathExtension.lowercased())
    }
}
