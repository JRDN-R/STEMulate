# STEMulate

STEMulate is a mobile-first, installable music-practice web app with a late-1990s hardware aesthetic. The browser app is a static Vite/React PWA that can run from GitHub Pages. A separate Firebase backend keeps the Music.ai key private and owns all paid processing work.

The checked-in `.env.example` starts in interactive demo mode, so the player,
beat-following metronome, chord path, section loops, speed controls, and mixer
can be tested without a backend or API charges. This workspace also contains a
gitignored live local configuration for project `stem-ulate`; the GitHub Pages
workflow builds with its public App Check settings enabled.

## What works now

- responsive iPhone and desktop mixer UI
- local audio/video file preview
- owner-confirmed, single-track YouTube and Spotify import jobs through a private worker
- Music.ai upload/job/status client contract
- adaptive multi-stem playback controls for vocals, drums, bass, guitars,
  piano, keys, strings, wind, and other when those URLs are returned
  (sample-locked Web Audio scheduling is still future work)
- beat-map-driven smart metronome with changing local timing (browser click
  scheduling, not yet studio-grade audio-clock scheduling)
- chord timeline, detected key/BPM, and named song sections
- one-tap section looping, seeking, mute, solo, volume, speed, and pitch UI
- Firebase Google owner sign-in hook
- offline app shell, web manifest, Apple touch icon, and iOS safe-area layout
- GitHub Pages deployment workflow

Pitch transposition is represented in the interface but still needs a production time-stretch/pitch-shift engine before it changes live audio.

## Run on your Mac

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/` in Safari or Chrome. To verify the production artifact:

```bash
npm test
npm run preview
```

The static GitHub Pages artifact is written to `dist/`, with `index.html` at its root.

## Publish with GitHub Pages

1. Push this project to [`JRDN-R/STEMulate`](https://github.com/JRDN-R/STEMulate).
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. Push to `main`, or run the “Deploy STEMulate to GitHub Pages” workflow manually.
4. Add `jrdn-r.github.io` to Firebase Authentication’s authorized domains.

The workflow is configured to publish the live browser client with the public
reCAPTCHA Enterprise App Check site key. Music.ai and Spotify credentials are
never part of the Pages build. Spotify importing is hidden and rejected by
default. Set the repository variable `VITE_ENABLE_SPOTIFY_IMPORT=true` only
after the private worker has both Spotify secrets mounted.

Use a dedicated custom domain on the GitHub Pages site before treating it as the
live private app. All project sites under `OWNER.github.io` share one browser
origin, so another project hosted there could otherwise access this app's
origin-scoped Firebase session and saved resume state.

The Vite build uses relative asset paths, so both user sites and project sites such as `https://OWNER.github.io/stemulate/` work without changing a base path.

## Connect Firebase and Music.ai

The browser must never receive a Music.ai API key. The Firebase web config in `src/lib/firebase.ts` identifies the Firebase project and is intentionally public; the Music.ai key belongs only in Secret Manager.

1. Switch the Firebase project to Blaze. Functions and Cloud Storage require billing for this architecture.
2. Enable Google sign-in in Firebase Authentication and add each allowed UID to
   the comma-separated backend owner allowlist. Each allowed account also needs
   the `owner=true` custom claim.
3. Enable Firestore, Cloud Storage, and App Check for the web app.
4. The Music.ai workspace has three saved workflows:
   `stemulate-multistem`, `stemulate-harmony-beats`, and
   `stemulate-song-sections`. STEMulate submits all three against the same
   `inputUrl`, waits for every result, and merges the output set. The Basic
   Stems template is supported directly: STEMulate recognizes vocals, drums,
   bass, guitars, piano, keys, strings, wind, and other outputs and
   intentionally ignores its redundant original mix.
5. Follow [`ingest-service/README.md`](ingest-service/README.md) to deploy the private `yt-dlp`/spotDL worker, then [`functions/README.md`](functions/README.md) to set the Music.ai secret and deploy Firebase.
6. Copy `.env.example` to `.env.local`, add the reCAPTCHA Enterprise App Check
   site key, set `VITE_STEMULATE_BACKEND_ENABLED=true`, and rebuild. Leave
   `VITE_ENABLE_SPOTIFY_IMPORT=false` until the private worker has both Spotify
   secrets mounted.

No Music.ai or Spotify secret is stored in this repository or browser build. If a real key has been pasted into chat or another shared location, rotate it before entering the replacement directly into Secret Manager.

## Processing architecture

```text
GitHub Pages PWA
  ├── local/iCloud file → private Cloud Storage upload
  ├── YouTube/Spotify URL → owner-only Firebase callable
  └── Firebase Auth + App Check + Firestore job state
              │
              ▼
Firebase Functions + Cloud Tasks + private Cloud Run
  ├── owner authorization and rights confirmation
  ├── yt-dlp or spotDL → validated, metadata-free M4A
  ├── exact-object signed upload into Cloud Storage
  ├── idempotent Music.ai job submission/status polling per workflow
  ├── deterministic multi-workflow result merge
  └── result copy to Cloud Storage
              │
              ▼
Music.ai workflow(s)
  ├── adaptive stems (vocals / drums / bass / guitars / piano / keys /
  │   strings / wind / other)
  ├── beats / BPM
  ├── chords / key
  └── song sections

The smart metronome is synthesized in the browser from the returned beat map;
it is not a separate Music.ai audio output.
```

The backend copies completed outputs because Music.ai result URLs should not be treated as permanent storage, and iOS may suspend the PWA while a job is running.

## Remote imports

The PWA accepts one canonical public YouTube video. A deploy can additionally
accept one Spotify track URL by setting `VITE_ENABLE_SPOTIFY_IMPORT=true` after
the private worker's Spotify credentials are configured. The browser never runs
a downloader and never receives its credentials. An App Check-protected callable
creates a private job, a named Cloud Task invokes a private Cloud Run service,
and that service runs fixed `yt-dlp` or spotDL commands without a shell. It
permits one result up to 20 minutes and 100 MiB, verifies it with `ffprobe`,
strips video/artwork/metadata, normalizes it to M4A, and writes only the exact
pre-authorized object. The existing Storage event then sends that object to
Music.ai.

spotDL does not export Spotify audio. It uses Spotify metadata to locate a matching recording through YouTube Music/YouTube. The UI states this before each import. Use only a single recording you created, own, or are authorized by both the rights holder and source service to download and send to Music.ai. Personal use alone does not grant those rights.

## Install on iPhone

Open the published URL in Safari, tap **Share**, choose **Add to Home Screen**, and leave **Open as Web App** enabled. The first Play tap unlocks web audio for the smart metronome.
