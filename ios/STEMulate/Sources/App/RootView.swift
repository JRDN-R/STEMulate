import FirebaseCore
import SwiftUI
import UIKit

struct RootView: View {
    var body: some View {
        Group {
            if FirebaseApp.app() == nil {
                FirebaseSetupRequiredView()
            } else {
                OwnerSessionRootView()
            }
        }
        .tint(.stemulateAccent)
        .background(Color.stemulateBackground.ignoresSafeArea())
    }
}

private struct OwnerSessionRootView: View {
    @StateObject private var ownerSession: GoogleOwnerSession
    @State private var isSigningIn = false
    @State private var errorMessage: String?

    init() {
        _ownerSession = StateObject(wrappedValue: GoogleOwnerSession())
    }

    var body: some View {
        Group {
            switch ownerSession.state {
            case .signedOut:
                SignInView(
                    isWorking: isSigningIn,
                    errorMessage: errorMessage,
                    signIn: signIn
                )

            case .checkingAuthorization:
                ProgressScreen(
                    title: "Checking access",
                    detail: "Confirming this Google account can use your private library."
                )

            case .unauthorized(_, let email):
                UnauthorizedAccountView(
                    email: email,
                    errorMessage: errorMessage,
                    isWorking: isSigningIn,
                    checkAgain: signIn,
                    signOut: signOut
                )

            case .authorized:
                AuthorizedAppContainer(ownerSession: ownerSession)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: ownerSession.state)
    }

    private func signIn() {
        guard !isSigningIn else { return }
        errorMessage = nil
        isSigningIn = true

        Task {
            defer { isSigningIn = false }
            do {
                guard let presenter = UIApplication.shared.stemulateTopViewController else {
                    throw BackendError.invalidResponse(
                        "The Google sign-in window is not available."
                    )
                }
                try await ownerSession.signIn(presenting: presenter)
            } catch {
                errorMessage = error.userFacingMessage
            }
        }
    }

    private func signOut() {
        do {
            try ownerSession.signOut()
            errorMessage = nil
        } catch {
            errorMessage = error.userFacingMessage
        }
    }
}

private struct AuthorizedAppContainer: View {
    @StateObject private var model: STEMulateAppModel

    init(ownerSession: GoogleOwnerSession) {
        _model = StateObject(
            wrappedValue: STEMulateAppModel(ownerSession: ownerSession)
        )
    }

    var body: some View {
        AppShellView(model: model)
            .task {
                await model.startLibrary()
            }
    }
}

private struct FirebaseSetupRequiredView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    AppMarkView()

                    VStack(alignment: .leading, spacing: 10) {
                        Label("Firebase setup needed", systemImage: "wrench.and.screwdriver.fill")
                            .font(.title2.bold())
                            .foregroundStyle(.primary)

                        Text(
                            "The native player is installed, but this build does not include "
                                + "its Firebase configuration yet."
                        )
                        .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        SetupStep(number: 1, text: "Add an iOS app in Firebase using this bundle ID.")
                        SetupStep(
                            number: 2,
                            text: "Download GoogleService-Info.plist and run "
                                + "ios/scripts/configure-firebase.sh on your Mac."
                        )
                        SetupStep(
                            number: 3,
                            text: "Rebuild and install. Your credentials stay outside Git."
                        )
                    }
                    .padding(20)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))

                    Text("The exact commands are in ios/README.md.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 620, alignment: .leading)
                .padding(24)
            }
            .navigationTitle("STEMulate")
            .background(Color.stemulateBackground)
        }
    }
}

private struct SetupStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)")
                .font(.caption.bold())
                .frame(width: 28, height: 28)
                .foregroundStyle(.black)
                .background(Color.stemulateAccent, in: Circle())

            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct SignInView: View {
    let isWorking: Bool
    let errorMessage: String?
    let signIn: () -> Void

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            AppMarkView()

            VStack(spacing: 10) {
                Text("Your songs. Your device.")
                    .font(.title2.bold())
                Text(
                    "Sign in to reach your private song library. Cached stems play locally "
                        + "through the native audio engine."
                )
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            }

            if let errorMessage = errorMessage {
                InlineErrorView(message: errorMessage)
            }

            Button(action: signIn) {
                HStack(spacing: 12) {
                    if isWorking {
                        ProgressView()
                    } else {
                        Image(systemName: "person.crop.circle.badge.checkmark")
                    }
                    Text(isWorking ? "Signing in…" : "Continue with Google")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isWorking)

            Text("Only accounts authorized by the library owner can continue.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: 520)
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.stemulateBackground)
    }
}

private struct UnauthorizedAccountView: View {
    let email: String?
    let errorMessage: String?
    let isWorking: Bool
    let checkAgain: () -> Void
    let signOut: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.system(size: 54, weight: .semibold))
                .foregroundStyle(.orange)

            VStack(spacing: 8) {
                Text("Access needs approval")
                    .font(.title2.bold())
                Text(
                    "\(email ?? "This Google account") is signed in, but the account "
                        + "has not been authorized for this private library."
                )
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }

            if let errorMessage = errorMessage {
                InlineErrorView(message: errorMessage)
            }

            VStack(spacing: 12) {
                Button(isWorking ? "Checking…" : "Check again", action: checkAgain)
                    .buttonStyle(.borderedProminent)
                    .disabled(isWorking)
                Button("Use another account", action: signOut)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: 520)
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.stemulateBackground)
    }
}

private struct ProgressScreen: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 18) {
            ProgressView()
                .controlSize(.large)
                .tint(.stemulateAccent)
            Text(title)
                .font(.title3.bold())
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.stemulateBackground)
    }
}

private extension UIApplication {
    var stemulateTopViewController: UIViewController? {
        let root = connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController

        var current = root
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }
}

#Preview {
    FirebaseSetupRequiredView()
        .preferredColorScheme(.dark)
}
