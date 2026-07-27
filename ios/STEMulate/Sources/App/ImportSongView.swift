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
                        Label("Import from YouTube", systemImage: "link")
                            .font(.title3.bold())

                        TextField("Paste a YouTube link", text: $link)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(14)
                            .background(.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))

                        Toggle(isOn: $rightsConfirmed) {
                            Text("I own this audio or have permission to process it")
                                .font(.subheadline)
                        }

                        if let progress = model.youtubeImportProgress {
                            VStack(alignment: .leading, spacing: 8) {
                                ProgressView(value: progress)
                                    .tint(.stemulateAccent)
                                Text(
                                    "\(Int((progress * 100).rounded()))% · "
                                        + (model.transientStatus ?? "Importing on this iPhone…")
                                )
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            }
                        }

                        Button {
                            let submittedLink = link
                            Task {
                                if await model.importYouTube(
                                    link: submittedLink,
                                    rightsConfirmed: rightsConfirmed
                                ) {
                                    link = ""
                                    rightsConfirmed = false
                                }
                            }
                        } label: {
                            ActivityButtonLabel(
                                title: model.isImporting ? "Importing…" : "Import on this iPhone",
                                systemImage: "iphone.and.arrow.forward",
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
                            "Works with individual youtube.com, youtu.be, m.youtube.com, and "
                                + "music.youtube.com video links. STEMulate downloads a compact "
                                + "M4A on this iPhone, verifies it, then uploads it privately for "
                                + "stem processing. The Cloud Run downloader is not used."
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
                        + "existing backend; playback stems are downloaded and cached on this device. "
                        + "Availability depends on the video and YouTube may change its delivery system."
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
