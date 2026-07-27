import XCTest
@testable import STEMulate

final class YouTubeVideoLinkTests: XCTestCase {
    private let videoID = "dQw4w9WgXcQ"

    func testCanonicalizesSupportedYouTubeForms() throws {
        let links = [
            "https://youtube.com/watch?v=\(videoID)",
            "https://www.youtube.com/watch?v=\(videoID)&t=42",
            "https://m.youtube.com/shorts/\(videoID)?feature=share",
            "https://music.youtube.com/watch?v=\(videoID)&list=RDAMVM",
            "https://youtu.be/\(videoID)?si=abc",
            "https://www.youtube.com/live/\(videoID)",
            "https://www.youtube.com/embed/\(videoID)",
        ]

        for link in links {
            let parsed = try YouTubeVideoLink.parse(link)
            XCTAssertEqual(parsed.videoID, videoID)
            XCTAssertEqual(
                parsed.canonicalURL.absoluteString,
                "https://www.youtube.com/watch?v=\(videoID)"
            )
        }
    }

    func testRejectsPagesThatAreNotOneVideo() {
        let links = [
            "https://www.youtube.com/playlist?list=PL123",
            "https://www.youtube.com/results?search_query=music",
            "https://www.youtube.com/@artist",
            "https://youtu.be/\(videoID)/extra",
            "https://www.youtube.com/watch?list=PL123",
        ]
        for link in links {
            XCTAssertThrowsError(try YouTubeVideoLink.parse(link))
        }
    }

    func testRejectsUntrustedOrMalformedURLs() {
        let links = [
            "http://youtu.be/\(videoID)",
            "https://example.com/watch?v=\(videoID)",
            "https://user:password@youtube.com/watch?v=\(videoID)",
            "https://youtube.com:444/watch?v=\(videoID)",
            "not a link",
            "https://youtu.be/short",
        ]
        for link in links {
            XCTAssertThrowsError(try YouTubeVideoLink.parse(link))
        }
    }

    func testOnlyTrustsHTTPSGoogleVideoMediaHosts() {
        XCTAssertTrue(
            YouTubeMediaURLPolicy.isTrusted(
                URL(string: "https://rr1---sn-a5mekn.googlevideo.com/videoplayback")
            )
        )
        XCTAssertTrue(
            YouTubeMediaURLPolicy.isTrusted(
                URL(string: "https://googlevideo.com/videoplayback")
            )
        )
        XCTAssertFalse(
            YouTubeMediaURLPolicy.isTrusted(
                URL(string: "http://rr1.googlevideo.com/videoplayback")
            )
        )
        XCTAssertFalse(
            YouTubeMediaURLPolicy.isTrusted(
                URL(string: "https://googlevideo.com.example.org/file")
            )
        )
        XCTAssertFalse(
            YouTubeMediaURLPolicy.isTrusted(
                URL(string: "https://example.com/file.m4a")
            )
        )
    }
}
