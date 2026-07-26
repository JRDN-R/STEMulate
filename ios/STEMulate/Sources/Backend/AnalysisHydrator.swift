import Foundation

enum AnalysisHydrator {
    static let maximumArtifactBytes = 16 * 1_024 * 1_024
    private static let maximumAnnotationsPerKind = 100_000

    static func hydrate(
        job: ProcessingJob,
        outputs: SignedOutputBundle,
        session: URLSession = .shared
    ) async throws -> HydratedSongAnalysis {
        let beatOutput = findAnalysisOutput(
            outputs.outputs,
            aliases: ["beatmap", "beats", "beat_map"]
        )
        let chordOutput = findAnalysisOutput(
            outputs.outputs,
            aliases: ["chordmap", "chords", "chord_map"]
        )
        let sectionOutput = findAnalysisOutput(
            outputs.outputs,
            aliases: ["sectionsmap", "sections", "sections_map"]
        )

        // Keep the values crossing each child-task boundary strongly typed and
        // Sendable. The untrusted `Any` JSON exists only inside that child.
        async let beats: [BeatAnnotation] = normalizeBeats(
            try await loadJSONIfPresent(beatOutput, session: session)
        )
        async let chords: [ChordAnnotation] = normalizeChords(
            try await loadJSONIfPresent(chordOutput, session: session)
        )
        async let sections: [SectionAnnotation] = normalizeSections(
            try await loadJSONIfPresent(sectionOutput, session: session)
        )

        return try await HydratedSongAnalysis(
            bpm: job.analysis.bpm ?? 0,
            key: job.analysis.key ?? "Unknown",
            beats: beats,
            chords: chords,
            sections: sections
        )
    }

    private static func loadJSONIfPresent(
        _ output: SignedOutputArtifact?,
        session: URLSession
    ) async throws -> Any? {
        guard let output else { return nil }
        if let sizeBytes = output.sizeBytes, sizeBytes > maximumArtifactBytes {
            throw BackendError.invalidResponse(
                "An analysis artifact exceeds the 16 MiB safety limit."
            )
        }
        let (bytes, response) = try await session.bytes(from: output.remoteURL)
        guard let http = response as? HTTPURLResponse,
              (200 ... 299).contains(http.statusCode) else {
            return nil
        }
        let declaredLength = response.expectedContentLength
        if declaredLength > maximumArtifactBytes {
            throw BackendError.invalidResponse(
                "An analysis artifact exceeds the 16 MiB safety limit."
            )
        }

        var data = Data()
        if declaredLength > 0 {
            data.reserveCapacity(Int(min(declaredLength, Int64(maximumArtifactBytes))))
        }
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumArtifactBytes else {
                throw BackendError.invalidResponse(
                    "An analysis artifact exceeds the 16 MiB safety limit."
                )
            }
            data.append(byte)
        }
        guard !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(
            with: data,
            options: [.fragmentsAllowed]
        )
    }

    private static func findAnalysisOutput(
        _ outputs: [SignedOutputArtifact],
        aliases: [String]
    ) -> SignedOutputArtifact? {
        let normalizedAliases = aliases.map(normalizeFieldName)
        return outputs.first { output in
            guard isAnalysisContent(output) else { return false }
            let key = normalizeFieldName(output.key)
            return normalizedAliases.contains(key)
                || normalizedAliases.contains { alias in
                    key.contains("_\(alias)") || key.contains("\(alias)_")
                }
        }
    }

    private static func isAnalysisContent(_ output: SignedOutputArtifact) -> Bool {
        if let contentType = output.contentType?.lowercased() {
            return contentType.contains("json") || contentType.hasPrefix("text/")
        }
        return ["json", "txt"].contains(output.remoteURL.pathExtension.lowercased())
    }

    private static func normalizeBeats(_ value: Any?) -> [BeatAnnotation] {
        list(value, keys: ["beats", "beatMap", "annotations"])
            .prefix(maximumAnnotationsPerKind)
            .enumerated()
            .compactMap { index, raw in
                guard let record = FirebaseValue.dictionary(raw) else { return nil }
                let time = firstNumber(record, keys: ["time", "start", "startTime"]) ?? 0
                let beat = firstNumber(
                    record,
                    keys: ["beat", "beatNum", "beatNumber", "number"]
                ) ?? Double((index % 4) + 1)
                guard time >= 0,
                      beat.isFinite,
                      beat >= -1_000_000,
                      beat <= 1_000_000 else {
                    return nil
                }
                return BeatAnnotation(time: time, beat: Int(beat))
            }
            .sorted { $0.time < $1.time }
    }

    private static func normalizeChords(_ value: Any?) -> [ChordAnnotation] {
        let labelFields = [
            "chord_simple_pop",
            "chord_complex_pop",
            "chord_simple_jazz",
            "chord_complex_jazz",
            "chord_majmin",
            "simplePop",
            "complexPop",
            "simpleJazz",
            "complexJazz",
            "majmin",
            "chord",
            "label",
            "value",
        ]
        return list(value, keys: ["chords", "chordMap", "annotations"])
            .prefix(maximumAnnotationsPerKind)
            .compactMap { raw in
                guard let record = FirebaseValue.dictionary(raw),
                      let chord = firstText(record, keys: labelFields) else {
                    return nil
                }
                let start = firstNumber(
                    record,
                    keys: ["start", "startTime", "time"]
                ) ?? 0
                let end = firstNumber(record, keys: ["end", "endTime"]) ?? 0
                guard start >= 0, end > start else { return nil }
                return ChordAnnotation(chord: chord, start: start, end: end)
            }
            .sorted { $0.start < $1.start }
    }

    private static func normalizeSections(_ value: Any?) -> [SectionAnnotation] {
        list(value, keys: ["sections", "sectionsMap", "annotations"])
            .prefix(maximumAnnotationsPerKind)
            .compactMap { raw in
                guard let record = FirebaseValue.dictionary(raw) else { return nil }
                let start = firstNumber(
                    record,
                    keys: ["start", "startTime", "time"]
                ) ?? 0
                let end = firstNumber(record, keys: ["end", "endTime"]) ?? 0
                guard start >= 0, end > start else { return nil }
                let label = firstText(record, keys: ["label", "section", "name"])
                    ?? "Section"
                return SectionAnnotation(label: label, start: start, end: end)
            }
            .sorted { $0.start < $1.start }
    }

    private static func list(_ value: Any?, keys: [String]) -> [Any] {
        if let value = FirebaseValue.array(value) { return value }
        guard let record = FirebaseValue.dictionary(value) else { return [] }
        for key in keys {
            if let value = FirebaseValue.array(record[key]) {
                return value
            }
        }
        return []
    }

    private static func firstNumber(
        _ record: [String: Any],
        keys: [String]
    ) -> Double? {
        for key in keys {
            if let number = FirebaseValue.double(record[key]) {
                return number
            }
        }
        return nil
    }

    private static func firstText(
        _ record: [String: Any],
        keys: [String]
    ) -> String? {
        var normalized: [String: Any] = [:]
        for (key, value) in record where normalized[normalizeFieldName(key)] == nil {
            normalized[normalizeFieldName(key)] = value
        }
        for key in keys {
            let value = normalized[normalizeFieldName(key)]
            if let string = FirebaseValue.string(value, maximumLength: 120) {
                return string
            }
            if let number = FirebaseValue.double(value) {
                return String(number)
            }
        }
        return nil
    }

    private static func normalizeFieldName(_ value: String) -> String {
        value.lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .joined(separator: "_")
    }
}
