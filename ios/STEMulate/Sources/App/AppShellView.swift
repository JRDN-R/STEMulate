import SwiftUI

enum AppTab: Hashable {
    case library
    case mixer
    case importSong
}

struct AppShellView: View {
    @ObservedObject var model: STEMulateAppModel

    var body: some View {
        TabView(selection: $model.selectedTab) {
            NavigationStack {
                LibraryView(model: model)
            }
            .tag(AppTab.library)
            .tabItem {
                Label("Library", systemImage: "music.note.list")
            }

            NavigationStack {
                MixerView(model: model)
            }
            .tag(AppTab.mixer)
            .tabItem {
                Label("Mixer", systemImage: "slider.horizontal.3")
            }

            NavigationStack {
                ImportSongView(model: model)
            }
            .tag(AppTab.importSong)
            .tabItem {
                Label("Import", systemImage: "square.and.arrow.down")
            }
        }
        .tint(.stemulateAccent)
        .overlay(alignment: .top) {
            if let status = model.transientStatus {
                StatusCapsule(status: status)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .alert(item: $model.presentedError) { error in
            Alert(
                title: Text(error.title),
                message: Text(error.message),
                dismissButton: .default(Text("OK"))
            )
        }
        .background(Color.stemulateBackground.ignoresSafeArea())
    }
}

private struct StatusCapsule: View {
    let status: String

    var body: some View {
        HStack(spacing: 9) {
            ProgressView()
                .controlSize(.small)
            Text(status)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(Color.white.opacity(0.12))
        }
        .shadow(color: .black.opacity(0.3), radius: 14, y: 5)
        .accessibilityElement(children: .combine)
    }
}
