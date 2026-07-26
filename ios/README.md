# STEMulate for iPhone

This is a native iOS 17+ SwiftUI app generated with XcodeGen. Playback and cached stems
stay on the phone; Firebase and the private Cloud Run services remain responsible
for authentication, processing, downloads, and export files.

## First install on your iPhone

You need a Mac, Xcode 16 or newer, an Apple ID, and an iPhone with Developer Mode
enabled.

1. Install Xcode from the Mac App Store. Open it once and let it finish setup.
2. In Xcode, open **Settings → Accounts** and add your Apple ID.
3. Connect the unlocked iPhone by cable, tap **Trust**, and enable
   **Settings → Privacy & Security → Developer Mode** if prompted.
4. Open [Firebase Console](https://console.firebase.google.com/) and select the
   **stem-ulate** project.
5. Open **Authentication → Sign-in method → Add new provider → Google**, enable
   it, choose the support email, and save.
6. Open **Project settings → General → Your apps**.
7. Select the iOS app with the exact bundle ID you will use below. If it does
   not exist, click **Add app → iOS**, enter that bundle ID, and register it.
8. Click **Download GoogleService-Info.plist**.
9. In Terminal, change into this `ios` folder and run:

```bash
./scripts/first-install.sh \
  YOUR_TEAM_ID \
  com.yourname.STEMulate \
  ~/Downloads/GoogleService-Info.plist
```

Your Team ID appears in Xcode under **Settings → Accounts → your account → team**.
The bundle ID must exactly match the Firebase iOS app and must be unique; using
your name in it is normally enough. The script installs XcodeGen when Homebrew is
available, generates the Xcode project, validates Firebase, and lists connected
devices. Copy your iPhone identifier from that list and rerun the same command
with it as the fourth argument:

```bash
./scripts/first-install.sh \
  YOUR_TEAM_ID \
  com.yourname.STEMulate \
  ~/Downloads/GoogleService-Info.plist \
  YOUR_DEVICE_IDENTIFIER
```

The Firebase plist and generated signing files are ignored by Git. Never put
service-account keys, downloader credentials, or other server secrets in the app.
If you prefer Xcode, run `./scripts/open-project.sh`, choose your team under
**STEMulate → Signing & Capabilities**, select your iPhone, and press **Run**.

Debug builds use Firebase’s App Check debug provider so Personal Team installs
remain usable. Release/TestFlight builds include the production App Attest
entitlement; enable **App Attest** for the paid Developer team’s App ID before
archiving.

On the first Debug run, copy the App Check debug token printed in Xcode’s console.
In Firebase Console, open **App Check → Apps → STEMulate → Manage debug tokens**,
add that token, then relaunch the app. The token stays on your Mac/iPhone; do not
commit or send it.

## Signing duration

- A free Apple Personal Team install normally expires after seven days. Reconnect
  the phone and run `./scripts/install-device.sh YOUR_DEVICE_IDENTIFIER` again.
- A paid Apple Developer membership supports longer direct provisioning and
  TestFlight; each TestFlight build is available for up to 90 days.

The Cloud Run downloader must still be deployed separately. Running the app
locally improves playback and caching but does not replace the import backend.
See `BACKEND_SETUP.md` for the callable, App Check, owner-claim, Cloud Run, and
preview-worker contract used by the native client.

## Useful commands

```bash
./scripts/build-simulator.sh
./scripts/test.sh "iPhone 16 Pro"
./scripts/open-project.sh
```
