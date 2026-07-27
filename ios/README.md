# STEMulate for iPhone

This is a native iOS 17+ SwiftUI app generated with XcodeGen. Playback and cached
stems stay on the phone. Public YouTube video audio is resolved and downloaded on
the iPhone, then sent through the existing private Firebase/Music.ai processing
pipeline. The native YouTube path does not call the Cloud Run downloader.

## One-command iPhone install

You need:

- A Mac with the current Xcode installed and opened once.
- Your Apple ID added in **Xcode → Settings → Accounts**.
- An unlocked, trusted iPhone with **Developer Mode** enabled.
- `GoogleService-Info.plist` for a Firebase iOS app whose bundle ID is unique to
  your Apple team.

From the repository root, run:

```bash
./install-iphone.command
```

The guided command:

1. Finishes Xcode setup if necessary.
2. Installs or locally builds a pinned XcodeGen helper.
3. Finds or asks for `GoogleService-Info.plist`.
4. Detects the Apple development team and connected iPhone.
5. Creates a private, ignored App Check debug token and opens the exact Firebase
   page where it must be registered.
6. Generates the project, resolves Swift packages, builds, signs, installs, and
   launches STEMulate.

The script stores only machine-local configuration under ignored files in
`ios/Config`. It never uploads signing identities, Firebase configuration, or
App Check tokens to GitHub.

Optional noninteractive values are available:

```bash
./install-iphone.command \
  --firebase-plist ~/Downloads/GoogleService-Info.plist \
  --team-id YOUR_TEAM_ID \
  --device YOUR_DEVICE_IDENTIFIER
```

Run `./install-iphone.command --help` for every option. The bundle ID is normally
read directly from the Firebase plist so the two values cannot silently drift.

## The unavoidable one-time taps

Apple and Firebase deliberately do not allow a shell script to bypass these:

- Add the Apple ID to Xcode.
- Connect, unlock, trust, and enable Developer Mode on the iPhone.
- Register the locally displayed App Check debug token in Firebase.
- Trust the developer profile on the iPhone if iOS asks.
- Sign in with the authorized Google account inside STEMulate.

If Google sign-in has not already been enabled, enable it in
**Firebase Authentication → Sign-in method → Google**. The backend currently
allows only accounts carrying the existing owner authorization claim.

## YouTube import behavior

The native importer accepts a single public video from:

- `youtube.com`
- `m.youtube.com`
- `music.youtube.com`
- `youtu.be`

It canonicalizes the link, resolves an audio-only M4A locally with YouTubeKit,
waits for YouTube’s stream preparation window, downloads directly to a file,
allows redirects only to HTTPS `googlevideo.com` hosts, enforces the backend’s
500 MiB limit, and verifies playable audio with AVFoundation. One HTTP 403 gets
one fresh resolution and retry; after that the app stops with a useful error
instead of remaining on “Working.”

YouTube changes its delivery system often. Private, members-only, age/region
restricted, live, DRM-protected, or PO-token-gated videos may not work. A pinned
resolver update and a rebuilt app may occasionally be required. Use only audio
you own or are authorized to process.

On iOS 26+, a user-started import uses `BGContinuedProcessingTask`, so it can keep
making visible progress after the app is backgrounded when the system permits.
On iOS 17–25, keep STEMulate open until the upload begins.

## Signing duration

- A free Apple Personal Team install normally expires after seven days. Reconnect
  the iPhone and run `./install-iphone.command` again; saved choices make renewal
  automatic.
- A paid Apple Developer membership supports longer direct provisioning and
  TestFlight. Each TestFlight build is available for up to 90 days.

Debug installs use Firebase’s App Check debug provider. Release/TestFlight builds
use App Attest and do not read the local debug token.

## Useful development commands

```bash
./scripts/build-simulator.sh
./scripts/test.sh "iPhone 16 Pro"
./scripts/open-project.sh
./scripts/list-devices.sh
```

See `THIRD_PARTY_NOTICES.md` for the pinned YouTubeKit revision. See
`BACKEND_SETUP.md` for the callable, App Check, owner authorization, storage,
Music.ai, and preview-worker contracts.
