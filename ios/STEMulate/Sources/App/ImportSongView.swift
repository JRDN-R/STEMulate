import SwiftUI
import UniformTypeIdentifiers

struct ImportSongView: View {
    @ObservedObject var model: STEMulateAppModel
    @State private var link = ""
    @State private var rightsConfirmed = false
    @State private var isChoosingFile = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Panel {
                    VStack(alignment: .leading, spacing: 18) {
                        Label("Import a link", systemImage: "link")
                            .font(.title3.bold())

                        TextField("Paste a YouTube or Spotify link", text: $link)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(14)
                            .background(.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))

                        Toggle(isOn: $rightsConfirmed) {
                            Text("I have permission to process this track")
                                .font(.subheadline)
                        }

                        Button {
                            let submittedLink = link
                            Task {
                                if await model.importRemote(
                                    link: submittedLink,
                                    rightsConfirmed: rightsConfirmed
                                ) {
                                    link = ""
                                    rightsConfirmed = false
                                }
                            }
                        } label: {
                            ActivityButtonLabel(
                                title: model.isImporting ? "Starting import…" : "Start import",
                                systemImage: "sparkles",
                                isWorking: model.isImporting
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(
                            model.isImporting
                                || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || !rightsConfirmed
                        )

                        Text(
                            "Supported forms include youtube.com, youtu.be, music.youtube.com, "
                                + "and Spotify track links. YouTube imports still require the "
                                + "private Cloud Run downloader to be deployed."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Panel {
                    VStack(alignment: .leading, spacing: 18) {
                        Label("Choose a file", systemImage: "doc.badge.plus")
                            .font(.title3.bold())

                        Text(
                            "Import audio or video from Files. The upload continues in this view, "
                                + "then the library shows live processing progress."
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                        if let progress = model.uploadProgress {
                            VStack(alignment: .leading, spacing: 8) {
                                ProgressView(value: progress)
                                    .tint(.stemulateAccent)
                                Text("\(Int((progress * 100).rounded()))% uploaded")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Button {
                            isChoosingFile = true
                        } label: {
                            ActivityButtonLabel(
                                title: model.isImporting ? "Uploading…" : "Open Files",
                                systemImage: "folder",
                                isWorking: model.isImporting
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(model.isImporting)
                    }
                }

                Text(
                    "Imports are private to the signed-in library. Processing happens in your "
                        + "existing backend; playback stems are downloaded and cached on this device."
                )
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            }
            .frame(maxWidth: 660)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Import")
        .background(Color.stemulateBackground)
        .fileImporter(
            isPresented: $isChoosingFile,
            allowedContentTypes: [.audio, .movie],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task {
                    await model.importLocalFile(url)
                }
            case .failure(let error):
                model.showError(error, title: "Couldn’t open that file")
            }
        }
    }
}
