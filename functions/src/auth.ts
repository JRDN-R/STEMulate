import type { CallableRequest } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";

import { OWNER_UIDS } from "./config";

export function requireOwner(request: CallableRequest<unknown>): string {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in before using STEMulate.");
  }

  const configuredOwners = new Set(
    OWNER_UIDS.value()
      .split(",")
      .map((uid) => uid.trim())
      .filter(Boolean),
  );

  if (configuredOwners.size === 0) {
    throw new HttpsError(
      "failed-precondition",
      "The backend owner allowlist has not been configured.",
    );
  }

  if (!configuredOwners.has(request.auth.uid)) {
    throw new HttpsError("permission-denied", "This account is not an app owner.");
  }

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.auth.uid)) {
    throw new HttpsError("permission-denied", "The authenticated owner ID is invalid.");
  }

  // Firestore and Storage rules use the same owner claim. Requiring it here
  // fails early instead of creating a job whose upload would later be denied.
  if (request.auth.token.owner !== true) {
    throw new HttpsError(
      "permission-denied",
      "This account is missing its Firebase owner claim. Refresh your sign-in after it is set.",
    );
  }

  return request.auth.uid;
}
