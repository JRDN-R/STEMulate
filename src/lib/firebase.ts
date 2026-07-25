import { getApp, getApps, initializeApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";
import { connectStorageEmulator, getStorage } from "firebase/storage";
import {
  appCheckSiteKey,
  backendConfigured,
  backendEnabled,
  functionsRegion,
  useEmulators,
} from "./backendConfig";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDail4uDtgyAABB6RPHiQz2IrmE3gbw-_w",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "stem-ulate.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "stem-ulate",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "stem-ulate.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "582552566044",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:582552566044:web:93272b75ab46889d9a22d9",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-9PJCR4JTY6",
};

let authInstance: Auth | null = null;

export const firebaseBackendConfigured = backendConfigured;

let authEmulatorConnected = false;
let firestoreEmulatorConnected = false;
let functionsEmulatorConnected = false;
let storageEmulatorConnected = false;

function getStemulateApp() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  if (backendEnabled && appCheckSiteKey) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (error) {
      // Hot reload can attempt initialization twice; Firebase reports that case.
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!code.includes("already-initialized")) throw error;
    }
  }
  return app;
}

export function getStemulateAuth(): Auth {
  if (authInstance) return authInstance;
  authInstance = getAuth(getStemulateApp());
  if (useEmulators && !authEmulatorConnected) {
    connectAuthEmulator(authInstance, "http://127.0.0.1:9099", { disableWarnings: true });
    authEmulatorConnected = true;
  }
  return authInstance;
}

export function getStemulateFirestore() {
  const firestore = getFirestore(getStemulateApp());
  if (useEmulators && !firestoreEmulatorConnected) {
    connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
    firestoreEmulatorConnected = true;
  }
  return firestore;
}

export function getStemulateFunctions() {
  const functions = getFunctions(getStemulateApp(), functionsRegion);
  if (useEmulators && !functionsEmulatorConnected) {
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    functionsEmulatorConnected = true;
  }
  return functions;
}

export function getStemulateStorage() {
  const storage = getStorage(getStemulateApp());
  if (useEmulators && !storageEmulatorConnected) {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    storageEmulatorConnected = true;
  }
  return storage;
}

export function observeUser(callback: (user: User | null) => void) {
  const auth = getStemulateAuth();
  void getRedirectResult(auth).catch(() => undefined);
  return onAuthStateChanged(auth, callback);
}

export async function signInOwner(): Promise<User | null> {
  const auth = getStemulateAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    return (await signInWithPopup(auth, provider)).user;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code.includes("popup") || code.includes("operation-not-supported")) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw error;
  }
}

export async function signOutOwner() {
  await signOut(getStemulateAuth());
}

export async function getOwnerToken(): Promise<string | null> {
  const user = getStemulateAuth().currentUser;
  return user ? user.getIdToken() : null;
}

export function getOwnerUser(): User | null {
  return getStemulateAuth().currentUser;
}
