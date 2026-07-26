import SwiftUI

struct LibraryView: View {
    @ObservedObject var model: STEMulateAppModel

    var body: some View {
        Group {
            if model.isLoadingLibrary, model.jobs.isEmpty {
                ProgressView("Loading your songs…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.jobs.isEmpty {
                ContentUnavailableView {
                    Label("No songs yet", systemImage: "music.note")
                } description: {
                    Text("Import a link or choose an audio file to create your first practice deck.")
                } actions: {
                    Button("Import a song") {
                        model.selectedTab = .importSong
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    Section {
                        ForEach(model.jobs) { job in
                            SongRow(
                                job: job,
                                isCached: model.cachedJobIDs.contains(job.id),
                                isPreparing: model.preparingJobID == job.id,
                                open: {
                                    Task { await model.prepare(job) }
                                },
                                offload: {
                                    Task { await model.offload(job) }
                                }
                            )
                            .listRowBackground(Color.stemulatePanel)
                            .listRowSeparatorTint(Color.white.opacity(0.08))
                        }
                    } header: {
                        Text("\(model.jobs.count) saved \(model.jobs.count == 1 ? "song" : "songs")")
                    } footer: {
                        Text(
                            "Downloaded stems stay on this device for smooth, synchronized playback. "
                                + "Offloading removes only the local audio copy."
                        )
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable {
                    await model.refreshCacheStatus()
                }
            }
        }
        .navigationTitle("Library")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Image(systemName: "waveform")
                    .font(.headline.bold())
                    .foregroundStyle(Color.stemulateAccent)
                    .accessibilityHidden(true)
            }

            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let accountEmail = model.accountEmail {
                        Text(accountEmail)
                    }
                    Button("Refresh downloads", systemImage: "arrow.clockwise") {
                        Task { await model.refreshCacheStatus() }
                    }
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                        model.signOut()
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
        .background(Color.stemulateBackground)
    }
}

private struct SongRow: View {
    let job: ProcessingJob
    let isCached: Bool
    let isPreparing: Bool
    let open: () -> Void
    let offload: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 14) {
                artwork

                VStack(alignment: .leading, spacing: 6) {
                    Text(job.displayName)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    HStack(spacing: 7) {
                        JobStateLabel(job: job)

                        if let bpm = job.analysis.bpm, bpm > 0 {
                            Text("•")
                            Text("\(Int(bpm.rounded())) BPM")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(
                        job.status == .failed ? Color.red : Color.secondary
                    )

                    if job.status == .failed, let message = job.error?.message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .lineLimit(2)
                    } else if job.status != .completed {
                        Text(job.stage.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer(minLength: 8)

                if isPreparing {
                    ProgressView()
                } else if job.canOpen {
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .disabled(!job.canOpen || isPreparing)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if isCached {
                Button("Offload", systemImage: "icloud.and.arrow.up", role: .destructive) {
                    offload()
                }
            }
        }
        .contextMenu {
            if job.canOpen {
                Button(isCached ? "Open mixer" : "Download and open", action: open)
            }
            if isCached {
                Button("Offload audio", systemImage: "trash", role: .destructive) {
                    offload()
                }
            }
        }
        .accessibilityHint(job.canOpen ? "Opens this song in the mixer." : job.status.detail)
    }

    private var artwork: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.stemulateAccent.opacity(0.3),
                            Color.blue.opacity(0.18),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Image(systemName: isCached ? "waveform.badge.checkmark" : "waveform")
                .font(.title3.bold())
                .foregroundStyle(Color.stemulateAccent)
        }
        .frame(width: 54, height: 54)
    }
}

private struct JobStateLabel: View {
    let job: ProcessingJob

    var body: some View {
        Label(job.status.title, systemImage: job.status.symbol)
            .labelStyle(.titleAndIcon)
    }
}

private extension ProcessingJobStatus {
    var title: String {
        switch self {
        case .awaitingUpload:
            return "Uploading"
        case .queued:
            return "Queued"
        case .processing:
            return "Processing"
        case .completed:
            return "Ready"
        case .failed:
            return "Needs attention"
        }
    }

    var detail: String {
        switch self {
        case .awaitingUpload:
            return "This file is still uploading."
        case .queued:
            return "This song is waiting to be processed."
        case .processing:
            return "The stems are still being prepared."
        case .completed:
            return "This song is ready."
        case .failed:
            return "Processing failed. Open the website or import the song again."
        }
    }

    var symbol: String {
        switch self {
        case .awaitingUpload:
            return "arrow.up.circle"
        case .queued:
            return "clock"
        case .processing:
            return "sparkles"
        case .completed:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }
}
