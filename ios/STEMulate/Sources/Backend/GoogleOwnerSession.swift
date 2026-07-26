import Combine
@preconcurrency import FirebaseAuth
@preconcurrency import FirebaseCore
import Foundation
@preconcurrency import GoogleSignIn
import UIKit

enum OwnerSessionState: Equatable {
    case signedOut
    case checkingAuthorization
    case unauthorized(uid: String, email: String?)
    case authorized(uid: String, email: String?)

    var authorizedUID: String? {
        guard case .authorized(let uid, _) = self else { return nil }
        return uid
    }
}

@MainActor
final class GoogleOwnerSession: ObservableObject {
    @Published private(set) var state: OwnerSessionState = .signedOut

    private var listenerHandle: AuthStateDidChangeListenerHandle?

    init() {
        precondition(
            FirebaseApp.app() != nil,
            "Call FirebaseBootstrap.configure() before creating GoogleOwnerSession."
        )
        listenerHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor [weak self] in
                await self?.receiveAuthState(user)
            }
        }
    }

    deinit {
        if let listenerHandle {
            Auth.auth().removeStateDidChangeListener(listenerHandle)
        }
    }

    func signIn(presenting viewController: UIViewController) async throws {
        guard let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty else {
            throw BackendError.notConfigured
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)

        let result = try await googleSignIn(presenting: viewController)
        guard let idToken = result.user.idToken?.tokenString else {
            throw BackendError.invalidResponse("Google did not return an ID token.")
        }
        let credential = GoogleAuthProvider.credential(
            withIDToken: idToken,
            accessToken: result.user.accessToken.tokenString
        )
        let authResult = try await firebaseSignIn(credential: credential)
        try await requireOwnerClaim(for: authResult.user, forceRefresh: true)
        state = .authorized(uid: authResult.user.uid, email: authResult.user.email)
    }

    func signOut() throws {
        GIDSignIn.sharedInstance.signOut()
        try Auth.auth().signOut()
        state = .signedOut
    }

    func handleOpenURL(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    func authorizedOwnerUID(forceRefresh: Bool = false) async throws -> String {
        guard let user = Auth.auth().currentUser else {
            throw BackendError.authenticationRequired
        }
        try await requireOwnerClaim(for: user, forceRefresh: forceRefresh)
        return user.uid
    }

    private func receiveAuthState(_ user: User?) async {
        guard let user else {
            state = .signedOut
            return
        }
        state = .checkingAuthorization
        do {
            try await requireOwnerClaim(for: user, forceRefresh: false)
            state = .authorized(uid: user.uid, email: user.email)
        } catch {
            state = .unauthorized(uid: user.uid, email: user.email)
        }
    }

    private func requireOwnerClaim(
        for user: User,
        forceRefresh: Bool
    ) async throws {
        let result = try await tokenResult(for: user, forceRefresh: forceRefresh)
        let ownerClaim = (result.claims["owner"] as? Bool)
            ?? (result.claims["owner"] as? NSNumber)?.boolValue
            ?? false
        guard ownerClaim else {
            throw BackendError.ownerAuthorizationRequired
        }
    }

    private func googleSignIn(
        presenting viewController: UIViewController
    ) async throws -> GIDSignInResult {
        try await withCheckedThrowingContinuation { continuation in
            GIDSignIn.sharedInstance.signIn(withPresenting: viewController) {
                result,
                error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(
                        throwing: BackendError.invalidResponse(
                            "Google sign-in returned no result."
                        )
                    )
                }
            }
        }
    }

    private func firebaseSignIn(
        credential: AuthCredential
    ) async throws -> AuthDataResult {
        try await withCheckedThrowingContinuation { continuation in
            Auth.auth().signIn(with: credential) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(
                        throwing: BackendError.invalidResponse(
                            "Firebase sign-in returned no result."
                        )
                    )
                }
            }
        }
    }

    private func tokenResult(
        for user: User,
        forceRefresh: Bool
    ) async throws -> AuthTokenResult {
        try await withCheckedThrowingContinuation { continuation in
            user.getIDTokenResult(forcingRefresh: forceRefresh) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result {
                    continuation.resume(returning: result)
                } else {
                    continuation.resume(
                        throwing: BackendError.invalidResponse(
                            "Firebase returned no authorization token."
                        )
                    )
                }
            }
        }
    }
}
