import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const uid = process.argv[2];
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

if (!uid || !projectId) {
  console.error(
    "Usage: GCLOUD_PROJECT=stem-ulate npm run set-owner -- <firebase-auth-uid>",
  );
  process.exitCode = 1;
} else {
  initializeApp({ credential: applicationDefault(), projectId });
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, {
    ...(user.customClaims ?? {}),
    owner: true,
  });
  console.log(`Set owner=true for Firebase Auth user ${uid}.`);
  console.log("Sign out and back in so the client receives a fresh ID token.");
}
