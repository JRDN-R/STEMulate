import Foundation

struct YouTubeVideoLink: Equatable, Sendable {
    let videoID: String
    let canonicalURL: URL

    static func parse(_ input: String) throws -> Self {
        let cleanInput = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: cleanInput),
              components.scheme?.lowercased() == "https",
              components.user == nil,
              components.password == nil,
              components.port == nil || components.port == 443,
              let rawHost = components.host else {
            throw YouTubeLinkError.invalidURL
        }

        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let pathParts = components.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        let videoID: String
        switch host {
        case "youtu.be":
            guard pathParts.count == 1 else {
                throw YouTubeLinkError.singleVideoRequired
            }
            videoID = pathParts[0]

        case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com":
            if pathParts == ["watch"] || pathParts.isEmpty {
                let videoIDs = Set(
                    (components.queryItems ?? [])
                        .filter { $0.name.lowercased() == "v" }
                        .compactMap(\.value)
                )
                guard videoIDs.count == 1, let queryVideoID = videoIDs.first else {
                    throw YouTubeLinkError.singleVideoRequired
                }
                videoID = queryVideoID
            } else if pathParts.count == 2,
                      ["embed", "live", "shorts"].contains(pathParts[0].lowercased()) {
                videoID = pathParts[1]
            } else {
                throw YouTubeLinkError.singleVideoRequired
            }

        default:
            throw YouTubeLinkError.unsupportedHost
        }

        guard isValidVideoID(videoID) else {
            throw YouTubeLinkError.invalidVideoID
        }
        guard let canonicalURL = URL(
            string: "https://www.youtube.com/watch?v=\(videoID)"
        ) else {
            throw YouTubeLinkError.invalidURL
        }
        return Self(videoID: videoID, canonicalURL: canonicalURL)
    }

    private static func isValidVideoID(_ value: String) -> Bool {
        guard value.utf8.count == 11 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (48 ... 57).contains(scalar.value)
                || (65 ... 90).contains(scalar.value)
                || (97 ... 122).contains(scalar.value)
                || scalar.value == 45
                || scalar.value == 95
        }
    }
}

enum YouTubeLinkError: LocalizedError, Equatable, Sendable {
    case invalidURL
    case unsupportedHost
    case singleVideoRequired
    case invalidVideoID

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Paste a complete HTTPS YouTube link."
        case .unsupportedHost:
            return "Use a youtube.com, music.youtube.com, m.youtube.com, or youtu.be link."
        case .singleVideoRequired:
            return "Use a link to one YouTube video, not a playlist, channel, or search page."
        case .invalidVideoID:
            return "That YouTube link does not contain a valid video ID."
        }
    }
}

enum YouTubeMediaURLPolicy {
    static func isTrusted(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              url.port == nil || url.port == 443,
              let rawHost = url.host else {
            return false
        }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return host == "googlevideo.com" || host.hasSuffix(".googlevideo.com")
    }
}
