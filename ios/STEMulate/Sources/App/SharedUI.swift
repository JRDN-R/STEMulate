import Foundation
import SwiftUI

extension Color {
    static let stemulateAccent = Color(
        red: 91 / 255,
        green: 235 / 255,
        blue: 226 / 255
    )
    static let stemulateBackground = Color(
        red: 7 / 255,
        green: 13 / 255,
        blue: 14 / 255
    )
    static let stemulatePanel = Color.white.opacity(0.075)
}

struct AppMarkView: View {
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 12 : 16) {
            ZStack {
                RoundedRectangle(cornerRadius: compact ? 11 : 17)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.stemulateAccent.opacity(0.36),
                                Color.blue.opacity(0.22),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                Image(systemName: "waveform")
                    .font(.system(size: compact ? 20 : 31, weight: .bold))
                    .foregroundStyle(Color.stemulateAccent)
            }
            .frame(width: compact ? 44 : 68, height: compact ? 44 : 68)

            VStack(alignment: .leading, spacing: 2) {
                Text("STEMULATE")
                    .font(compact ? .headline : .title.bold())
                    .tracking(1.2)
                if !compact {
                    Text("Native stem practice")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct InlineErrorView: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.footnote)
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.red.opacity(0.25))
        }
    }
}

struct Panel<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(18)
            .background(Color.stemulatePanel, in: RoundedRectangle(cornerRadius: 22))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .stroke(Color.white.opacity(0.09))
            }
    }
}

struct ActivityButtonLabel: View {
    let title: String
    let systemImage: String
    let isWorking: Bool

    var body: some View {
        HStack(spacing: 9) {
            if isWorking {
                ProgressView()
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
        }
    }
}

extension Error {
    var userFacingMessage: String {
        if let localized = self as? LocalizedError,
           let description = localized.errorDescription,
           !description.isEmpty {
            return description
        }
        let description = localizedDescription
        return description.isEmpty ? "Something went wrong. Please try again." : description
    }
}

extension TimeInterval {
    var stemulateTimecode: String {
        guard isFinite, self >= 0 else { return "0:00" }
        let total = Int(self.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
