@preconcurrency import FirebaseAppCheck
@preconcurrency import FirebaseCore
import Foundation

private final class ProductionAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        if #available(iOS 14.0, *) {
            return AppAttestProvider(app: app)
        }
        return DeviceCheckProvider(app: app)
    }
}

enum FirebaseBootstrap {
    /// Call once from the SwiftUI app initializer, before any Firebase service is used.
    @MainActor
    static func configure() {
        guard FirebaseApp.app() == nil else { return }

#if APP_CHECK_DEBUG
        // The generated debug token must be allowlisted in Firebase Console.
        // Never use this provider in an Archive/TestFlight build.
        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
#else
        AppCheck.setAppCheckProviderFactory(ProductionAppCheckProviderFactory())
#endif
        FirebaseApp.configure()
    }
}
