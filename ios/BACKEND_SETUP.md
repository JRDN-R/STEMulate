# Native backend setup

The iOS client uses the existing `stem-ulate` Firebase project and private
services. It does not contain an API key for the processing provider, a Cloud
Run credential, or a service-account key.

## Required Firebase configuration

1. Register an iOS Firebase app whose bundle ID exactly matches
   `PRODUCT_BUNDLE_IDENTIFIER`.
2. Enable **Authentication → Sign-in method → Google**.
3. Download that iOS app's `GoogleService-Info.plist`, then run:

   ```bash
   cd ios
   ./scripts/configure-firebase.sh ~/Downloads/GoogleService-Info.plist
   ```

4. Build and run the Debug app once. Xcode's console prints an App Check debug
   token. Add it at **Firebase Console → App Check → Apps → STEMulate → Manage
   debug tokens**, then relaunch. Do not paste the token into source control.
5. Release/TestFlight uses App Attest. Register the paid-team App ID, enable the
   App Attest capability, register the iOS app with App Check, and enforce App
   Check only after a Release build has successfully obtained a token.
6. The signed-in Firebase user must have both the `owner=true` custom claim and
   a UID present in the Functions `OWNER_UIDS` deployment parameter:

   ```bash
   gcloud auth application-default login
   GCLOUD_PROJECT=stem-ulate \
     npm --prefix functions run set-owner -- YOUR_FIREBASE_AUTH_UID
   ```

   Sign out and back in after changing the claim.

## Required deployed services

Deploy the checked-in rules, indexes, Functions, downloader, and preview worker:

```bash
npm --prefix functions install
npm --prefix functions run build
firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

The following callable Functions must be present in `us-central1`:

- `createProcessingJob`
- `createRemoteProcessingJob`
- `getProcessingOutputs`
- `requestProcessingPreview`
- `getProcessingPreview`
- `renameProcessingJob`
- `saveProcessingJobMixerSettings`

Remote YouTube/Spotify imports additionally require the private
`stemulate-ingest` Cloud Run service, `stemulate-downloads` Cloud Tasks queue,
and matching Functions parameters. Native playback prefers the private
`stemulate-stream` AAC preview service plus `stemulate-previews` queue. When the
preview service is unavailable, the app downloads the original WAV/FLAC output
URLs instead.

Follow `../ingest-service/README.md`, `../stream-service/README.md`, and
`../functions/README.md` for the exact IAM, queue, environment, workflow, and
deployment commands. Both Cloud Run services remain private; Cloud Tasks invokes
them with dedicated service accounts.

## Security and data contract

- Firestore reads are restricted to `users/{signedInUid}/jobs/*` and require
  the `owner=true` claim. The iOS decoder also rejects an owner mismatch.
- Client writes to job documents are denied. Renames and mixer saves use trusted
  callables.
- Source uploads go directly to the one Storage path returned by
  `createProcessingJob`, with the exact declared size and MIME type.
- Signed playback URLs expire after six hours. The app immediately hands them
  to a local disk cache; it requests fresh links when a cached file is missing.
- Analysis JSON/text is downloaded only over HTTPS and is rejected above
  16 MiB. Beat, chord, and section records are normalized before reaching UI or
  the metronome.
- Debug builds use `AppCheckDebugProviderFactory` only when the
  `APP_CHECK_DEBUG` compiler condition is present. Release builds use App Attest
  and never compile in a debug token.
