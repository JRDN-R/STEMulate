import SwiftUI

struct MixerView: View {
    @ObservedObject var model: STEMulateAppModel
    @ObservedObject private var audioEngine: NativeStemAudioEngine
    @State private var scrubPosition: TimeInterval = 0
    @State private var isScrubbing = false

    init(model: STEMulateAppModel) {
        self.model = model
        _audioEngine = ObservedObject(wrappedValue: model.audioEngine)
    }

    var body: some View {
        Group {
            if let job = model.selectedJob, let deck = model.localDeck {
                ScrollView {
                    LazyVStack(spacing: 18) {
                        songHeader(job: job)
                        analysisPanel
                        transportPanel
                        stemMixer(deck: deck)
                        cachePanel(job: job)
                    }
                    .frame(maxWidth: 760)
                    .padding(18)
                    .frame(maxWidth: .infinity)
                }
            } else {
                ContentUnavailableView {
                    Label("Choose a song", systemImage: "slider.horizontal.3")
                } description: {
                    Text("Open a ready song from the library to download its stems and start mixing.")
                } actions: {
                    Button("Go to Library") {
                        model.selectedTab = .library
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle(model.selectedJob?.displayName ?? "Mixer")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.selectedJob != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.saveMixerSettings() }
                    } label: {
                        if model.isSavingMixer {
                            ProgressView()
                        } else {
                            Label(
                                model.saveConfirmation ?? "Save",
                                systemImage: model.saveConfirmation == nil
                                    ? "square.and.arrow.down"
                                    : "checkmark"
                            )
                        }
                    }
                    .disabled(model.isSavingMixer)
                }
            }
        }
        .background(Color.stemulateBackground)
        .onAppear {
            scrubPosition = audioEngine.transportSnapshot.position
        }
        .onChange(of: audioEngine.transportSnapshot.position) { _, position in
            if !isScrubbing {
                scrubPosition = position
            }
        }
    }

    private func songHeader(job: ProcessingJob) -> some View {
        HStack(alignment: .center, spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 18)
                    .fill(Color.stemulateAccent.opacity(0.16))
                Image(systemName: "waveform")
                    .font(.title.bold())
                    .foregroundStyle(Color.stemulateAccent)
            }
            .frame(width: 68, height: 68)

            VStack(alignment: .leading, spacing: 5) {
                Text(job.displayName)
                    .font(.title2.bold())
                    .lineLimit(2)
                Label("Downloaded to this iPhone", systemImage: "iphone.and.arrow.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var analysisPanel: some View {
        if let analysis = model.selectedAnalysis {
            Panel {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("LIVE CHORD PATH")
                                .font(.caption.bold())
                                .tracking(1.5)
                                .foregroundStyle(Color.stemulateAccent)
                            Text(currentChord(in: analysis)?.chord ?? "Follow the changes")
                                .font(.title3.bold())
                        }
                        Spacer()
                        if !analysis.key.isEmpty, analysis.key != "Unknown" {
                            AnalysisBadge(text: analysis.key, suffix: "key")
                        }
                        if analysis.bpm > 0 {
                            AnalysisBadge(
                                text: "\(Int(analysis.bpm.rounded()))",
                                suffix: "BPM"
                            )
                        }
                    }

                    if analysis.chords.isEmpty {
                        Label(
                            "No chord map was returned for this song.",
                            systemImage: "music.note"
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 10) {
                                ForEach(
                                    Array(analysis.chords.enumerated()),
                                    id: \.offset
                                ) { _, chord in
                                    ChordCard(
                                        chord: chord,
                                        isCurrent: contains(
                                            position: audioEngine.transportSnapshot.position,
                                            start: chord.start,
                                            end: chord.end
                                        )
                                    ) {
                                        seek(to: chord.start)
                                    }
                                }
                            }
                        }
                    }

                    if !analysis.sections.isEmpty {
                        Divider()
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ARRANGEMENT")
                                .font(.caption.bold())
                                .tracking(1.4)
                                .foregroundStyle(.secondary)

                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 8) {
                                    ForEach(
                                        Array(analysis.sections.enumerated()),
                                        id: \.offset
                                    ) { _, section in
                                        let current = contains(
                                            position: audioEngine.transportSnapshot.position,
                                            start: section.start,
                                            end: section.end
                                        )
                                        Button {
                                            seek(to: section.start)
                                        } label: {
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(section.label)
                                                    .font(.subheadline.bold())
                                                Text(section.start.stemulateTimecode)
                                                    .font(.caption2.monospacedDigit())
                                                    .foregroundStyle(
                                                        current
                                                            ? Color.black.opacity(0.68)
                                                            : Color.secondary
                                                    )
                                            }
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 10)
                                            .foregroundStyle(
                                                current ? Color.black : Color.primary
                                            )
                                            .background(
                                                current
                                                    ? Color.stemulateAccent
                                                    : Color.white.opacity(0.07),
                                                in: RoundedRectangle(cornerRadius: 12)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var transportPanel: some View {
        Panel {
            VStack(spacing: 16) {
                if let error = audioEngine.transportSnapshot.errorMessage {
                    InlineErrorView(message: error)
                }

                HStack {
                    Text(scrubPosition.stemulateTimecode)
                    Slider(
                        value: $scrubPosition,
                        in: 0 ... max(audioEngine.transportSnapshot.duration, 0.01),
                        onEditingChanged: { editing in
                            isScrubbing = editing
                            if !editing {
                                seek(to: scrubPosition)
                            }
                        }
                    )
                    .tint(.stemulateAccent)
                    Text(audioEngine.transportSnapshot.duration.stemulateTimecode)
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

                HStack(spacing: 18) {
                    Button {
                        seek(to: audioEngine.transportSnapshot.position - 10)
                    } label: {
                        Image(systemName: "gobackward.10")
                    }
                    .buttonStyle(TransportButtonStyle())
                    .accessibilityLabel("Back 10 seconds")

                    Button(action: togglePlayback) {
                        Image(
                            systemName: audioEngine.transportSnapshot.state == .playing
                                ? "pause.fill"
                                : "play.fill"
                        )
                        .font(.title2)
                    }
                    .buttonStyle(PrimaryTransportButtonStyle())
                    .accessibilityLabel(
                        audioEngine.transportSnapshot.state == .playing ? "Pause" : "Play"
                    )

                    Button {
                        seek(to: audioEngine.transportSnapshot.position + 10)
                    } label: {
                        Image(systemName: "goforward.10")
                    }
                    .buttonStyle(TransportButtonStyle())
                    .accessibilityLabel("Forward 10 seconds")
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        Menu {
                            ForEach([0.5, 0.75, 1, 1.25, 1.5, 2], id: \.self) { rate in
                                Button(rate == 1 ? "1× (Normal)" : "\(rate.formatted())×") {
                                    setRate(Float(rate))
                                }
                            }
                        } label: {
                            Label(
                                "\(audioEngine.transportSnapshot.playbackRate.formatted())×",
                                systemImage: "speedometer"
                            )
                        }
                        .buttonStyle(.bordered)

                        Button(action: toggleLoop) {
                            Label(
                                audioEngine.transportSnapshot.loop == nil
                                    ? "Loop section"
                                    : "Loop on",
                                systemImage: "repeat"
                            )
                        }
                        .buttonStyle(.bordered)
                        .tint(
                            audioEngine.transportSnapshot.loop == nil
                                ? Color.gray
                                : Color.stemulateAccent
                        )

                        Toggle(
                            isOn: Binding(
                                get: { audioEngine.transportSnapshot.metronomeEnabled },
                                set: setMetronome
                            )
                        ) {
                            Label("Loud click", systemImage: "metronome")
                        }
                        .toggleStyle(.button)
                        .buttonStyle(.bordered)
                        .disabled((model.selectedAnalysis?.bpm ?? 0) <= 0)
                    }
                }
                .font(.caption.bold())
            }
        }
    }

    private func stemMixer(deck: LocalStemDeck) -> some View {
        Panel {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("STEM MIXER")
                            .font(.caption.bold())
                            .tracking(1.5)
                            .foregroundStyle(Color.stemulateAccent)
                        Text("\(deck.stems.count) synchronized tracks")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                ForEach(deck.stems) { stem in
                    if let channel = audioEngine.transportSnapshot.channels[stem.stemID] {
                        StemChannelStrip(
                            stem: stem,
                            channel: channel,
                            setVolume: {
                                model.markMixerChanged()
                                audioEngine.setVolume($0, for: stem.stemID)
                            },
                            setPan: {
                                model.markMixerChanged()
                                audioEngine.setPan($0, for: stem.stemID)
                            },
                            setMuted: {
                                model.markMixerChanged()
                                audioEngine.setMuted($0, for: stem.stemID)
                            },
                            setSoloed: {
                                model.markMixerChanged()
                                audioEngine.setSoloed($0, for: stem.stemID)
                            }
                        )
                        if stem.id != deck.stems.last?.id {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    private func cachePanel(job: ProcessingJob) -> some View {
        Panel {
            HStack(spacing: 14) {
                Image(systemName: "internaldrive.fill")
                    .foregroundStyle(Color.stemulateAccent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Available offline")
                        .font(.subheadline.bold())
                    Text("Offload the stems to reclaim space. The song stays in your library.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Offload", role: .destructive) {
                    Task { await model.offload(job) }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func togglePlayback() {
        do {
            if audioEngine.transportSnapshot.state == .playing {
                audioEngine.pause()
            } else {
                try audioEngine.play()
            }
        } catch {
            model.showError(error, title: "Playback couldn’t start")
        }
    }

    private func seek(to position: TimeInterval) {
        do {
            try audioEngine.seek(to: position)
        } catch {
            model.showError(error, title: "Couldn’t seek")
        }
    }

    private func setRate(_ rate: Float) {
        do {
            try audioEngine.setPlaybackRate(rate)
        } catch {
            model.showError(error, title: "Couldn’t change speed")
        }
    }

    private func toggleLoop() {
        do {
            if audioEngine.transportSnapshot.loop != nil {
                try audioEngine.setLoop(nil)
                return
            }

            let position = audioEngine.transportSnapshot.position
            let section = model.selectedAnalysis?.sections.first {
                contains(position: position, start: $0.start, end: $0.end)
            }
            let range = section.map {
                StemLoopRange(start: $0.start, end: $0.end)
            } ?? StemLoopRange(
                start: 0,
                end: audioEngine.transportSnapshot.duration
            )
            try audioEngine.setLoop(range)
        } catch {
            model.showError(error, title: "Couldn’t set the loop")
        }
    }

    private func setMetronome(_ enabled: Bool) {
        do {
            try audioEngine.setMetronome(
                enabled: enabled,
                bpm: model.selectedAnalysis?.bpm
            )
            model.markMixerChanged()
        } catch {
            model.showError(error, title: "Couldn’t start the click")
        }
    }

    private func currentChord(
        in analysis: HydratedSongAnalysis
    ) -> ChordAnnotation? {
        analysis.chords.first {
            contains(
                position: audioEngine.transportSnapshot.position,
                start: $0.start,
                end: $0.end
            )
        }
    }

    private func contains(
        position: TimeInterval,
        start: TimeInterval,
        end: TimeInterval
    ) -> Bool {
        position >= start && position < end
    }
}

private struct AnalysisBadge: View {
    let text: String
    let suffix: String

    var body: some View {
        HStack(spacing: 4) {
            Text(text)
                .foregroundStyle(Color.stemulateAccent)
            Text(suffix)
                .foregroundStyle(.secondary)
        }
        .font(.caption.bold())
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ChordCard: View {
    let chord: ChordAnnotation
    let isCurrent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Text(chord.start.stemulateTimecode)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(
                        isCurrent ? Color.black.opacity(0.6) : Color.secondary
                    )
                Text(chord.chord)
                    .font(.title3.bold())
                Text((chord.end - chord.start).formatted(.number.precision(.fractionLength(1))) + "s")
                    .font(.caption2)
                    .foregroundStyle(
                        isCurrent ? Color.black.opacity(0.6) : Color.gray
                    )
            }
            .frame(minWidth: 78)
            .padding(.horizontal, 10)
            .padding(.vertical, 12)
            .foregroundStyle(isCurrent ? Color.black : Color.primary)
            .background(
                isCurrent ? Color.stemulateAccent : Color.white.opacity(0.07),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(
                        isCurrent ? Color.clear : Color.white.opacity(0.09)
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(chord.chord) at \(chord.start.stemulateTimecode)")
    }
}

private struct StemChannelStrip: View {
    let stem: LocalStemFile
    let channel: StemChannelState
    let setVolume: (Float) -> Void
    let setPan: (Float) -> Void
    let setMuted: (Bool) -> Void
    let setSoloed: (Bool) -> Void

    @State private var snapFeedback = 0
    @State private var panIsInDetent = false
    @State private var volumeIsInDetent = false

    var body: some View {
        VStack(spacing: 13) {
            HStack {
                Label(stem.displayName, systemImage: stemSymbol)
                    .font(.headline)
                Spacer()
                Button("M") {
                    setMuted(!channel.isMuted)
                }
                .buttonStyle(ChannelToggleStyle(isActive: channel.isMuted, color: .orange))
                .accessibilityLabel(channel.isMuted ? "Unmute \(stem.displayName)" : "Mute \(stem.displayName)")

                Button("S") {
                    setSoloed(!channel.isSoloed)
                }
                .buttonStyle(ChannelToggleStyle(isActive: channel.isSoloed, color: .stemulateAccent))
                .accessibilityLabel(
                    channel.isSoloed ? "Disable solo for \(stem.displayName)" : "Solo \(stem.displayName)"
                )
            }

            HStack(spacing: 12) {
                Image(systemName: "speaker.wave.2.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Slider(
                    value: Binding(
                        get: { channel.volume },
                        set: { rawValue in
                            let snapped = TransportMath.snappedVolume(rawValue)
                            let isInDetent = snapped != rawValue
                            if isInDetent, !volumeIsInDetent {
                                snapFeedback += 1
                            }
                            volumeIsInDetent = isInDetent
                            setVolume(snapped)
                        }
                    ),
                    in: 0 ... 1
                )
                .tint(.stemulateAccent)
                Text("\(Int((channel.volume * 100).rounded()))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 42, alignment: .trailing)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(stem.displayName) volume")

            HStack(spacing: 12) {
                Text("L")
                Slider(
                    value: Binding(
                        get: { channel.pan },
                        set: { rawValue in
                            let snapped = TransportMath.snappedPan(rawValue)
                            let isInDetent = snapped != rawValue
                            if isInDetent, !panIsInDetent {
                                snapFeedback += 1
                            }
                            panIsInDetent = isInDetent
                            setPan(snapped)
                        }
                    ),
                    in: -1 ... 1
                )
                .tint(.stemulateAccent)
                Text("R")
                Text(panLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 42, alignment: .trailing)
            }
            .font(.caption.bold())
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(stem.displayName) pan, \(panLabel)")
        }
        .padding(.vertical, 2)
        .sensoryFeedback(.alignment, trigger: snapFeedback)
    }

    private var panLabel: String {
        if abs(channel.pan) < 0.001 { return "C" }
        let amount = Int((abs(channel.pan) * 100).rounded())
        return channel.pan < 0 ? "L\(amount)" : "R\(amount)"
    }

    private var stemSymbol: String {
        switch stem.stemID {
        case "vocals":
            return "music.microphone"
        case "drums", "kick", "snare", "toms", "hi_hat", "cymbals":
            return "circle.grid.cross"
        case "bass":
            return "waveform.path"
        case "guitars":
            return "guitars.fill"
        case "piano", "keys":
            return "pianokeys"
        default:
            return "waveform"
        }
    }
}

private struct ChannelToggleStyle: ButtonStyle {
    let isActive: Bool
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.bold())
            .frame(width: 34, height: 30)
            .foregroundStyle(isActive ? Color.black : Color.secondary)
            .background(
                isActive ? color : Color.white.opacity(0.08),
                in: RoundedRectangle(cornerRadius: 9)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private struct TransportButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3)
            .frame(width: 50, height: 50)
            .background(Color.white.opacity(0.08), in: Circle())
            .opacity(configuration.isPressed ? 0.65 : 1)
    }
}

private struct PrimaryTransportButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 68, height: 68)
            .foregroundStyle(.black)
            .background(Color.stemulateAccent, in: Circle())
            .shadow(color: Color.stemulateAccent.opacity(0.22), radius: 12)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}
